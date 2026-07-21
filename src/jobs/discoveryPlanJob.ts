import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { deliverLead, upsertBusinessFromEngineLead } from "../scraperBridge/deliverLead.js";
import { materializeDiscoveryPlan, type DiscoveryPlanRequest } from "../discovery/planner.js";
import { enqueueBusinessProcessing, ensureEnriched, ensureIntelligence } from "./businessProcessingJob.js";
import { env } from "../config/env.js";
import { JobProfiler } from "../lib/perf.js";
import { getProvider, getGenerator } from "../discovery/providerRegistry.js";
import { getPlan, getPlanConcurrency } from "../config/plans.js";
import type { PlanId } from "../config/plans.js";
import type { EngineLead } from "../scraperBridge/pythonBridge.js";
import {
  initJobMetrics,
  finalizeJobMetrics,
  recordTimeToFirstLead,
  incrementDiscoveryMetrics,
  incrementFailureMetrics,
} from "../lib/observability.js";


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

/**
 * Heartbeat interval (ms). Workers pulse this on every iteration of the
 * lead-delivery loop while a task is running, so a stale-task reclaimer
 * can distinguish a live-but-slow worker from a crashed one.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Emits a heartbeat for a discovery task row.  Fire-and-forget — a single
 * missed heartbeat is harmless; the stale threshold is intentionally much
 * longer than this interval.
 */
function heartbeat(taskId: string): void {
  db.from("discovery_tasks")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", taskId)
    .then(() => {/* intentionally fire-and-forget */})
    .catch((err: unknown) => console.warn("[discoveryTask] heartbeat failed", err));
}

export async function handleDiscoveryPlanJob(payload: DiscoveryPlanPayload): Promise<void> {
  await db.from("discovery_plans").update({ status: "planning" }).eq("id", payload.planId).eq("status", "queued");
  await materializeDiscoveryPlan(payload.planId, payload);

  // Phase 7: Initialize the job metrics row when the plan officially begins.
  // Best-effort — never blocks plan execution.
  try {
    const { data: plan } = await db
      .from("discovery_plans")
      .select("scrape_job_id, user_id, requested_count")
      .eq("id", payload.planId)
      .maybeSingle();
    if (plan) {
      initJobMetrics({
        planId: payload.planId,
        scrapeJobId: plan.scrape_job_id,
        userId: plan.user_id,
        requestedCount: plan.requested_count,
      });
    }
  } catch {
    // Non-fatal.
  }
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
  // Phase 2: job-level profiler
  const profiler = new JobProfiler();
  // Queue wait = time from when pg-boss created the job to now (worker pickup)
  // pg-boss v10 stores this as `createdon` (lowercase, Date object)
  const jobCreatedOn: Date | undefined = (payload as any).createdon ?? (payload as any).createdOn;
  const queueWaitMs = jobCreatedOn instanceof Date
    ? Date.now() - jobCreatedOn.getTime()
    : undefined;
  if (queueWaitMs !== undefined) {
    profiler.recordRaw("queue_wait", queueWaitMs);
  }
  profiler.mark("worker_pickup");

  const { data: task, error: taskError } = await db.from("discovery_tasks").select("*").eq("id", payload.taskId).single();
  if (taskError) throw taskError;

  // ── Stale-task crash recovery ───────────────────────────────────────────
  // A task stuck in "running" with a heartbeat older than STALE_TASK_TIMEOUT_MS
  // belongs to a crashed worker.  Re-claim it so pg-boss's retry can proceed
  // rather than leaving it stranded indefinitely.
  const staleThresholdMs = env.STALE_TASK_TIMEOUT_MS;
  const isStaleRunning =
    task.status === "running" &&
    task.last_heartbeat_at != null &&
    Date.now() - Date.parse(task.last_heartbeat_at) > staleThresholdMs;
  const isQueued = task.status === "queued";

  if (!isQueued && !isStaleRunning) {
    // Another live worker owns this task — do not steal it.
    return;
  }

  // ── Concurrency-cap pre-check (before claiming) ────────────────────────
  // Check the user's running task count against their plan cap BEFORE marking
  // the task as running.  If already at cap, skip this task and let pg-boss
  // re-deliver it on the next polling cycle (another user's tasks will be
  // served in the meantime — this is the primary fairness enforcement).
  const userId = task.user_id as string | null;
  const planTierId = (task as any).plan_tier_id as string | null;
  const concurrencyCap = getPlanConcurrency(
    (planTierId as PlanId) ?? "free",
    env.PLAN_CONCURRENCY_OVERRIDES,
  );

  if (userId) {
    const { count: runningCount } = await (db
      .from("discovery_tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "running") as any);

    if ((runningCount ?? 0) >= concurrencyCap) {
      // User is at cap — skip without claiming.  pg-boss will re-deliver.
      return;
    }
  }

  const currentAttempt = (task.attempts ?? 0) + 1;
  const { data: claimed } = await db.from("discovery_tasks")
    .update({ status: "running", attempts: currentAttempt, started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), error: null })
    .eq("id", payload.taskId)
    .in("status", isStaleRunning ? ["running"] : ["queued"])
    .select("id").maybeSingle();
  if (!claimed) return; // another worker beat us to the claim

  let planCheck: any;
  {
    const t = profiler.timer("plan_cancellation_check");
    const { data } = await db.from("discovery_plans")
      .select("requested_count, delivered_count, status").eq("id", payload.planId).maybeSingle();
    t.end();
    planCheck = data;
  }
  if (!planCheck || planCheck.status === "cancelled") {
    await recordTaskOutcome(task, { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, status: "completed", startedAt: Date.now(), completionReason: "cancelled" });
    return; // do NOT call completePlanIfDrained — cancellation is already terminal
  }

  // ── Early-exit: plan already satisfied ─────────────────────────────────
  // RELIABILITY FIX (efficiency): once the requested quantity is already
  // met there is no reason to spin up a fresh browser.
  if (planCheck.delivered_count >= planCheck.requested_count) {
    await recordTaskOutcome(task, { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, status: "completed", startedAt: Date.now(), completionReason: "quantity_reached" });
    await completePlanIfDrained(payload.planId);
    return;
  }

  let discovered = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let exhausted = false;
  const startedAt = Date.now();
  let lastHeartbeat = Date.now();
  // Phase 2: capture perf from Python __done__ sentinel
  let pythonPerfData: Record<string, unknown> | undefined;

  try {
    const pythonTimer = profiler.timer("python_subprocess_total");

    // ── Provider registry routing (Phase 5 Refinement 3) ─────────────────
    // Route through the provider registry instead of calling runEngineQuery
    // directly.  The Google Maps provider wraps runEngineQuery unchanged;
    // future providers plug in here with zero changes to this task handler.
    const sourceId = task.source ?? "google_maps";
    const provider = getProvider(sourceId);
    const generator = getGenerator(sourceId);
    const searchTarget = {
      niche: task.niche,
      city: task.city,
      countryCode: task.country_code,
      region: payload.request.region,
    };
    const searchQueries = generator.generate(searchTarget);

    // Outer loop: one iteration per SearchQuery (most providers produce one;
    // multi-query providers like future Yelp may produce several per niche).
    for (const searchQuery of searchQueries) {
      for await (const lead of provider.search(
        searchQuery,
        searchTarget,
        {
          maxResults: task.candidate_budget,
          candidateBudget: task.candidate_budget,
          discoveryOnly: true,
          taskDbPath: `data/discovery-${payload.taskId}.db`,
        },
        undefined,
        (done) => {
          exhausted = done.exhausted;
          if (done.perf) pythonPerfData = done.perf;
          pythonTimer.end();
        },
      )) {

      // ── Heartbeat pulse ──────────────────────────────────────────────────
      if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        heartbeat(payload.taskId);
        lastHeartbeat = Date.now();
      }

      // ── Mid-loop cancellation check ─────────────────────────────────────
      const tMid = profiler.timer("mid_loop_cancel_check");
      const { data: midCheck } = await db.from("discovery_plans")
        .select("status, delivered_count, requested_count").eq("id", payload.planId).maybeSingle();
      tMid.end();
      if (!midCheck || midCheck.status === "cancelled") {
        break; // Python subprocess will be GC'd; SIGTERM not needed for discovery_only
      }
      if (midCheck.delivered_count >= midCheck.requested_count) break;

      discovered += 1;
      const pid = lead._pipeline_id ?? `local:${discovered}`;
      console.log(`PIPELINE ${pid}`);
      console.log(`DISCOVERED name=${JSON.stringify(lead.name)}`);

      const validation = validateDiscoveryCandidate(lead);
      if (!validation.valid) {
        rejected += 1;
        console.log(`PIPELINE ${pid}`);
        console.log(`EXITED HERE`);
        console.log(`reason=validateDiscoveryCandidate:${validation.reason}`);
        continue;
      }

      // Persist and schedule slow work first.
      const tUpsert = profiler.timer("business_upsert");
      const businessId = await upsertBusinessFromEngineLead(lead, payload.request.region);
      tUpsert.end();
      console.log(`BUSINESS_UPSERTED businessId=${businessId}`);
      const tEnqueue = profiler.timer("enqueue_enrich");
      await enqueueBusinessProcessing(businessId, "enrich");
      tEnqueue.end();
      // NOTE: "score" is deliberately NOT enqueued here — enrichBusiness()
      // enqueues it once enrichment finishes (see businessProcessingJob.ts).

      // Maps-checkable channel gate (phone/website only — email/instagram
      // are resolved post-enrichment).
      const requestedChannels = payload.request.channels;
      const mapsCheckableChannels = requestedChannels.filter((c) => c === "phone" || c === "website");
      const needsEnrichmentToDecide = requestedChannels.some((c) => c === "email" || c === "instagram");

      if (!channelsSatisfied(lead, mapsCheckableChannels)) {
        rejected += 1;
        console.log(`PIPELINE ${pid}`);
        console.log(`EXITED HERE`);
        console.log(`reason=maps_channel_gate:requested=${JSON.stringify(mapsCheckableChannels)},phone=${JSON.stringify(lead.phone)},website=${JSON.stringify(lead.website)}`);
        continue;
      }

      if (needsEnrichmentToDecide) {
        // Guard ensureEnriched so a single slow/failing website crawl does
        // NOT crash the entire city/niche task — the business is not lost
        // (the async worker still finishes enriching it), we just skip
        // this lead's channel gate for now and move on.
        const tEnsureStart = Date.now();
        console.log(`ENSURE_ENRICHED_START`);
        try {
          const tEnsure = profiler.timer("ensure_enriched");
          await ensureEnriched(businessId);
          tEnsure.end();
          console.log(`ENSURE_ENRICHED_END duration=${Date.now() - tEnsureStart}ms`);

          if (requestedChannels.includes("instagram")) {
            const tIntel = profiler.timer("ensure_intelligence");
            await ensureIntelligence(businessId);
            tIntel.end();
          }
        } catch (enrichErr) {
          const message = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
          console.warn(`[discoveryTask] ensureEnriched/ensureIntelligence failed for businessId=${businessId} — skipping channel gate`, enrichErr);
          rejected += 1;
          console.log(`ENSURE_ENRICHED_END duration=${Date.now() - tEnsureStart}ms (threw)`);
          console.log(`PIPELINE ${pid}`);
          console.log(`EXITED HERE`);
          console.log(`reason=ensureEnriched_threw:businessId=${businessId},error=${JSON.stringify(message)}`);
          continue;
        }
        const { data: enriched } = await db.from("businesses")
          .select("email, phone, instagram, website").eq("id", businessId).maybeSingle();
        const satisfied = Boolean(enriched) && channelsSatisfied(enriched, requestedChannels);
        console.log(`CHANNELS_AFTER_ENRICHMENT email=${!!enriched?.email}, phone=${!!enriched?.phone}, instagram=${!!enriched?.instagram}, website=${!!enriched?.website}`);
        console.log(`CHANNELS_SATISFIED=${satisfied}`);
        if (!satisfied) {
          rejected += 1;
          console.log(`PIPELINE ${pid}`);
          console.log(`EXITED HERE`);
          console.log(`reason=post_enrichment_channel_gate:requested=${JSON.stringify(requestedChannels)},row=${JSON.stringify(enriched)}`);
          continue;
        }
      }

      console.log(`DELIVER_LEAD_START`);
      const tDeliver = profiler.timer("deliver_lead");
      const delivery = await deliverLead(lead, {
        userId: payload.request.userId,
        professionSlug: payload.request.professionSlug,
        discoveryMode: "live",
        scrapeJobId: payload.request.scrapeJobId,
        dailyLimit: payload.request.dailyLimit,
        monthlyLimit: payload.request.monthlyLimit,
        discoveryPlanId: payload.planId,
      }, payload.request.region, businessId);
      tDeliver.end();
      console.log(`DELIVER_LEAD_END result=${JSON.stringify(delivery)}`);

      // NOTE: insertLeadForUser() runs INSIDE deliverLead() (deliverLead.ts,
      // not instrumented per scope) — there is no separate timestamp
      // available from this file alone. INSERT_LEAD_START is logged
      // immediately after DELIVER_LEAD_END resolves, which is the earliest
      // point this file can observe it.
      if (delivery.limitReached) {
        console.log(`PIPELINE ${pid}`);
        console.log(`EXITED HERE`);
        console.log(`reason=plan_limit_reached:no leads row inserted,delivery=${JSON.stringify(delivery)}`);
        break;
      }
      if (!delivery.wasNewForUser) {
        console.log(`PIPELINE ${pid}`);
        console.log(`EXITED HERE`);
        console.log(`reason=duplicate_already_owned_by_user:businessId=${businessId},no new leads row inserted`);
        duplicates += 1;
        continue;
      }

      console.log(`INSERT_LEAD_START`);
      // insertLeadForUser() (deliverLead.ts) already ran by this point as
      // part of the deliverLead() call above; DeliveryResult does not
      // expose leads.id, so it cannot be printed here without modifying
      // deliverLead.ts, which is out of scope for this instrumentation pass.
      console.log(`INSERT_LEAD_END leadId=<unavailable from discoveryPlanJob.ts — DeliveryResult has no leads.id field>`);

      profiler.mark("first_lead_delivered");
      // Phase 7: record time-to-first-lead (idempotent — COALESCE guard in DB).
      const elapsedMs = Date.now() - startedAt;
      recordTimeToFirstLead(payload.planId, elapsedMs);
      accepted += 1;
      console.log(`FINISHED`);
    } // end inner lead loop

      // Break outer search-query loop if plan is satisfied or cancelled
      const { data: afterQuery } = await db.from("discovery_plans")
        .select("delivered_count, requested_count, status").eq("id", payload.planId).maybeSingle();
      if (!afterQuery || afterQuery.status === "cancelled") break;
      if (afterQuery.delivered_count >= afterQuery.requested_count) break;
    } // end outer search-query loop

    // Determine completion reason for metrics.
    const { data: finalPlan } = await db.from("discovery_plans")
      .select("delivered_count, requested_count, status").eq("id", payload.planId).maybeSingle();
    const completionReason: string = finalPlan?.status === "cancelled"
      ? "cancelled"
      : finalPlan?.delivered_count >= finalPlan?.requested_count
        ? "quantity_reached"
        : exhausted
          ? "exhausted"
          : "limit_reached";

    await recordTaskOutcome(task, { discovered, accepted, rejected, duplicates, exhausted, status: "completed", startedAt, completionReason });

    // Phase 7: accumulate discovery metrics for this task into the plan's metrics row.
    incrementDiscoveryMetrics(payload.planId, {
      businessesDiscovered: discovered,
      duplicateCount: duplicates,
      searchExhaustionReason: exhausted ? completionReason : undefined,
    });

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
      duplicates,
      exhausted,
      status: willRetry ? "queued" : "failed",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      completionReason: willRetry ? "retrying" : "failed",
    });

    // Phase 7: track browser crashes and navigation timeouts from error messages.
    const errMsg = error instanceof Error ? error.message : String(error);
    if (/crash|target closed|oom/i.test(errMsg)) {
      incrementFailureMetrics(payload.planId, { browserCrashes: 1 });
    } else if (/timeout|timed out/i.test(errMsg)) {
      incrementFailureMetrics(payload.planId, { navigationTimeouts: 1 });
    }

    if (!willRetry) {
      // No further pg-boss retry is coming for this task — the plan must
      // still be allowed to conclude instead of hanging on this one city.
      await completePlanIfDrained(payload.planId);
    }
    throw error; // let pg-boss apply its own retry/backoff while attempts remain
  } finally {
    // Phase 2: attach Python perf and print the TS-side report
    if (pythonPerfData) profiler.attachPythonPerf(pythonPerfData);
    profiler.printReport({
      query: task?.niche ?? "",
      city: task?.city ?? "",
      delivered: accepted,
      requested: task?.candidate_budget ?? 0,
      queueWaitMs: queueWaitMs,
    });
    if (pythonPerfData) {
      console.debug(`[discoveryTask] Python perf summary attached — run_total_ms=${(pythonPerfData as any)?.run_total_ms ?? "n/a"}`);
    }
  }
}

async function recordTaskOutcome(
  task: any,
  outcome: {
    discovered: number;
    accepted: number;
    rejected: number;
    duplicates: number;
    exhausted: boolean;
    status: string;
    error?: string;
    startedAt: number;
    completionReason: string;
  },
) {
  const runtimeMs = Date.now() - outcome.startedAt;
  const taskSummary = {
    discovered: outcome.discovered,
    accepted: outcome.accepted,
    rejected: outcome.rejected,
    duplicates: outcome.duplicates,
    exhausted: outcome.exhausted,
    runtime_ms: runtimeMs,
    completion_reason: outcome.completionReason,
  };

  await db.from("discovery_tasks").update({
    status: outcome.status,
    discovered_count: outcome.discovered,
    accepted_count: outcome.accepted,
    rejected_count: outcome.rejected,
    error: outcome.error ?? null,
    task_summary: taskSummary,
    completed_at: outcome.status === "completed" || outcome.status === "failed" ? new Date().toISOString() : null,
    last_heartbeat_at: null, // clear heartbeat so stale-detector ignores finished rows
  }).eq("id", task.id);

  // Accumulate location stats atomically inside Postgres (migration 016).
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

/**
 * Checks whether every task for a plan has reached a terminal state and, if
 * so, closes the plan and the parent scrape_job with the correct terminal
 * status.
 *
 * Terminal states for a task: completed | failed.
 * In-flight states: queued | running | rate_limited.
 *
 * The plan's own terminal state is chosen as follows:
 *   - If the plan was cancelled                      → "cancelled"
 *   - If delivered_count >= requested_count          → "completed"
 *   - Otherwise (genuinely exhausted short)          → "completed_partial"
 *
 * "completed_partial" is written to scrape_jobs.status instead of the old
 * "completed" so the frontend can distinguish a full fill from a genuine
 * shortfall without needing to compare requested vs delivered counts.
 */
async function completePlanIfDrained(planId: string) {
  const { data: remaining } = await db.from("discovery_tasks")
    .select("id").eq("plan_id", planId).in("status", ["queued", "running", "rate_limited"]).limit(1);
  if (remaining?.length) return; // still tasks in flight — do not close yet

  const { data: plan } = await db.from("discovery_plans")
    .select("requested_count, delivered_count, scrape_job_id, status, created_at").eq("id", planId).single();
  if (!plan) return;

  // Don't overwrite a cancellation that already landed.
  if (plan.status === "cancelled") {
    await supabaseAdmin.from("scrape_jobs").update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      job_summary: buildJobSummary(plan, "cancelled"),
    }).eq("id", plan.scrape_job_id);
    return;
  }

  const planFinalStatus = plan.delivered_count >= plan.requested_count ? "completed" : "completed_partial";
  const jobFinalStatus = planFinalStatus; // 1-to-1 mapping for now

  const completionReason = planFinalStatus === "completed" ? "quantity_reached" : "exhausted";

  await db.from("discovery_plans").update({
    status: planFinalStatus,
    completed_at: new Date().toISOString(),
  }).eq("id", planId);

  await supabaseAdmin.from("scrape_jobs").update({
    status: jobFinalStatus,
    results_count: plan.delivered_count,
    completed_at: new Date().toISOString(),
    job_summary: buildJobSummary(plan, completionReason),
  }).eq("id", plan.scrape_job_id);

  // Phase 7: finalize the job metrics row now that the plan has concluded.
  finalizeJobMetrics({
    planId,
    deliveredCount: plan.delivered_count,
    completionStatus: planFinalStatus as "completed" | "completed_partial",
  });
}

function buildJobSummary(plan: any, completionReason: string) {
  const startedAt = plan.started_at ? Date.parse(plan.started_at) : Date.parse(plan.created_at);
  return {
    requested: plan.requested_count,
    delivered: plan.delivered_count,
    shortfall: Math.max(0, plan.requested_count - plan.delivered_count),
    completion_reason: completionReason,
    runtime_ms: Date.now() - startedAt,
  };
}
