/**
 * The deterministic Free-plan outreach generator.
 *
 * profession + niche + template + known lead data + channel + optional
 * deterministic opportunity signal → one finished message.
 *
 * NO LLM. The only network read anywhere in this path is the existing
 * deterministic Opportunity Explanation endpoint, and that read is
 * best-effort: if it fails, generation still succeeds via the fallback
 * ladder. `generateOutreachDraft()` (the Paid/AI stub) is deliberately not
 * imported here, so Free can never route through the 501 AI path.
 */

import type { ProfessionSlug } from "@/lib/professions";
import { isProfessionSlug } from "@/lib/professions";
import type {
  AngleSource,
  ContinuityMetadata,
  FreeTemplateKey,
  GenerationRefusal,
  Lead,
  LeadActivity,
  NormalizedOpportunitySignal,
  OpportunityComponent,
  OutreachChannel,
  SlotContent,
  ToneCaution,
} from "@/lib/outreach/types";
import { getProfessionOutreachProfile } from "./professions";
import { resolveNiche } from "./niches/nicheMap";
import { getCategoryProfile } from "./niches/nicheCategories";
import { resolveCompatibility } from "./compatibility";
import { normalizeExplanation, readOpportunitySignal, UNAVAILABLE_SIGNAL } from "./signals/opportunitySignal";
import { getTemplateDefinition, isTemplateEligible, type EligibilityContext } from "./templates";
import { resolveAngle, resolveSlots, toSafeLeadFacts } from "./templates/slots";
import { formatForChannel, type FormattedMessage } from "./channels/formatters";
import { readContinuity, type ContinuityRead } from "./continuity/read";
import { buildContinuityMetadata } from "./continuity/write";

export type GenerationSuccess = {
  readonly ok: true;
  readonly channel: OutreachChannel;
  readonly templateKey: FreeTemplateKey;
  readonly subject: string | null;
  readonly body: string;
  readonly slots: SlotContent;
  readonly angleComponent: OpportunityComponent | "generic";
  readonly angleSource: AngleSource;
  readonly toneOverride: ToneCaution | null;
  readonly signal: NormalizedOpportunitySignal;
  /** Ready to attach to a genuine-send activity when the user actually sends. */
  readonly continuityMetadata: ContinuityMetadata;
};

export type GenerationResult = GenerationSuccess | GenerationRefusal;

export type GenerateInput = {
  readonly lead: Lead;
  readonly profession: ProfessionSlug | string | null | undefined;
  readonly templateKey: FreeTemplateKey;
  readonly channel: OutreachChannel;
  readonly activities?: readonly LeadActivity[];
  readonly signal?: NormalizedOpportunitySignal;
  readonly senderName?: string | null;
  readonly explicitPricingContext?: boolean;
  readonly now?: Date;
};

/**
 * Pure generation. Everything it needs has already been resolved by the
 * caller, so the same inputs always produce byte-identical output.
 */
export function generateFreeOutreach(input: GenerateInput): GenerationResult {
  const { lead, templateKey, channel, now = new Date() } = input;

  // Missing profession → refuse. Never a profession-neutral message.
  if (!isProfessionSlug(typeof input.profession === "string" ? input.profession : null)) {
    return {
      ok: false,
      reason: "no_profession",
      detail: "Set your focus area in settings before generating outreach — messages are written from your profession.",
    };
  }
  const professionSlug = input.profession as ProfessionSlug;
  const profession = getProfessionOutreachProfile(professionSlug);

  const continuityRead: ContinuityRead = readContinuity(input.activities ?? []);

  const eligibilityContext: EligibilityContext = {
    lastSendAt: continuityRead.lastSendAt,
    continuity: continuityRead.continuity,
    explicitPricingContext: input.explicitPricingContext === true,
  };

  const eligibility = isTemplateEligible(templateKey, lead, eligibilityContext, now);
  if (eligibility !== true) {
    return { ok: false, reason: "template_ineligible", detail: eligibility.refusalReason };
  }

  const niche = resolveNiche(lead.niche);
  const category = getCategoryProfile(niche.category);
  const compatibility = resolveCompatibility({
    profession: professionSlug,
    category: niche.category,
    nicheValue: niche.nicheValue,
  });

  // Re-apply suppression here so a caller-supplied signal is filtered the
  // same way a freshly-read one is.
  const rawSignal = input.signal ?? UNAVAILABLE_SIGNAL;
  const suppressed = new Set(compatibility.suppressedComponents);
  const ranked = rawSignal.rankedComponents.filter((component) => !suppressed.has(component));
  const signal: NormalizedOpportunitySignal = rawSignal.available
    ? {
        available: ranked.length > 0,
        rankedComponents: ranked,
        topComponent: ranked[0] ?? null,
        score: rawSignal.score,
      }
    : UNAVAILABLE_SIGNAL;

  const safeLead = toSafeLeadFacts(lead);
  const slotInput = {
    lead: safeLead,
    templateKey,
    profession,
    category,
    signal,
    establishedQuality: compatibility.establishedQuality,
    continuity: continuityRead.continuity,
    senderName: input.senderName?.trim() || null,
  };

  let angle = resolveAngle(slotInput);

  // Re-engagement may only carry an angle when a genuinely NEW
  // deterministic signal exists. If the signal is unavailable, or it just
  // reproduces the stored original angle, the angle is omitted rather than
  // generic copy being dressed up as a new reason.
  if (templateKey === "reengagement") {
    const stored = continuityRead.continuity?.originalAngleComponent ?? null;
    const isNew = signal.available && angle.source === "opportunity" && angle.component !== stored;
    if (!isNew) {
      angle = { component: "generic", source: "profession-generic", text: "", observation: null, value: null };
    }
  }

  const definition = getTemplateDefinition(templateKey);
  const orderedSlots = angle.text ? definition.orderedSlots : definition.orderedSlots.filter((s) => s !== "angle");
  const slots = resolveSlots(slotInput, orderedSlots, angle);
  const formatted: FormattedMessage = formatForChannel(channel, slots, safeLead.businessName);

  return {
    ok: true,
    channel,
    templateKey,
    subject: formatted.subject,
    body: formatted.body,
    slots,
    angleComponent: angle.component,
    angleSource: angle.source,
    toneOverride: compatibility.toneOverride ?? null,
    signal,
    continuityMetadata: buildContinuityMetadata({
      templateKey,
      angleComponent: angle.component,
      angleSource: angle.source,
      channel,
      ctaStyle: profession.ctaStyle,
    }),
  };
}

/**
 * Convenience wrapper that performs the best-effort deterministic signal
 * read first. Still no LLM anywhere — and a failed read never blocks
 * generation.
 */
export async function generateFreeOutreachWithSignal(
  input: Omit<GenerateInput, "signal">,
): Promise<GenerationResult> {
  const signal = await readOpportunitySignal(input.lead.id);
  return generateFreeOutreach({ ...input, signal });
}

export { normalizeExplanation };
