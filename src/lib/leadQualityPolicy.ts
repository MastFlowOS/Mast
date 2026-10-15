/**
 * Internal lead-quality policy (rating / review count).
 *
 * INTERNAL ONLY: these thresholds are server-side defaults. They are not part
 * of the discover request, not user-configurable, and not shown in the UI.
 * Change them here — this is the only place the numbers live. The SQL side
 * (migrations/040) receives them as arguments from `POOL_QUALITY_ARGS`, so the
 * pool query and the live gate can never drift apart.
 *
 * FIELD CONTRACT (verified against maps_scraper.py / utils/parsing.py):
 *   engine lead : `rating` (number | null), `reviews` (number)
 *   businesses  : `reviews_rating`, `reviews_count`
 * These are different spellings of the same two facts, mapped explicitly by
 * the callers — never by guessing names. (`review_count` is only the
 * best-effort results-card key in the scraper and is not used here.)
 *
 * MISSING / MALFORMED POLICY ("unknown never rejects"):
 * The scraper emits `rating = null` when the rating was not found/parsed (or
 * parsed > 5) and `reviews = 0` when the count was not found/parsed — so 0
 * reviews and "extraction failed" are indistinguishable. Rejecting on those
 * would discard potentially valid leads over a selector miss. Therefore a
 * value is only judged when it was positively observed:
 *   rating  : finite number in (0, 5]            -> judged; anything else unknown
 *   reviews : finite number > 0                   -> judged; 0/negative/NaN unknown
 * Unknown values pass this gate. Consequence (documented risk): a business
 * that genuinely has zero reviews / no rating is not rejected by this gate.
 */

export type LeadQualityPolicy = {
  /** Minimum star rating (inclusive). */
  minRating: number;
  /** Minimum number of reviews (inclusive). */
  minReviewCount: number;
};

export const DEFAULT_LEAD_QUALITY_POLICY: Readonly<LeadQualityPolicy> = Object.freeze({
  minRating: 4.0,
  minReviewCount: 20,
});

/** Rating above this is not a real Google rating (scraper also nulls it). */
const MAX_RATING = 5;

/** Coerce to a finite number; numeric strings accepted, everything else null. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The rating if positively observed, else null (= unknown). */
export function observedRating(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n > 0 && n <= MAX_RATING ? n : null;
}

/** The review count if positively observed, else null (= unknown). */
export function observedReviewCount(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

export type LeadQualityInput = {
  rating?: unknown;
  reviews?: unknown;
};

export type LeadQualityDecision =
  | { reject: false }
  | { reject: true; reason: string; failed: Array<"rating" | "reviews"> };

/**
 * Pure verdict on a lead's observed rating/review count. No I/O.
 * Callers map their own field names into `{ rating, reviews }`.
 */
export function evaluateLeadQuality(
  input: LeadQualityInput,
  policy: LeadQualityPolicy = DEFAULT_LEAD_QUALITY_POLICY,
): LeadQualityDecision {
  const rating = observedRating(input.rating);
  const reviews = observedReviewCount(input.reviews);
  const failed: Array<"rating" | "reviews"> = [];
  if (rating !== null && rating < policy.minRating) failed.push("rating");
  if (reviews !== null && reviews < policy.minReviewCount) failed.push("reviews");
  if (failed.length === 0) return { reject: false };
  return {
    reject: true,
    failed,
    reason: `quality_gate:${failed.join("+")}(rating=${rating},reviews=${reviews},min_rating=${policy.minRating},min_reviews=${policy.minReviewCount})`,
  };
}

/** Arguments the pool SQL function receives (same policy as the live gate). */
export const POOL_QUALITY_ARGS = {
  p_min_rating: DEFAULT_LEAD_QUALITY_POLICY.minRating,
  p_min_reviews: DEFAULT_LEAD_QUALITY_POLICY.minReviewCount,
} as const;
