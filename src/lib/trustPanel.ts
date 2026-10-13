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

export type ScoreDisplay = {
  isScored: boolean;
  score: number | null;
  level: string;
  label: string;
};

/**
 * Pure display resolver for opportunity score.
 * Never invents a numerical score from priority when genuine opportunityScore is null or missing.
 * Honest unscored state when absent.
 */
export function resolveScoreDisplay(opportunityScore: number | null | undefined): ScoreDisplay {
  if (opportunityScore != null && Number.isFinite(opportunityScore)) {
    const rounded = Math.round(opportunityScore);
    const level = rounded >= 80 ? "High Opportunity" : rounded >= 60 ? "Medium Opportunity" : "Opportunity";
    return {
      isScored: true,
      score: rounded,
      level,
      label: String(rounded),
    };
  }

  return {
    isScored: false,
    score: null,
    level: "Unscored",
    label: "—",
  };
}

export type ContactBadgeStatus = "verified" | "available" | "missing";

export type ContactBadgeDisplay = {
  label: "Verified" | "Available" | "Missing";
  status: ContactBadgeStatus;
};

/**
 * Resolves contact badge semantics honestly:
 * - "Missing" if no contact value exists.
 * - "Verified" ONLY if a genuine trust entry confirms it (verifiedAt present and confidence >= 0.7).
 * - "Available" when contact value exists but has not been verified.
 * Never labels as "Verified" merely because a value exists.
 */
export function resolveContactVerificationBadge(
  value: string | null | undefined,
  entry?: FieldTrustEntry | null
): ContactBadgeDisplay {
  if (!value || !value.trim()) {
    return { label: "Missing", status: "missing" };
  }

  if (entry?.verifiedAt && (entry.confidence ?? 0) >= 0.7) {
    return { label: "Verified", status: "verified" };
  }

  return { label: "Available", status: "available" };
}
