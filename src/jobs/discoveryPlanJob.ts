import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { runEngineQuery, type EngineLead } from "../scraperBridge/pythonBridge.js";
import { deliverLead, upsertBusinessFromEngineLead } from "../scraperBridge/deliverLead.js";
import { materializeDiscoveryPlan, type DiscoveryPlanRequest } from "../discovery/planner.js";
import { enqueueBusinessProcessing, ensureEnriched } from "./businessProcessingJob.js";
import { env } from "../config/env.js";
import { JobProfiler } from "../lib/perf.js";

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

  const currentAttempt = (task.attempts ?? 0) + 1;
  const { data: claimed } = await db.from("discovery_tasks")
    .update({ status: "running", attempts: currentAttempt, started_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), error: null })
    .eq("id", payload.taskId)
    .in("status", isStaleRunning ? ["running"] : ["queued"])
    .select("id").maybeSingle();
  if (!claimed) return; // another worker beat us to the claim

  // ── Cancellation check (pre-flight) ────────────────────────────────────
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
    }, undefined, (done) => {
      exhausted = done.exhausted;
      // Phase 2: capture Python perf from __done__ sentinel
      if (done.perf) pythonPerfData = done.perf;
      pythonTimer.end();
    })) {

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
      const validation = validateDiscoveryCandidate(lead);
      if (!validation.valid) { rejected += 1; continue; }

      // Persist and schedule slow work first.
      const tUpsert = profiler.timer("business_upsert");
      const businessId = await upsertBusinessFromEngineLead(lead, payload.request.region);
      tUpsert.end();
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

      if (!channelsSatisfied(lead, mapsCheckableChannels)) { rejected += 1; continue; }

      if (needsEnrichmentToDecide) {
        // Guard ensureEnriched so a single slow/failing website crawl does
        // NOT crash the entire city/niche task — the business is not lost
        // (the async worker still finishes enriching it), we just skip
        // this lead's channel gate for now and move on.
        try {
          const tEnsure = profiler.timer("ensure_enriched");
          await ensureEnriched(businessId);
          tEnsure.end();
        } catch (enrichErr) {
          console.warn(`[discoveryTask] ensureEnriched failed for businessId=${businessId} — skipping channel gate`, enrichErr);
          rejected += 1;
          continue;
        }
        const { data: enriched } = await db.from("businesses")
          .select("email, phone, instagram, website").eq("id", businessId).maybeSingle();
        if (!enriched || !channelsSatisfied(enriched, requestedChannels)) { rejected += 1; continue; }
      }

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

      if (delivery.limitReached) break;
      if (delivery.wasNewForUser) {
        profiler.mark("first_lead_delivered");
        accepted += 1;
      } else {
        duplicates += 1;
      }
    }

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
