/**
 * PHASE 5 — target-aware discovery stopping: per-round sizing formulas.
 *
 * Extracted out of poolExpandJob.ts (both the legacy sequential path and
 * the curated-area pooled path use these) so the exact formulas that
 * decide how much a single engine subprocess is asked to scan/deliver are
 * directly unit-testable, without needing to spin up the rest of that
 * file's Supabase/pg-boss machinery.
 *
 * THE BUG THIS REPLACES: before this phase, `askFor` (the raw Maps scan
 * budget, passed as `max_results`) floored on the FIXED, full
 * `payload.shortfall` — never the shrinking `stillNeededNow()` — and
 * `deliver_target` (the true qualified-lead stopping point) was never
 * sent to the Python engine at all, so it silently fell back to
 * `max_results`. Together, this meant every round's engine subprocess
 * chased a qualified-lead target many times larger than what was actually
 * still needed, long after sibling areas/cities had already delivered
 * enough leads to satisfy the user.
 *
 * THE FIX: both `streamTarget` (this round's real, current need — used as
 * `deliver_target`) and `askFor` (the scan-budget floor) are derived from
 * the LIVE remaining amount at call time, not a value fixed at job start.
 */

/**
 * Per-round qualified-lead target for the CURATED-AREA pooled path
 * (`runGoogleAreaPoolForCity` in poolExpandJob.ts). Clamped to at least 1
 * (an area worker is never started for a genuinely zero-need round — the
 * caller already checks `stillNeededNow() <= 0` first) and at most
 * `floor` (the streaming batch floor, so one area never tries to single-
 * handedly deliver the entire remaining target).
 */
export function areaStreamTarget(remaining: number, floor: number): number {
  return Math.max(Math.min(remaining, floor), 1);
}

/**
 * Per-round qualified-lead target for the LEGACY sequential path (no
 * curated areas for this city). `chunk` is the country-rotation fairness
 * share (diversity accounting only, from `CountryRotation.chunkSize()`);
 * `floor` is the same streaming batch floor as the area path.
 */
export function cityStreamTarget(remaining: number, chunk: number, floor: number): number {
  return Math.min(remaining, Math.max(chunk, floor));
}

/**
 * Raw Maps scan budget (`max_results`) for a round asking for
 * `streamTarget` qualified leads. Intentionally larger than
 * `streamTarget` (a fixed multiplier buffer for enrichment/filter/dedup
 * losses) — but, since this phase's fix, floored on `streamTarget`
 * itself rather than the full original (and never-shrinking) job target.
 */
export function computeAskFor(streamTarget: number, multiplier = 4): number {
  return Math.max(streamTarget * multiplier, streamTarget);
}
