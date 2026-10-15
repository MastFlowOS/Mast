/**
 * Live Discovery — pre-upsert early prune (plan-based path).
 *
 * WHY THIS EXISTS
 * ---------------
 * `handleDiscoveryTask` used to run the Maps-checkable channel gate (phone /
 * website) only AFTER `upsertBusinessFromEngineLead()` and
 * `enqueueBusinessProcessing(..., "enrich")` — so a lead that could never
 * satisfy the user's request was still written to `businesses` and had an
 * enrichment job queued before being thrown away.
 *
 * This module holds the SAME decision, evaluated on data already present on
 * the engine lead, so it can run before either of those. It deliberately
 * reuses `channelsSatisfied` (src/lib/channelFilter.ts) rather than
 * re-implementing the predicate, so the verdict is identical to the gate it
 * replaces — only the position in the pipeline changes.
 *
 * WHAT IS (AND IS NOT) DECIDED HERE
 * ---------------------------------
 * Only channels whose Live Discovery verdict depends SOLELY on the lead:
 *
 *   website, phone  -> the post-upsert gate this replaces was strict on the
 *                      lead (no enrichment stage is consulted for them), so
 *                      rejecting earlier cannot change any delivered result.
 *
 * email and instagram are intentionally NOT decided here. They can be
 * satisfied later by the enrichment workflow (website crawl) or by an
 * existing `businesses` row found during upsert, neither of which is visible
 * on the lead. A missing email/instagram on the lead is therefore never a
 * reason to reject at this stage.
 *
 * RATING / REVIEW COUNT (decided elsewhere)
 * -----------------------------------------
 * `lead.rating` / `lead.reviews` are populated only AFTER the engine has
 * opened the business detail panel (the expensive step). Pre-click, the only
 * source is the results-card text, which maps_scraper.py documents as
 * best-effort/informational ("NOTHING below may branch discovery behavior on
 * them"), so it is deliberately NOT used for rejection. The internal
 * rating/review gate therefore runs in handleDiscoveryTask right after the
 * panel-derived lead arrives and before the upsert, via `evaluateLeadQuality`
 * (src/lib/leadQualityPolicy.ts; thresholds are server-side defaults, absent
 * or unparsed values never reject). It saves the upsert/enrichment, not the
 * panel click.
 *
 * TRADE-OFF (deliberate, per the "reject before database writes" goal):
 * a lead rejected here is no longer persisted to the shared `businesses`
 * pool as a side effect. Previously such leads were upserted first, which
 * incidentally seeded the pool for other users with different channel
 * needs.
 */

import { channelsSatisfied, type ChannelCandidate } from "../lib/channelFilter.js";

/** Channels decidable from the Maps lead alone. Order is irrelevant. */
const LEAD_ONLY_CHANNELS: readonly string[] = ["phone", "website"];

/**
 * The subset of `requested` whose verdict depends only on data already on
 * the lead. Preserves request order and drops duplicates.
 */
export function leadOnlyChannels(requested: readonly string[]): string[] {
  const out: string[] = [];
  for (const ch of requested) {
    if (LEAD_ONLY_CHANNELS.includes(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/**
 * Channels it is safe to forward to the Python engine as `required_channels`
 * for the discovery_only path. Identical to `leadOnlyChannels` on purpose:
 * the engine must never prune on a channel Node itself would not prune on at
 * this stage (see module doc — email/instagram stay with enrichment).
 */
export function engineRequiredChannels(requested: readonly string[]): string[] {
  return leadOnlyChannels(requested);
}

export type EarlyPruneDecision =
  | { prune: false }
  | {
      prune: true;
      /** Channels (from the lead-only subset) that are absent on the lead. */
      missing: string[];
      /**
       * Reason string in the SAME format the post-upsert gate emitted, so
       * the existing `candidate_rejected` consumers/dashboards are
       * unaffected by the reorder.
       */
      reason: string;
      /** The lead-only channel list that was evaluated. */
      evaluated: string[];
    };

/**
 * Decide whether a lead can be rejected before any persistence or
 * enrichment scheduling. Pure: no I/O, no clock, no logging.
 */
export function evaluateEarlyChannelPrune(
  lead: ChannelCandidate,
  requested: readonly string[],
): EarlyPruneDecision {
  const evaluated = leadOnlyChannels(requested);
  if (channelsSatisfied(lead, evaluated)) return { prune: false };
  const missing = evaluated.filter((ch) => !channelsSatisfied(lead, [ch]));
  return {
    prune: true,
    missing,
    evaluated,
    reason: `maps_channel_gate:requested=${JSON.stringify(evaluated)}`,
  };
}
