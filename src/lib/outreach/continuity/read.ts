/**
 * Reading real outreach history from `lead_activities`.
 *
 * Only the four genuine outbound activity types count. Generating,
 * drafting, copying, or opening something is explicitly NOT contact:
 * `message_generated`, `email_opened`, `instagram_opened`, and
 * `contact_form_opened` are all ignored. `lead.status` is never consulted
 * — it cannot tell you which channel was actually used.
 *
 * Message bodies are never parsed to reconstruct continuity; only the
 * structured `metadata` object is read, and defensively, since rows
 * written before that metadata existed won't have it.
 */

import type {
  ContinuityMetadata,
  GenuineSendActivity,
  GenuineSendActivityType,
  LeadActivity,
  OpportunityComponent,
  OutreachChannel,
  TemplateKey,
} from "@/lib/outreach/types";

export const GENUINE_SEND_TYPES: readonly GenuineSendActivityType[] = [
  "email_sent",
  "instagram_sent",
  "call_completed",
  "contact_form_sent",
];

const ANGLE_SOURCES = ["opportunity", "category-fallback", "profession-generic"] as const;
const CHANNELS: readonly OutreachChannel[] = ["email", "instagram", "phone", "contact_form"];
const COMPONENTS: readonly (OpportunityComponent | "generic")[] = [
  "website",
  "branding",
  "social",
  "growth",
  "newness",
  "tech",
  "generic",
];

export function isGenuineSend(activity: Pick<LeadActivity, "type">): boolean {
  return (GENUINE_SEND_TYPES as readonly string[]).includes(activity.type as string);
}

/**
 * Defensive read of a stored metadata blob. Returns null rather than a
 * partially-populated object — a half-read angle is worse than
 * recomputing one.
 */
export function parseContinuityMetadata(raw: unknown): ContinuityMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const originalTemplate = record.originalTemplate;
  const originalAngleComponent = record.originalAngleComponent;
  const originalAngleSource = record.originalAngleSource;
  const sentAt = record.sentAt;
  const channel = record.channel;

  if (typeof originalTemplate !== "string") return null;
  if (typeof sentAt !== "string") return null;
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) return null;
  if (typeof originalAngleComponent !== "string" || !(COMPONENTS as readonly string[]).includes(originalAngleComponent)) {
    return null;
  }
  if (typeof originalAngleSource !== "string" || !(ANGLE_SOURCES as readonly string[]).includes(originalAngleSource)) {
    return null;
  }

  return {
    originalTemplate: originalTemplate as TemplateKey,
    originalAngleComponent: originalAngleComponent as OpportunityComponent | "generic",
    originalAngleSource: originalAngleSource as (typeof ANGLE_SOURCES)[number],
    sentAt,
    channel: channel as OutreachChannel,
    ...(typeof record.ctaStyle === "string" ? { ctaStyle: record.ctaStyle } : {}),
  };
}

export type ContinuityRead = {
  /** ISO timestamp of the most recent genuine send, or null if there is none. */
  readonly lastSendAt: string | null;
  readonly lastSendChannel: OutreachChannel | null;
  /** Structured metadata from that send, or null when the row predates it / is malformed. */
  readonly continuity: ContinuityMetadata | null;
  readonly sendCount: number;
};

export const NO_CONTINUITY: ContinuityRead = {
  lastSendAt: null,
  lastSendChannel: null,
  continuity: null,
  sendCount: 0,
};

/**
 * Most recent genuine outbound event wins. Old events without metadata
 * still count as contact — they just yield `continuity: null`, which the
 * pipeline treats as "recompute the angle", never as an error.
 */
export function readContinuity(activities: readonly LeadActivity[]): ContinuityRead {
  const sends = activities.filter(isGenuineSend) as GenuineSendActivity[];
  if (sends.length === 0) return NO_CONTINUITY;

  const sorted = [...sends].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const latest = sorted[0];

  return {
    lastSendAt: latest.timestamp,
    lastSendChannel: latest.channel ?? null,
    continuity: parseContinuityMetadata(latest.metadata),
    sendCount: sends.length,
  };
}
