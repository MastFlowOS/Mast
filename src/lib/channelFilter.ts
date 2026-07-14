/**
 * ROOT CAUSE this fixes: the `channels` the user requested (email / phone /
 * instagram / website) were validated only for PLAN ELIGIBILITY (can this
 * plan use this channel at all — see discover.ts) and were never actually
 * used to filter WHICH businesses get delivered. `deliverLead` /
 * `insertLeadForUser` (src/scraperBridge/deliverLead.ts) deliver whatever
 * the engine/pool handed them regardless of `channels`, and
 * `lookupAndDeliverFromPool` (src/lib/poolLookup.ts) never even received
 * `channels` as a parameter. A user asking for "Email + Phone" would get
 * website-only or Instagram-only businesses mixed in.
 *
 * Fix: this single predicate is now applied, post-enrichment, everywhere a
 * lead/business is about to be delivered to a user — discoverJob.ts,
 * poolExpandJob.ts, and poolLookup.ts. "The final returned opportunity must
 * satisfy every requested channel" (AND semantics across requested
 * channels — requesting Email+Phone requires BOTH, not either).
 */

export type ChannelCandidate = {
  email?: string | null;
  phone?: string | null;
  instagram?: string | null;
  website?: string | null;
};

const CHANNEL_FIELDS = ["email", "phone", "instagram", "website"] as const;
type ChannelField = (typeof CHANNEL_FIELDS)[number];

function hasChannel(candidate: ChannelCandidate, channel: string): boolean {
  if (!CHANNEL_FIELDS.includes(channel as ChannelField)) {
    // Unknown/unsupported channel key — fail closed rather than silently
    // ignoring a filter the user explicitly asked for.
    return false;
  }
  const value = candidate[channel as ChannelField];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * True only if `candidate` has EVERY channel in `requestedChannels`. An
 * empty `requestedChannels` array means "no channel filter" — everything
 * passes, matching the pre-existing (unfiltered) behavior when the user
 * didn't select any channel.
 */
export function channelsSatisfied(candidate: ChannelCandidate, requestedChannels: string[]): boolean {
  if (requestedChannels.length === 0) return true;
  return requestedChannels.every((ch) => hasChannel(candidate, ch));
}
