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
  | "area_productivity_max_runtime";

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
