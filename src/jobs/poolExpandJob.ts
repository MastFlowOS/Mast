import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import type { EngineLead } from "../scraperBridge/pythonBridge.js";
import { deliverLead, type DeliveryResult } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { resolveCountriesForSelection, CountryRotation } from "../lib/geo/regions.js";
import type { CountryInfo } from "../lib/geo/countries.js";
import { PipelineTracer } from "../lib/pipelineTrace.js";
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
import { areaStreamTarget, cityStreamTarget, computeAskFor } from "../discovery/roundSizing.js";
import {
  createAreaScanBudgetCoordinator,
  allocateInitialAreaScanBudget,
  requestAreaScanBudgetExpansion,
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
  classifyAreaYield,
  recordDeliveredLead,
  recordProductiveActivity,
  recordQualifiedLead,
  scopeAreaAbort,
  type AreaProductivityState,
} from "../discovery/areaProductivity.js";
import { getBrowserSlotPool, acquireBrowserSlotBlocking } from "../lib/workerCapacity.js";
import { getResourceCapacity } from "../lib/resourceCapacity.js";
import { env } from "../config/env.js";

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
 */
async function getOrCreatePoolExpandPlanId(followUp: PoolExpandFollowUp, payload: PoolExpandJobPayload): Promise<string> {
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

    const stillNeededNow = () => (followUp ? payload.shortfall - newForUser : payload.shortfall - delivered);

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
      const parentDelivered = followUp ? newForUser : delivered;
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
    ): Promise<"continue" | "batch_done" | "stop_outer"> {
      const pid = tracer.receive(lead._pipeline_id, lead.name);
      // PHASE 10 telemetry: every lead the engine yields counts as a
      // "candidate seen" for this area, regardless of what happens to it
      // next — and whether email/instagram are present on arrival is
      // recorded here, BEFORE any validation/delivery logic runs, so it's
      // a pure observation and never changes what gets delivered (item 5:
      // no quality/qualification semantics change).
      areaRecorder?.recordCandidateSeen({ hasEmail: Boolean(lead.email), hasInstagram: Boolean(lead.instagram) });
      try {
        if (followUp && !channelsSatisfied(lead, followUp.channels)) {
          tracer.reject(pid, `channel_filter:${JSON.stringify(followUp.channels)}`);
          return "continue"; // doesn't satisfy every requested channel for the waiting user — not counted
        }

        const validation = validateLead(lead);
        if (!validation.valid) {
          console.log(`[poolExpandJob] skipping invalid lead name=${JSON.stringify(lead.name)} reason=${validation.reason}`);
          tracer.reject(pid, `validation:${validation.reason}`);
          return "continue";
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
        if (result.wasNewForUser) newForUser += 1;

        if (followUp) {
          // Guard: if the job was cancelled while we were running, stop.
          const { data: jobStatus } = await supabaseAdmin.from("scrape_jobs")
            .select("status").eq("id", followUp.scrapeJobId).maybeSingle();
          if (jobStatus?.status === "cancelled") {
            if (reqId) terminateRequest(reqId, "USER_CANCELLED");
            abortController.abort("USER_CANCELLED");
            return "stop_outer";
          }

          await supabaseAdmin.from("scrape_jobs")
            .update({ results_count: resultsCountBase + newForUser })
            .eq("id", followUp.scrapeJobId)
            .not("status", "eq", "cancelled");

          if (result.limitReached) {
            console.log(`[poolExpandJob] user=${followUp.userId} hit their plan limit mid-run — stopping early`);
            userPlanLimitHit = true;
            if (reqId) terminateRequest(reqId, "EXHAUSTED");
            abortController.abort("EXHAUSTED");
            return "stop_outer";
          }

          if (newForUser >= payload.shortfall) {
            targetReachedAtMs = Date.now();
            if (reqId) terminateRequest(reqId, "TARGET_REACHED");
            abortController.abort("TARGET_REACHED");
            return "stop_outer";
          }
        } else if (delivered >= payload.shortfall) {
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
          areas.length,
          browserPool.available(),
          env.GOOGLE_MAPS_AREA_WORKERS,
          getResourceCapacity().safeAreaWorkers,
        ),
      );
      const scanBudgetCoordinator: AreaScanBudgetCoordinator = createAreaScanBudgetCoordinator(streamTargetForCity, {
        multiplier: env.AREA_SCAN_BUDGET_MULTIPLIER,
        minAreaBudgetFactor: env.AREA_SCAN_BUDGET_MIN_FACTOR,
        maxAreaBudgetFactor: env.AREA_SCAN_BUDGET_MAX_FACTOR,
        expansionChunkFactor: env.AREA_SCAN_BUDGET_EXPANSION_FACTOR,
      });
      console.info(
        `[poolExpandJob][area-scan-budget] city=${city} global_scan_budget=${scanBudgetCoordinator.globalScanBudget} ` +
          `stream_target=${streamTargetForCity} active_area_count=${activeAreaCount}`,
      );

      const result = await runAreaWorkerPool({
        configuredWorkers: env.GOOGLE_MAPS_AREA_WORKERS,
        // Phase 6: resource-aware (cgroup PID/thread) ceiling — see
        // resourceCapacity.ts and discoveryPlanJob.ts's matching call site.
        safeResourceWorkers: getResourceCapacity().safeAreaWorkers,
        totalCuratedAreas: areas.length,
        availableCapacity: browserPool.available(),
        requestedQuantity: target,
        claimNextArea: (usedAreas) =>
          claimAreaForCity(supabaseAdmin, {
            niche: singleNiche,
            countryCode: country.code,
            city,
            source: "google_maps",
            areas: areas.filter((a) => !usedAreas.has(a)),
          }),
        tryAcquireSlot: () => browserPool.tryAcquire(),
        isTerminal: () => stopOuter || stillNeededNow() <= 0 || abortController.signal.aborted,
        onEvent: (event) => {
          if (event.type === "worker_started") {
            areasStartedCount += 1;
            areaWorkerNumbers.set(event.area, event.slot + 1);
          }
          if (event.type === "worker_finished") {
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
        },
        runArea: async (area): Promise<AreaRunOutcome> => {
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
          // PHASE 32: was computeAskFor(streamTarget) — every area's own
          // independent 4x-multiplied scan budget. Now a bounded SLICE of
          // the shared per-city budget (see scanBudgetCoordinator above);
          // `askFor` may grow via requestAreaScanBudgetExpansion() below if
          // this area proves productive and exhausts its slice before
          // reaching its own streamTarget.
          let askFor = allocateInitialAreaScanBudget(scanBudgetCoordinator, area, activeAreaCount);
          const initialAskFor = askFor;
          let scanBudgetExpansionRounds = 0;
          const areaRecorder = stability.startArea(area, areaWorkerNumbers.get(area) ?? 0, streamTarget);
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
          // PHASE 25: shared limits object — see areaProductivity.ts's
          // AreaProductivityLimits and env.ts for where these two knobs
          // come from and why their defaults are safe.
          const productivityLimits = {
            productiveIdleMs: env.AREA_PRODUCTIVITY_IDLE_MS,
            maxAreaRuntimeMs: env.AREA_PRODUCTIVITY_MAX_RUNTIME_MS,
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
          };

          const productivityTimer = setInterval(() => {
            if (areaAbort.signal.aborted) return;
            const now = Date.now();
            // PHASE 25's idle/max-runtime check still runs FIRST and
            // unconditionally — precedence is unchanged (STEP 4 of the
            // Phase 25 prompt). Only if it says "keep going" do we ALSO
            // check the PHASE 30 yield classifier — an area that failed
            // the idle/max-runtime check was already going to stop for
            // that reason regardless of its yield.
            const stopReason = evaluateAreaProductivity(productivity, now, productivityLimits)
              ?? evaluateAreaYieldStop(productivity, now, yieldLimits);
            if (!stopReason) return;
            productivity.stoppedReason = stopReason;
            // PHASE 25 STEP 8 (extended PHASE 30) — observational-only
            // telemetry. Never gates anything above; only describes why the
            // stop already happened.
            const candidateVolume = productivity.newlyDiscoveredCount + productivity.newlyQueuedCount;
            const yieldCount = Math.max(productivity.qualifiedCount, productivity.deliveredCount);
            console.info(
              `[poolExpandJob][area-productivity] area=${area} stop_reason=${stopReason} ` +
                `qualified=${productivity.qualifiedCount} delivered=${productivity.deliveredCount} ` +
                `elapsed_ms=${now - productivity.startedAt} ` +
                `time_since_last_productive_activity_ms=${now - productivity.lastProductiveActivityAt} ` +
                `last_productive_activity=${new Date(productivity.lastProductiveActivityAt).toISOString()} ` +
                `productive_event_type=${productivity.lastProductiveEventType ?? "none"} ` +
                `productive_idle_ms=${productivityLimits.productiveIdleMs} ` +
                `max_area_runtime_ms=${productivityLimits.maxAreaRuntimeMs} ` +
                `newly_discovered=${productivity.newlyDiscoveredCount} newly_queued=${productivity.newlyQueuedCount} ` +
                `candidate_volume=${candidateVolume} yield_rate=${candidateVolume > 0 ? (yieldCount / candidateVolume).toFixed(3) : "n/a"}`,
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

          try {
            // PHASE 32 — bounded expansion loop. Almost always runs exactly
            // once (the common case, identical to pre-Phase-32 behavior
            // apart from `askFor`'s smaller starting value). Only loops
            // again when the engine call below reports `exhausted: true`
            // (ran out of ITS OWN scan budget, not target-reached/aborted)
            // AND this area hasn't yet delivered its own `streamTarget`
            // AND `requestAreaScanBudgetExpansion` grants more (STEP 3) —
            // never unbounded (see that function's own caps).
            areaScanBudgetLoop: for (;;) {
            let batchStop = false;
            for await (const lead of runEngineQuery(
              {
                query: `${singleNiche} in ${area}, ${city}`,
                city,
                country: country.code,
                niche: singleNiche,
                region: payload.region,
                area,
                max_results: askFor,        // scan budget — raw Maps supply cap (intentional over-fetch)
                // PHASE 5 FIX: tells the Python engine's LeadAcceptanceGate
                // (service.py's `_deliver_target`) the true number of
                // QUALIFIED leads this round needs, decoupled from the
                // generous `max_results` scan budget above. Previously
                // omitted, so `_deliver_target` silently fell back to
                // `max_results` (askFor) — the engine kept chasing up to 4x
                // (or, before this fix, the full un-shrinking shortfall)
                // more qualified leads than this round actually needed
                // before its own should_stop() cooperative check ever
                // fired, letting MapsScraper.search() keep scanning raw
                // candidates well past the point this round was satisfied.
                deliver_target: streamTarget,
                required_channels: followUp?.channels ?? [],
                db_path: `data/leads-pool-expand.db`,
              },
              // PHASE 12D: this area's own scoped signal, not the shared
              // job-level abortController.signal directly — see the doc
              // comment above `productivity`/`areaAbort`.
              areaSignal,
              (info) => {
                areaExhausted = info.exhausted;
                lastPerf = info.perf;
                lastTerminationReason = info.terminationReason;
                doneInfoReceived = true;
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
                // PHASE 25: live discovery-progress signal — see
                // PRODUCTIVE_DISCOVERY_PROGRESS_EVENTS's doc comment above
                // for exactly which events count and why. Purely additive
                // observation; never affects what runEngineQuery yields.
                onProgress: (progress) => {
                  if (progress.stage !== "discovery") return;
                  if (!PRODUCTIVE_DISCOVERY_PROGRESS_EVENTS.has(progress.event)) return;
                  recordProductiveActivity(
                    productivity,
                    progress.event === "candidate_queued" ? "candidate_queued" : "candidate_discovered",
                  );
                },
              },
            )) {
              discovered += 1;
              const outcome = await processLead(lead, streamTarget, chunk, areaRecorder, productivity);
              if (outcome === "stop_outer") {
                stopOuter = true;
                accepted = chunk.deliveredThisChunk;
                batchStop = true;
                break;
              }
              if (outcome === "batch_done") {
                accepted = chunk.deliveredThisChunk;
                batchStop = true;
                break;
              }
            }

            if (batchStop) break areaScanBudgetLoop;

            // The engine's own generator ended naturally (this area's
            // streamTarget was not reached via processLead's "batch_done").
            // Only consider an expansion grant when it was genuinely the
            // SCAN BUDGET that ran out (`areaExhausted`) — never when the
            // global target was already hit, this area was itself
            // aborted (idle/low-yield/parent-abort — scopeAreaAbort), or
            // this area already reached its own streamTarget.
            if (
              stopOuter ||
              areaAbort.signal.aborted ||
              !areaExhausted ||
              chunk.deliveredThisChunk >= streamTarget
            ) {
              break areaScanBudgetLoop;
            }

            const yieldClass = classifyAreaYield(productivity, Date.now(), yieldLimits);
            const grant = requestAreaScanBudgetExpansion(scanBudgetCoordinator, area, yieldClass);
            if (grant <= 0) break areaScanBudgetLoop;

            askFor = grant;
            scanBudgetExpansionRounds += 1;
            } // areaScanBudgetLoop
          } finally {
            clearInterval(productivityTimer);
            accepted = chunk.deliveredThisChunk;
            rejected = Math.max(0, discovered - accepted);
            // PHASE 32 STEP 6 — compact per-area scan-budget telemetry, so
            // the next benchmark can confirm areas are no longer each
            // getting a giant duplicated budget.
            console.info(
              `[poolExpandJob][area-scan-budget] area=${area} city=${city} ` +
                `global_scan_budget=${scanBudgetCoordinator.globalScanBudget} ` +
                `area_initial_scan_budget=${initialAskFor} ` +
                `area_scan_budget_expansions=${scanBudgetExpansionRounds} ` +
                `area_final_scan_budget=${askFor}`,
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
          }

          return { discovered, accepted, rejected, duplicates: 0, exhausted: areaExhausted, failed: false };
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
    }

  } catch (err) {
    if (followUp) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err), completed_at: new Date().toISOString() })
        .eq("id", followUp.scrapeJobId)
        .not("status", "eq", "cancelled"); // preserve cancellation even on error
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

    // PHASE 5 — TARGET-AWARE DISCOVERY STOPPING (job-level telemetry
    // summary). Logged on every exit path (normal completion, early
    // return, cancellation, or an exception still propagating past this
    // point) so a production run always leaves one line answering "how
    // much Maps discovery happened after the parent target was already
    // satisfied" — see logChildTelemetry()'s doc comment above for what
    // candidatesAfterParentTarget/mapsOperationsAfterParentTarget actually
    // measure (an upper bound, not an exact per-candidate count).
    const finalParentDelivered = followUp ? newForUser : delivered;
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
