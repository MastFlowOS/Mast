/**
 * Deterministic variant selection.
 *
 * `hash(leadId + templateKey + slotType) % variants.length`. No
 * `Math.random()`, no `Date.now()`, no module-level mutable state — the
 * same inputs always select the same variant, in every process, forever.
 *
 * Variation is only ever applied to phrasing that carries no facts:
 * openings, CTAs, and optional signoffs. Observations and opportunity
 * angles are never varied.
 */

import type { SlotType } from "@/lib/outreach/types";

/**
 * FNV-1a (32-bit). Chosen for being tiny, dependency-free, and stable
 * across runtimes — not for cryptographic properties, which are
 * irrelevant here.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function variationKey(leadId: number | string, templateKey: string, slotType: SlotType): string {
  return `${leadId}|${templateKey}|${slotType}`;
}

/**
 * Pick one entry deterministically. Returns null for an empty list rather
 * than throwing — the caller decides whether an absent slot is fatal.
 */
export function pickVariant<T>(
  variants: readonly T[],
  leadId: number | string,
  templateKey: string,
  slotType: SlotType,
): T | null {
  if (variants.length === 0) return null;
  const index = hashString(variationKey(leadId, templateKey, slotType)) % variants.length;
  return variants[index];
}
