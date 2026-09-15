import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import type { EngineLead, EngineDoneInfo } from "../scraperBridge/pythonBridge.js";
import { deliverLead, type DeliveryResult } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { resolveCountriesForSelection, CountryRotation } from "../lib/geo/regions.js";
import type { CountryInfo } from "../lib/geo/countries.js";
import { PipelineTracer } from "../lib/pipelineTrace.js";
import { createStreetLifecycleTracer, emitRunSummary, type StreetLifecycleTracer } from "../lib/streetLifecycleTrace.js";
import { registerRequestAbortController, terminateRequest, isRequestActive } from "../discovery/requestLifecycle.js";
// AREA POOL FIX (issue 3): poolExpandJob is what actually runs for
// Starter/Pro/Premium plans (instant_pool/instant_pool_ranked — this is
// the "N newForUser" job the production log referred to) — the
// discoveryPlanJob.ts task queue only runs for discoveryMode==="live"
// plans. Because this file called runEngineQuery() directly, once per
// city, sequentially, it never went anywhere near runAreaWorkerPool() —
// hence zero [discovery-capacity]/[area-worker-start] lines in the log
// despite GOOGLE_MAPS_AREA_WORKERS being configured. See this file's
// runGoogleAreaPoolForCity() below for the fix: reuses the SAME pool
// primitives discoveryPlanJob.ts's runOneAreaAttempt/handleDiscoveryTask
// wiring already uses, driving the SAME processLead() per-lead pipeline
// (dedup/channels/target semantics untouched — only the query is now
// scoped per curated area, and multiple areas can run concurrently).
import { getAreasForCityOrDefault } from "../lib/geo/cityAreas.js";
import { claimAreaForCity, recordAreaOutcome } from "../discovery/areaRotation.js";
import { runAreaWorkerPool, computeDynamicDiscoveryCapacity, type AreaRunOutcome } from "../discovery/googleAreaPool.js";
// CRITMODE Phase 4 — PART B: same street-discovery primitives
// discoveryPlanJob.ts's task-queue path already uses (claim/heartbeat/
// complete RPC wrappers, unchanged) plus ensureStreetInventory() (PART A —
// the one new addition, gating real inventory population per city). See
// runGoogleAreaPoolForCity() below for the actual pool-path wiring.
import {
  claimDiscoveryStreet,
  completeDiscoveryStreetClaim,
  heartbeatDiscoveryStreetClaim,
  ensureStreetInventory,
  type StreetClaim,
  type StreetScope,
} from "../discovery/streetDiscovery.js";
import { areaStreamTarget, cityStreamTarget, computeAskFor } from "../discovery/roundSizing.js";
import {
  createAreaScanBudgetCoordinator,
  type AreaScanBudgetCoordinator,
} from "../discovery/areaScanBudget.js";
import {
  RunStabilityTracker,
  extractAreaSlaCounters,
  type AreaTelemetryRecorder,
  type AreaTerminationReason,
} from "../discovery/runStabilityTelemetry.js";
import {
  createAreaProductivityState,
  evaluateAreaProductivity,
  evaluateAreaYieldStop,
  recordDeliveredLead,
  recordProductiveActivity,
  recordQualifiedLead,
  recordCandidateQueued,
  recordCandidateRejected,
  admitCandidate,
  closeCandidateTerminal,
  cancelOpenCandidates,
  scopeAreaAbort,
  type AreaProductivityState,
} from "../discovery/areaProductivity.js";
import { getBrowserSlotPool, acquireBrowserSlotBlocking } from "../lib/workerCapacity.js";
import { getResourceCapacity, getResourceWorkerSlotPool, trySharedPidAdmission } from "../lib/resourceCapacity.js";
import { env } from "../config/env.js";
// PAID-TIER LIVE SCRAPING BRIDGE — reuse the EXISTING Task 1 live-event
// infrastructure (event builders + process-local/persisted pub/sub) and
// Task 1's own area-pool-lifecycle translation (worker_started/
// worker_finished -> scout_started/area_started/area_completed), instead
// of inventing a second, parallel event system for this job. See this
// file's own doc comment additions below for exactly where each is used.
import {
  publishDiscoveryLiveEvent,
  candidateDiscoveredEvent,
  candidateRejectedEvent,
  leadDeliveredEvent,
  discoveryCompletedEvent,
  discoveryFailedEvent,
} from "../discovery/liveDiscoveryEvent.js";
import { publishAreaPoolLifecycleEvent } from "./discoveryPlanJob.js";
// CRITMODE — user-scoped target accounting fix: see targetAccounting.ts's
// doc comment for the full production root-cause writeup. Every place
// below that used to compare `delivered` (pool-wide) or a
// `newForUser > 0 ? ... : ...delivered` ternary against `payload.shortfall`
// now goes through these three pure functions instead, so the stop
// condition, the live remaining-need calc, and the reported outcome can
// never independently drift from each other again.
import { remainingTarget, isTargetReached, reportedDelivered } from "../discovery/targetAccounting.js";

/**
 * CRITMODE — "10 requested, 9 shown" bug (see migrations/033 for the full
 * root-cause writeup). Concurrent area workers each deliver leads and each
 * independently write scrape_jobs.results_count off a local snapshot of the
 * shared `newForUser` counter; because these are separate async round
 * trips, a worker whose snapshot was taken EARLIER (a lower value) can
 * still WIN the race and land its write AFTER a later, higher one —
 * silently regressing the counter the frontend is watching. This RPC
 * (migrations/033_bump_scrape_job_results_count.sql) makes the write
 * atomic and order-independent: `results_count` can only ever move up
 * (`GREATEST(existing, p_count)`), so no matter which of several
 * concurrent/out-of-order writes lands last, the column always reflects
 * the true maximum ever reported for this job.
 */
async function bumpResultsCount(jobId: string, count: number): Promise<void> {
  const { error } = await (supabaseAdmin as any).rpc("bump_scrape_job_results_count", {
    p_job_id: jobId,
    p_count: count,
  });
  if (error) throw error;
}

export type PoolExpandFollowUp = {
  userId: string;
  professionSlug: string | null;
  rank: boolean;
  scrapeJobId: string;
  dailyLimit: number;
  monthlyLimit: number;
  /** Requested channels for the user this expand run is following up for — see channelFilter.ts. */
  channels: string[];
};

/**
 * PHASE 3A FIX: gives this followUp run a durable `discovery_plans` row to
 * reserve deliveries against, via the SAME `claim_discovery_delivery()`
 * atomic reservation `discovery.task` (live mode) already uses — see
 * migrations/023_global_request_lifecycle.sql and
 * migrations/024_pool_expand_delivery_reservation.sql.
 *
 * Without this, `deliverLead()` is called with no `discoveryPlanId`, so
 * `insertLeadForUser()` skips the reservation entirely and this run's
 * "have I delivered enough yet" check is nothing but the local `newForUser`
 * JS variable below — which pg-boss redelivering this same job (its own
 * fresh worker, its own fresh `newForUser` starting at 0) can race with,
 * jointly delivering more than `payload.shortfall` actually allows.
 *
 * `get_or_create_pool_expand_plan()` is idempotent per `scrapeJobId`: a
 * redelivered invocation of this same logical job gets back the SAME row
 * (whatever `delivered_count` the first worker has already claimed), not a
 * fresh one — so the durable cap holds across both workers, not just
 * within one.
 *
 * PAID-TIER LIVE SCRAPING BRIDGE — exported so discover.ts can create/get
 * this SAME plan row synchronously, before queuing the follow-up job, so
 * the HTTP response can hand the frontend a real planId to subscribe to
 * immediately. Idempotent per scrapeJobId (see above), so discover.ts's
 * call and this file's own later call always resolve to the identical
 * row/id — never a second plan.
 */
export async function getOrCreatePoolExpandPlanId(followUp: PoolExpandFollowUp, payload: PoolExpandJobPayload): Promise<string> {
  const { data, error } = await (supabaseAdmin as any).rpc("get_or_create_pool_expand_plan", {
    p_scrape_job_id: followUp.scrapeJobId,
    p_user_id: followUp.userId,
    p_niche: payload.niche,
    p_region: payload.region,
    p_channels: followUp.channels ?? [],
    p_currencies: payload.currencies ?? [],
    p_profession_slug: followUp.professionSlug,
    p_requested_count: payload.shortfall,
  });
  if (error) throw error;
  return data as string;
}

export type PoolExpandJobPayload = {
  region: string;
  niche: string;
  shortfall: number;
  /** Target currencies, if any — see src/lib/geo/regions.ts. */
  currencies?: string[];
  /**
   * When present, this expand run is a direct continuation of a specific
   * user's Instant Discovery request that fell short — each newly-
   * discovered business is ALSO delivered to that user (credit-charged,
   * CRM row inserted) under the SAME scrape_job_id the gateway already
   * returned to them.
   *
   * When absent, this only grows the shared pool — used when a shortfall
   * happens but there's no single user to hand results back to fast enough
   * to matter, or for backward compatibility.
   */
  followUp?: PoolExpandFollowUp;
};

/**
 * Grows `businesses` for a region/niche that came up short during an
 * Instant Discovery pool lookup. Runs the same engine as discover.live, via
 * the same bridge.
 *
 * PHASE 5: same per-lead atomic credit check as discoverJob.ts — a
 * followUp run can also be stopped early if the user's limit is reached
 * mid-run (e.g. they started a second search while this one was still
 * backfilling).
 *
 * PRODUCT-QUALITY PASS (this file): same three fixes as discoverJob.ts —
 * see that file's docstring for the full root-cause writeup. Summary:
 *  1. Niches are split (splitNicheQuery) and searched independently (OR),
 *     each tagged via the engine's `niche` param so `businesses.niche`
 *     (and therefore the frontend's "discovered niche" column) is
 *     populated correctly instead of being left blank.
 *  2. `followUp.channels`, when present, is enforced post-enrichment via
 *     channelsSatisfied() before a lead is delivered to that user.
 *  3. The engine is asked for generous headroom per niche/country and the
 *     loop keeps going until `shortfall` is actually met or every
 *     niche/country combination genuinely exhausts (engine
 *     `onDone.exhausted`), instead of stopping after one under-sized
 *     engine call.
 *
 * ARCHITECTURE FIX (this pass): same as discoverJob.ts — `region` is
 * expanded into real countries via resolveCountriesForSelection() (never
 * searched literally), distributed across those countries with
 * CountryRotation so one country can't dominate the pool, and — if
 * `currencies` was provided — narrowed to countries where a discovered
 * business can realistically pay in that currency. `payload.region` is
 * still passed through to deliverLead/pool storage unchanged.
 *
 * PHASE 3A FIX (overshoot correctness): a followUp run used to track its
 * remaining amount ONLY in the local `newForUser` JS variable below,
 * compared against `payload.shortfall`. Since pg-boss can redeliver this
 * job after its expiration window, a second worker could start the same
 * logical work with its own fresh `newForUser` while the first was still
 * delivering, and the two together could jointly exceed `shortfall`. Every
 * followUp delivery is now given a `discoveryPlanId` (see
 * getOrCreatePoolExpandPlanId() below), so it goes through the same
 * durable, atomically-enforced `claim_discovery_delivery()` reservation
 * `discovery.task` (live mode) already used — the local counters below
 * remain as a same-worker fast-path exit, but the actual cap is enforced in
 * Postgres, not in this function's memory.
 */
// CONSUMER-POLICY FIX: see matching comment in discoverJob.ts. Same thrash —
// killing the subprocess the instant the raw fairness `chunk` was reached
// (often 1) — happens here via the identical chunk-consumption pattern, so
// it gets the identical fix: a streaming batch floor decoupled from the
// per-round fairness accounting.
const STREAM_BATCH_FLOOR = 5;

// CRITMODE Phase 4 — PART B: same heartbeat cadence discoveryPlanJob.ts's
// street branch uses for STREET_CLAIM_LEASE_SECONDS (300s) leases — long
// enough not to hammer the RPC, short enough that a crashed worker's lease
// still expires and becomes reclaimable well within one lease window.
const STREET_HEARTBEAT_INTERVAL_MS = 60_000;

// PHASE 12D (still true under PHASE 25): how often each area's own
// adaptive-productivity timer polls the pure evaluateAreaProductivity()
// classifier (see areaProductivity.ts). This is purely a check-frequency
// knob, not a behavioral one — the actual idle/max-runtime windows are
// env.AREA_PRODUCTIVITY_IDLE_MS / env.AREA_PRODUCTIVITY_MAX_RUNTIME_MS.
// Kept small relative to those windows so a stop is detected promptly
// without meaningfully changing when the classifier actually says stop.
const AREA_PRODUCTIVITY_CHECK_INTERVAL_MS = 5_000;

// PHASE 25 — STEP 1/STEP 3 audit result: of the engine's existing
// `"type":"progress"` stdout events (service.py's `_on_progress` /
// MapsScraper's `_emit_progress` — see pythonBridge.ts's EngineProgressEvent),
// only these two are HIGH-CONFIDENCE evidence of a genuinely NEW candidate
// being produced by this area's Maps discovery. Every other existing event
// (`maps_navigation_start`/`maps_navigation_complete`/`panel_resolved` —
// session lifecycle, not per-candidate; `round_scanned` — a scan round
// that may or may not have found anything new, i.e. the "repeated UI/DOM
// polling" case STEP 3 explicitly says must NOT reset the clock;
// `crash_recovered`/`crash_detected` — recovery churn, not forward
// progress) is deliberately EXCLUDED from resetting the productive-activity
// clock. This is the exact fix for the Bronx/Staten Island benchmark
// failure: both were actively emitting `candidate_discovered`/
// `candidate_queued` at the moment the old (qualified-only) clock killed
// them.
const PRODUCTIVE_DISCOVERY_PROGRESS_EVENTS = new Set(["candidate_discovered", "candidate_queued"]);

export async function handlePoolExpandJob(payload: PoolExpandJobPayload): Promise<void> {
  const { followUp } = payload;
  const reqCheckId = followUp?.scrapeJobId;
  if (reqCheckId) {
    // 1. Process-local fast path (protects within same Node worker instance)
    if (isRequestActive(reqCheckId)) {
      console.log(`[poolExpandJob] job reqId=${reqCheckId} is already active in this process — skipping duplicate execution`);
      return;
    }

    // 2. Durable Postgres claim (row lock + heartbeat staleness across Railway worker containers)
    try {
      const { data: claimed, error: claimErr } = await (supabaseAdmin as any).rpc("claim_pool_expand_execution", {
        p_scrape_job_id: reqCheckId,
      });
      if (!claimErr && claimed === false) {
        console.log(`[poolExpandJob] job reqId=${reqCheckId} is already actively owned by another worker process (or terminal) — skipping duplicate execution`);
        return;
      }
    } catch (err) {
      console.warn(`[poolExpandJob] claim_pool_expand_execution check failed (proceeding with fallback):`, err);
    }
  }
  const niches = splitNicheQuery(payload.niche);
  const countries = resolveCountriesForSelection(payload.region, { currencies: payload.currencies });
  const jobStartedAt = Date.now();

  // Phase S1: one PipelineTracer per job run — lives entirely in memory for
  // the lifetime of this call, discarded when it returns. The try/finally
  // below (which now wraps the entire function body, not just the main
  // search loop) guarantees tracer.reconcile() prints no matter how this
  // function ends: normal completion, the early "no countries" return,
  // cancellation, plan-limit abort, search exhaustion, or an uncaught
  // exception propagating out (which still propagates exactly as before —
  // this only adds a diagnostic print, and for followUp runs the existing
  // "mark scrape_jobs failed" behavior in the catch below, before it does).
  const tracer = new PipelineTracer();

  let userPlanLimitHit = false;
  let delivered = 0; // total businesses newly added to the pool (all niches)
  // `newForUser` stays RELATIVE to this invocation — it's compared against
  // `payload.shortfall` below (stillNeededNow / the >= payload.shortfall
  // checks) and reported as this run's own contribution in job_summary, so
  // it must keep starting at 0 each call.
  let newForUser = 0; // of those, how many were credited/delivered to followUp.userId
  // AUDIT FIX (Finding 1/7 — results_count overwriting): `scrape_jobs.results_count`
  // is written as an ABSOLUTE value below (`results_count: resultsCountBase +
  // newForUser`), never as an increment. The old code wrote `results_count:
  // newForUser` directly, which regressed the visible total on ANY second
  // write to this counter — not just a pg-boss retry (a second, independent
  // execution of this whole function), but also the very FIRST invocation,
  // whenever discover.ts's synchronous Instant-Discovery pool lookup had
  // already written `results_count: delivered.length` (e.g. 5) before this
  // background followUp run's first delivery overwrote it with a smaller
  // number (e.g. 1). Seeding `resultsCountBase` from the row's pre-existing
  // count and adding `newForUser` to it on every write fixes both paths.
  let resultsCountBase = 0;

  // AUDIT FIX (Finding 6 — jobs permanently remaining in STREAMING): this
  // function previously had no heartbeat, no stale-task table, and no
  // timeout wrapping its search loop — a crashed/hung invocation left
  // `scrape_jobs.status = 'streaming'` with no code path anywhere that
  // would ever revisit it (confirmed directly against production: 12/34
  // instant_pool_ranked rows stuck this way). Pulsing `last_heartbeat_at`
  // here — the same pattern discovery_tasks/business_processing_tasks
  // already use — lets a scheduled sweep (jobs/staleScrapeJobSweep.ts)
  // distinguish a live-but-slow run from a genuinely crashed one and
  // reclaim the row into a terminal state instead of leaving it stranded.
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // PHASE 3A FIX: resolved once per invocation (not per lead) and handed to
  // every deliverLead() call below via ctx.discoveryPlanId, so this run's
  // deliveries — and any concurrently-running redelivery of the same
  // logical job — share one durable, atomically-enforced target instead of
  // each trusting its own local counter. Stays undefined for bare
  // pool-growth runs (no followUp) — those have no attached user, so
  // insertLeadForUser() never reaches the reservation check anyway.
  let discoveryPlanId: string | undefined;

  // PHASE 5 — TARGET-AWARE DISCOVERY STOPPING (telemetry state).
  // Declared here (outer function scope, not inside the try block) so the
  // `finally` block's summary log below can always read final values,
  // regardless of which exit path the function takes. See
  // logChildTelemetry()'s doc comment (below, inside the try block, where
  // it's constructed) for what each field means.
  let targetReachedAtMs: number | null = null;
  let candidatesAfterParentTarget = 0;
  let mapsOperationsAfterParentTarget = 0;
  let maxTargetStopLatencyMs = 0;

  // PHASE 10 — RUN-TO-RUN STABILITY TELEMETRY. One tracker per job
  // invocation; see runStabilityTelemetry.ts for the pure recording/
  // aggregation logic this just wires up. Declared here (outer function
  // scope) for the same reason as the PHASE 5 telemetry state above: the
  // `finally` block's summary log must be able to read it regardless of
  // which exit path this function takes.
  const stability = new RunStabilityTracker();
  let areasStartedCount = 0;
  const areaWorkerNumbers = new Map<string, number>();

  // PAID-TIER LIVE SCRAPING BRIDGE — mirrors discoveryPlanJob.ts's own
  // `startedScoutSlots` exactly: shared across every runGoogleAreaPoolForCity()
  // call this invocation makes (one per niche/country/city round), so a
  // slot's `scout_started` fires only once for the lifetime of this run,
  // not once per city.
  const startedScoutSlots = new Set<number>();

  try {
    if (followUp) {
      discoveryPlanId = await getOrCreatePoolExpandPlanId(followUp, payload);

      const { data: existingJob } = await supabaseAdmin.from("scrape_jobs")
        .select("results_count")
        .eq("id", followUp.scrapeJobId)
        .maybeSingle();
      resultsCountBase = existingJob?.results_count ?? 0;

      await supabaseAdmin.from("scrape_jobs")
        .update({ status: "streaming", last_heartbeat_at: new Date().toISOString() })
        .eq("id", followUp.scrapeJobId)
        .not("status", "eq", "cancelled");

      heartbeatInterval = setInterval(() => {
        supabaseAdmin.from("scrape_jobs")
          .update({ last_heartbeat_at: new Date().toISOString() })
          .eq("id", followUp.scrapeJobId)
          .eq("status", "streaming")
          .then(
            () => {/* intentionally fire-and-forget */},
            (err: unknown) => console.warn("[poolExpandJob] heartbeat failed", err),
          );
      }, 15_000);
    }

    if (countries.length === 0) {
      console.error(`[poolExpandJob] no countries resolved for region=${JSON.stringify(payload.region)} — nothing to search`);
      if (followUp) {
        await supabaseAdmin.from("scrape_jobs").update({
          status: "completed_partial",
          completed_at: new Date().toISOString(),
          job_summary: { requested: payload.shortfall, delivered: 0, shortfall: payload.shortfall, completion_reason: "no_countries", runtime_ms: 0 },
        }).eq("id", followUp.scrapeJobId);
        // PAID-TIER LIVE SCRAPING BRIDGE — genuine early-terminal exit;
        // still a real, already-computed outcome (no countries to search),
        // not an invented one.
        if (discoveryPlanId) {
          publishDiscoveryLiveEvent(discoveryCompletedEvent(discoveryPlanId, resultsCountBase + newForUser, resultsCountBase + payload.shortfall));
        }
      }
      return;
    }

    const abortController = new AbortController();
    const reqId = discoveryPlanId ?? followUp?.scrapeJobId;
    const unregisterRequestAbort = reqId ? registerRequestAbortController(reqId, abortController) : undefined;

    // The target this run is actually trying to satisfy: for a followUp,
    // that's "give this user `shortfall` more NEW deliveries"; for a bare
    // pool-growth run (no followUp), it's "add `shortfall` more businesses
    // to the pool" — there's no per-user channel filter to apply in that
    // case, so every delivered (deduped) business counts.
    //
    // NOTE: `target` is used for BOTH (a) the area worker pool's
    // concurrency sizing (`requestedQuantity` → computeDynamicDiscoveryCapacity
    // — unchanged, worker COUNT is untouched by this phase) and (b) — as
    // of PHASE 10 — each child's own `deliver_target`/`askFor` scan budget
    // (askFor/streamTarget below). `stillNeededNow()` (the live, shrinking
    // remaining) is still used to decide WHETHER to start another
    // round/area at all, and to stop already-running siblings the instant
    // it hits zero — see roundSizing.ts's doc comment for why the two
    // concerns (how much to ask a child for vs. when to stop asking) are
    // deliberately decoupled.
    const target = payload.shortfall;

    // ROOT CAUSE FIX (CRITMODE — user-scoped target accounting bug): see
    // targetAccounting.ts for the full writeup. Every caller below that
    // asks "how many more do we still need" goes through this single pure
    // function so it can never independently disagree with the stop
    // condition in processLead() (which uses isTargetReached() from the
    // same module).
    const stillNeededNow = () => remainingTarget({ shortfall: payload.shortfall, delivered, newForUser, hasFollowUp: Boolean(followUp) });

    // PHASE 5 — TARGET-AWARE DISCOVERY STOPPING (telemetry).
    //
    // `targetReachedAtMs` is set the instant the GLOBAL (parent) target is
    // satisfied — see processLead() below, the exact point that already
    // calls abortController.abort("TARGET_REACHED"). Every engine
    // subprocess's onDone callback (legacy path and area-pooled path,
    // below) reads this to tell "this child's own natural completion" apart
    // from "this child was still mid-flight when the parent's target was
    // already met elsewhere, and got torn down because of that" — the
    // latter is exactly the waste this phase targets.
    //
    // These are best-effort production measurements, not a precise
    // per-candidate audit trail: `candidatesAfterParentTarget` sums each
    // stopped child's OWN `maps_candidates_seen` counter (from its
    // `__perf__.area_sla`) — i.e. the total raw Maps candidates that child
    // had scanned by the time it was killed, not strictly only the ones
    // scanned after the abort fired (Python does not timestamp individual
    // candidates). It is therefore an upper bound on in-flight scan waste
    // at the moment of stop, not an exact count. (State vars themselves —
    // targetReachedAtMs/candidatesAfterParentTarget/
    // mapsOperationsAfterParentTarget/maxTargetStopLatencyMs — are declared
    // in the outer function scope above so the `finally` block's summary
    // can read them too.)
    function logChildTelemetry(
      label: string,
      childRequested: number,
      info: { delivered: number; requested: number; perf?: Record<string, unknown> },
    ) {
      const childDelivered = info.delivered;
      const childRemaining = Math.max(0, childRequested - childDelivered);
      const parentTarget = payload.shortfall;
      const parentDelivered = delivered;
      const parentRemaining = Math.max(0, parentTarget - parentDelivered);
      const areaSla = (info.perf?.area_sla ?? {}) as Record<string, unknown>;
      const mapsCandidatesSeen = typeof areaSla.maps_candidates_seen === "number" ? areaSla.maps_candidates_seen : undefined;

      let stopLine = "";
      if (targetReachedAtMs !== null) {
        const discoveryStopAtMs = Date.now();
        const targetStopLatencyMs = discoveryStopAtMs - targetReachedAtMs;
        maxTargetStopLatencyMs = Math.max(maxTargetStopLatencyMs, targetStopLatencyMs);
        mapsOperationsAfterParentTarget += 1;
        if (typeof mapsCandidatesSeen === "number") candidatesAfterParentTarget += mapsCandidatesSeen;
        stopLine =
          ` stop_signal_at_ms=${targetReachedAtMs} discovery_stop_at_ms=${discoveryStopAtMs} ` +
          `target_stop_latency_ms=${targetStopLatencyMs} candidates_in_flight_at_stop=${mapsCandidatesSeen ?? "n/a"}`;
      }

      console.log(
        `[poolExpandJob][telemetry] ${label} parent_target=${parentTarget} parent_delivered=${parentDelivered} ` +
          `parent_remaining=${parentRemaining} child_requested=${childRequested} child_delivered=${childDelivered} ` +
          `child_remaining=${childRemaining}${stopLine}`,
      );
    }

    /**
     * One lead's full validate → deliver → dedup/target-check pipeline —
     * extracted VERBATIM (no behavior change) from what used to be the
     * inline body of the single `for await` loop below, so both the
     * legacy sequential path (no curated areas) and the new
     * runGoogleAreaPoolForCity() path (curated areas — multiple engine
     * processes at once) share the exact same dedup/channel/target logic
     * instead of two independently-maintained copies.
     *
     * Returns what the caller should do next:
     *  - "continue": process the next lead (rejected/duplicate/nothing to stop for)
     *  - "batch_done": this engine process has delivered its streaming
     *    batch — caller ends ITS OWN `for await` (moves to the next round
     *    in the legacy path; lets the area worker claim a new area in the
     *    pooled path)
     *  - "stop_outer": target reached / user cancelled / plan limit hit —
     *    caller must stop EVERYTHING (both paths already called
     *    terminateRequest()/abortController.abort() before returning this,
     *    exactly as the original inline code did, so concurrent pooled
     *    areas stop too)
     *
     * Any error deliverLead() throws still propagates out of this
     * function exactly as before — the legacy path's own `for await`
     * remains uncaught (bubbles to this function's outer catch, which
     * marks the job failed, same as always); the pooled path relies on
     * runAreaWorkerPool's own per-area try/catch (Step 8 — one area's
     * failure isolated from its siblings), consistent with how
     * discoveryPlanJob.ts's own pooled path already treats a per-lead
     * failure inside one area.
     */
    async function processLead(
      lead: EngineLead,
      streamTarget: number,
      chunk: { deliveredThisChunk: number },
      areaRecorder?: AreaTelemetryRecorder,
      // PHASE 12D: only supplied by the area-pooled path (runGoogleAreaPoolForCity
      // below) — the legacy sequential (no curated areas) path is
      // intentionally untouched by this phase, exactly as the phase prompt
      // scopes it ("isolating this change").
      productivity?: AreaProductivityState,
      // CRITMODE — diagnostics only: optional per-street counters/marks,
      // supplied ONLY by the street-pooled path's runArea() below. Every
      // call here is a plain side-effecting callback whose return value is
      // never consulted — it cannot influence delivery, dedup, or target
      // accounting.
      streetDiagnostics?: { onDelivered: () => void; onNewForUser: () => void },
      // PAID-TIER LIVE SCRAPING BRIDGE — 1-indexed scout identity + real
      // area/street label for this lead's live events, supplied by the
      // caller (runArea() below, via areaWorkerNumbers — the SAME map
      // populated by the onEvent worker_started handler's `event.slot + 1`,
      // never re-derived). `undefined` on the legacy sequential (no curated
      // areas) path, normalized to scout 1 below — mirrors
      // discoveryPlanJob.ts's runOneAreaAttempt's `effectiveScoutId = scoutId ?? 1`.
      liveEventCtx?: { scoutId?: number; areaLabel?: string },
    ): Promise<"continue" | "batch_done" | "stop_outer"> {
      const pid = tracer.receive(lead._pipeline_id, lead.name);
      const effectiveScoutId = liveEventCtx?.scoutId ?? 1;
      const eventAreaLabel = liveEventCtx?.areaLabel;
      // PHASE 10 telemetry: every lead the engine yields counts as a
      // "candidate seen" for this area, regardless of what happens to it
      // next — and whether email/instagram are present on arrival is
      // recorded here, BEFORE any validation/delivery logic runs, so it's
      // a pure observation and never changes what gets delivered (item 5:
      // no quality/qualification semantics change).
      areaRecorder?.recordCandidateSeen({ hasEmail: Boolean(lead.email), hasInstagram: Boolean(lead.instagram) });
      // PAID-TIER LIVE SCRAPING BRIDGE — real candidate-admission point,
      // same checkpoint discoveryPlanJob.ts's own candidateDiscoveredEvent
      // uses (pid assigned, before any validation/rejection decision).
      // Only emitted for a real user-facing followUp run — see this file's
      // onEvent wiring above for the matching gate/comment.
      if (discoveryPlanId) {
        publishDiscoveryLiveEvent(candidateDiscoveredEvent(discoveryPlanId, effectiveScoutId, pid, lead.name, eventAreaLabel));
      }
      try {
        if (followUp && !channelsSatisfied(lead, followUp.channels)) {
          tracer.reject(pid, `channel_filter:${JSON.stringify(followUp.channels)}`);
          if (productivity) recordCandidateRejected(productivity);
          if (discoveryPlanId) {
            publishDiscoveryLiveEvent(
              candidateRejectedEvent(discoveryPlanId, effectiveScoutId, pid, `channel_filter:${JSON.stringify(followUp.channels)}`, eventAreaLabel),
            );
          }
          return "continue"; // doesn't satisfy every requested channel for the waiting user — not counted
        }

        const validation = validateLead(lead);
        if (!validation.valid) {
          console.log(`[poolExpandJob] skipping invalid lead name=${JSON.stringify(lead.name)} reason=${validation.reason}`);
          tracer.reject(pid, `validation:${validation.reason}`);
          if (productivity) recordCandidateRejected(productivity);
          if (discoveryPlanId) {
            publishDiscoveryLiveEvent(
              candidateRejectedEvent(discoveryPlanId, effectiveScoutId, pid, `validation:${validation.reason}`, eventAreaLabel),
            );
          }
          return "continue";
        }

        // CRITMODE FIX: disqualified candidates (lead.is_disqualified)
        // must never reach deliverLead() — no leads row, no target
        // increment, no credit consumption. Mirrors
        // validateDiscoveryCandidate()'s existing gate in
        // discoveryPlanJob.ts, applied here at the same point in the
        // pipeline (right before delivery), since this file's own
        // validateLead() doesn't check disqualification.
        if (lead.is_disqualified) {
          console.log(`[poolExpandJob] skipping disqualified lead name=${JSON.stringify(lead.name)}`);
          tracer.reject(pid, "disqualified");
          if (productivity) recordCandidateRejected(productivity);
          if (discoveryPlanId) {
            publishDiscoveryLiveEvent(candidateRejectedEvent(discoveryPlanId, effectiveScoutId, pid, "disqualified", eventAreaLabel));
          }
          return "continue"; // not counted, keep streaming
        }

        // PHASE 10 telemetry: reaching here means this lead already
        // passed the engine's own strict qualification gate (website+
        // email+phone+instagram, enforced via `required_channels`/
        // `deliver_target` server-side) AND this run's own channel/format
        // checks above — i.e. "qualified" in the run-stability sense.
        // Purely observational; does not gate anything below.
        areaRecorder?.recordQualified();
        // PHASE 12D: same "this lead qualified" observation point, feeding
        // the adaptive area-productivity classifier instead of (or as well
        // as) the run-stability telemetry above — also purely observational,
        // does not gate anything below, and does not change qualification.
        if (productivity) recordQualifiedLead(productivity);

        tracer.transition(pid, "DATABASE_INSERT_STARTED");
        let result: DeliveryResult;
        try {
          result = await deliverLead(
            lead,
            {
              userId: followUp?.userId ?? null,
              professionSlug: followUp?.professionSlug ?? null,
              discoveryMode: followUp?.rank ? "instant_pool_ranked" : "instant_pool",
              scrapeJobId: followUp?.scrapeJobId ?? "",
              dailyLimit: followUp?.dailyLimit,
              monthlyLimit: followUp?.monthlyLimit,
              // PHASE 3A FIX: routes this delivery through the same
              // atomic claim_discovery_delivery() reservation
              // discovery.task (live mode) uses — see
              // getOrCreatePoolExpandPlanId() above. undefined for
              // bare pool-growth runs (no followUp), matching
              // insertLeadForUser()'s existing "no plan id → no
              // reservation" behavior.
              discoveryPlanId,
            },
            payload.region,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          tracer.fail(pid, `deliverLead threw: ${message}`);
          console.error(`[poolExpandJob] [trace] ${JSON.stringify(lead.name)} \u2193 FAILED — deliverLead threw: ${message}`);
          throw err; // preserve existing behavior exactly — propagate, job still fails as before
        } finally {
          // Phase S1: by the time this finally runs, this pipeline id's
          // fate for the database-insert stage is already settled —
          // either FAILED (catch above, about to rethrow) or `result`
          // was assigned and is delivered below. deliverLead() can
          // never leave it open.
        }

        // This file's own semantics (unchanged): a business is
        // considered added to the pool the moment deliverLead()
        // resolves without throwing, regardless of whether THIS
        // followUp user specifically got a new CRM row for it — so
        // that is exactly what DELIVERED tracks here too.
        tracer.transition(pid, "DATABASE_INSERTED");
        tracer.deliver(pid);

        delivered += 1;
        chunk.deliveredThisChunk += 1;
        areaRecorder?.recordDelivered();
        if (productivity) recordDeliveredLead(productivity);
        streetDiagnostics?.onDelivered(); // CRITMODE — diagnostics only
        if (result.wasNewForUser) {
          newForUser += 1;
          streetDiagnostics?.onNewForUser(); // CRITMODE — diagnostics only
          // PAID-TIER LIVE SCRAPING BRIDGE — the authoritative "this user
          // got a new lead" point, mirroring discoveryPlanJob.ts's own
          // `accepted += 1; publishDiscoveryLiveEvent(leadDeliveredEvent(...))`
          // (that file's `accepted`/this file's `newForUser` are the same
          // concept — a genuinely new CRM row for the requesting user).
          if (discoveryPlanId) {
            publishDiscoveryLiveEvent(leadDeliveredEvent(discoveryPlanId, effectiveScoutId, pid, lead.name, eventAreaLabel));
          }
        } else if (discoveryPlanId) {
          // Business was added to (or already existed in) the shared pool,
          // but this specific followUp user already owns it — same real
          // condition, same reason string, discoveryPlanJob.ts's own
          // `duplicate_already_owned_by_user` rejection already uses for
          // the identical DeliveryResult.wasNewForUser===false case.
          publishDiscoveryLiveEvent(
            candidateRejectedEvent(discoveryPlanId, effectiveScoutId, pid, "duplicate_already_owned_by_user", eventAreaLabel),
          );
        }

        if (followUp) {
          // Guard: if the job was cancelled while we were running, stop.
          const { data: jobStatus } = await supabaseAdmin.from("scrape_jobs")
            .select("status").eq("id", followUp.scrapeJobId).maybeSingle();
          if (jobStatus?.status === "cancelled") {
            if (reqId) terminateRequest(reqId, "USER_CANCELLED");
            abortController.abort("USER_CANCELLED");
            return "stop_outer";
          }

          // CRITMODE FIX: was a plain unconditional `.update({ results_count:
          // resultsCountBase + newForUser })`, which lets an out-of-order
          // (stale, lower) write from a slower concurrent area worker
          // overwrite a fresher (higher) one that already landed — see
          // bumpResultsCount()'s doc comment / migrations/033 for the full
          // root-cause writeup. This is the exact place the 10th
          // newForUser lead's progress could get silently erased from
          // what the frontend displays, even though the lead itself was
          // correctly persisted and charged.
          await bumpResultsCount(followUp.scrapeJobId, resultsCountBase + newForUser);

          if (result.limitReached) {
            console.log(`[poolExpandJob] user=${followUp.userId} hit their plan limit mid-run — stopping early`);
            userPlanLimitHit = true;
            // Same real reason string discoveryPlanJob.ts's own
            // `delivery.limitReached` branch already uses for the
            // identical DeliveryResult field.
            if (discoveryPlanId) {
              publishDiscoveryLiveEvent(candidateRejectedEvent(discoveryPlanId, effectiveScoutId, pid, "plan_limit_reached", eventAreaLabel));
            }
            if (reqId) terminateRequest(reqId, "EXHAUSTED");
            abortController.abort("EXHAUSTED");
            return "stop_outer";
          }

          // ROOT CAUSE FIX (CRITMODE — user-scoped target accounting bug):
          // this is the exact accounting bug from the production incident
          // (parent_delivered=10, newForUser=9, frontend correctly showed
          // 9 — but the run had already stopped). The old `|| delivered >=
          // payload.shortfall` clause let the pool-wide (non-user-scoped)
          // counter satisfy a followUp run's target on its own — so the
          // moment 10 businesses had been added to the pool (one of which
          // this user already owned, i.e. wasNewForUser=false and no
          // target slot consumed by design — see insertLeadForUser()),
          // the run stopped one genuinely-new lead short of what the user
          // actually requested. isTargetReached() (targetAccounting.ts)
          // now enforces: for a followUp run the ONLY thing that can
          // satisfy "the requested target has been reached" is
          // `newForUser` — the count of NEW user-owned lead records
          // actually prepared for the requesting user. `delivered` (pool
          // growth) is irrelevant to whether THIS user's request is done.
          if (isTargetReached({ shortfall: payload.shortfall, delivered, newForUser, hasFollowUp: true })) {
            targetReachedAtMs = Date.now();
            if (reqId) terminateRequest(reqId, "TARGET_REACHED");
            abortController.abort("TARGET_REACHED");
            return "stop_outer";
          }
        } else if (isTargetReached({ shortfall: payload.shortfall, delivered, newForUser, hasFollowUp: false })) {
          targetReachedAtMs = Date.now();
          if (reqId) terminateRequest(reqId, "TARGET_REACHED");
          abortController.abort("TARGET_REACHED");
          return "stop_outer";
        }

        if (chunk.deliveredThisChunk >= streamTarget) {
          return "batch_done"; // this process has delivered its streaming batch for this round — move on
        }
        return "continue";
      } catch (err) {
        // Phase S1 safety net: catches anything NOT already handled
        // above (e.g. channelsSatisfied()/validateLead() throwing
        // unexpectedly, or the scrape_jobs status read/update
        // failing) so this pipeline id is never left open even for a
        // genuinely unforeseen error. If deliverLead's own catch
        // above already closed it out as FAILED, tracer.fail() here
        // is a safe no-op (first outcome wins, logged, not silently
        // overwritten). Does not change what happens to the job: the
        // existing outer catch (below, at the function level) still
        // marks a followUp job 'failed' and rethrows exactly as
        // before.
        const message = err instanceof Error ? err.message : String(err);
        tracer.fail(pid, `unhandled error while processing lead: ${message}`);
        throw err;
      }
    }

    /**
     * AREA POOL FIX (issue 3): runs runAreaWorkerPool() for one (niche,
     * country, city) round instead of a single sequential runEngineQuery()
     * call, when curated (or default) areas exist for this city — mirrors
     * discoveryPlanJob.ts's handleDiscoveryTask wiring (same
     * computeDynamicDiscoveryCapacity sizing via `requestedQuantity`, same
     * claim_discovery_area/record_discovery_area_outcome calls, same
     * process-wide browser slot semaphore) so `requested=10 →
     * computedWorkers=3 → finalWorkers=3` (when >= 3 areas and >= 3
     * browser slots are available; otherwise the usual area/slot bound
     * applies) actually happens for THIS job type too, not just
     * discovery.task.
     *
     * Returns "stop_outer" if any area's processLead() decided the whole
     * job should stop (target reached / cancelled / limit reached) —
     * every other concurrently-running area already got
     * abortController.abort()'d by processLead() itself by the time this
     * resolves (runAreaWorkerPool awaits every worker before returning).
     */
    async function runGoogleAreaPoolForCity(
      singleNiche: string,
      country: CountryInfo,
      city: string,
      areas: string[],
    ): Promise<"stop_outer" | "continued"> {
      let stopOuter = false;
      const browserPool = getBrowserSlotPool();
      stability.startWave();

      // CRITMODE Phase 4 — PART B: street-first discovery through the REAL
      // production pool path (this function IS the fix — see this file's
      // own header comment / the forensic audit for why the old
      // area-pool-only version of this function was the root cause).
      //
      // Gated on `followUp?.userId` ONLY: street coverage is a genuinely
      // per-user RPC-enforced resource (user_discovery_street_state), and
      // this integration must never manufacture an owner for it — the
      // exact same rule discoveryPlanJob.ts's own street branch already
      // enforces for `task.user_id`. A bare pool-growth run (no followUp)
      // has no real requesting user to scope that state against, so it
      // stays on the existing area path unchanged, exactly as before this
      // phase.
      let streetScope: StreetScope | undefined;
      let streetInventoryCountForCity = 0;
      if (followUp?.userId) {
        const inventoryOutcome = await ensureStreetInventory(supabaseAdmin, country.code, city, {
          countryName: country.name,
        });
        if (inventoryOutcome.mode === "street") {
          streetInventoryCountForCity = inventoryOutcome.count;
          streetScope = {
            userId: followUp.userId,
            niche: singleNiche,
            professionSlug: followUp.professionSlug,
            countryCode: country.code,
            city,
            source: "google_maps",
          };
          console.info(
            `[poolExpandJob][street-discovery] city=${city} country=${country.code} inventory=${inventoryOutcome.count} mode=street`,
          );
        } else {
          console.info(
            `[poolExpandJob][street-discovery] city=${city} country=${country.code} mode=area ` +
              `fallback_reason=${inventoryOutcome.fallbackReason}`,
          );
        }
      }
      const useStreetPool = Boolean(streetScope);
      // Keyed by the street claim's own state_id (the id runAreaWorkerPool's
      // generic claimNextArea/runArea plumbing treats as the opaque "area"
      // string) — same pattern discoveryPlanJob.ts's street branch already
      // uses, so a claim's real street name/key is always resolved through
      // this map, never guessed from the id.
      const streetClaims = new Map<string, StreetClaim>();
      // CRITMODE — diagnostics only: one lifecycle tracer per claimed
      // street (state_id -> tracer), mirroring `streetClaims` exactly.
      // Never read by any decision logic — purely additive.
      const streetLifecycleTracers = new Map<string, StreetLifecycleTracer>();
      const streetWorkerId = `poolExpand:${(followUp?.scrapeJobId ?? reqId ?? "unknown").slice(0, 24)}`;
      // Total distinct claim targets for THIS city, for pool-sizing
      // purposes only (see runAreaWorkerPool's totalCuratedAreas doc
      // comment) — the real street inventory count when street mode is
      // active, the curated/default area list length otherwise. Concurrency
      // WORKER COUNT logic itself (computeDynamicDiscoveryCapacity) is
      // completely unchanged by this phase.
      const totalClaimTargets = useStreetPool ? streetInventoryCountForCity : areas.length;

      // PHASE 32 — AREA SCAN-BUDGET OPTIMIZATION. One shared budget for
      // THIS city's area-pool run (STEP 5: sibling isolation — a fresh
      // coordinator per runGoogleAreaPoolForCity() call, never reused
      // across cities/requests). `streamTargetForCity` is the same fixed
      // value every area in this run already computed independently via
      // `areaStreamTarget(target, STREAM_BATCH_FLOOR)` below — hoisted
      // here once since it does not vary per area. `activeAreaCount`
      // mirrors runAreaWorkerPool's OWN concurrency formula exactly (same
      // inputs, same exported pure function) so the shared budget is split
      // across the actual number of concurrent workers the pool below will
      // start — never guessed independently.
      const streamTargetForCity = areaStreamTarget(target, STREAM_BATCH_FLOOR);
      const activeAreaCount = Math.max(
        1,
        computeDynamicDiscoveryCapacity(
          target,
          totalClaimTargets,
          browserPool.available(),
          env.GOOGLE_MAPS_AREA_WORKERS,
          getResourceCapacity().safeAreaWorkers,
        ),
      );
      const scanBudgetCoordinator: AreaScanBudgetCoordinator = createAreaScanBudgetCoordinator(
        streamTargetForCity,
        {
          multiplier: env.AREA_SCAN_BUDGET_MULTIPLIER,
          minAreaBudgetFactor: env.AREA_SCAN_BUDGET_MIN_FACTOR,
          maxAreaBudgetFactor: env.AREA_SCAN_BUDGET_MAX_FACTOR,
          expansionChunkFactor: env.AREA_SCAN_BUDGET_EXPANSION_FACTOR,
          minExplorationCandidates: env.AREA_SCAN_MIN_EXPLORATION_CANDIDATES,
          productiveMaxFactor: env.AREA_SCAN_PRODUCTIVE_MAX_FACTOR,
          maxProductiveCandidates: env.AREA_SCAN_PRODUCTIVE_MAX_CANDIDATES,
        },
        activeAreaCount,
      );
      console.info(
        `[poolExpandJob][area-scan-budget] city=${city} global_scan_budget=${scanBudgetCoordinator.globalScanBudget} ` +
          `stream_target=${streamTargetForCity} active_area_count=${activeAreaCount}`,
      );

      const result = await runAreaWorkerPool({
        configuredWorkers: env.GOOGLE_MAPS_AREA_WORKERS,
        // Phase 6: resource-aware (cgroup PID/thread) ceiling — see
        // resourceCapacity.ts and discoveryPlanJob.ts's matching call site.
        safeResourceWorkers: getResourceCapacity().safeAreaWorkers,
        totalCuratedAreas: totalClaimTargets,
        availableCapacity: browserPool.available(),
        requestedQuantity: target,
        claimNextArea: async (usedAreas, slotIndex = 0) => {
          if (useStreetPool && streetScope) {
            const slotWorkerId = `${streetWorkerId}-w${slotIndex + 1}`;
            const claim = await claimDiscoveryStreet(supabaseAdmin, streetScope, slotWorkerId, reqId ?? streetWorkerId, slotIndex);
            if (!claim) return undefined;
            if (usedAreas.has(claim.stateId)) {
              throw new Error(`claim_discovery_street returned a duplicate active claim (${claim.stateId})`);
            }
            streetClaims.set(claim.stateId, claim);
            // CRITMODE — diagnostics only: mint this street's own lifecycle
            // tracer the instant its claim RPC resolves (street_claimed).
            // Purely additive bookkeeping — does not affect the claim,
            // pool admission, or anything downstream.
            const tracerHandle = createStreetLifecycleTracer({
              streetKey: claim.streetKey,
              streetName: claim.streetName,
              runId: reqId ?? streetWorkerId,
              workerId: slotWorkerId,
            });
            tracerHandle.markClaimed();
            streetLifecycleTracers.set(claim.stateId, tracerHandle);
            return claim.stateId;
          }
          return claimAreaForCity(supabaseAdmin, {
            niche: singleNiche,
            countryCode: country.code,
            city,
            source: "google_maps",
            areas: areas.filter((a) => !usedAreas.has(a)),
          });
        },
        // PHASE 42A — ROOT-CAUSE FIX: a browser-memory slot alone is not
        // enough. Also require a PID/thread-budget slot from the SAME
        // process-wide semaphore every OTHER concurrently-running area
        // pool (this job's siblings across concurrent poolExpand jobs, and
        // discoveryPlanJob.ts's own area pools) draws from — so this
        // area's start is refused, atomically, once the real cgroup PID
        // budget is exhausted, regardless of how many other invocations
        // are running right now. Both slots are acquired together and
        // released together (all-or-nothing) so a partial acquire never
        // leaks a held slot. See resourceCapacity.ts's
        // initResourceWorkerSlotPool() doc comment for the full writeup.
        tryAcquireSlot: () => {
          const releaseBrowser = browserPool.tryAcquire();
          if (!releaseBrowser) return undefined;
          const releaseResource = getResourceWorkerSlotPool().tryAcquire();
          if (!releaseResource) {
            releaseBrowser();
            return undefined;
          }
          // P0 — SHARED LIVE PID ADMISSION: third gate, re-checks REAL live
          // pids.current (shared process-wide with discoveryPlanJob.ts's own
          // area workers AND with enrichment — see resourceCapacity.ts's
          // trySharedPidAdmission() doc comment) rather than trusting only
          // the static resourceWorkerSlotPool capacity measured once at
          // startup. All three gates are acquired together / released
          // together (all-or-nothing) so a partial acquire never leaks a
          // held slot.
          const sharedPidAdmission = trySharedPidAdmission(env.PIDS_PER_AREA_WORKER, "area_worker");
          if (!sharedPidAdmission.granted) {
            releaseResource();
            releaseBrowser();
            return undefined;
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            sharedPidAdmission.release();
            releaseResource();
            releaseBrowser();
          };
        },
        isTerminal: () => stopOuter || stillNeededNow() <= 0 || abortController.signal.aborted,
        // AREA ADMISSION FIX (small-target over-expansion): gates only
        // whether ANOTHER NEW area gets claimed/started — never touches
        // streamTarget/child_requested/askFor (per-area budget, unchanged),
        // concurrency, or any area already running. Re-evaluates the SAME
        // concurrency-sizing formula used to pick the initial fan-out
        // (`computeDynamicDiscoveryCapacity`), but against the LIVE,
        // shrinking `stillNeededNow()` (this execution path's existing,
        // authoritative remaining-need calc — already followUp/newForUser
        // -aware, see its definition above) instead of the static `target`.
        // For a small request that's mostly satisfied, this naturally
        // shrinks the number of areas worth admitting going forward,
        // without capping/shrinking what any individual admitted area asks
        // for. `isTerminal()` above already covers "fully satisfied" (0
        // areas justified); this only refines "how many areas are
        // justified while > 0 leads are still remaining".
        shouldAdmitNextArea: (usedAreasCount, inFlightAreaCount) => {
          const remaining = stillNeededNow();
          if (remaining <= 0) return false;
          const admissibleAreaCount = computeDynamicDiscoveryCapacity(
            remaining,
            totalClaimTargets,
            browserPool.available(),
            env.GOOGLE_MAPS_AREA_WORKERS,
            getResourceCapacity().safeAreaWorkers,
          );
          // STARVATION FIX: compare against the LIVE in-flight area count,
          // not `usedAreasCount` (usedAreas.size is monotonic — areas ever
          // claimed, never decreasing). Comparing against the monotonic
          // count meant that once `admissibleAreaCount` areas had EVER
          // been claimed, admission stayed refused permanently — even
          // after every one of them finished and 0 workers were running,
          // producing remaining>0 + 0 running + unclaimed areas with no
          // way to ever recover. `inFlightAreaCount` shrinks as areas
          // complete, so admission correctly reopens exactly when live
          // concurrency headroom exists again.
          const admit = inFlightAreaCount < admissibleAreaCount;
          if (!admit) {
            console.info(
              `[poolExpandJob][area-admission] city=${city} used_areas=${usedAreasCount} in_flight=${inFlightAreaCount} ` +
                `parent_remaining=${remaining} admissible_area_count=${admissibleAreaCount} ` +
                `admitting_next_area=false`,
            );
          }
          return admit;
        },
        onEvent: (event) => {
          if (event.type === "worker_started") {
            areasStartedCount += 1;
            areaWorkerNumbers.set(event.area, event.slot + 1);
            if (useStreetPool) {
              const claim = streetClaims.get(event.area);
              console.info(
                `[poolExpandJob][street-discovery] claim city=${city} country=${country.code} ` +
                  `street_key=${claim?.streetKey ?? "unknown"} street_name=${claim?.streetName ?? "unknown"}`,
              );
              console.info(
                `[street-claim] city=${city} street=${claim?.streetName ?? claim?.streetKey ?? "unknown"} worker_slot=worker_${event.slot + 1} result=CLAIMED`,
              );
            }
          }
          if (event.type === "worker_finished" && !useStreetPool) {
            // discovery_area_stats (recordAreaOutcome) is curated-area-
            // specific bookkeeping — street completion state lives
            // entirely in user_discovery_street_state, already written by
            // claimDiscoveryStreet/completeDiscoveryStreetClaim inside
            // runArea() below. Nothing further to persist here in street
            // mode (fall through below to still publish the live event).
            recordAreaOutcome(supabaseAdmin, {
              niche: singleNiche,
              countryCode: country.code,
              city,
              area: event.area,
              source: "google_maps",
              discovered: event.outcome.discovered,
              accepted: event.outcome.accepted,
            }).catch((err) => console.warn(`[poolExpandJob] recordAreaOutcome failed for area=${event.area}`, err));
          }

          // PAID-TIER LIVE SCRAPING BRIDGE — Task 1's own worker_started/
          // worker_finished -> scout_started/area_started/area_completed
          // translation (real slot -> scoutId, real area/street label, real
          // outcome), reused VERBATIM — see publishAreaPoolLifecycleEvent's
          // doc comment in discoveryPlanJob.ts. `discoveryPlanId` is only
          // ever set for a real user-facing followUp run (see
          // getOrCreatePoolExpandPlanId() above); a bare background
          // pool-growth run never has one, so it never reaches this branch
          // — satisfies "only emit for the user-facing follow-up".
          if (discoveryPlanId) {
            publishAreaPoolLifecycleEvent(
              discoveryPlanId,
              startedScoutSlots,
              event,
              (a) => (useStreetPool ? streetClaims.get(a)?.streetName ?? streetClaims.get(a)?.streetKey : a),
            );
          }
        },
        runArea: async (area, slotIndex = 0): Promise<AreaRunOutcome> => {
          // CRITMODE Phase 4 — PART B: resolve this claim's real street
          // (undefined in area mode) once, up front — every place below
          // that needs a human-readable label or the street-scoped query
          // reads from here rather than re-deriving it.
          const streetClaim = useStreetPool ? streetClaims.get(area) : undefined;
          const areaLabel = streetClaim?.streetName ?? area;
          const slotWorkerId = `${streetWorkerId}-w${slotIndex + 1}`;
          // CRITMODE — diagnostics only. `undefined` in area mode (no
          // street claim, no tracer) — every use below is optional-chained
          // so this is a complete no-op outside the street-pool path.
          const streetTrace = streetClaim ? streetLifecycleTracers.get(area) : undefined;
          // CRITMODE — diagnostics only, per-street counters. `raw`/
          // `admitted`/`qualified` are read from the EXISTING `productivity`
          // counters at finalize time below (newlyDiscoveredCount/
          // newlyQueuedCount/qualifiedCount) rather than re-counted here —
          // only `new_for_user`/`delivered` (not tracked per-area anywhere
          // today; the existing `delivered`/`newForUser` vars are job-wide,
          // not per-street) and `enrichment_attempts` (no existing counter
          // at all) are new, purely additive local counters.
          let streetNewForUser = 0;
          let streetDelivered = 0;
          const streetEnrichmentAttemptIds = new Set<string>();
          // CRITMODE PART 2 — diagnostics only. `discovery:panel_failure_retry`
          // events carry no `pipeline_id` (they're per-attempt, not
          // per-candidate), so a plain counter is enough — no dedup Set needed.
          let streetPanelRetryCount = 0;
          let discovered = 0;
          let accepted = 0;
          let rejected = 0;
          let areaExhausted = false;
          const chunk = { deliveredThisChunk: 0 };
          // PHASE 10 FIX (child_requested=5 regression): streamTarget
          // (-> deliver_target, "child_requested" in the telemetry log
          // below) is the fixed, AUTHORITATIVE GLOBAL `target`
          // (`payload.shortfall`) — never `stillNeededNow()`. Giving each
          // area's expensive, freshly-launched Google Maps session a
          // productive target (up to the full request size) — instead of
          // an artificially shrunk one — is what makes that session worth
          // starting at all. Overshoot once the GLOBAL target is actually
          // satisfied is still prevented, independently, by
          // abortController.abort("TARGET_REACHED") in processLead() below
          // (see roundSizing.ts's doc comment for the full writeup).
          const streamTarget = streamTargetForCity;
          // PHASE 41 — REGRESSION FIX: Phase 32's "bounded slice of a
          // shared per-city budget, topped up via a scan-budget expansion
          // grant when a productive area
          // exhausts it" replaced the historical, known-good behavior of
          // giving EVERY area its own full `computeAskFor(streamTarget)`
          // budget (~400 raw `max_results` for streamTarget=100) in ONE
          // `runEngineQuery()` call. That "exhausted slice -> ask for
          // more" pattern forced a SECOND (third, ...) `runEngineQuery()`
          // invocation per area whenever a productive area ran through its
          // initial slice — each one a brand-new Python subprocess, a
          // brand-new Playwright browser session, and a brand-new Google
          // Maps session, none of which reuse the previous invocation's
          // warm state. That repeated cold-start work (not worker count,
          // not RateLimiter, not the Maps scraping logic itself) was the
          // primary throughput regression vs. the ~100 leads/~16 min
          // baseline. Restored: the full historical per-area budget, in
          // ONE shot, exactly as `computeAskFor` has always computed it —
          // no per-area / activeAreaCount division, no expansion loop.
          // `scanBudgetCoordinator` (created above) is kept ONLY for its
          // existing per-city telemetry log line; it is no longer consulted
          // to size or grow this area's `askFor`.
          const askFor = computeAskFor(streamTarget);
          const areaRecorder = stability.startArea(areaLabel, areaWorkerNumbers.get(area) ?? 0, streamTarget);
          let lastPerf: Record<string, unknown> | undefined;
          // PHASE 11.1: the bridge's own termination classification for
          // THIS area's engine invocation (see EngineDoneInfo.terminationReason
          // in pythonBridge.ts) — the authoritative signal for whether this
          // area completed normally, was stopped mid-flight, or failed.
          // `doneInfoReceived` distinguishes "we got a completion callback
          // with no fresh telemetry in it" (parent_pool_cache-eligible)
          // from "we never got a completion callback at all" (unknown).
          let lastTerminationReason: AreaTerminationReason | undefined;
          let doneInfoReceived = false;
          // CRITMODE — diagnostics only: the raw EngineDoneInfo from the
          // most recent onDone callback, read (never re-measured) by
          // streetTrace.finalize() below for its bridgeTimings/progressMarks.
          let lastDoneInfoForTrace: EngineDoneInfo | undefined;

          // PHASE 12D — HYBRID ADAPTIVE AREA STOPPING (PHASE 25: upgraded
          // to key off PRODUCTIVE ACTIVITY, not just qualified leads — see
          // areaProductivity.ts's module doc comment for the full writeup).
          //
          // `productivity` is this area's own live state (startedAt/
          // firstQualifiedAt/lastQualifiedAt/qualifiedCount/deliveredCount/
          // stoppedReason/lastProductiveActivityAt/lastProductiveEventType —
          // see areaProductivity.ts). `areaAbort` scopes
          // cancellation to THIS area only: its `signal` is what gets
          // passed to runEngineQuery() below (NOT the shared job-level
          // `abortController.signal` directly) so that aborting it SIGTERMs
          // only this area's own engine subprocess. It still aborts
          // automatically whenever the shared `abortController` aborts
          // (TARGET_REACHED/USER_CANCELLED/EXHAUSTED — see
          // scopeAreaAbort()'s doc comment), so the existing global abort
          // path is completely unchanged; this is purely an ADDITIONAL,
          // narrower way for a single area to stop early.
          const productivity = createAreaProductivityState();
          const { signal: areaSignal, controller: areaAbort } = scopeAreaAbort(abortController.signal);
          // PHASE 5B-2 — candidate-level lifecycle accounting (Phase 5B-1
          // audit fix). `inFlightPipelineIds` / `terminalPipelineIds` are
          // THIS area's own identity-based tracking, keyed by `pipeline_id`
          // (the engine's stable per-candidate correlation key). They exist
          // ALONGSIDE `productivity.inFlightCount`/`terminalCandidateCount`
          // (unchanged arithmetic: newlyDiscoveredCount - terminalCandidateCount)
          // — these two Sets are what make the increments feeding that
          // arithmetic CORRECT (each candidate admitted at most once, closed
          // terminal at most once), not a replacement for it. See
          // `admitPipelineId`/`closeCandidateTerminal` below.
          const inFlightPipelineIds = new Set<string>();
          const terminalPipelineIds = new Set<string>();
          // PHASE 25: shared limits object — see areaProductivity.ts's
          // AreaProductivityLimits and env.ts for where these two knobs
          // come from and why their defaults are safe.
          const productivityLimits = {
            productiveIdleMs: env.AREA_PRODUCTIVITY_IDLE_MS,
            maxAreaRuntimeMs: env.AREA_PRODUCTIVITY_MAX_RUNTIME_MS,
            // PHASE 45 — bounds how long the primary idle timeout may defer
            // while state.inFlightCount > 0 (see areaProductivity.ts's
            // withinBoundedInFlightGrace doc comment). Deliberately the
            // SAME env knob evaluateAreaYieldStop already uses below, so
            // there is one shared, single-source-of-truth in-flight grace
            // window per area, not two independently-tuned ones.
            inFlightGraceMs: env.AREA_YIELD_INFLIGHT_GRACE_MS,
          };
          // PHASE 30: a SEPARATE, independent check from productivityLimits
          // above — see areaProductivity.ts's classifyAreaYield doc comment
          // for why an idle-safe (still busy) area can nonetheless be
          // low-yield and worth rotating out.
          const yieldLimits = {
            minElapsedMsForEvaluation: env.AREA_YIELD_MIN_ELAPSED_MS,
            minCandidateVolumeForEvaluation: env.AREA_YIELD_MIN_CANDIDATE_VOLUME,
            lowYieldMaxRate: env.AREA_YIELD_LOW_MAX_RATE,
            marginalMaxRate: env.AREA_YIELD_MARGINAL_MAX_RATE,
            inFlightGraceMs: env.AREA_YIELD_INFLIGHT_GRACE_MS,
          };

          const productivityTimer = setInterval(() => {
            if (areaAbort.signal.aborted) return;
            const now = Date.now();
            // PHASE 25's idle/max-runtime check still runs FIRST and
            // unconditionally — precedence is unchanged (STEP 4 of the
            // Phase 25 prompt). Only if it says "keep going" do we ALSO
            // check the PHASE 30 / PHASE 36 yield classifier — an area that failed
            // the idle/max-runtime check was already going to stop for
            // that reason regardless of its yield.
            const stopReason = evaluateAreaProductivity(productivity, now, productivityLimits)
              ?? evaluateAreaYieldStop(productivity, now, yieldLimits);
            if (!stopReason) return;
            productivity.stoppedReason = stopReason;
            // PHASE 25 STEP 8 (extended PHASE 30 / PHASE 36) — observational-only
            // telemetry. Never gates anything above; only describes why the
            // stop already happened.
            const candidateVolume = productivity.newlyDiscoveredCount + productivity.newlyQueuedCount;
            const yieldCount = Math.max(productivity.qualifiedCount, productivity.deliveredCount);
            const inFlightCount = productivity.inFlightCount;
            const terminalCount = productivity.terminalCandidateCount;
            const yieldRate = terminalCount > 0
              ? (yieldCount / terminalCount).toFixed(3)
              : (candidateVolume > 0 ? (yieldCount / candidateVolume).toFixed(3) : "n/a");

            console.info(
              `[poolExpandJob][area-productivity] area=${area} stop_reason=${stopReason} ` +
                `qualified=${productivity.qualifiedCount} delivered=${productivity.deliveredCount} ` +
                `candidate_count=${productivity.newlyDiscoveredCount} ` +
                `terminal_candidate_count=${terminalCount} ` +
                `in_flight_count=${inFlightCount} ` +
                `yield_rate=${yieldRate} ` +
                `elapsed_ms=${now - productivity.startedAt} ` +
                `time_since_last_productive_activity_ms=${now - productivity.lastProductiveActivityAt} ` +
                `last_productive_activity=${new Date(productivity.lastProductiveActivityAt).toISOString()} ` +
                `productive_event_type=${productivity.lastProductiveEventType ?? "none"} ` +
                `productive_idle_ms=${productivityLimits.productiveIdleMs} ` +
                `max_area_runtime_ms=${productivityLimits.maxAreaRuntimeMs} ` +
                `newly_discovered=${productivity.newlyDiscoveredCount} newly_queued=${productivity.newlyQueuedCount} ` +
                `candidate_volume=${candidateVolume} ` +
                `yield_evaluation_deferred_due_to_inflight=${productivity.yieldEvaluationDeferredDueToInflight}`,
            );
            // Aborts ONLY this area's own scoped signal — see
            // scopeAreaAbort()'s doc comment. Never calls
            // terminateRequest()/abortController.abort(): those are the
            // GLOBAL paths and must never be triggered by one area going
            // idle or low-yield (Step "STOPPING MECHANISM" in the phase
            // prompt / PHASE 30 STEP 4's sibling/global safety).
            areaAbort.abort(stopReason);
          }, AREA_PRODUCTIVITY_CHECK_INTERVAL_MS);
          productivityTimer.unref?.();

          // CRITMODE Phase 4 — PART B (requirement 7 — heartbeat active
          // claims): renews this street's lease periodically for the
          // duration of this area's whole runEngineQuery() call, exactly
          // like discoveryPlanJob.ts's own street branch. No-op in area
          // mode (streetClaim undefined).
          let streetHeartbeatStopped = false;
          let streetHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
          if (streetClaim && streetScope) {
            const renewStreetClaim = () => {
              void heartbeatDiscoveryStreetClaim(supabaseAdmin, streetClaim, streetScope!.userId, slotWorkerId)
                .then((renewed) => {
                  if (!renewed) {
                    streetHeartbeatStopped = true;
                    console.warn(
                      `[poolExpandJob][street-discovery] claim heartbeat lost city=${city} street=${streetClaim.streetKey}`,
                    );
                  }
                })
                .catch((err: unknown) =>
                  console.warn(`[poolExpandJob][street-discovery] claim heartbeat failed street=${streetClaim.streetKey}`, err),
                );
            };
            streetHeartbeatTimer = setInterval(renewStreetClaim, STREET_HEARTBEAT_INTERVAL_MS);
            streetHeartbeatTimer.unref?.();
          }

          try {
            // CRITMODE — diagnostics only: engine_spawn_started, recorded
            // immediately before the call that ultimately invokes
            // child_process.spawn() inside pythonBridge.ts.
            streetTrace?.markSpawnStarted();
            // PHASE 41 — restored: exactly ONE runEngineQuery() invocation
            // for this area's entire scan allocation (see `askFor` above).
            // No expansion loop, no second engine/browser/subprocess
            // launch for the same area — that repeated cold-start work was
            // the confirmed regression (see the `askFor` comment above).
            //
            // CRITMODE Phase 4 — PART B (requirement 6 — street-scoped
            // query): a claimed street uses "[niche] on [street], [city]";
            // area mode keeps the existing "[niche] in [area], [city]"
            // query unchanged.
            for await (const lead of runEngineQuery(
              {
                query: streetClaim
                  ? `${singleNiche} on ${areaLabel}, ${city}`
                  : `${singleNiche} in ${areaLabel}, ${city}`,
                city,
                country: country.code,
                niche: singleNiche,
                region: payload.region,
                area: areaLabel,
                max_results: askFor,        // scan budget — raw Maps supply cap (intentional over-fetch)
                deliver_target: streamTarget,
                required_channels: followUp?.channels ?? [],
                db_path: `data/leads-pool-expand.db`,
                // ROOT CAUSE FIX (CRITMODE — user-scoped dedup bug): a
                // followUp run DOES have a real requesting user
                // (followUp.userId) waiting on this delivery — this was
                // previously omitted here, so the Python side always saw
                // user_id=None and silently fell back to the GLOBAL
                // businesses-existence check (PersistentEarlyDedupChecker
                // ._is_duplicate_global) even for a followUp user, instead
                // of the per-user ownership check
                // (._is_duplicate_for_user) Phase 1A intended. A bare
                // pool-growth run (no followUp) still omits user_id
                // entirely (followUp?.userId is undefined), preserving
                // the exact prior global pool-building behavior — see
                // EngineQueryParams.user_id's doc comment in
                // pythonBridge.ts.
                user_id: followUp?.userId,
              },
              // PHASE 12D: this area's own scoped signal, not the shared
              // job-level abortController.signal directly.
              areaSignal,
              (info) => {
                areaExhausted = info.exhausted;
                lastPerf = info.perf;
                lastTerminationReason = info.terminationReason;
                doneInfoReceived = true;
                // CRITMODE — diagnostics only: engine_done, plus stash the
                // done-info for finalize() below (bridgeTimings/progressMarks
                // are already computed by pythonBridge.ts — read, not re-measured).
                streetTrace?.markEngineDone();
                lastDoneInfoForTrace = info;
                logChildTelemetry(`area=${area} city=${city}`, streamTarget, info);
                if (info.success === false) {
                  console.warn(
                    `[poolExpandJob] engine discovery FAILED for area=${area} (${city}/${country.code}) — ` +
                      `reason=${info.failureReason} detail=${info.failureDetail ?? "n/a"}`,
                  );
                }
              },
              {
                requestId: reqId,
                areaLabel: area,
                // PHASE 25 / PHASE 36: live discovery & enrichment progress signal.
                // PHASE 5B-2 — candidate-level lifecycle accounting fix
                // (Phase 5B-1 audit). Every branch below that closes a
                // candidate out goes through `closeCandidateTerminal`, which
                // is idempotent by `progress.pipelineId` — a candidate can
                // never be double-counted terminal, no matter how many
                // terminal-flagged events arrive for it (retries, duplicate
                // dead-letters, etc.). A stage's mid-pipeline
                // success/retryable-failure is deliberately NEVER routed
                // through `closeCandidateTerminal` — see each branch.
                onProgress: (progress) => {
                  // CRITMODE — diagnostics only: count distinct candidates
                  // that reached ANY enrichment-stage progress event (no
                  // existing counter for this). Never gates anything —
                  // purely additive to the Set below.
                  if (
                    (progress.stage === "website" || progress.stage === "instagram" || progress.stage === "contact") &&
                    progress.pipelineId
                  ) {
                    streetEnrichmentAttemptIds.add(progress.pipelineId);
                  }
                  // CRITMODE PART 2 — diagnostics only. `stage="engine"`
                  // events (target_reached/drain_begin/worker_shutdown_begin)
                  // are new (see execution_driver.py/service.py), but travel
                  // through the exact same onProgress callback as every
                  // other stage — no new wiring needed beyond these two
                  // additive branches.
                  if (progress.stage === "engine") {
                    if (progress.event === "drain_begin" && progress.itemId !== undefined) {
                      const pending = Number.parseInt(progress.itemId, 10);
                      if (Number.isFinite(pending)) streetTrace?.markPendingAtDrain(pending);
                    }
                  } else if (progress.stage === "discovery" && progress.event === "panel_failure_retry") {
                    streetPanelRetryCount += 1;
                  }
                  if (progress.stage === "discovery") {
                    if (progress.event === "candidate_discovered") {
                      admitCandidate(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId);
                    } else if (progress.event === "candidate_queued") {
                      recordCandidateQueued(productivity);
                    } else if (
                      progress.event === "candidate_closed_pruned" ||
                      progress.event === "candidate_keyword_pruned" ||
                      progress.event === "candidate_early_channel_pruned" ||
                      // 5B-1 gap #2 (discovery half): a dedup hit was
                      // previously silently dropped — never closed out,
                      // inflating inFlightCount forever for that candidate.
                      progress.event === "candidate_early_duplicate"
                    ) {
                      closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "early_pruned");
                    }
                  } else if (
                    progress.stage === "website" ||
                    progress.stage === "instagram" ||
                    progress.stage === "contact"
                  ) {
                    if (progress.event === "candidate_early_channel_pruned") {
                      closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "early_pruned");
                    } else if (progress.event === "stage_failed") {
                      // 5B-1 gap #4: only a DEAD-LETTERED failure (retries
                      // exhausted) is candidate-terminal. A retryable
                      // failure (`progress.terminal === false`) must not
                      // close the candidate — it may still succeed on a
                      // later attempt.
                      if (progress.terminal) {
                        closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "failed");
                      }
                    } else if (progress.event === "stage_completed") {
                      recordProductiveActivity(productivity, "enrichment_completed");
                    }
                  } else if (progress.stage === "merge") {
                    // 5B-1 gap #5: merge events were emitted by Python and
                    // silently dropped by Node. Merge success continues the
                    // candidate on to qualification (not terminal); only a
                    // dead-lettered merge failure closes it out.
                    if (progress.event === "stage_failed" && progress.terminal) {
                      closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "failed");
                    }
                  } else if (progress.stage === "qualification") {
                    // 5B-1 gaps #1/#2/#3: `candidate_rejected` now covers
                    // EVERY rejection reason (not just niche mismatch /
                    // Instagram follower limit), emitted with
                    // `terminal: true` by the engine. `candidate_qualified`
                    // is deliberately NOT terminal here — a qualified
                    // candidate's one authoritative terminal transition is
                    // its eventual storage outcome (see the "storage"
                    // branch below), not this event. A `stage_failed` here
                    // is the QualificationWorker itself crashing/exhausting
                    // retries (distinct from a business-rule rejection).
                    if (progress.terminal) {
                      if (progress.event === "stage_failed") {
                        closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "failed");
                      } else {
                        closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "rejected");
                      }
                    }
                  } else if (progress.stage === "storage") {
                    // 5B-1 gap #6: storage events were emitted by Python and
                    // silently dropped by Node. A successful write is the
                    // candidate's "delivered" resolution; a dead-lettered
                    // write is its "storage_failed" resolution — either way
                    // storage is the pipeline's last stage, so both close
                    // the candidate. Deliberately NOT "qualified" here (that
                    // would re-trigger `recordQualifiedLead` a second time —
                    // `processLead()` below already calls it once for this
                    // same lead's delivery bookkeeping).
                    if (progress.event === "stage_completed") {
                      closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "delivered");
                    } else if (progress.event === "stage_failed" && progress.terminal) {
                      closeCandidateTerminal(productivity, inFlightPipelineIds, terminalPipelineIds, progress.pipelineId, "failed");
                    }
                  }
                },
              },
            )) {
              streetTrace?.markFirstForwarded(); // CRITMODE — diagnostics only, idempotent
              discovered += 1;
              const outcome = await processLead(lead, streamTarget, chunk, areaRecorder, productivity, streetTrace
                ? { onDelivered: () => { streetDelivered += 1; }, onNewForUser: () => { streetNewForUser += 1; streetTrace.markFirstNewForUser(); } }
                : undefined,
                // PAID-TIER LIVE SCRAPING BRIDGE — same areaWorkerNumbers
                // map the onEvent worker_started handler above populates
                // from the real `event.slot + 1`, keyed by this same
                // `area` — never re-derived independently.
                { scoutId: areaWorkerNumbers.get(area), areaLabel });
              if (outcome === "stop_outer") {
                stopOuter = true;
                accepted = chunk.deliveredThisChunk;
                break;
              }
              if (outcome === "batch_done") {
                accepted = chunk.deliveredThisChunk;
                break;
              }
            }
            // PHASE 41: no expansion loop — this area's single
            // runEngineQuery() invocation above either reached its
            // streamTarget (batch_done), was aborted (TARGET_REACHED /
            // idle / low-yield), or exhausted its full ~400-candidate
            // scan budget (areaExhausted) and naturally ended. All three
            // are terminal for this area; the area worker pool
            // (googleAreaPool.ts) — not a same-area retry — is what picks
            // up any remaining shortfall, exactly as it did in the
            // known-good baseline.
          } finally {
            clearInterval(productivityTimer);
            // PHASE 5B-2 (5B-1 gap #8) — this area is done, for whatever
            // reason (batch_done / stop_outer / natural exhaustion / idle
            // or low-yield rotation / abort). Whatever candidates are still
            // open (admitted but never closed terminal) at this exact
            // moment are force-closed as "cancelled", by pipeline_id, so
            // `inFlightCount` reconciles to 0 instead of being left at
            // whatever stale nonzero value the last progress event happened
            // to leave it at. A late duplicate terminal event for one of
            // these pipeline_ids arriving after this point is a no-op —
            // `closeCandidateTerminal` already guards on `terminalPipelineIds`.
            cancelOpenCandidates(productivity, inFlightPipelineIds, terminalPipelineIds);
            accepted = chunk.deliveredThisChunk;
            rejected = Math.max(0, discovered - accepted);
            // PHASE 41 — compact per-area scan-budget and productivity telemetry.
            console.info(
              `[poolExpandJob][area-scan-budget] area=${area} city=${city} ` +
                `global_scan_budget=${scanBudgetCoordinator.globalScanBudget} ` +
                `area_scan_budget=${askFor} ` +
                `in_flight_count=${productivity.inFlightCount} ` +
                `terminal_candidate_count=${productivity.terminalCandidateCount} ` +
                `qualified_count=${productivity.qualifiedCount} ` +
                `yield_evaluation_deferred_due_to_inflight=${productivity.yieldEvaluationDeferredDueToInflight}`,
            );
            // PHASE 12D: when THIS area's own productivity timer is what
            // ended the run, that specific, more informative reason takes
            // precedence over whatever generic bridge-level reason
            // (typically CANCELLED, since the subprocess was SIGTERM'd)
            // the aborted engine call itself reported — see
            // AreaTerminationReason's doc comment in
            // runStabilityTelemetry.ts.
            const effectiveTerminationReason = productivity.stoppedReason ?? lastTerminationReason;
            stability.recordAreaFinished(
              areaRecorder.finish(
                extractAreaSlaCounters(lastPerf?.area_sla as Record<string, unknown> | undefined),
                { terminationReason: effectiveTerminationReason, perfReceived: doneInfoReceived },
              ),
            );

            if (streetHeartbeatTimer) clearInterval(streetHeartbeatTimer);
            // CRITMODE Phase 4 — PART B (requirements 8/10 — completion
            // semantics): a street is marked COMPLETED only when this
            // area's ENTIRE engine operation reached genuine exhaustion —
            // never merely because one lead was found (`accepted > 0` is
            // irrelevant here), and never while its lease was already lost
            // to another worker. Every other outcome (target reached,
            // cancelled, idle/low-yield rotation, failure) leaves the claim
            // to expire naturally so a later run — this user's or, after
            // completion, a different user's — can still pick it up. Exact
            // same completion gate as discoveryPlanJob.ts's own street
            // branch (`engineTerminationReason === "SUCCESS_EXHAUSTED"`).
            if (streetClaim && streetScope) {
              const streetCompleted = !streetHeartbeatStopped
                && effectiveTerminationReason === "SUCCESS_EXHAUSTED"
                && await completeDiscoveryStreetClaim(supabaseAdmin, streetClaim, streetScope.userId, slotWorkerId);
              if (streetCompleted) {
                console.info(
                  `[poolExpandJob][street-discovery] completed city=${city} country=${country.code} street=${streetClaim.streetKey}`,
                );
              } else {
                console.info(
                  `[poolExpandJob][street-discovery] claim left recoverable city=${city} street=${streetClaim.streetKey} ` +
                    `termination=${effectiveTerminationReason ?? "unknown"}`,
                );
              }
              // CRITMODE — diagnostics only: emit this street's full
              // lifecycle summary line exactly once, at the same point its
              // completion/recoverable state is already decided above.
              // Reads productivity's EXISTING counters (never re-counts)
              // for raw/admitted/qualified.
              streetTrace?.finalize({
                info: lastDoneInfoForTrace,
                counts: {
                  raw_candidates: productivity.newlyDiscoveredCount,
                  yielded_candidates: discovered,
                  admitted_candidates: productivity.newlyQueuedCount,
                  enrichment_attempts: streetEnrichmentAttemptIds.size,
                  panel_retry_count: streetPanelRetryCount,
                  qualified: productivity.qualifiedCount,
                  new_for_user: streetNewForUser,
                  delivered: streetDelivered,
                },
                terminationReason: effectiveTerminationReason ?? null,
              });
              streetLifecycleTracers.delete(area);
            }
          }

          return {
            discovered,
            accepted,
            rejected,
            duplicates: 0,
            exhausted: areaExhausted,
            // A claimed-but-not-completed street is not a hard failure of
            // this area worker (leads may still have been delivered) — it
            // only means the claim itself stays recoverable for a future
            // run. `failed` here only ever gates
            // AreaWorkerPoolResult.allFailed (task-level retry decision,
            // area mode only); street mode's own retry/recovery lives in
            // the RPC lease, not this flag.
            failed: false,
          };
        },
      });

      if (result.startedWorkers === 0 && result.poolSize === 0) {
        // Saturated (no browser slot) or misconfigured — fall through so
        // the caller's existing legacy single-search path still covers
        // this round instead of silently doing nothing.
        return "continued";
      }
      return stopOuter ? "stop_outer" : "continued";
    }

    outer: for (const singleNiche of niches) {
      if (stillNeededNow() <= 0) break;

      const rotation = new CountryRotation(countries);
      let roundsLeft = countries.length * 6 + 20;

      while (stillNeededNow() > 0 && !rotation.isFullyExhausted && roundsLeft-- > 0) {
        for (const { country, city } of rotation.round()) {
          const remaining = stillNeededNow();
          if (remaining <= 0) break;

          // AREA POOL FIX (issue 3): route through the SAME Google Maps
          // area worker pool discoveryPlanJob.ts uses, when this city has
          // curated (or default) sub-areas — see runGoogleAreaPoolForCity()
          // above. Falls through to the legacy single-search path below
          // only when there are no areas to use, or the pool reports it
          // couldn't start (saturated browser slots) — same end result as
          // before in that case, just without the area refinement.
          const areas = getAreasForCityOrDefault(country.code, city);
          if (areas.length > 0) {
            const poolOutcome = await runGoogleAreaPoolForCity(singleNiche, country, city, areas);
            if (poolOutcome === "stop_outer") break outer;
            continue; // this round's city is done (pool exhausted areas or hit capacity) — next city
          }

          const chunk = rotation.chunkSize(remaining); // fairness share — diversity accounting only
          // PHASE 10 FIX: streamTarget (-> deliver_target) is the fixed,
          // authoritative global `target`, never the shrinking `remaining`
          // — see roundSizing.ts's doc comment for the full regression
          // writeup. `chunk`/STREAM_BATCH_FLOOR remain true minimums only.
          const streamTarget = cityStreamTarget(target, chunk, STREAM_BATCH_FLOOR);
          const askFor = computeAskFor(streamTarget);

          let citySearchExhausted = false;
          const chunkState = { deliveredThisChunk: 0 };

          for await (const lead of runEngineQuery(
            {
              query: singleNiche,
              city, // ROOT CAUSE FIX: a real city (e.g. "Lagos"), never country.name
              country: country.code,
              niche: singleNiche,
              region: payload.region,
              max_results: askFor,        // scan budget — raw Maps supply cap (intentional over-fetch)
              // PHASE 5 FIX: see the matching deliver_target comment in
              // runGoogleAreaPoolForCity() above — same decoupling, same
              // reason, for the legacy (no curated areas) path.
              deliver_target: streamTarget,
              required_channels: followUp?.channels ?? [],
              db_path: `data/leads-pool-expand.db`,
              // ROOT CAUSE FIX (CRITMODE — user-scoped dedup bug): same
              // fix as the area-pooled runEngineQuery() call above — see
              // that call's comment for the full explanation. Legacy
              // (no curated areas) sequential path was equally affected.
              user_id: followUp?.userId,
            },
            abortController.signal,
            (info) => {
              citySearchExhausted = info.exhausted;
              logChildTelemetry(`city=${city}`, streamTarget, info);
              if (info.success === false) {
                // See discoverJob.ts's onDone callback for the full
                // explanation (Part 8 fix) — citySearchExhausted is
                // guaranteed false here, so markCurrentSearchExhausted
                // below is correctly skipped on a genuine failure.
                console.warn(
                  `[poolExpandJob] engine discovery FAILED for ${city}/${country.code} — ` +
                    `reason=${info.failureReason} detail=${info.failureDetail ?? "n/a"}`,
                );
              }
            },
            { requestId: reqId },
          )) {
            const outcome = await processLead(lead, streamTarget, chunkState);
            if (outcome === "stop_outer") break outer;
            if (outcome === "batch_done") break;
          }

          if (citySearchExhausted) {
            // Advances to this country's next city; only drops the whole
            // country once every one of its cities is exhausted.
            rotation.markCurrentSearchExhausted(country);
          }
        }
      }
    }

    // Determine final status and write summary metrics.
    if (followUp) {
      const { data: finalRow } = await supabaseAdmin.from("scrape_jobs")
        .select("status").eq("id", followUp.scrapeJobId).maybeSingle();
      const wasCancelled = finalRow?.status === "cancelled";

      const completionReason = wasCancelled
        ? "cancelled"
        : userPlanLimitHit
          ? "plan_limit_reached"
          : newForUser >= payload.shortfall
            ? "quantity_reached"
            : "exhausted";

      const finalStatus = wasCancelled
        ? "cancelled"
        : newForUser >= payload.shortfall
          ? "completed"
          : "completed_partial";

      // CRITMODE FIX: fold the final results_count into this SAME atomic
      // write as the terminal status flip (via the monotonic RPC, not a
      // plain `.update()`), instead of relying on whatever the last
      // per-lead bumpResultsCount() call happened to leave behind. This
      // closes the remaining race window between that last per-lead write
      // and this completion write, and guarantees the exact row version
      // the frontend's realtime subscription reacts to (status===
      // "completed") always carries the correct, final count — never a
      // stale one from an earlier, since-superseded snapshot.
      await bumpResultsCount(followUp.scrapeJobId, resultsCountBase + newForUser);
      await supabaseAdmin.from("scrape_jobs").update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        job_summary: {
          requested: payload.shortfall,
          delivered: newForUser,
          shortfall: Math.max(0, payload.shortfall - newForUser),
          completion_reason: completionReason,
          runtime_ms: Date.now() - jobStartedAt,
        },
      }).eq("id", followUp.scrapeJobId);

      // PAID-TIER LIVE SCRAPING BRIDGE — plan-level terminal event, at the
      // actual end of this run, using the SAME accounting just written
      // above (never a second counter). `fullRequestedTarget` reconstructs
      // the user's ORIGINAL requested quantity (what the frontend's
      // useLiveDiscoveryState(planId, quantity) was seeded with) —
      // `resultsCountBase` (whatever scrape_jobs.results_count already was
      // when this run's plan was created — the pool-hit count) plus
      // `payload.shortfall` (this run's own target, i.e. what was still
      // needed). `payload.shortfall` ALONE would be wrong here: it would
      // shrink the frontend's target away from the real requested quantity
      // once this event's `target` overwrites state.target (see
      // liveDiscoveryState.ts's discovery_completed handling).
      if (discoveryPlanId) {
        const finalDeliveredCount = resultsCountBase + newForUser;
        const fullRequestedTarget = resultsCountBase + payload.shortfall;
        if (wasCancelled) {
          publishDiscoveryLiveEvent(discoveryFailedEvent(discoveryPlanId, "cancelled"));
        } else {
          publishDiscoveryLiveEvent(discoveryCompletedEvent(discoveryPlanId, finalDeliveredCount, fullRequestedTarget));
        }
      }
    }

  } catch (err) {
    if (followUp) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err), completed_at: new Date().toISOString() })
        .eq("id", followUp.scrapeJobId)
        .not("status", "eq", "cancelled"); // preserve cancellation even on error
      // PAID-TIER LIVE SCRAPING BRIDGE — real, already-computed error
      // message; only emitted when a plan actually exists for this run.
      if (discoveryPlanId) {
        publishDiscoveryLiveEvent(discoveryFailedEvent(discoveryPlanId, err instanceof Error ? err.message : String(err)));
      }
    }
    throw err;
  } finally {
    // AUDIT FIX (Finding 6): stop pulsing the heartbeat on every exit path —
    // normal completion, the early "no countries" return, a cancellation,
    // search exhaustion, or an uncaught exception (the catch above still
    // runs first and still rethrows, unchanged).
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    // Phase S1: runs on every exit from this function — normal completion,
    // the early "no countries" return, a cancellation/limit-reached abort,
    // search exhaustion, or an uncaught exception propagating out (the
    // catch above still runs first and still rethrows, unchanged — this
    // only adds a diagnostic print before it does). Sweep first so any
    // business still mid-flight at that exact moment gets an explicit
    // terminal outcome instead of silently falling out of the report.
    tracer.sweepIncomplete("job_ended_before_business_finished");
    console.log(`[poolExpandJob] pipeline reconciliation:\n${tracer.reconcile()}`);

    // CRITMODE — diagnostics only: run-level street timing rollup, on
    // every exit path, same rationale as the pipeline reconciliation
    // above. `reqId` is recomputed here identically to how it was derived
    // inside the try block (discoveryPlanId is the same outer-scope `let`
    // that call site reads) since `reqId` itself is block-scoped to the
    // try. A run with no street-pool streets (area mode, or an early
    // return before any street was ever claimed) simply emits zero rows.
    const diagnosticsRunId = discoveryPlanId ?? followUp?.scrapeJobId;
    if (diagnosticsRunId) emitRunSummary(diagnosticsRunId);

    // PHASE 5 — TARGET-AWARE DISCOVERY STOPPING (job-level telemetry
    // summary). Logged on every exit path (normal completion, early
    // return, cancellation, or an exception still propagating past this
    // point) so a production run always leaves one line answering "how
    // much Maps discovery happened after the parent target was already
    // satisfied" — see logChildTelemetry()'s doc comment above for what
    // candidatesAfterParentTarget/mapsOperationsAfterParentTarget actually
    // measure (an upper bound, not an exact per-candidate count).
    // ROOT CAUSE FIX (same accounting bug as stillNeededNow()/the
    // stop-condition above): a followUp run's reported "parent_delivered"
    // must always be the user-scoped newForUser count, for the whole run —
    // not `delivered` (pool-wide) whenever newForUser happens to still be 0.
    const finalParentDelivered = reportedDelivered({ shortfall: payload.shortfall, delivered, newForUser, hasFollowUp: Boolean(followUp) });
    console.log(
      `[poolExpandJob][telemetry] SUMMARY parent_target=${payload.shortfall} ` +
        `parent_delivered=${finalParentDelivered} parent_remaining=${Math.max(0, payload.shortfall - finalParentDelivered)} ` +
        `target_reached_at_ms=${targetReachedAtMs ?? "n/a"} ` +
        `max_target_stop_latency_ms=${targetReachedAtMs !== null ? maxTargetStopLatencyMs : "n/a"} ` +
        `maps_operations_after_parent_target=${mapsOperationsAfterParentTarget} ` +
        `candidates_after_parent_target=${candidatesAfterParentTarget}`,
    );

    // PHASE 10 — RUN-TO-RUN STABILITY TELEMETRY (job-level summary + area
    // yield report). Logged alongside the PHASE 5 summary above, on every
    // exit path, for the exact same reason. See runStabilityTelemetry.ts
    // for what each field means and compareAreaWaves()'s doc comment for
    // why the wave-comparison signals deliberately don't name a single
    // root cause.
    const jobSummary = stability.summary({ areasStarted: areasStartedCount, targetReachedAtMs });
    console.log(
      `[poolExpandJob][stability] SUMMARY area_waves=${jobSummary.areaWaves} areas_started=${jobSummary.areasStarted} ` +
        `areas_completed=${jobSummary.areasCompleted} global_target_time_ms=${jobSummary.globalTargetTimeMs ?? "n/a"} ` +
        `total_runtime_ms=${jobSummary.totalRuntimeMs} per_wave_yield=${JSON.stringify(jobSummary.perWaveYield)} ` +
        `avg_qualified_per_area=${jobSummary.averageQualifiedPerArea.toFixed(2)} ` +
        `median_qualified_per_area=${jobSummary.medianQualifiedPerArea}`,
    );
    for (const row of stability.yieldReport()) {
      console.log(
        `[poolExpandJob][stability][area-yield] area=${row.area} raw=${row.raw} yielded=${row.yielded} ` +
          `qualified=${row.qualified} yield_rate=${row.yield_rate.toFixed(3)} qualification_rate=${row.qualification_rate.toFixed(3)}`,
      );
    }
    const waveComparison = stability.waveComparison();
    if (waveComparison.waveCount > 1) {
      for (const signal of waveComparison.signals) {
        console.log(
          `[poolExpandJob][stability][wave-variance] metric=${signal.metric} hypothesis="${signal.hypothesis}" ` +
            `values=${JSON.stringify(signal.values.map((v) => Number(v.toFixed(2))))} cv=${signal.coefficientOfVariation.toFixed(3)}`,
        );
      }
    }
  }

  console.log(
    `[poolExpandJob] region=${payload.region} niches=${JSON.stringify(niches)} ` +
      `countries=${JSON.stringify(countries.map((c: CountryInfo) => c.code))} shortfall=${payload.shortfall} ` +
      `delivered=${delivered}${followUp ? ` newForUser=${newForUser} (followUp for user=${followUp.userId})` : ""}`,
  );
}
