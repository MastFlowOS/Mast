import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { runEngineQuery, type EngineLead } from "../scraperBridge/pythonBridge.js";
import { deliverLead, upsertBusinessFromEngineLead } from "../scraperBridge/deliverLead.js";
import { materializeDiscoveryPlan, type DiscoveryPlanRequest } from "../discovery/planner.js";
import { enqueueBusinessProcessing, ensureEnriched } from "./businessProcessingJob.js";

const db = supabaseAdmin as any;

export type DiscoveryPlanPayload = DiscoveryPlanRequest & { planId: string };
export type DiscoveryTaskPayload = { taskId: string; planId: string; request: DiscoveryPlanRequest };

/**
 * RELIABILITY FIX: mirrors planner.ts's DISCOVERY_TASK_RETRY_OPTIONS
 * (retryLimit: 8 → up to 9 total attempts). A discovery_tasks row used to
 * be reset to status "queued" on every failure unconditionally, including
 * the LAST failure pg-boss would ever retry. Once pg-boss's own retry
 * budget was exhausted, nothing was left to pick that "queued" row back up
 * — no live job existed for it anymore — so it sat there forever, and
 * completePlanIfDrained() (which treats "queued" as still-in-flight) could
 * never finish the plan even after every other task genuinely completed.
 * Now the row is only left "queued" while pg-boss still has retries left
 * for it; on the final attempt it's marked "failed" (a terminal status)
 * instead, so the plan can still conclude — a single stubborn city/niche
 * can no longer hang an entire discovery request indefinitely.
 */
const DISCOVERY_TASK_MAX_ATTEMPTS = 9;

export async function handleDiscoveryPlanJob(payload: DiscoveryPlanPayload): Promise<void> {
  await db.from("discovery_plans").update({ status: "planning" }).eq("id", payload.planId).eq("status", "queued");
  await materializeDiscoveryPlan(payload.planId, payload);
}

/** Baseline gate used before a lead is visible.  It intentionally relies only
 * on independently observed Maps data: identity, location and a usable Maps
 * contact/presence field.  Rich fields are validated later by dedicated jobs. */
function validateDiscoveryCandidate(lead: EngineLead): { valid: true } | { valid: false; reason: string } {
  if (!lead.name?.trim()) return { valid: false, reason: "missing_name" };
  if (!lead.address?.trim()) return { valid: false, reason: "missing_address" };
  if (!lead.maps_link?.includes("google.")) return { valid: false, reason: "missing_maps_provenance" };
  if (lead.closed || lead.is_disqualified) return { valid: false, reason: "disqualified" };
  return validateLead(lead);
}

export async function handleDiscoveryTask(payload: DiscoveryTaskPayload): Promise<void> {
  const { data: task, error: taskError } = await db.from("discovery_tasks").select("*").eq("id", payload.taskId).single();
  if (taskError) throw taskError;

  const currentAttempt = (task.attempts ?? 0) + 1;
  const { data: claimed } = await db.from("discovery_tasks")
    .update({ status: "running", attempts: currentAttempt, started_at: new Date().toISOString(), error: null })
    .eq("id", payload.taskId).eq("status", "queued").select("id").maybeSingle();
  if (!claimed) return; // duplicate wake-up or a retry already owns this task

  // RELIABILITY FIX (efficiency, not correctness): the requested quantity
  // is a hard target, but once it's already been met there's no reason for
  // a task that hasn't started yet to spin up a fresh browser/subprocess
  // just to have its eventual delivery attempt rejected by
  // claim_discovery_delivery(). Tasks that are already mid-flight aren't
  // affected — this only short-circuits ones still sitting in the queue
  // when a sibling task already finished satisfying the plan.
  const { data: planProgress } = await db.from("discovery_plans")
    .select("requested_count, delivered_count").eq("id", payload.planId).maybeSingle();
  if (planProgress && planProgress.delivered_count >= planProgress.requested_count) {
    await recordTaskOutcome(task, { discovered: 0, accepted: 0, rejected: 0, exhausted: false, status: "completed" });
    await completePlanIfDrained(payload.planId);
    return;
  }

  let discovered = 0;
  let accepted = 0;
  let rejected = 0;
  let exhausted = false;
  try {
    for await (const lead of runEngineQuery({
      query: task.niche,
      city: task.city,
      country: task.country_code,
      niche: task.niche,
      region: payload.request.region,
      max_results: task.candidate_budget,
      discovery_only: true,
      require_viability: false,
      db_path: `data/discovery-${payload.taskId}.db`,
    }, undefined, (done) => { exhausted = done.exhausted; })) {
      discovered += 1;
      const validation = validateDiscoveryCandidate(lead);
      if (!validation.valid) { rejected += 1; continue; }

      // Persist and schedule slow work first.  A website/Instagram timeout can
      // therefore never hold up discovery for another city/country task.
      const businessId = await upsertBusinessFromEngineLead(lead, payload.request.region);
      await enqueueBusinessProcessing(businessId, "enrich");
      // NOTE: "score" is deliberately NOT enqueued here. enrichBusiness()
      // (in businessProcessingJob.ts) enqueues it itself once enrichment
      // actually finishes (or immediately, for a business with no
      // website/Instagram to crawl) — that's the only place "score" is ever
      // enqueued now. Audit Broken #2 fix: enqueueing both here, back-to-back
      // and unordered, meant business.score frequently ran before
      // business.enrich had written the fields Opportunity Score/Business
      // Health depend on (ssl_valid, seo, blog, growth_signals, ...), and the
      // legitimate re-score enrichBusiness() tried to fire afterwards was
      // silently swallowed by the old upsert's ON CONFLICT DO NOTHING.

      // Audit Broken #1 fix: Google Maps almost never exposes an email
      // directly, so checking a user's full requested channel set (which may
      // include "email"/"instagram") against this raw, pre-enrichment payload
      // rejected nearly every real candidate before enrichment ever got a
      // chance to find that contact info. Channels Maps CAN answer on its own
      // (phone/website) are still checked immediately, so an obviously
      // unqualified candidate is rejected without paying for enrichment.
      const requestedChannels = payload.request.channels;
      const mapsCheckableChannels = requestedChannels.filter((c) => c === "phone" || c === "website");
      const needsEnrichmentToDecide = requestedChannels.some((c) => c === "email" || c === "instagram");

      if (!channelsSatisfied(lead, mapsCheckableChannels)) { rejected += 1; continue; }

      if (needsEnrichmentToDecide) {
        // Email/Instagram can only be known after the site/IG crawl, so wait
        // for enrichment to actually finish before deciding whether this
        // lead is deliverable — this does mean this one lead's delivery
        // decision is no longer instant, but it's the only correct way to
        // honor an email/instagram channel request without misjudging every
        // candidate on data Maps was never going to supply.
        await ensureEnriched(businessId);
        const { data: enriched } = await db.from("businesses")
          .select("email, phone, instagram, website").eq("id", businessId).maybeSingle();
        if (!enriched || !channelsSatisfied(enriched, requestedChannels)) { rejected += 1; continue; }
      }

      // Audit Broken #4 fix: pass the businessId we already resolved above
      // instead of letting deliverLead() upsert this exact lead a second
      // time — the second upsert used to find the row the first one just
      // inserted and apply a "rediscovery" confidence bump meant for a
      // business turning up again in a LATER, independent search, not its
      // own first discovery.
      const delivery = await deliverLead(lead, {
        userId: payload.request.userId,
        professionSlug: payload.request.professionSlug,
        discoveryMode: "live",
        scrapeJobId: payload.request.scrapeJobId,
        dailyLimit: payload.request.dailyLimit,
        monthlyLimit: payload.request.monthlyLimit,
        discoveryPlanId: payload.planId,
      }, payload.request.region, businessId);
      if (delivery.limitReached) break;
      if (delivery.wasNewForUser) accepted += 1;
    }

    await recordTaskOutcome(task, { discovered, accepted, rejected, exhausted, status: "completed" });
    await completePlanIfDrained(payload.planId);
  } catch (error) {
    // RELIABILITY FIX: a recoverable failure (browser/page crash, nav
    // timeout, rate limit, network blip) should give pg-boss's retry a
    // chance to "restart the worker" — that only works while attempts are
    // still within the retry budget planner.ts gave this queue
    // (DISCOVERY_TASK_RETRY_OPTIONS.retryLimit). Once this was the last
    // attempt pg-boss will ever make, leaving the row "queued" would strand
    // it forever with no job left to claim it — so it's marked "failed"
    // (terminal) instead, letting completePlanIfDrained() treat this
    // city/niche as genuinely given-up-on rather than eternally pending.
    const willRetry = currentAttempt < DISCOVERY_TASK_MAX_ATTEMPTS;
    await recordTaskOutcome(task, {
      discovered,
      accepted,
      rejected,
      exhausted,
      status: willRetry ? "queued" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    if (!willRetry) {
      // No further pg-boss retry is coming for this task — the plan must
      // still be allowed to conclude (quantity reached, or every OTHER
      // task genuinely exhausted) instead of hanging on this one city.
      await completePlanIfDrained(payload.planId);
    }
    throw error; // let pg-boss apply its own retry/backoff while attempts remain
  }
}

async function recordTaskOutcome(task: any, outcome: { discovered: number; accepted: number; rejected: number; exhausted: boolean; status: string; error?: string }) {
  await db.from("discovery_tasks").update({
    status: outcome.status,
    discovered_count: outcome.discovered,
    accepted_count: outcome.accepted,
    rejected_count: outcome.rejected,
    error: outcome.error ?? null,
    completed_at: outcome.status === "completed" ? new Date().toISOString() : null,
  }).eq("id", task.id);

  // Accumulate, don't overwrite. This used to be a plain `.upsert()`, which
  // means ON CONFLICT DO UPDATE SET column = <value> — that REPLACES the
  // stored count with just this one run's numbers rather than adding to
  // it, so the planner's "historical yield" ranking (accepted_count /
  // searches, in planner.ts) was reading a value that reset on every call
  // instead of growing. A single row here can also be touched by two
  // different discovery_plans running concurrently for the same
  // niche/country/city/source, so the increment has to happen atomically
  // inside Postgres (record_discovery_location_outcome, migration 016) —
  // a read-then-write from here would still lose updates under that race.
  await db.rpc("record_discovery_location_outcome", {
    p_niche: task.niche,
    p_country_code: task.country_code,
    p_city: task.city,
    p_source: task.source,
    p_discovered_delta: outcome.discovered,
    p_accepted_delta: outcome.accepted,
    p_exhausted: outcome.exhausted,
    p_errored: Boolean(outcome.error),
  });
}

async function completePlanIfDrained(planId: string) {
  const { data: remaining } = await db.from("discovery_tasks").select("id").eq("plan_id", planId).in("status", ["queued", "running", "rate_limited"]).limit(1);
  if (remaining?.length) return;
  const { data: plan } = await db.from("discovery_plans").select("requested_count, delivered_count, scrape_job_id").eq("id", planId).single();
  if (!plan) return;
  const status = plan.delivered_count >= plan.requested_count ? "completed" : "partial";
  await db.from("discovery_plans").update({ status, completed_at: new Date().toISOString() }).eq("id", planId);
  await supabaseAdmin.from("scrape_jobs").update({ status: "completed", results_count: plan.delivered_count, completed_at: new Date().toISOString() }).eq("id", plan.scrape_job_id);
}
