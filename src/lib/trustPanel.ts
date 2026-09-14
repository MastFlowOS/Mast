import type { FieldTrustEntry, LeadTrust } from "./api";

/**
 * Pure rendering-decision helpers for the Trust & Health panel
 * (src/components/mast/workspace/LeftSidebar.tsx). Kept separate from the
 * component and from api.ts's live network/query code so this logic can be
 * unit tested without pulling in supabase.ts's `import.meta.env` dependency
 * (see src/lib/__tests__/trustPanel.test.ts) — the repo's existing test
 * convention runs plain `tsx --test` with no Vite/browser env shim, so any
 * testable frontend logic needs to live somewhere that doesn't transitively
 * import supabase.ts at the module top level. Only `import type` is used
 * from ./api here, which is erased at compile time and adds no runtime
 * dependency.
 */

export type TrustPanelState = "loading" | "error" | "empty" | "data";

/** Which of the four states the Trust panel should render, in priority order. */
export function resolveTrustPanelState(args: { isLoading: boolean; isError: boolean; data: LeadTrust | null | undefined }): TrustPanelState {
  if (args.isLoading) return "loading";
  if (args.isError) return "error";
  if (!args.data) return "empty";
  return "data";
}

/** Looks up one field's trust entry by key, never fabricating a value when absent. */
export function getFieldTrustEntry(fieldTrust: Record<string, FieldTrustEntry> | null | undefined, key: string): FieldTrustEntry | undefined {
  return fieldTrust?.[key];
}

/** Human-readable "last verified" line, or null when there's nothing to show (never guessed). */
export function formatVerificationLine(lastVerifiedAt: string | null | undefined, lastVerificationKind: string | null | undefined): string | null {
  if (!lastVerifiedAt && !lastVerificationKind) return null;
  const datePart = lastVerifiedAt ? new Date(lastVerifiedAt).toLocaleDateString() : "Unknown date";
  return lastVerificationKind ? `${datePart} · ${lastVerificationKind}` : datePart;
}

/**
 * Disqualification transparency (Priority: Trust & Health follow-up).
 *
 * Pure display mapping over the existing `businesses.is_disqualified` /
 * `businesses.disqualify_reason` values already returned by the Trust
 * endpoint — this never invents or rewrites a reason. If the business isn't
 * disqualified, there is nothing to show. If it is, but no reason was
 * stored, the caller gets an explicit "Reason unavailable" label instead of
 * a fabricated explanation.
 */
export type DisqualificationDisplay = { label: string; reason: string };

export function resolveDisqualificationDisplay(
  trust: Pick<LeadTrust, "isDisqualified" | "disqualifyReason"> | null | undefined,
): DisqualificationDisplay | null {
  if (!trust?.isDisqualified) return null;
  const stored = trust.disqualifyReason?.trim();
  return {
    label: "Disqualified",
    reason: stored ? stored : "Reason unavailable",
  };
}
