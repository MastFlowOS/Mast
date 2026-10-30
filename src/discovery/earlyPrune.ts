/**
 * Live Discovery — pre-upsert early prune (plan-based path).
 *
 * WHY THIS EXISTS
 * ---------------
 * `handleDiscoveryTask` runs the early channel gate to prune candidates that
 * definitely cannot satisfy the user's requested channels BEFORE
 * `upsertBusinessFromEngineLead()` and `enqueueBusinessProcessing(..., "enrich")`
 * — so candidates with unrecoverable missing channels are not needlessly persisted
 * or crawled.
 *
 * RECOVERABLE CHANNELS (Phase 1 Fix):
 * If a requested channel (e.g. phone, email, instagram) is missing from the
 * initial Google Maps candidate but can still be discovered from an available,
 * usable website, we do NOT reject the candidate at this stage. Instead, the
 * candidate proceeds to enrichment (ContactWorker/WebsiteWorker) to attempt
 * extraction.
 *
 * UNRECOVERABLE CHANNELS:
 * - Missing website when website is requested: permanently unsatisfiable -> prune.
 * - Missing phone when phone is requested AND no usable website is present:
 *   cannot be discovered downstream -> prune.
 * - Missing email/instagram when requested AND no usable website is present:
 *   cannot be discovered downstream -> prune.
 *
 * Final strict channel validation occurs post-enrichment before delivery,
 * preserving full AND semantics across all user-selected channels.
 */

import { channelsSatisfied, type ChannelCandidate } from "../lib/channelFilter.js";
import { isValidWebsite } from "../lib/leadValidation.js";

/** Channels decidable from the Maps lead alone or requiring Maps presence. */
const LEAD_ONLY_CHANNELS: readonly string[] = ["phone", "website"];

/**
 * The subset of `requested` whose verdict depends on data on the lead.
 * Preserves request order and drops duplicates.
 */
export function leadOnlyChannels(requested: readonly string[]): string[] {
  const out: string[] = [];
  for (const ch of requested) {
    if (LEAD_ONLY_CHANNELS.includes(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/**
 * Channels safe to forward to the Python engine as `required_channels`
 * for the discovery_only path. Only forwards lead-only channels (website/phone)
 * so detail-panel fast abort can run where appropriate.
 */
export function engineRequiredChannels(requested: readonly string[]): string[] {
  return leadOnlyChannels(requested);
}

export type EarlyPruneDecision =
  | { prune: false }
  | {
      prune: true;
      /** Channels that are definitely unsatisfiable given available data. */
      missing: string[];
      /**
       * Reason string in the SAME format the post-upsert gate emitted, so
       * the existing `candidate_rejected` consumers/dashboards are
       * unaffected.
       */
      reason: string;
      /** The channel list that was evaluated for early pruning. */
      evaluated: string[];
    };

/**
 * Checks whether a requested channel is potentially satisfiable for this candidate.
 * Returns true if:
 * 1. The channel is already satisfied on the initial lead, OR
 * 2. The channel is not "website" and the lead has a usable website to enable downstream enrichment.
 */
export function isChannelPotentiallySatisfiable(
  lead: ChannelCandidate,
  channel: string,
): boolean {
  if (channelsSatisfied(lead, [channel])) {
    return true;
  }
  // If the channel is missing on Maps, can it still be discovered from an available website?
  if (channel !== "website" && isValidWebsite(lead.website)) {
    return true;
  }
  return false;
}

/**
 * Decide whether a lead can be rejected before any persistence or
 * enrichment scheduling.
 *
 * Crucial rule: If a requested channel is missing from the initial Google Maps
 * candidate but can still be discovered from an available website, do NOT
 * reject the candidate before giving the existing enrichment system an
 * opportunity to find it.
 *
 * Pure: no I/O, no clock, no logging.
 */
export function evaluateEarlyChannelPrune(
  lead: ChannelCandidate,
  requested: readonly string[],
): EarlyPruneDecision {
  if (!requested || requested.length === 0) {
    return { prune: false };
  }

  const evaluated = leadOnlyChannels(requested);
  const unsatisfiable: string[] = [];

  for (const ch of requested) {
    if (!isChannelPotentiallySatisfiable(lead, ch)) {
      if (!unsatisfiable.includes(ch)) {
        unsatisfiable.push(ch);
      }
    }
  }

  if (unsatisfiable.length === 0) {
    return { prune: false };
  }

  // To preserve reason format compatibility with dashboards and tests:
  // evaluated list reflects the lead-only channels that failed or evaluated subset
  const evaluatedForReason = evaluated.length > 0 ? evaluated : unsatisfiable;

  return {
    prune: true,
    missing: unsatisfiable,
    evaluated: evaluatedForReason,
    reason: `maps_channel_gate:requested=${JSON.stringify(evaluatedForReason)}`,
  };
}
