/**
 * CRITMODE — user-scoped target accounting.
 *
 * ROOT CAUSE (production incident): a `followUp` pool-expand run requested
 * N leads for a specific user (`payload.shortfall`), but poolExpandJob.ts's
 * stop condition and remaining-need calculation both allowed the run to
 * finish once `delivered` (a pool-wide counter — every business newly
 * added to the Global Lead Pool by this run, regardless of who it's new
 * for) reached N, OR'd/mixed in with `newForUser` (the count of NEW
 * user-owned `leads` rows actually prepared for the requesting user).
 *
 * Confirmed production log:
 *   parent_delivered=10   (pool-wide `delivered`)
 *   newForUser=9          (user-scoped — what the frontend correctly showed)
 * The run terminated successfully at parent_delivered=10, one short of what
 * the user actually asked for, because one of the 10 pool deliveries was a
 * business the requesting user already owned (`wasNewForUser: false` —
 * correctly NOT charged a credit / NOT a new CRM row by insertLeadForUser()
 * in deliverLead.ts) yet it still counted toward the pool-wide `delivered`
 * counter that the (buggy) stop condition also accepted.
 *
 * THE INVARIANT this module enforces:
 *   For a user request of N leads, the run must not be considered complete
 *   until N genuinely NEW user-owned lead records have been prepared for
 *   that user — never before, regardless of how many pool-wide deliveries
 *   (`delivered`) happened along the way. A business the requesting user
 *   already owns must not consume a target slot (enforced upstream, in
 *   insertLeadForUser() — see deliverLead.ts — which never charges/creates
 *   a CRM row for it and therefore never increments `newForUser`), but
 *   another user may still receive that same business independently
 *   (insertLeadForUser() is keyed on `(user_id, business_id)`, not global).
 *
 * A bare pool-growth run (no followUp / no specific waiting user) has no
 * per-user notion at all — for that case only, the pool-wide `delivered`
 * counter IS the correct measure of "has this run grown the pool by N",
 * exactly as before.
 *
 * Extracted out of poolExpandJob.ts (both the legacy sequential path and
 * the curated-area pooled path funnel every stop/remaining-need decision
 * through processLead(), which now calls these) so the exact accounting
 * rule is directly unit-testable without needing to spin up the rest of
 * that file's Supabase/pg-boss/browser-slot machinery — same precedent as
 * roundSizing.ts / areaProductivity.ts.
 */

export type TargetAccountingState = {
  /** The fixed, authoritative requested quantity for this run (payload.shortfall). */
  shortfall: number;
  /**
   * Count of businesses newly added to the Global Lead Pool by this run —
   * pool-wide, NOT scoped to any particular user. A business the
   * requesting user already owned still increments this (it may be a
   * business new to the pool but not new to this specific user, or vice
   * versa — either way this counter alone never answers "has the
   * requesting user's request been satisfied").
   */
  delivered: number;
  /**
   * Count of genuinely NEW user-owned `leads` rows prepared for the
   * followUp.userId this run is delivering to. Only meaningful when a
   * followUp is present; a duplicate-for-this-user delivery
   * (`wasNewForUser: false`) never increments this.
   */
  newForUser: number;
  /**
   * Whether this run is a followUp for a specific waiting user. When
   * false, there is no per-user notion at all and `delivered` (pool-wide)
   * is the correct measure of "has this run grown the pool by N".
   */
  hasFollowUp: boolean;
};

/**
 * How many more leads this run still needs to prepare/deliver before it
 * may stop. For a followUp run this is ALWAYS `shortfall - newForUser` —
 * for the ENTIRE run, not just once newForUser happens to be nonzero (that
 * was the original ternary bug: `followUp && newForUser > 0 ? ... :
 * ...delivered` fell back to the pool-wide counter for every lead up to
 * and including the first genuinely-new-for-this-user delivery).
 */
export function remainingTarget(state: TargetAccountingState): number {
  const denominator = state.hasFollowUp ? state.newForUser : state.delivered;
  return state.shortfall - denominator;
}

/**
 * Whether this run's requested target has been genuinely satisfied and it
 * may stop successfully. For a followUp run, ONLY `newForUser` — the count
 * of NEW user-owned lead records actually prepared for the requesting
 * user — can satisfy this. The pool-wide `delivered` counter must never be
 * allowed to satisfy a followUp run's target on its own; that is the exact
 * production regression this function fixes.
 */
export function isTargetReached(state: TargetAccountingState): boolean {
  return remainingTarget(state) <= 0;
}

/**
 * The value to report/log as "how many did this run actually deliver
 * against the requested target" — same user-scoped rule as
 * remainingTarget()/isTargetReached(), used for job_summary /
 * SUMMARY-telemetry reporting so every surface (stop decision, remaining
 * need, and reported outcome) agrees on the same number.
 */
export function reportedDelivered(state: TargetAccountingState): number {
  return state.hasFollowUp ? state.newForUser : state.delivered;
}
