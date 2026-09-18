/**
 * A tiny in-memory record of what the deterministic Free generator
 * produced for a given (lead, channel), so the Mark-Sent paths can attach
 * the matching continuity metadata to the genuine-send activity they
 * already record — without threading a new prop through four component
 * layers.
 *
 * Deliberately NOT persisted: a draft is not a send. Provenance only
 * becomes durable when the user actually marks something sent, at which
 * point it lands on `lead_activities.metadata`.
 */

import type { ContinuityMetadata, OutreachChannel } from "@/lib/outreach/types";

const store = new Map<string, ContinuityMetadata>();

function key(leadId: number | string, channel: OutreachChannel): string {
  return `${leadId}|${channel}`;
}

export function rememberDraftProvenance(
  leadId: number | string,
  channel: OutreachChannel,
  metadata: ContinuityMetadata,
): void {
  store.set(key(leadId, channel), metadata);
}

/** Returns the metadata for the last generated draft on this lead+channel, or null. */
export function getDraftProvenance(
  leadId: number | string,
  channel: OutreachChannel,
): ContinuityMetadata | null {
  return store.get(key(leadId, channel)) ?? null;
}

export function clearDraftProvenance(leadId: number | string, channel: OutreachChannel): void {
  store.delete(key(leadId, channel));
}
