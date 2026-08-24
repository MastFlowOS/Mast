/**
 * PHASE 25 — Area productivity stop logic, upgraded from "time since last
 * qualification" (PHASE 12D) to "time since last PRODUCTIVE ACTIVITY".
 *
 * PHASE 12D shipped a hybrid clock keyed entirely off qualified leads: the
 * exploration window (before the first qualified lead) measured from
 * `startedAt`, and the inactivity window (after the first qualified lead)
 * measured from `lastQualifiedAt`. The Coffee Shop benchmark (25k-line log,
 * see the Phase 25 prompt) showed this is too blunt: Bronx and Staten
 * Island were both actively yielding fresh candidates from the Maps
 * provider when they were killed at ~120s purely because qualification
 * (website+email+phone+instagram, all four channels) hadn't landed yet.
 * Brooklyn (1 qualified) and Queens (3 qualified) were similarly stopped
 * mid-discovery even though they were still doing useful work.
 *
 * PHASE 25 replaces BOTH windows with a single clock,
 * `lastProductiveActivityAt`, updated by any HIGH-CONFIDENCE forward-
 * progress signal (see `recordProductiveActivity` below) — not just
 * qualification. An area that keeps finding/queuing candidates is never
 * killed just because none of them have qualified yet; an area that keeps
 * qualifying/delivering leads is (as before) never killed either. Only
 * genuine silence — no discovery, no qualification, no delivery for
 * `productiveIdleMs` — stops an area now.
 *
 * A second, independent bound — `maxAreaRuntimeMs` — is unchanged in
 * spirit from "there must be a hard ceiling": no matter how much activity
 * an area reports, it cannot run forever. See STEP 4 of the phase prompt.
 *
 * SCOPE (unchanged from PHASE 12D): pure, DB-free, engine-free. This module
 * does NOT decide how many leads an area is allowed to deliver, and does
 * NOT compare one area's progress to another's — it only answers "has this
 * one area gone quiet for long enough that it should be replaced?"
 */

export type AreaProductivityStopReason =
  | "area_productivity_timeout_before_first_qualified"
  | "area_productivity_idle_timeout"
  | "area_productivity_max_runtime"
  // PHASE 30 — this area kept producing/queueing candidates (so it never
  // tripped the PHASE 25 idle clock above) but its qualified/delivered
  // yield relative to that candidate volume stayed effectively zero for
  // long enough that continuing to hold a worker slot is no longer worth
  // it. See `classifyAreaYield`/`evaluateAreaYieldStop` below.
  | "area_productivity_low_yield";

/**
 * The specific kind of event that most recently reset
 * `lastProductiveActivityAt` — telemetry-only (STEP 8's
 * `productive_event_type`), never read by the classifier itself.
 *
 * Deliberately a NARROW allowlist (STEP 3's "safe productive signal"):
 * only events that represent genuine forward progress reset the clock.
 * Explicitly excluded (never passed here, never reset the clock):
 * heartbeats, logging-only lines, duplicate/no-op candidates, repeated
 * UI/DOM polling, a rate-limit wait by itself, and a retry loop that
 * produces no new candidate.
 */
export type ProductiveEventType =
  | "candidate_discovered"
  | "candidate_queued"
  | "enrichment_completed"
  | "qualified"
  | "delivered";

/**
 * One area worker's live productivity state. Deliberately minimal — no
 * candidate-quality heuristics, no rating/review/name scoring — just
 * enough to run the "time since last PRODUCTIVE ACTIVITY" classifier and
 * report what happened afterward.
 */
export type AreaProductivityState = {
  readonly startedAt: number;
  firstQualifiedAt: number | null;
  lastQualifiedAt: number | null;
  qualifiedCount: number;
  deliveredCount: number;
  stoppedReason: AreaProductivityStopReason | null;
  /**
   * PHASE 25 — the single reference point the classifier now uses for
   * BOTH the pre-first-qualified and post-first-qualified windows. Starts
   * at `startedAt` and is advanced only by `recordProductiveActivity`
   * (which `recordQualifiedLead`/`recordDeliveredLead` call internally, so
   * every existing call site keeps working unchanged).
   */
  lastProductiveActivityAt: number;
  /** Telemetry-only — see `ProductiveEventType`'s doc comment. Null until the first productive event. */
  lastProductiveEventType: ProductiveEventType | null;
  /**
   * PHASE 30 — STEP 1 audit result: candidate VOLUME was not previously
   * tracked anywhere on this state (only the timestamp/event-type of the
   * most recent productive event was kept). These two counters are the
   * minimum addition needed to answer "how much raw exploration has this
   * area actually done" for the yield classifier below, without
   * duplicating anything `AreaTelemetryRecord` (runStabilityTelemetry.ts)
   * already tracks — that module records engine-reported `area_sla`
   * counters for POST-HOC reporting after an area finishes; these two
   * fields are the LIVE, in-flight counts the yield classifier needs while
   * the area is still running. Incremented only by `recordProductiveActivity`,
   * so they stay in lockstep with `lastProductiveActivityAt`/
   * `lastProductiveEventType` and can never drift out of sync with what
   * the clock itself considers "productive".
   */
  newlyDiscoveredCount: number;
  newlyQueuedCount: number;
  /**
   * PHASE 36 — In-flight candidate tracking.
   * Tracks admitted candidates currently in-flight through enrichment and
   * qualification that have not yet reached a terminal resolution.
   */
  inFlightCount: number;
  /** Count of candidates that have reached a terminal outcome (qualified, rejected, early_pruned, failed). */
  terminalCandidateCount: number;
  /** Telemetry flag: whether a low-yield classification was deferred because candidates were in-flight. */
  yieldEvaluationDeferredDueToInflight: boolean;
  /**
   * PHASE 41 — REGRESSION FIX: `now` of the FIRST time `classifyAreaYield`
   * deferred a low-yield call because of in-flight candidates. `null`
   * until that first deferral. This is what bounds the deferral —
   * Phase 36/37's `maxPossibleRate` check on its own can be kept alive
   * indefinitely by a discovery stream that keeps adding fresh in-flight
   * candidates just as fast as old ones resolve (so `inFlightCount` never
   * reaches 0 and the "in-flight could still rescue the rate" condition
   * never goes false). Once `now - firstInFlightDeferralAt` reaches
   * `AreaYieldLimits.inFlightGraceMs`, `classifyAreaYield` stops deferring
   * and evaluates yield from whatever terminal evidence exists so far —
   * even with candidates still in-flight — so a genuinely low-yield area
   * can no longer stall a rotation decision forever.
   */
  firstInFlightDeferralAt: number | null;
};

export function createAreaProductivityState(now: number = Date.now()): AreaProductivityState {
  return {
    startedAt: now,
    firstQualifiedAt: null,
    lastQualifiedAt: null,
    qualifiedCount: 0,
    deliveredCount: 0,
    stoppedReason: null,
    lastProductiveActivityAt: now,
    lastProductiveEventType: null,
    newlyDiscoveredCount: 0,
    newlyQueuedCount: 0,
    inFlightCount: 0,
    terminalCandidateCount: 0,
    yieldEvaluationDeferredDueToInflight: false,
    firstInFlightDeferralAt: null,
  };
}

/**
 * PHASE 25 — the narrow, safe productive-activity signal (STEP 3).
 *
 * Call this (directly, or via `recordQualifiedLead`/`recordDeliveredLead`
 * below) ONLY for an event that is genuinely new forward progress:
 *
 *   - a candidate discovered from a provider (a NEW candidate, not a
 *     duplicate/no-op re-seen one)
 *   - a candidate actually admitted/queued for enrichment
 *   - an enrichment stage (website/contact/Instagram) completed successfully
 *   - a lead qualified
 *   - a lead delivered
 *
 * Never call this for a heartbeat, a logging-only line, a duplicate
 * candidate, repeated UI/DOM polling, a rate-limit wait by itself, or a
 * retry loop that produced no new candidate — those must NOT reset the
 * clock, exactly per STEP 3 of the phase prompt.
 */
export function recordProductiveActivity(
  state: AreaProductivityState,
  eventType: ProductiveEventType,
  now: number = Date.now(),
): void {
  state.lastProductiveActivityAt = now;
  state.lastProductiveEventType = eventType;
  // PHASE 30 — candidate-volume counters (see the state field doc comment
  // above). Deliberately only these two event types count as "candidate
  // volume": `enrichment_completed` is progress on a candidate already
  // counted at discovery/queue time, and `qualified`/`delivered` are
  // OUTCOMES the yield classifier measures volume AGAINST, not volume
  // themselves — counting them here too would make the yield rate
  // trivially high for every area regardless of actual yield.
  if (eventType === "candidate_discovered") {
    state.newlyDiscoveredCount += 1;
    state.inFlightCount = Math.max(0, state.newlyDiscoveredCount - state.terminalCandidateCount);
  }
  if (eventType === "candidate_queued") {
    state.newlyQueuedCount += 1;
  }
}

/**
 * PHASE 36 — Record candidate discovery explicitly.
 */
export function recordCandidateDiscovered(state: AreaProductivityState, now: number = Date.now()): void {
  recordProductiveActivity(state, "candidate_discovered", now);
}

/**
 * PHASE 36 — Record candidate queueing explicitly.
 */
export function recordCandidateQueued(state: AreaProductivityState, now: number = Date.now()): void {
  recordProductiveActivity(state, "candidate_queued", now);
}

export type CandidateTerminalOutcome = "qualified" | "rejected" | "early_pruned" | "failed";

/**
 * PHASE 36 — Record a candidate reaching a terminal lifecycle outcome
 * (qualified, rejected, early_pruned, failed).
 */
export function recordCandidateTerminal(
  state: AreaProductivityState,
  outcome: CandidateTerminalOutcome,
  now: number = Date.now(),
): void {
  state.terminalCandidateCount += 1;
  state.inFlightCount = Math.max(0, state.newlyDiscoveredCount - state.terminalCandidateCount);
  if (outcome === "qualified") {
    recordQualifiedLead(state, now);
  }
}

export function recordCandidateRejected(state: AreaProductivityState, now: number = Date.now()): void {
  recordCandidateTerminal(state, "rejected", now);
}

export function recordCandidateEarlyPruned(state: AreaProductivityState, now: number = Date.now()): void {
  recordCandidateTerminal(state, "early_pruned", now);
}

export function recordCandidateFailed(state: AreaProductivityState, now: number = Date.now()): void {
  recordCandidateTerminal(state, "failed", now);
}

/**
 * Call once per lead that passes the engine's existing qualification gate
 * (website + valid email + valid phone + valid Instagram) for this area —
 * i.e. at the exact same point poolExpandJob.ts's `processLead()` already
 * calls `areaRecorder.recordQualified()`. Never weakens or re-implements
 * qualification itself — this only OBSERVES that a lead already qualified,
 * and (PHASE 25) counts as productive activity like any other genuine
 * forward-progress event.
 */
export function recordQualifiedLead(state: AreaProductivityState, now: number = Date.now()): void {
  state.qualifiedCount += 1;
  if (state.terminalCandidateCount < state.qualifiedCount) {
    state.terminalCandidateCount = state.qualifiedCount;
    state.inFlightCount = Math.max(0, state.newlyDiscoveredCount - state.terminalCandidateCount);
  }
  if (state.firstQualifiedAt === null) state.firstQualifiedAt = now;
  state.lastQualifiedAt = now;
  recordProductiveActivity(state, "qualified", now);
}

/**
 * Call once per lead actually delivered for this area. PHASE 25: now also
 * counts as productive activity (it did not before — see the PHASE 12D
 * comment this replaces — but a delivery is strictly the most
 * unambiguous forward-progress signal an area can produce, so excluding
 * it from the productive clock was never intentional, just an artifact of
 * PHASE 12D keying everything off `lastQualifiedAt`).
 */
export function recordDeliveredLead(state: AreaProductivityState, now: number = Date.now()): void {
  state.deliveredCount += 1;
  recordProductiveActivity(state, "delivered", now);
}

/** Tunable stop thresholds — see env.ts for where these defaults come from and why they're safe. */
export type AreaProductivityLimits = {
  /**
   * How long an area may go with NO productive activity (before or after
   * its first qualified lead) before it is considered stalled.
   */
  productiveIdleMs: number;
  /**
   * Hard wall-clock ceiling on one area's total runtime, independent of
   * how much activity it reports — STEP 4's "a pathological provider
   * cannot run forever" bound.
   */
  maxAreaRuntimeMs: number;
};

/**
 * The classifier itself. Pure function of (state, now, limits) — no clock
 * access, no side effects, fully deterministic and unit-testable with a
 * fake `now`.
 *
 * Precedence (STEP 4 / STEP 5 / "exact stop-order precedence" in the final
 * report):
 *   1. `maxAreaRuntimeMs` — checked FIRST and unconditionally, so a
 *      continuously-productive area is still eventually bounded.
 *   2. `productiveIdleMs` since `lastProductiveActivityAt` — the SAME
 *      check both before and after the first qualified lead now (PHASE 25
 *      unifies what used to be two different reference points). The
 *      returned reason string still distinguishes the two cases (STEP 8:
 *      callers/telemetry still care whether this area ever qualified
 *      anything at all), but the elapsed-time math is identical.
 *
 * Never returns a reason based on a fixed qualified-lead COUNT — only
 * elapsed time, exactly per the "no fixed per-area qualified quota"
 * requirement carried over from PHASE 12D.
 */
export function evaluateAreaProductivity(
  state: AreaProductivityState,
  now: number,
  limits: AreaProductivityLimits,
): AreaProductivityStopReason | null {
  if (now - state.startedAt >= limits.maxAreaRuntimeMs) {
    return "area_productivity_max_runtime";
  }

  const idleFor = now - state.lastProductiveActivityAt;
  if (idleFor < limits.productiveIdleMs) return null;

  return state.firstQualifiedAt === null
    ? "area_productivity_timeout_before_first_qualified"
    : "area_productivity_idle_timeout";
}

/**
 * PHASE 30 / PHASE 36 — AREA YIELD / ROTATION OPTIMIZATION (IN-FLIGHT AWARE).
 *
 * `evaluateAreaProductivity` above answers "has this area gone quiet?" —
 * and, by PHASE 25 design, an area that keeps discovering/queueing
 * candidates never goes quiet, no matter how few (or none) of those
 * candidates ever qualify.
 *
 * PHASE 36 Fix: When candidates are still in-flight through the enrichment/
 * qualification pipeline, an area must not be prematurely classified as
 * LOW_YIELD solely from current qualification yield while in-flight count > 0.
 * The yield classifier calculates yield on terminal candidates and defers
 * LOW_YIELD decisions during the in-flight grace window.
 */
export type AreaYieldClass = "productive" | "marginal" | "low_yield";

/** Tunable yield-classification thresholds — see env.ts for defaults and rationale. */
export type AreaYieldLimits = {
  /**
   * Stage A ("early exploration window," STEP 3): an area is never
   * evaluated for yield before BOTH this much wall-clock time AND
   * `minCandidateVolumeForEvaluation` candidates have accumulated. Below
   * either threshold, `classifyAreaYield` always returns "productive" —
   * this is the literal implementation of "do not stop an area solely
   * because qualified=0 if candidate volume is still low."
   */
  minElapsedMsForEvaluation: number;
  /** See `minElapsedMsForEvaluation` — the candidate-volume half of the same gate. */
  minCandidateVolumeForEvaluation: number;
  /**
   * Stage B: once evaluation is allowed, an area whose
   * (qualified ∪ delivered) / candidateVolume ratio is at or below this
   * fraction is classified LOW_YIELD — the only class `evaluateAreaYieldStop`
   * ever stops for.
   */
  lowYieldMaxRate: number;
  /**
   * Ratio strictly above `lowYieldMaxRate` and at or below this fraction is
   * classified MARGINAL — kept alive (STEP 3: "prefer a conservative
   * two-stage model" / test 5's "marginal yield → keep temporarily"), never
   * stopped by this classifier. Must be >= `lowYieldMaxRate`.
   */
  marginalMaxRate: number;
  /**
   * PHASE 36 — In-flight candidate grace duration (ms).
   * Defers LOW_YIELD classification while candidates remain in-flight.
   */
  inFlightGraceMs?: number;
};

/**
 * Pure classifier — deterministic function of (state, now, limits), no
 * clock access, no side effects.
 *
 * PHASE 36: In-Flight Aware Yield Evaluation.
 * 1. If inFlightCount > 0 and within inFlightGraceMs, do not classify LOW_YIELD.
 * 2. When evaluated, calculates yield rate against terminal candidates
 *    (terminalCandidateCount), avoiding dilution by in-flight candidates.
 */
export function classifyAreaYield(
  state: AreaProductivityState,
  now: number,
  limits: AreaYieldLimits,
): AreaYieldClass {
  const elapsedMs = now - state.startedAt;
  const candidateVolume = state.newlyDiscoveredCount + state.newlyQueuedCount;

  // Stage A — early exploration: insufficient signal either way. Never
  // returns low_yield/marginal here, regardless of qualifiedCount.
  if (elapsedMs < limits.minElapsedMsForEvaluation || candidateVolume < limits.minCandidateVolumeForEvaluation) {
    state.yieldEvaluationDeferredDueToInflight = false;
    return "productive";
  }

  // Stage B — pipeline-drain-aware yield evaluation.
  const yieldCount = Math.max(state.qualifiedCount, state.deliveredCount);
  const inFlightCount = state.inFlightCount;
  const terminalCandidates = state.terminalCandidateCount;

  // PHASE 37: If candidates remain in-flight through enrichment/qualification,
  // do not prematurely kill the area as LOW_YIELD while in-flight candidates could still
  // produce qualified leads or before sufficient terminal evidence has accumulated.
  //
  // PHASE 41 — REGRESSION FIX: that deferral is now BOUNDED. A discovery
  // stream that keeps adding fresh in-flight candidates just as fast as
  // old ones resolve can hold `inFlightCount > 0` (and therefore
  // `maxPossibleRate` optimistically high) indefinitely — the low-yield
  // stop then never fires and the area burns the full max-runtime ceiling
  // instead of rotating. In-flight candidates may still defer a low-yield
  // call TEMPORARILY (unchanged), but once `inFlightGraceMs` has elapsed
  // since the FIRST such deferral, the area is evaluated on whatever
  // terminal evidence it has actually accumulated so far, in-flight
  // candidates or not.
  if (inFlightCount > 0) {
    const maxPossibleRate = (terminalCandidates + inFlightCount) > 0
      ? (yieldCount + inFlightCount) / (terminalCandidates + inFlightCount)
      : 0;

    // Would in-flight candidates justify deferring, on the ORIGINAL
    // (unbounded) Phase 37 rule?
    const wantsDeferral =
      maxPossibleRate > limits.lowYieldMaxRate || terminalCandidates < limits.minCandidateVolumeForEvaluation;

    if (wantsDeferral) {
      const graceMs = limits.inFlightGraceMs ?? Infinity;
      if (state.firstInFlightDeferralAt === null) {
        state.firstInFlightDeferralAt = now;
      }
      const withinGraceWindow = now - state.firstInFlightDeferralAt < graceMs;
      if (withinGraceWindow) {
        state.yieldEvaluationDeferredDueToInflight = true;
        return "productive";
      }
      // Grace window exhausted — fall through to terminal-evidence
      // evaluation below even though candidates remain in-flight.
    }
  }

  const denominator = terminalCandidates > 0 ? terminalCandidates : candidateVolume;
  const rate = denominator > 0 ? yieldCount / denominator : 0;

  if (rate <= limits.lowYieldMaxRate) {
    state.yieldEvaluationDeferredDueToInflight = false;
    return "low_yield";
  }

  state.yieldEvaluationDeferredDueToInflight = false;
  if (rate <= limits.marginalMaxRate) return "marginal";
  return "productive";
}

/**
 * STEP 3's stop decision: ONLY a `low_yield` classification may cause a
 * stop. `productive` and `marginal` both return null (marginal is kept
 * "temporarily" — it may still transition to low_yield or productive on a
 * later poll as more candidates/qualifications arrive).
 *
 * Deliberately returns only a stop reason, not a boolean — mirrors
 * `evaluateAreaProductivity`'s shape so both can be polled the same way by
 * the same timer (see poolExpandJob.ts's `runArea`), with the SAME
 * per-area-only, sibling-safe stopping mechanism (`scopeAreaAbort`) below.
 */
export function evaluateAreaYieldStop(
  state: AreaProductivityState,
  now: number,
  limits: AreaYieldLimits,
): "area_productivity_low_yield" | null {
  return classifyAreaYield(state, now, limits) === "low_yield" ? "area_productivity_low_yield" : null;
}

/**
 * STOPPING MECHANISM — per-area scoped abort. (Unchanged from PHASE 12D.)
 *
 * Wraps a parent (job-level) AbortSignal in a NEW, per-area AbortController
 * whose signal:
 *   - aborts automatically if/when the parent signal aborts (so the
 *     existing global TARGET_REACHED/USER_CANCELLED/EXHAUSTED abort path
 *     still reaches every area exactly as today), AND
 *   - can ALSO be aborted independently, by calling the returned
 *     `controller`'s own `.abort(reason)` (e.g. when this area's own
 *     productivity timer fires) — which affects ONLY this one area's
 *     engine subprocess (the caller must pass the returned `signal`, not
 *     the parent signal, into that area's own `runEngineQuery()` call).
 *
 * Deliberately implemented with a plain `addEventListener` forward instead
 * of relying on `AbortSignal.any()` so this module has no minimum-Node-
 * version assumption baked in and the forwarding behavior is explicit and
 * easy to unit test.
 */
export function scopeAreaAbort(parentSignal: AbortSignal): { signal: AbortSignal; controller: AbortController } {
  const controller = new AbortController();
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });
  }
  return { signal: controller.signal, controller };
}
