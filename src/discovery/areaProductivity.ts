/**
 * PHASE 12D — Hybrid adaptive area stopping.
 *
 * Pure, DB-free, engine-free "time since last qualification" classifier —
 * mirrors the existing split in this directory (googleAreaPool.ts,
 * roundSizing.ts, areaRotation.ts, runStabilityTelemetry.ts) between pure
 * policy/arithmetic and the actual Postgres/engine wiring, which lives in
 * poolExpandJob.ts's `runArea()`.
 *
 * SCOPE (see the phase prompt this implements): this module does NOT decide
 * how many leads an area is allowed to deliver, and it does NOT compare one
 * area's progress to another's. It only answers one question, given one
 * area's own history: "has this area gone quiet for long enough that it
 * should be replaced?" A productive area (one that keeps producing
 * qualified leads) is never stopped by this classifier, no matter how long
 * it runs or how much slower it is than a sibling area.
 *
 * Two clocks, not one:
 *   - Before the first qualified lead: the clock is "time since this area
 *     started" (`startedAt`). This is the bounded EXPLORATION window every
 *     area gets, regardless of how fast/slow other areas are producing.
 *   - After the first qualified lead: the clock resets to "time since the
 *     MOST RECENT qualified lead" (`lastQualifiedAt`). This is the
 *     INACTIVITY window — a productive area keeps resetting this clock
 *     every time it qualifies another lead, so it is never stopped while it
 *     keeps producing.
 *
 * Both windows currently share one config knob (`AREA_PRODUCTIVITY_IDLE_MS`
 * in src/config/env.ts) — see that constant's own doc comment for why, and
 * for the audit range the default was grounded in.
 */

export type AreaProductivityStopReason =
  | "area_productivity_timeout_before_first_qualified"
  | "area_productivity_idle_timeout";

/**
 * One area worker's live productivity state — deliberately minimal (per the
 * phase prompt's "LIVE STATE" section): no candidate-quality heuristics, no
 * rating/review/name scoring, just enough to run the "time since last
 * qualification" classifier and to report what happened afterward.
 */
export type AreaProductivityState = {
  readonly startedAt: number;
  firstQualifiedAt: number | null;
  lastQualifiedAt: number | null;
  qualifiedCount: number;
  deliveredCount: number;
  stoppedReason: AreaProductivityStopReason | null;
};

export function createAreaProductivityState(now: number = Date.now()): AreaProductivityState {
  return {
    startedAt: now,
    firstQualifiedAt: null,
    lastQualifiedAt: null,
    qualifiedCount: 0,
    deliveredCount: 0,
    stoppedReason: null,
  };
}

/**
 * Call once per lead that passes the engine's existing qualification gate
 * (website + valid email + valid phone + valid Instagram) for this area —
 * i.e. at the exact same point poolExpandJob.ts's `processLead()` already
 * calls `areaRecorder.recordQualified()`. Resets the inactivity clock.
 * Never weakens or re-implements qualification itself — this only OBSERVES
 * that a lead already qualified.
 */
export function recordQualifiedLead(state: AreaProductivityState, now: number = Date.now()): void {
  state.qualifiedCount += 1;
  if (state.firstQualifiedAt === null) state.firstQualifiedAt = now;
  state.lastQualifiedAt = now;
}

/** Call once per lead actually delivered for this area — observational only, does not affect the classifier below. */
export function recordDeliveredLead(state: AreaProductivityState): void {
  state.deliveredCount += 1;
}

/**
 * The classifier itself. Pure function of (state, now, idleMs) — no clock
 * access, no side effects, fully deterministic and unit-testable with a
 * fake `now`.
 *
 * Returns the stop reason once the relevant window has elapsed with no
 * qualification, or `null` if the area should keep running. Never returns a
 * reason based on a fixed qualified-lead COUNT — only elapsed time since
 * the relevant reference point, exactly per the phase prompt's "no fixed
 * per-area qualified quota" requirement.
 */
export function evaluateAreaProductivity(
  state: AreaProductivityState,
  now: number,
  idleMs: number,
): AreaProductivityStopReason | null {
  if (state.firstQualifiedAt === null) {
    // Bounded exploration window — this area has not yet produced a single
    // qualified lead. It gets the FULL window regardless of how much
    // slower it is than any sibling area (no cross-area comparison here).
    return now - state.startedAt >= idleMs ? "area_productivity_timeout_before_first_qualified" : null;
  }
  // At least one qualified lead so far — the clock is "time since the most
  // recent one", not total runtime, so a steadily-productive area is never
  // stopped no matter how long it has been running.
  const referencePoint = state.lastQualifiedAt ?? state.firstQualifiedAt;
  return now - referencePoint >= idleMs ? "area_productivity_idle_timeout" : null;
}

/**
 * STOPPING MECHANISM — per-area scoped abort.
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
