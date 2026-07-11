/**
 * Gradual confidence model (Phase 7). Confidence is a 0-100 trust signal on
 * `businesses`, NOT a binary "verified" flag — it moves incrementally, and
 * only repeated failures (confidence bottoming out) triggers archiving.
 * Businesses are NEVER deleted; archiving just stops them from being
 * delivered to users (see pool_lookup's `archived_at is null` filter).
 *
 * Tuning these numbers is a product decision, not a technical one — kept
 * as named constants in one place for that reason.
 */

/** The "verification interval" from the product doc — ~14 days, applied identically whether a business was fully re-verified or just naturally rediscovered. */
export const VERIFICATION_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/** How much sooner to re-check a business that just failed verification (not yet archived) — closer monitoring than the standard interval. */
export const FAILED_VERIFICATION_RECHECK_MS = 3 * 24 * 60 * 60 * 1000;

export const CONFIDENCE_DEFAULT = 65; // a fresh discovery: plausible, not yet independently re-verified
export const CONFIDENCE_MAX = 100;
export const CONFIDENCE_MIN = 0;

const FULL_VERIFICATION_SUCCESS_DELTA = 15;
const REDISCOVERY_SUCCESS_DELTA = 8; // smaller bump — incidental, not a deliberate check
const VERIFICATION_FAILURE_DELTA = -30;

/** Confidence at or below this, after a failure, triggers archiving. */
export const ARCHIVE_THRESHOLD = 10;

const clampConfidence = (n: number) => Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, n));

export function applyFullVerificationSuccess(current: number): number {
  return clampConfidence(current + FULL_VERIFICATION_SUCCESS_DELTA);
}

export function applyRediscoverySuccess(current: number): number {
  return clampConfidence(current + REDISCOVERY_SUCCESS_DELTA);
}

export function applyVerificationFailure(current: number): number {
  return clampConfidence(current + VERIFICATION_FAILURE_DELTA);
}

export function shouldArchive(confidenceAfterFailure: number): boolean {
  return confidenceAfterFailure <= ARCHIVE_THRESHOLD;
}
