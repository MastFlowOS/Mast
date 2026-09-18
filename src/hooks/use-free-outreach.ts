/**
 * The Free-plan generation entry point for the UI.
 *
 * This is a deliberately separate path from `generateOutreachDraft()` /
 * `useGenerateOutreachDraft()`, which remain the Paid/AI contract. Nothing
 * in this hook calls an AI endpoint; the only network read is the existing
 * deterministic Opportunity Explanation, and it is best-effort.
 */

import { useCallback } from "react";
import { useLeadActivities, useSettings } from "@/hooks/use-mast-api";
import { isProfessionSlug, professionSlugForLabel, type ProfessionSlug } from "@/lib/professions";
import type { Lead, OutreachChannel } from "@/lib/api";
import type { FreeTemplateKey } from "@/lib/outreach/types";
import { generateFreeOutreachWithSignal, type GenerationResult } from "@/lib/outreach/pipeline";
import { isTemplateEligible, type EligibilityContext } from "@/lib/outreach/templates";
import { readContinuity } from "@/lib/outreach/continuity/read";
import { rememberDraftProvenance } from "@/lib/outreach/draftProvenance";

/**
 * Resolve the sender's profession. The lead's own `professionSlug` (set by
 * Discover) wins when present; otherwise the stored focus-area label is
 * looked up through professions.ts — never derived by string manipulation.
 */
export function resolveSenderProfession(
  lead: Lead | undefined,
  focusAreaLabel: string | null | undefined,
): ProfessionSlug | null {
  if (lead?.professionSlug && isProfessionSlug(lead.professionSlug)) return lead.professionSlug;
  return professionSlugForLabel(focusAreaLabel);
}

export function useFreeOutreach(lead: Lead | undefined) {
  const { data: settings } = useSettings();
  const { data: activities } = useLeadActivities(lead);

  const profession = resolveSenderProfession(lead, settings?.focusArea);
  const continuity = readContinuity(activities ?? []);

  const eligibilityContext: EligibilityContext = {
    lastSendAt: continuity.lastSendAt,
    continuity: continuity.continuity,
    // No pricing-transition setting exists in the product, so this is
    // always false. No field is invented or inferred.
    explicitPricingContext: false,
  };

  const checkEligibility = useCallback(
    (templateKey: FreeTemplateKey) => {
      if (!lead) return { refusalReason: "No lead loaded." } as const;
      if (!profession) {
        return {
          refusalReason: "Set your focus area in settings — messages are written from your profession.",
        } as const;
      }
      return isTemplateEligible(templateKey, lead, eligibilityContext);
    },
    [lead, profession, eligibilityContext.lastSendAt, eligibilityContext.continuity],
  );

  const generate = useCallback(
    async (templateKey: FreeTemplateKey, channel: OutreachChannel, senderName?: string | null): Promise<GenerationResult> => {
      if (!lead) {
        return { ok: false, reason: "no_profession", detail: "No lead loaded." };
      }
      const result = await generateFreeOutreachWithSignal({
        lead,
        profession,
        templateKey,
        channel,
        activities: activities ?? [],
        senderName: senderName ?? null,
        explicitPricingContext: false,
      });
      if (result.ok) {
        rememberDraftProvenance(lead.id, channel, result.continuityMetadata);
      }
      return result;
    },
    [lead, profession, activities],
  );

  return { profession, hasProfession: profession !== null, continuity, checkEligibility, generate };
}
