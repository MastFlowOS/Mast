/**
 * Building the structured `metadata` blob attached to a genuine send.
 *
 * No new table and no migration — this rides on the existing
 * `lead_activities.metadata` column. This module only *builds* the object;
 * the four Mark-Sent paths and the backend email send attach it to the
 * activity they already record, so no existing logging changes shape.
 *
 * Nothing here is written for opened events, notes, follow-up scheduling,
 * or any other activity type.
 */

import type {
  AngleSource,
  ContinuityMetadata,
  FreeTemplateKey,
  OpportunityComponent,
  OutreachChannel,
} from "@/lib/outreach/types";

export type ContinuityWriteInput = {
  readonly templateKey: FreeTemplateKey;
  readonly angleComponent: OpportunityComponent | "generic";
  readonly angleSource: AngleSource;
  readonly channel: OutreachChannel;
  readonly sentAt?: string;
  readonly ctaStyle?: string;
};

export function buildContinuityMetadata(input: ContinuityWriteInput): ContinuityMetadata {
  return {
    originalTemplate: input.templateKey,
    originalAngleComponent: input.angleComponent,
    originalAngleSource: input.angleSource,
    sentAt: input.sentAt ?? new Date().toISOString(),
    channel: input.channel,
    ...(input.ctaStyle ? { ctaStyle: input.ctaStyle } : {}),
  };
}

/**
 * Merge continuity metadata into whatever metadata an existing send path
 * already writes, without clobbering it.
 */
export function withContinuityMetadata(
  existing: Record<string, unknown> | null | undefined,
  metadata: ContinuityMetadata | null,
): Record<string, unknown> | null {
  if (!metadata) return existing ?? null;
  return { ...(existing ?? {}), ...metadata };
}
