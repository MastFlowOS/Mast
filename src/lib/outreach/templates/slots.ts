/**
 * Slot resolution: turns (profession profile, category profile,
 * compatibility, signal, continuity, template) into channel-agnostic
 * `SlotContent`.
 *
 * Two hard rules enforced structurally here:
 *  1. Nothing in this file reads a lead field that isn't on the safe list
 *     below. Private CRM notes (`notes`, `brandingNotes`, `websiteNotes`,
 *     `tags`, `priority`, `followUpAt`, `igLastPost`, `igPostDescription`)
 *     and follower counts are never read, so they cannot leak.
 *  2. No slot string contains a line break. Assembling paragraphs is
 *     exclusively channels/formatters.ts's job.
 */

import type {
  AngleSource,
  ContinuityMetadata,
  FreeTemplateKey,
  Lead,
  NormalizedOpportunitySignal,
  OpportunityComponent,
  SlotContent,
} from "@/lib/outreach/types";
import type { ProfessionProfile } from "../professions";
import type { CategoryProfile } from "../niches/nicheCategories";
import { pickVariant } from "./variation";
import { ASSUMPTION_GUARDED_COMPONENTS } from "../compatibility";

/**
 * The only lead fields slot resolution is allowed to read. Anything not
 * here is structurally unreachable from this module.
 */
export type SafeLeadFacts = {
  readonly id: number | string;
  readonly businessName: string;
  readonly instagramHandle: string | null;
};

export function toSafeLeadFacts(lead: Lead): SafeLeadFacts {
  return {
    id: lead.id,
    businessName: lead.businessName,
    instagramHandle: lead.instagramHandle ? lead.instagramHandle.replace(/^@/, "") : null,
  };
}

export type ResolvedAngle = {
  readonly component: OpportunityComponent | "generic";
  readonly source: AngleSource;
  /** The core profession-specific relevance statement — populates the `angle` slot. */
  readonly text: string;
  /** The authored problem framing, when one was selected. Never lead-specific. */
  readonly observation: string | null;
  /**
   * Optional supporting elaboration for the `value` slot, distinct from
   * `text`. The authored profession data model currently has exactly one
   * string per component (`valuePropAngles[component]`), which is what
   * `text` already carries — there is no second, genuinely different
   * sentence to elaborate with. Rather than repeat `text` here (which
   * previously caused email/contact-form bodies to say the same sentence
   * twice back-to-back), this stays `null` whenever no distinct
   * elaboration exists, so the `value` slot is correctly omitted.
   */
  readonly value: string | null;
};

export type SlotResolutionInput = {
  readonly lead: SafeLeadFacts;
  readonly templateKey: FreeTemplateKey;
  readonly profession: ProfessionProfile;
  readonly category: CategoryProfile;
  readonly signal: NormalizedOpportunitySignal;
  readonly establishedQuality: boolean;
  readonly continuity: ContinuityMetadata | null;
  readonly senderName: string | null;
};

/**
 * The deterministic angle ladder:
 *  1. profession + unsuppressed opportunity component (+ category context)
 *  2. profession + opportunity component
 *  3. profession + category serviceOpportunityContext
 *  4. profession genericFallbackAngle
 *
 * `signal.rankedComponents` has already had suppressed components removed
 * by the signal adapter, so walking it in order *is* rungs 1–2.
 */
export function resolveAngle(input: SlotResolutionInput): ResolvedAngle {
  const { profession, category, signal, establishedQuality } = input;

  const problemsByComponent = new Map(profession.commonProblems.map((p) => [p.component, p]));

  for (const component of signal.rankedComponents) {
    const problem = problemsByComponent.get(component);
    const angleText = profession.valuePropAngles[component];
    if (!problem || !angleText) continue;
    return {
      component,
      source: "opportunity",
      text: angleText,
      observation: problem.problemConcept,
      // No distinct elaboration exists beyond the angle text itself for
      // this component — omit rather than repeat it as `value`.
      value: null,
    };
  }

  // Rung 3 — a category-level framing. For established-quality categories
  // the website/branding/tech framings are only reachable from a real
  // signal, never assumed, so they are skipped here.
  for (const context of category.serviceOpportunityContext) {
    if (establishedQuality && ASSUMPTION_GUARDED_COMPONENTS.includes(context.component)) continue;
    const angleText = profession.valuePropAngles[context.component];
    if (!angleText) continue;
    return {
      component: context.component,
      source: "category-fallback",
      text: angleText,
      observation: context.concept,
      // Same reasoning as the opportunity-sourced case above: no distinct
      // elaboration exists, so omit rather than repeat `text`.
      value: null,
    };
  }

  // Rung 4 — profession-specific floor. Never profession-neutral.
  return {
    component: "generic",
    source: "profession-generic",
    text: profession.genericFallbackAngle,
    observation: null,
    value: null,
  };
}

function continuityLine(templateKey: FreeTemplateKey): string {
  // Deliberately claims nothing about whether the message was seen,
  // opened, read, ignored, or replied to.
  switch (templateKey) {
    case "follow_up_2day":
      return "I got in touch a couple of days ago and wanted to follow up on it.";
    case "follow_up_5day":
      return "I reached out a little while back and thought I'd check in once more.";
    case "buried_bump":
      return "I sent a note recently that may well have got buried.";
    case "reengagement":
      return "I got in touch a while ago and thought I'd reach back out.";
    case "pricing_transition":
      return "I got in touch previously about working together.";
    case "initial":
      return "";
  }
}

function addressee(lead: SafeLeadFacts, channel: "instagram" | "other"): string {
  if (channel === "instagram" && lead.instagramHandle) return `@${lead.instagramHandle}`;
  return lead.businessName;
}

/**
 * Build the ordered, channel-agnostic slot content for a template. Slots
 * the template doesn't declare are omitted entirely rather than emitted
 * empty.
 */
export function resolveSlots(
  input: SlotResolutionInput,
  orderedSlots: readonly string[],
  angle: ResolvedAngle,
): SlotContent {
  const { lead, templateKey, profession, senderName } = input;
  const wants = (slot: string) => orderedSlots.includes(slot);

  const openingVariant =
    pickVariant(profession.openingVariants, lead.id, templateKey, "opening") ?? profession.openingVariants[0];
  const ctaVariant = pickVariant(profession.ctaVariants, lead.id, templateKey, "cta") ?? profession.ctaVariants[0];

  const content: SlotContent = {
    opening: `${openingVariant} I came across ${addressee(lead, "other")}.`,
    cta: ctaVariant,
  };

  if (wants("continuity")) {
    const line = continuityLine(templateKey);
    if (line) content.continuity = line;
  }

  if (wants("observation") && angle.observation) {
    content.observation = angle.observation;
  }

  if (wants("angle") && angle.component !== "generic") {
    content.angle = angle.text;
  } else if (wants("angle")) {
    content.angle = angle.text;
  }

  if (wants("value") && angle.value) {
    content.value = angle.value;
  }

  if (wants("signoff") && senderName) {
    content.signoff = senderName;
  }

  return content;
}

export { continuityLine, addressee };
