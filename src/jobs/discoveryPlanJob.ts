import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { getBoss, QUEUES } from "../lib/queue.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { deliverLead, upsertBusinessFromEngineLead } from "../scraperBridge/deliverLead.js";
import { materializeDiscoveryPlan, dispatchQueuedDiscoveryTasks, DISCOVERY_TASK_RETRY_OPTIONS, type DiscoveryPlanRequest } from "../discovery/planner.js";
import { enqueueBusinessProcessing, ensureEnriched, ensureIntelligence } from "./businessProcessingJob.js";
import { env } from "../config/env.js";
import { JobProfiler } from "../lib/perf.js";
import { getProvider, getGenerator } from "../discovery/providerRegistry.js";
import { getPlan, getPlanConcurrency } from "../config/plans.js";
import type { PlanId } from "../config/plans.js";
import type { EngineLead, EngineDoneInfo } from "../scraperBridge/pythonBridge.js";
import { registerRequestAbortController, terminateRequest, type RequestTerminalReason } from "../discovery/requestLifecycle.js";
import { cityTransitionFor } from "../discovery/cityScheduling.js";
import { hasCuratedAreas, claimAreaForCity, recordAreaOutcome } from "../discovery/areaRotation.js";
import { getAreasForCity } from "../lib/geo/cityAreas.js";
import { runAreaWorkerPool, type AreaWorkerLogEvent, type AreaWorkerPoolResult } from "../discovery/googleAreaPool.js";
import { getBrowserSlotPool, acquireBrowserSlotBlocking } from "../lib/workerCapacity.js";
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
 * AUDIT FIX (Finding 3 — concurrency-skip permanently completing pg-boss
 * jobs): how long to wait before re-checking a task that was skipped
 * because its user was already at their concurrency cap. Short enough that
 * a freed-up slot is picked up promptly; long enough not to hammer the
 * `discovery_tasks` running-count query every polling cycle for a user who
 * is legitimately still at cap.
 */
const CONCURRENCY_RECHECK_DELAY_SECONDS = 5;

/**
 * Heartbeat interval (ms). Workers pulse this on every iteration of the
 * lead-delivery loop while a task is running, so a stale-task reclaimer
 * can distinguish a live-but-slow worker from a crashed one.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const REQUEST_TERMINAL_POLL_MS = 500;

/**
 * MINIMAL FIX (discovery liveness / city failure classification — forensic
 * audit §9/§10): thrown when the engine's own `runEngineQuery()` call
 * completed cleanly (reported `__done__`, so no ordinary exception was
 * ever raised out of `provider.search()`) but its bridge-computed
 * `terminationReason` was `WATCHDOG_TIMEOUT` or `FAILURE` — i.e. neither a
 * clean success nor genuine exhaustion. Reusing the existing `catch
 * (error)` block's already-bounded pg-boss retry (`willRetry =
 * currentAttempt < DISCOVERY_TASK_MAX_ATTEMPTS`, unchanged) is the
 * smallest safe way to give this city a bounded retry instead of
 * recording a normal "completed" outcome and immediately burning its one
 * scheduling attempt / rotating to the next city — without inventing a
 * second, parallel retry mechanism or redesigning `dispatchQueuedDiscoveryTasks()`'s
 * one-city-at-a-time scheduling at all. See `cityScheduling.ts`'s
 * `cityTransitionFor()` for the classification this reacts to.
 */
class EngineTerminationRetryError extends Error {
  constructor(
    public readonly reason: "WATCHDOG_TIMEOUT" | "SCRAPER_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "EngineTerminationRetryError";
  }
}

function terminalReasonForPlan(plan: any): RequestTerminalReason | undefined {
  if (!plan) return "SCRAPER_FAILURE";
  if (plan.status === "cancelled") return "USER_CANCELLED";
  if (plan.delivered_count >= plan.requested_count) return "TARGET_REACHED";
  if (plan.status === "completed_partial") return "EXHAUSTED";
  if (plan.status === "failed") return "SCRAPER_FAILURE";
  return undefined;
}

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
  const { data: plan } = await db.from("discovery_plans").select("status").eq("id", payload.planId).maybeSingle();
  if (!plan || plan.status === "cancelled" || plan.status === "completed") return;
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

/** One area/city search attempt's full outcome — see runOneAreaAttempt(). */
type AreaAttemptResult = {
  discovered: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  exhausted: boolean;
  cityReason: string;
  terminalReason?: RequestTerminalReason;
  /**
   * Mirrors the original single-area code path's EngineTerminationRetryError
   * throw condition (WATCHDOG_TIMEOUT/SCRAPER_FAILURE, not genuine
   * exhaustion, plan not already terminal) — returned instead of thrown so
   * a pool caller (Worker Pools B) can isolate the failure to this one area
   * (Step 8) instead of it necessarily taking down the whole task. The
   * legacy single-area call site still throws EngineTerminationRetryError
   * itself when this is true, preserving the exact original behavior.
   */
  shouldRetryTask: boolean;
  pythonPerfData?: Record<string, unknown>;
  bridgeTimings?: EngineDoneInfo["bridgeTimings"];
  progressMarks?: EngineDoneInfo["progressMarks"];
  engineTerminationReason?: EngineDoneInfo["terminationReason"];
};

/**
 * Runs ONE complete discovery search — one SearchQuery set, one
 * provider.search() stream, full lead-processing pipeline (validate →
 * upsert → channel gate → enrich → deliver) — for a single `area` (or
 * `undefined` for a city with no curated areas / a non-Google provider).
 *
 * This is the exact body that lived inline in handleDiscoveryTask before
 * Worker Pools B (Google Maps area worker pool); it is factored out,
 * unchanged in behavior, so it can run either:
 *   • once, for the legacy single-area path (any provider, or a Google
 *     Maps city with GOOGLE_MAPS_AREA_WORKERS=1 — today's default), or
 *   • concurrently, once per claimed area, inside runAreaWorkerPool() for
 *     a Google Maps city with curated areas and GOOGLE_MAPS_AREA_WORKERS
 *     > 1.
 *
 * Deliberately does NOT call recordTaskOutcome / recordAreaOutcome /
 * completePlanIfDrained / dispatchQueuedDiscoveryTasks — those stay at the
 * task level in handleDiscoveryTask, called once (legacy path) or once per
 * area from the pool wrapper (recordAreaOutcome) / once in aggregate
 * (recordTaskOutcome), per Worker Pools B Step 10.
 */
async function runOneAreaAttempt(
  ctx: {
    db: any;
    task: any;
    payload: DiscoveryTaskPayload;
    profiler: JobProfiler;
    provider: ReturnType<typeof getProvider>;
    generator: ReturnType<typeof getGenerator>;
    requestAbort: AbortController;
    observeTerminalPlan: () => Promise<RequestTerminalReason | undefined>;
    startedAt: number;
  },
  area: string | undefined,
): Promise<AreaAttemptResult> {
  const { db, task, payload, profiler, provider, generator, requestAbort, observeTerminalPlan, startedAt } = ctx;

  let discovered = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let exhausted = false;
  let lastHeartbeat = Date.now();
  let pythonPerfData: Record<string, unknown> | undefined;
  let bridgeTimings: EngineDoneInfo["bridgeTimings"];
  let progressMarks: EngineDoneInfo["progressMarks"];
  let engineTerminationReason: EngineDoneInfo["terminationReason"];

  const searchTarget = {
    niche: task.niche,
    city: task.city,
    countryCode: task.country_code,
    region: payload.request.region,
    area,
  };
  const searchQueries = generator.generate(searchTarget);
  const pythonTimer = profiler.timer("python_subprocess_total");

  // Outer loop: one iteration per SearchQuery (most providers produce one;
  // multi-query providers like future Yelp may produce several per niche).
  outer: for (const searchQuery of searchQueries) {
    for await (const lead of provider.search(
      searchQuery,
      searchTarget,
      {
        maxResults: task.candidate_budget,
        candidateBudget: task.candidate_budget,
        discoveryOnly: true,
        // Worker Pools B Step 4: EVERY area belonging to this task shares
        // this SAME path (keyed only by taskId, never by area), so early
        // fingerprint dedup catches the same business found by two
        // overlapping areas — never one SQLite db per area.
        taskDbPath: `data/discovery-${payload.taskId}.db`,
        requestId: payload.planId,
      },
      requestAbort.signal,
      (done) => {
        exhausted = done.exhausted;
        engineTerminationReason = done.terminationReason;
        if (done.success === false) {
          // See discoverJob.ts's onDone callback for the full Part 8
          // explanation. `exhausted` is guaranteed false in this branch
          // already; this is log-level visibility only — persisting
          // `success`/`failureReason` into discovery_tasks itself would
          // need a schema change (new columns + the `p_exhausted` RPC
          // below updated to accept them) that's out of scope for this
          // pass. Flagged here rather than silently applied.
          console.warn(
            `[discoveryPlanJob] engine discovery FAILED for task=${payload.taskId} area=${area ?? "n/a"} — ` +
              `reason=${done.failureReason} detail=${done.failureDetail ?? "n/a"}`,
          );
        }
        if (done.perf) pythonPerfData = done.perf;
        bridgeTimings = done.bridgeTimings;
        progressMarks = done.progressMarks;
        pythonTimer.end();
      },
    )) {
    if (requestAbort.signal.aborted) break outer;

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
    if (terminalReasonForPlan(midCheck)) {
      await observeTerminalPlan();
      break outer;
    }

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

    if (requestAbort.signal.aborted) break outer;

    // Persist and schedule slow work first.
    const tUpsert = profiler.timer("business_upsert");
    const businessId = await upsertBusinessFromEngineLead(lead, payload.request.region, undefined, payload.request.scrapeJobId);
    tUpsert.end();
    if (requestAbort.signal.aborted) break outer;
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

    // Cancellation/target may have landed during an expensive enrichment.
    // Preserve work already completed, but never start a new acceptance.
    if (requestAbort.signal.aborted || await observeTerminalPlan()) break outer;

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
      await observeTerminalPlan();
      break outer;
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
    const elapsedSec = elapsedMs / 1000;
    const leadsPerMin = elapsedSec > 0 ? ((accepted / elapsedSec) * 60).toFixed(1) : "0.0";
    const rawPerMin = elapsedSec > 0 ? ((discovered / elapsedSec) * 60).toFixed(1) : "0.0";
    console.info(
      `[discovery-sla] plan=${payload.planId} task=${payload.taskId} accepted=${accepted} ` +
        `target=${payload.request?.quantity ?? "n/a"} discovered=${discovered} rejected=${rejected} duplicates=${duplicates} ` +
        `elapsed_ms=${elapsedMs} leads_per_min=${leadsPerMin} raw_per_min=${rawPerMin}`,
    );
    console.log(`FINISHED`);
    if (await observeTerminalPlan()) break outer;
    } // end inner lead loop

    // Break outer search-query loop if plan is satisfied or cancelled
    const { data: afterQuery } = await db.from("discovery_plans")
      .select("delivered_count, requested_count, status").eq("id", payload.planId).maybeSingle();
    if (terminalReasonForPlan(afterQuery)) {
      await observeTerminalPlan();
      break;
    }
  } // end outer search-query loop

  // Determine completion reason for metrics.
  const { data: finalPlan } = await db.from("discovery_plans")
    .select("delivered_count, requested_count, status").eq("id", payload.planId).maybeSingle();
  const terminalReason = terminalReasonForPlan(finalPlan);
  // MINIMAL FIX (discovery liveness / city failure classification —
  // forensic audit §9/§10): `engineTerminationReason` (captured from the
  // bridge's onDone callback above) is now threaded into
  // `cityTransitionFor()` so a watchdog kill or scraper failure is never
  // silently folded into `CITY_EXHAUSTED`/`CITY_NO_PROGRESS` just
  // because `exhausted` is `false` on every failed run.
  const cityReason = terminalReason ?? cityTransitionFor(
    { candidatesFound: discovered, acceptedLeads: accepted },
    exhausted,
    engineTerminationReason,
  );
  const shouldRetryTask = !terminalReason && (cityReason === "WATCHDOG_TIMEOUT" || cityReason === "SCRAPER_FAILURE");

  return { discovered, accepted, rejected, duplicates, exhausted, cityReason, terminalReason, shouldRetryTask, pythonPerfData, bridgeTimings, progressMarks, engineTerminationReason };
}

/** Worker Pools B Step 11 — concise, grep-able pool/worker log lines. */
function logAreaPoolEvent(payload: DiscoveryTaskPayload, task: any, event: AreaWorkerLogEvent): void {
  switch (event.type) {
    case "pool_start":
      console.info(
        `[google-area-pool] task=${payload.taskId} city=${task.city} ` +
          `configured=${event.configured} available_areas=${event.availableAreas} ` +
          `capacity=${event.capacity} started=${event.poolSize}`,
      );
      break;
    case "worker_started":
      console.info(`[google-area-worker] task=${payload.taskId} area=${event.area} started`);
      break;
    case "worker_finished":
      console.info(
        `[google-area-worker] task=${payload.taskId} area=${event.area} finished ` +
          `accepted=${event.outcome.accepted} discovered=${event.outcome.discovered} failed=${event.outcome.failed}`,
      );
      break;
    case "worker_skipped_no_slot":
      console.info(`[google-area-pool] task=${payload.taskId} city=${task.city} slot=${event.slot} skipped reason=no_capacity`);
      break;
    case "worker_skipped_no_area":
      console.info(`[google-area-pool] task=${payload.taskId} city=${task.city} skipped reason=no_distinct_area_left`);
      break;
    case "pool_stopped":
      console.info(`[google-area-pool] task=${payload.taskId} city=${task.city} stopped reason=${event.reason}`);
      break;
  }
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
  // the task as running.  If already at cap, skip this task (another user's
  // tasks will be served in the meantime — this is the primary fairness
  // enforcement) and explicitly schedule a fresh check shortly after.
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
      // AUDIT FIX (Finding 3): pg-boss v10 unconditionally marks a job
      // complete whenever its handler resolves without throwing (confirmed
      // directly against the installed pg-boss@10.1.5 source — there is no
      // "resolved but please redeliver" branch). The old comment here
      // ("pg-boss will re-deliver") described behavior pg-boss v10 does not
      // have: a bare `return` permanently completed THIS pg-boss job while
      // the `discovery_tasks` row itself was left "queued" — orphaned, since
      // dispatchQueuedDiscoveryTasks() runs exactly once per plan and no
      // other code path will ever send a job for this row again. That
      // orphaned "queued" row then satisfies completePlanIfDrained()'s
      // in-flight check forever, so the plan (and its scrape_job) could
      // never reach a terminal state. Explicitly schedule a fresh
      // discovery.task job for this same row instead of relying on a
      // redelivery that will never happen.
      const boss = await getBoss();
      await boss.send(
        QUEUES.discoveryTask,
        { taskId: payload.taskId, planId: payload.planId, request: payload.request },
        { ...DISCOVERY_TASK_RETRY_OPTIONS, startAfter: CONCURRENCY_RECHECK_DELAY_SECONDS },
      );
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

  // PHASE 3B — production observability: makes concurrent city/provider
  // overlap visible in Railway logs (not inferable from "code uses async"
  // alone). worker=<short task id> is stable for the lifetime of this
  // claimed task, so start/finish/cancel lines for the same worker can be
  // grepped and correlated across a plan's log lines.
  const workerLabel = payload.taskId.slice(0, 8);
  console.info(
    `[discovery] worker=${workerLabel} started plan=${payload.planId} city=${task.city} ` +
      `country=${task.country_code} niche=${task.niche} source=${task.source ?? "google_maps"}`,
  );

  let planCheck: any;
  {
    const t = profiler.timer("plan_cancellation_check");
    const { data } = await db.from("discovery_plans")
      .select("requested_count, delivered_count, status").eq("id", payload.planId).maybeSingle();
    t.end();
    planCheck = data;
  }
  if (!planCheck || terminalReasonForPlan(planCheck)) {
    await recordTaskOutcome(task, { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, status: planCheck?.status === "cancelled" ? "cancelled" : "completed", startedAt: Date.now(), completionReason: planCheck?.status === "cancelled" ? "USER_CANCELLED" : "TARGET_REACHED", terminationReason: terminalReasonForPlan(planCheck) });
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

  // The plan row is the cross-process authority.  This controller is the
  // local, immediate propagation mechanism: a short poll makes a cancel or
  // target completion stop a Python process even while it is quiet and has
  // not yielded another lead yet.
  const requestAbort = new AbortController();
  const unregisterRequestAbort = registerRequestAbortController(payload.planId, requestAbort);
  const observeTerminalPlan = async (): Promise<RequestTerminalReason | undefined> => {
    const { data } = await db.from("discovery_plans")
      .select("status, delivered_count, requested_count, terminal_reason")
      .eq("id", payload.planId).maybeSingle();
    const reason = terminalReasonForPlan(data);
    if (reason) terminateRequest(payload.planId, reason);
    return reason;
  };
  const terminalPoll = setInterval(() => { void observeTerminalPlan(); }, REQUEST_TERMINAL_POLL_MS);
  terminalPoll.unref?.();

  let discovered = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let exhausted = false;
  const startedAt = Date.now();
  let lastHeartbeat = Date.now();
  // Phase 2: capture perf from Python __done__ sentinel
  let pythonPerfData: Record<string, unknown> | undefined;
  // PHASE 3C-1 STEP 2: bridge transport timings + progress-protocol marks
  // captured from the same onDone callback — see EngineDoneInfo's own doc
  // comments (pythonBridge.ts) for what each field means and the audit
  // finding each one closes.
  let bridgeTimings: EngineDoneInfo["bridgeTimings"];
  let progressMarks: EngineDoneInfo["progressMarks"];
  // MINIMAL FIX (discovery liveness / city failure classification —
  // forensic audit §9/§10): the bridge's own already-computed termination
  // classification (see `EngineDoneInfo.terminationReason` in
  // pythonBridge.ts), captured here so it can be threaded into
  // `cityTransitionFor()` below instead of being discarded at this
  // boundary the way it was before this fix (per the audit's §3/§8 — this
  // is the exact gap it calls out).
  let engineTerminationReason: EngineDoneInfo["terminationReason"];
  // PHASE 3C-4C-B — geographic search rotation. Set below, only for
  // cities with a curated area list (src/lib/geo/cityAreas.ts); stays
  // undefined for the (large majority of) cities without one, which take
  // the exact same single-cluster search path as before this phase.
  let claimedArea: string | undefined;

  try {
    // ── Provider registry routing (Phase 5 Refinement 3) ─────────────────
    // Route through the provider registry instead of calling runEngineQuery
    // directly.  The Google Maps provider wraps runEngineQuery unchanged;
    // future providers plug in here with zero changes to this task handler.
    const sourceId = task.source ?? "google_maps";
    const provider = getProvider(sourceId);
    const generator = getGenerator(sourceId);

    // ── Phase 3C-4C-B / Worker Pools B: curated areas for this city ──────
    const curatedAreas = getAreasForCity(task.country_code, task.city);

    // Worker Pools B — Google Maps area worker pool. STRICT SCOPE: only
    // Google Maps, only cities with curated areas, and only when
    // GOOGLE_MAPS_AREA_WORKERS has been deliberately raised above its
    // conservative default of 1. At the default, this condition is always
    // false and every task takes the EXACT SAME single-area code path as
    // before this phase (Step 1's "safe default must preserve today's
    // behavior" requirement) — including for Google Maps cities that do
    // have curated areas, which still claim exactly one area and run
    // exactly one search, same as always.
    const useGoogleAreaPool = sourceId === "google_maps" && hasCuratedAreas(curatedAreas);

    const attemptCtx = { db, task, payload, profiler, provider, generator, requestAbort, observeTerminalPlan, startedAt };

    let terminalReason: RequestTerminalReason | undefined;
    // Initialized (not just declared) so TS's definite-assignment analysis
    // doesn't complain about the pool branch's assignment happening inside
    // an async callback closure — always overwritten before use either way.
    let cityReason: string = "";
    let poolResult: AreaWorkerPoolResult | undefined;

    if (!useGoogleAreaPool) {
      // ── Legacy / non-pooled path (unchanged behavior) ───────────────────
      // Any provider, any city without curated areas, or a Google Maps
      // city with the default GOOGLE_MAPS_AREA_WORKERS=1.
      if (hasCuratedAreas(curatedAreas)) {
        claimedArea = await claimAreaForCity(db, {
          niche: task.niche,
          countryCode: task.country_code,
          city: task.city,
          source: sourceId,
          areas: curatedAreas,
        });
      }

      // Worker Pools B nested-concurrency safety: even on the legacy
      // (non-pooled) path, a Google Maps browser launch must still acquire
      // a slot from the SAME process-wide semaphore a pooled task's area
      // workers use — see acquireBrowserSlotBlocking()'s own doc comment
      // for exactly why this is required, not optional, once ANY task in
      // this process can fan out to more than one browser. Blocking (not
      // skipping) preserves this path's existing guarantee that a claimed
      // task always gets to run. Non-Google providers are completely
      // unaffected — they never touch this semaphore, matching STRICT
      // SCOPE (Google Maps only).
      const releaseLegacySlot = sourceId === "google_maps"
        ? await acquireBrowserSlotBlocking(getBrowserSlotPool(), { signal: requestAbort.signal })
        : undefined;
      let attempt: AreaAttemptResult;
      try {
        attempt = await runOneAreaAttempt(attemptCtx, claimedArea);
      } finally {
        releaseLegacySlot?.();
      }
      discovered = attempt.discovered;
      accepted = attempt.accepted;
      rejected = attempt.rejected;
      duplicates = attempt.duplicates;
      exhausted = attempt.exhausted;
      pythonPerfData = attempt.pythonPerfData;
      bridgeTimings = attempt.bridgeTimings;
      progressMarks = attempt.progressMarks;
      engineTerminationReason = attempt.engineTerminationReason;
      terminalReason = attempt.terminalReason;
      cityReason = attempt.cityReason;

      // MINIMAL FIX (discovery liveness / city failure classification —
      // forensic audit §9/§10): a watchdog timeout or scraper failure is
      // not genuine exhaustion — it must not consume this city's one
      // scheduling attempt. Route it through the exact same bounded
      // pg-boss retry the `catch (error)` block below already applies to
      // a thrown exception (see `EngineTerminationRetryError`'s own doc
      // comment for why this, rather than a new retry mechanism, is the
      // minimal safe fix).
      if (attempt.shouldRetryTask) {
        throw new EngineTerminationRetryError(
          cityReason as "WATCHDOG_TIMEOUT" | "SCRAPER_FAILURE",
          `engine reported ${cityReason} for city=${task.city} country=${task.country_code} ` +
            `(discovered=${discovered} accepted=${accepted}) — not genuine exhaustion, retrying same city (bounded)`,
        );
      }
    } else {
      // ── Worker Pools B: Google Maps area worker pool ────────────────────
      const browserSlotPool = getBrowserSlotPool();

      poolResult = await runAreaWorkerPool({
        configuredWorkers: env.GOOGLE_MAPS_AREA_WORKERS,
        totalCuratedAreas: curatedAreas.length,
        availableCapacity: browserSlotPool.available(),
        requestedQuantity: payload.request?.quantity,
        claimNextArea: async (usedAreas) => {
          // Reuse the EXISTING claim_discovery_area() atomic claim — never
          // a second area-claim mechanism (Step 3). Two concurrent workers
          // for the same city land on different areas because of that
          // function's own `for update skip locked` clause; `usedAreas`
          // additionally stops THIS task's pool from looping back onto an
          // area it already ran this pass once every curated area has been
          // touched once (Step 9 — no tight-loop re-claim of the same area).
          const claimed = await claimAreaForCity(db, {
            niche: task.niche,
            countryCode: task.country_code,
            city: task.city,
            source: sourceId,
            areas: curatedAreas,
          });
          if (!claimed || usedAreas.has(claimed)) return undefined;
          return claimed;
        },
        runArea: async (area) => {
          // Step 5: a brand-new runOneAreaAttempt() call per area means a
          // brand-new provider.search() stream — a fresh service.py /
          // MapsScraper / Playwright / Chromium process per area, never a
          // shared or reused browser.
          const attempt = await runOneAreaAttempt(attemptCtx, area);

          // Step 10: exactly one terminal accounting update per claimed
          // area, recorded immediately here (independent of any sibling
          // area worker's outcome or of the task-level aggregate below).
          await recordAreaOutcome(db, {
            niche: task.niche,
            countryCode: task.country_code,
            city: task.city,
            area,
            source: sourceId,
            discovered: attempt.discovered,
            accepted: attempt.accepted,
          });

          // Last-writer-wins for the single structured per-task timing log
          // line below — combining multiple Python subprocesses' perf
          // blobs into one meaningful summary is out of scope for this
          // phase (see the final report's "remaining limitations").
          pythonPerfData = attempt.pythonPerfData ?? pythonPerfData;
          bridgeTimings = attempt.bridgeTimings ?? bridgeTimings;
          progressMarks = attempt.progressMarks ?? progressMarks;
          engineTerminationReason = attempt.engineTerminationReason ?? engineTerminationReason;
          cityReason = attempt.cityReason;
          terminalReason = attempt.terminalReason ?? terminalReason;

          // Step 8: a WATCHDOG_TIMEOUT/SCRAPER_FAILURE-classified area run
          // is recorded as a "failed" area for pool bookkeeping — it does
          // NOT throw, so sibling area workers are never affected. Only if
          // literally every area this pool ran ends up failed does the
          // pool as a whole propagate a retry below (Step 9: preserve
          // existing task-level retry semantics for the task itself,
          // rather than inventing a second retry mechanism).
          if (attempt.shouldRetryTask) {
            console.warn(
              `[google-area-worker] task=${payload.taskId} area=${area} terminal_reason=${attempt.cityReason} ` +
                `— treated as a failed area for pool bookkeeping (siblings unaffected)`,
            );
          }

          return {
            discovered: attempt.discovered,
            accepted: attempt.accepted,
            rejected: attempt.rejected,
            duplicates: attempt.duplicates,
            exhausted: attempt.exhausted,
            failed: attempt.shouldRetryTask,
          };
        },
        tryAcquireSlot: () => browserSlotPool.tryAcquire(),
        isTerminal: async () => {
          const { data } = await db.from("discovery_plans")
            .select("status, delivered_count, requested_count").eq("id", payload.planId).maybeSingle();
          return Boolean(terminalReasonForPlan(data));
        },
        onEvent: (event) => logAreaPoolEvent(payload, task, event),
      });

      discovered = poolResult.totals.discovered;
      accepted = poolResult.totals.accepted;
      rejected = poolResult.totals.rejected;
      duplicates = poolResult.totals.duplicates;
      // Best-effort aggregate: "exhausted" is only meaningful per-area;
      // the task-level metrics field below treats the whole pool as
      // exhausted only if every area that ran reported exhaustion.
      exhausted = poolResult.perArea.length > 0 && poolResult.perArea.every((p) => p.outcome.exhausted);

      if (poolResult.allFailed) {
        // Preserve existing task-level retry semantics (Step 9) — this is
        // the SAME bounded pg-boss retry path a thrown exception already
        // takes below, not a new mechanism. claimedArea is intentionally
        // left undefined here (each area already recorded its own outcome
        // above), so the catch block's `if (claimedArea)` recordAreaOutcome
        // call is correctly skipped — no double-counting.
        throw new EngineTerminationRetryError(
          "SCRAPER_FAILURE",
          `google area pool: all ${poolResult.perArea.length} area worker(s) failed for ` +
            `task=${payload.taskId} city=${task.city} (areas=${poolResult.areasProcessed.join(",")})`,
        );
      }

      const { data: finalPlanAfterPool } = await db.from("discovery_plans")
        .select("delivered_count, requested_count, status").eq("id", payload.planId).maybeSingle();
      terminalReason = terminalReasonForPlan(finalPlanAfterPool);
      cityReason = terminalReason
        ?? (cityReason || (poolResult.perArea.length === 0 ? "CITY_NO_PROGRESS" : "CITY_EXHAUSTED"));
    }

    const completionReason: string = cityReason;
    console.info(`[discovery-city] CITY_FINISHED city=${task.city} country=${task.country_code} elapsed_ms=${Date.now() - startedAt} candidates_found=${discovered} accepted=${accepted} rejected=${rejected} reason=${cityReason}`);

    // PHASE 3C-1 STEP 2 — ONE structured timing line per task (not
    // per-anchor — see this phase's own "do NOT spam logs with per-anchor
    // timing" constraint). Uses the existing progress/diagnostic
    // mechanism (console.info, matching every other `[discovery...]`
    // summary line in this file) rather than a new sink. task_start is
    // always 0 by construction (every other timestamp here is already
    // ms-since-spawn/ms-since-task-start); task_end is this task
    // attempt's own wall-clock runtime. Marks the bridge/engine never
    // reported (e.g. a run that failed before navigation) are simply
    // absent, not synthesized. For a Google area pool, these fields
    // reflect the LAST area worker to finish, not a merge of every area
    // (see the final report's "remaining limitations").
    const marks = progressMarks ?? {};
    console.info(
      `[discovery-timing] plan=${payload.planId} task=${payload.taskId} city=${task.city} ` +
        `country=${task.country_code} niche=${task.niche} provider=${task.source ?? "google_maps"} ` +
        `attempt=${currentAttempt} retry_count=${currentAttempt - 1} candidates_seen=${discovered} ` +
        `candidates_yielded=${discovered - rejected} accepted=${accepted} terminal_reason=${cityReason} ` +
        `task_start_ms=0 python_spawn_ms=${bridgeTimings?.spawnMs?.toFixed(0) ?? "n/a"} ` +
        `first_engine_output_ms=${bridgeTimings?.firstLineMs?.toFixed(0) ?? "n/a"} ` +
        `maps_navigation_start_ms=${marks["discovery:maps_navigation_start"]?.toFixed(0) ?? "n/a"} ` +
        `maps_navigation_complete_ms=${marks["discovery:maps_navigation_complete"]?.toFixed(0) ?? "n/a"} ` +
        `panel_resolved_ms=${marks["discovery:panel_resolved"]?.toFixed(0) ?? "n/a"} ` +
        `first_candidate_discovered_ms=${marks["discovery:candidate_discovered"]?.toFixed(0) ?? "n/a"} ` +
        // Node-level acceptance (post validation/channel-gate/deliverLead,
        // set at the profiler.mark("first_lead_delivered") call above) is
        // the semantically correct "first candidate ACCEPTED" instant;
        // the engine's own "candidate_queued" mark (survived Maps-side
        // dedup, before Node's gates) is a fallback for a run that never
        // reached an accepted lead, so the row still shows how far it got.
        `first_candidate_accepted_ms=${profiler.getMarkMs("first_lead_delivered")?.toFixed(0) ?? marks["discovery:candidate_queued"]?.toFixed(0) ?? "n/a"} ` +
        `task_end_ms=${Date.now() - startedAt}`,
    );

    const totalDurationMs = Date.now() - startedAt;
    const firstLeadMs = profiler.getMarkMs("first_lead_delivered") ?? "n/a";
    console.info(
      `[discovery-summary] plan=${payload.planId} task=${payload.taskId} firstLeadMs=${firstLeadMs} ` +
        `totalDurationMs=${totalDurationMs} newForUser=${accepted} rawCandidates=${discovered} ` +
        `duplicates=${duplicates} rejected=${rejected} failed=${poolResult?.allFailed ? 1 : 0} ` +
        `areasUsed=${poolResult?.areasProcessed.length ?? (claimedArea ? 1 : 0)} ` +
        `maxConcurrentAreas=${poolResult?.poolSize ?? 1} maxConcurrentBrowsers=${getBrowserSlotPool().capacity}`,
    );

    await recordTaskOutcome(task, { discovered, accepted, rejected, duplicates, exhausted, status: terminalReason === "USER_CANCELLED" ? "cancelled" : "completed", startedAt, completionReason, terminationReason: cityReason });
    // PHASE 3C-4C-B: record this claimed area's outcome — a separate
    // dimension on the SAME kind of counters as the city-level table
    // above, not a second incompatible definition of "productive"
    // (requirement §7). No-op for the majority of cities with no curated
    // area list (claimedArea stays undefined for those), AND for the
    // Worker Pools B pool path (each area already recorded its own
    // outcome individually above — see Step 10).
    if (claimedArea) {
      await recordAreaOutcome(db, {
        niche: task.niche,
        countryCode: task.country_code,
        city: task.city,
        area: claimedArea,
        source: task.source ?? "google_maps",
        discovered,
        accepted,
      });
    }

    // Phase 7: accumulate discovery metrics for this task into the plan's metrics row.
    incrementDiscoveryMetrics(payload.planId, {
      businessesDiscovered: discovered,
      duplicateCount: duplicates,
      searchExhaustionReason: exhausted ? completionReason : undefined,
    });

    await completePlanIfDrained(payload.planId);
    // Advance only after recording this city's measurable outcome. A
    // productive city has consumed its full bounded scan; the per-plan
    // unique task is the request-scoped city memory that prevents repeats.
    if (!terminalReason) await dispatchQueuedDiscoveryTasks(payload.planId, payload.request);
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
    // PHASE 3C-4C-B: still record whatever partial outcome this claimed
    // area produced before the crash — mirrors record_discovery_location_outcome
    // being recorded unconditionally (success or error) at the city level.
    if (claimedArea) {
      await recordAreaOutcome(db, {
        niche: task.niche,
        countryCode: task.country_code,
        city: task.city,
        area: claimedArea,
        source: task.source ?? "google_maps",
        discovered,
        accepted,
      });
    }

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
    clearInterval(terminalPoll);
    unregisterRequestAbort();
    // Phase 2: attach Python perf and print the TS-side report
    if (pythonPerfData) profiler.attachPythonPerf(pythonPerfData);
    profiler.printReport({
      query: task?.niche ?? "",
      city: task?.city ?? "",
      delivered: accepted,
      requested: task?.candidate_budget ?? 0,
      queueWaitMs: queueWaitMs,
      // PHASE 3C-1 STEP 2 — AUDIT FIX: printReport() has accepted these
      // three fields since Phase 2, but nothing ever supplied them (see
      // EngineDoneInfo.bridgeTimings's own doc comment) — they were
      // computed in pythonBridge.ts and only ever reached a single
      // console.log line there, never this report.
      spawnMs: bridgeTimings?.spawnMs,
      firstLineMs: bridgeTimings?.firstLineMs ?? undefined,
      firstLeadMs: bridgeTimings?.firstLeadMs ?? undefined,
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
    terminationReason?: string;
  },
) {
  const runtimeMs = Date.now() - outcome.startedAt;
  console.info(
    `[discovery] worker=${String(task.id).slice(0, 8)} finished plan=${task.plan_id} city=${task.city} ` +
      `status=${outcome.status} reason=${outcome.terminationReason ?? outcome.completionReason} ` +
      `accepted=${outcome.accepted} runtime_ms=${runtimeMs}`,
  );
  const taskSummary = {
    discovered: outcome.discovered,
    accepted: outcome.accepted,
    rejected: outcome.rejected,
    duplicates: outcome.duplicates,
    exhausted: outcome.exhausted,
    runtime_ms: runtimeMs,
    completion_reason: outcome.completionReason,
    termination_reason: outcome.terminationReason ?? outcome.completionReason,
  };

  await db.from("discovery_tasks").update({
    status: outcome.status,
    discovered_count: outcome.discovered,
    accepted_count: outcome.accepted,
    rejected_count: outcome.rejected,
    error: outcome.error ?? null,
    productive: outcome.accepted > 0,
    last_attempt_at: new Date().toISOString(),
    termination_reason: outcome.terminationReason ?? outcome.completionReason,
    task_summary: taskSummary,
    completed_at: outcome.status === "completed" || outcome.status === "failed" || outcome.status === "cancelled" ? new Date().toISOString() : null,
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
