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
 * A city is productive when it is still producing candidates that survive
 * the request's acceptance gate.  This is intentionally not tied to how
 * close the whole request is to its target: one accepted lead is evidence
 * that continuing the current city is useful.
 */
export function cityTransitionFor(attempt: Pick<CityAttempt, "candidatesFound" | "acceptedLeads">, exhausted: boolean): CityTransitionReason {
  if (attempt.acceptedLeads > 0) return "CITY_PRODUCTIVE";
  return exhausted ? "CITY_EXHAUSTED" : "CITY_NO_PROGRESS";
}

/** Request-scoped memory: a location has one normal attempt per plan. */
export function shouldScheduleCity(attempt: Pick<CityAttempt, "attempted">): boolean {
  return !attempt.attempted;
}
