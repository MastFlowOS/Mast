/**
 * PHASE 5 — target-aware discovery stopping: per-round sizing formulas.
 * PHASE 10 — run-to-run stability: reverted the child-budget regression
 * Phase 5 introduced (see below).
 *
 * Extracted out of poolExpandJob.ts (both the legacy sequential path and
 * the curated-area pooled path use these) so the exact formulas that
 * decide how much a single engine subprocess is asked to scan/deliver are
 * directly unit-testable, without needing to spin up the rest of that
 * file's Supabase/pg-boss machinery.
 *
 * PHASE 5's BUG (original): before that phase, `askFor` (the raw Maps
 * scan budget, passed as `max_results`) floored on the FIXED, full
 * `payload.shortfall` — never the shrinking `stillNeededNow()` — and
 * `deliver_target` (the true qualified-lead stopping point) was never
 * sent to the Python engine at all, so it silently fell back to
 * `max_results`.
 *
 * PHASE 5's FIX (the regression this phase reverts): it made `streamTarget`
 * — and therefore `deliver_target`, and `askFor` derived from it — shrink
 * to `Math.min(stillNeededNow(), STREAM_BATCH_FLOOR)`. For a completely
 * normal 10-lead request, `STREAM_BATCH_FLOOR=5` used as an UPPER bound
 * (via `Math.min`) collapsed every single child's `deliver_target` to 5,
 * regardless of how many leads the request actually still needed. Each
 * area's Google Maps session is expensive to start (browser launch, page
 * load, scroll, scrape) — asking it for only 5 qualified leads when 10
 * were needed starves that expensive session of a productive target,
 * forcing MANY MORE areas/rounds to be claimed to reach the same total.
 * That is the direct root cause of both the observed run-to-run runtime
 * variance (more rounds = more chances for one slow area to dominate a
 * run) and the `[discovery-capacity]` log storm (every extra round
 * re-enters `runGoogleAreaPoolForCity()`, which re-creates the area
 * worker pool and re-logs its one-line sizing decision — see
 * `googleAreaPool.ts`).
 *
 * PHASE 10's FIX: `deliver_target` is the AUTHORITATIVE GLOBAL TARGET
 * (`target` — the plan's fixed requested/shortfall quantity for this
 * run), never the shrinking live remaining. `floor`/`chunk` are true
 * lower bounds (never upper caps) on top of it. Overshoot across
 * concurrent sibling areas/cities is prevented independently — by
 * `abortController.abort("TARGET_REACHED")` the instant the GLOBAL
 * delivered count actually reaches `target` (see `processLead()` in
 * poolExpandJob.ts) — not by asking each child for less than it could
 * productively deliver in one session.
 */

/**
 * Per-round qualified-lead target for the CURATED-AREA pooled path
 * (`runGoogleAreaPoolForCity` in poolExpandJob.ts). `target` is the
 * request's fixed, authoritative requested quantity (`payload.shortfall`)
 * — NOT the live shrinking remaining. `floor` is a true minimum (never a
 * cap): the result is never smaller than either `target` or `floor`.
 */
export function areaStreamTarget(target: number, floor = 1): number {
  return Math.max(target, floor);
}

/**
 * Per-round qualified-lead target for the LEGACY sequential path (no
 * curated areas for this city). `target` is the same fixed authoritative
 * quantity as `areaStreamTarget`; `chunk` is the country-rotation
 * fairness share (diversity accounting only, from
 * `CountryRotation.chunkSize()`) and `floor` is the same streaming-batch
 * floor as the area path — both are true minimums, never caps.
 */
export function cityStreamTarget(target: number, chunk: number, floor = 1): number {
  return Math.max(target, chunk, floor);
}

/**
 * Raw Maps scan budget (`max_results`) for a round asking for
 * `streamTarget` qualified leads. Intentionally larger than
 * `streamTarget` (a fixed multiplier buffer for enrichment/filter/dedup
 * losses), and always derived from `streamTarget` itself — `deliver_target`
 * (== streamTarget) and `max_results` (== askFor) are computed
 * independently and both sent to the Python engine; the engine never
 * silently substitutes one for the other (see service.py's
 * `_deliver_target` fallback, which only applies when `deliver_target` is
 * omitted entirely — it never is, from either call site below).
 */
export function computeAskFor(streamTarget: number, multiplier = 4): number {
  return Math.max(streamTarget * multiplier, streamTarget);
}
