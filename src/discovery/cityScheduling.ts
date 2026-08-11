export type CityAttempt = {
  city: string;
  country: string;
  niche: string;
  attempted: boolean;
  productive: boolean;
  candidatesFound: number;
  acceptedLeads: number;
};

export type CityTransitionReason =
  | "CITY_PRODUCTIVE"
  | "CITY_NO_PROGRESS"
  | "CITY_EXHAUSTED"
  | "CITY_ROTATION"
  | "USER_CANCELLED"
  | "TARGET_REACHED"
  | "WATCHDOG_TIMEOUT"
  | "SCRAPER_FAILURE";

/**
 * Mirrors `EngineDoneInfo["terminationReason"]` (src/scraperBridge/pythonBridge.ts)
 * field-for-field — the bridge's own, already-computed classification of
 * why a single `runEngineQuery()` call ended. Declared locally rather than
 * imported so this module (and its tests) stay independent of the bridge's
 * module-load side effects (env.ts's zod-validated config), exactly the
 * same "string union, not a cross-module import" pattern pythonBridge.ts
 * itself already uses for `EngineDiscoveryFailureReason` mirroring the
 * Python-side enum.
 */
export type EngineTerminationReason =
  | "SUCCESS_TARGET_REACHED"
  | "SUCCESS_EXHAUSTED"
  | "WATCHDOG_TIMEOUT"
  | "CANCELLED"
  | "FAILURE";

/**
 * A city is productive when it is still producing candidates that survive
 * the request's acceptance gate.  This is intentionally not tied to how
 * close the whole request is to its target: one accepted lead is evidence
 * that continuing the current city is useful.
 *
 * MINIMAL FIX (discovery liveness / city failure classification — forensic
 * audit §9): `terminationReason`, when supplied, is the bridge's own
 * already-computed classification of how this run ended (see
 * `EngineDoneInfo.terminationReason` in pythonBridge.ts) — it is consulted
 * BEFORE falling back to the coarse `exhausted` boolean, so a watchdog
 * kill or an unclassified scraper failure is never bucketed as genuine
 * `CITY_EXHAUSTED`/`CITY_NO_PROGRESS` just because `exhausted` happens to
 * be `false` on every failed run (see cityScheduling's own prior
 * behavior, and discoveryPlanJob.ts, both audited). `acceptedLeads > 0`
 * still wins first, unconditionally — a city that already produced a real,
 * accepted lead is productive regardless of how the run subsequently
 * ended (e.g. a crash right after the one lead that mattered was already
 * delivered — see audit §12's "Candidate yielded, then crash before
 * __done__" row). `terminationReason` absent (the default) preserves the
 * exact previous two-argument behavior for any existing caller/test.
 */
export function cityTransitionFor(
  attempt: Pick<CityAttempt, "candidatesFound" | "acceptedLeads">,
  exhausted: boolean,
  terminationReason?: EngineTerminationReason,
): CityTransitionReason {
  if (attempt.acceptedLeads > 0) return "CITY_PRODUCTIVE";
  if (terminationReason === "WATCHDOG_TIMEOUT") return "WATCHDOG_TIMEOUT";
  // "FAILURE" is the bridge's catch-all for "!success, not CANCELLED" —
  // i.e. a genuine scraper failure (unrecoverable DiscoveryFailure /
  // unclassified error after every crash-retry attempt was exhausted).
  // Not exhaustion: the search never got far enough to genuinely run out
  // of results, it broke.
  if (terminationReason === "FAILURE") return "SCRAPER_FAILURE";
  return exhausted ? "CITY_EXHAUSTED" : "CITY_NO_PROGRESS";
}

/** Request-scoped memory: a location has one normal attempt per plan. */
export function shouldScheduleCity(attempt: Pick<CityAttempt, "attempted">): boolean {
  return !attempt.attempted;
}
