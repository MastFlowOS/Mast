/**
 * The six deterministic Free templates.
 *
 * `objection_handling` is deliberately absent: it is Paid/AI only, is
 * excluded from `FreeTemplateKey` by construction (see types.ts), and the
 * Free pipeline never imports or references it — which makes "Free
 * generation can't reach the AI path" structural rather than a runtime
 * check.
 *
 * Templates are plain data plus two pure predicates. They produce
 * channel-agnostic slot *ordering* and eligibility only; the actual copy
 * for each slot is resolved in slots.ts, and all channel formatting
 * happens in channels/formatters.ts. No template contains a line break or
 * a subject line.
 */

import type {
  ContinuityMetadata,
  FreeTemplateKey,
  Lead,
  SlotType,
  TemplateDefinition,
  TemplateEligibilityResult,
} from "@/lib/outreach/types";

/** Days after which re-engagement is allowed — MAST's existing "going cold" precedent. */
export const REENGAGEMENT_MIN_DAYS = 14;

export type EligibilityContext = {
  /** Most recent genuine outbound send, from continuity/read.ts. Null when there is none. */
  readonly lastSendAt: string | null;
  readonly continuity: ContinuityMetadata | null;
  /**
   * Explicit pricing-transition context. There is no such setting or
   * database field in the product today, so this is always false — the
   * template stays visible but ineligible rather than inventing a field.
   */
  readonly explicitPricingContext: boolean;
};

export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

function requirePriorContact(context: EligibilityContext): TemplateEligibilityResult {
  if (!context.lastSendAt) {
    return { refusalReason: "No prior outreach has been sent to this lead yet." };
  }
  return true;
}

const INITIAL_SLOTS: SlotType[] = ["opening", "observation", "angle", "value", "cta", "signoff"];
const FOLLOW_UP_SLOTS: SlotType[] = ["opening", "continuity", "angle", "cta", "signoff"];
const SHORT_FOLLOW_UP_SLOTS: SlotType[] = ["opening", "continuity", "cta"];

const NO_FABRICATION: string[] = [
  "that the recipient saw, opened, read, or ignored the message",
  "that the recipient replied",
  "any experience, years in business, portfolio, testimonial, client, team, award, result, or metric",
  "any fact about the lead's business that is not a verified lead field or a deterministic signal",
];

const TEMPLATE_DEFINITIONS: Record<FreeTemplateKey, TemplateDefinition> = {
  initial: {
    key: "initial",
    purpose: "First touch. Introduce the sender and offer one authored angle.",
    requiredContext: [],
    orderedSlots: INITIAL_SLOTS,
    eligible: () => true,
    forbiddenClaims: NO_FABRICATION,
    fallbackBehavior:
      "Needs only a profession. With no niche, no opportunity signal, and no location it still produces opening + profession generic fallback angle + CTA.",
  },

  follow_up_2day: {
    key: "follow_up_2day",
    purpose: "Gentle nudge after a real prior send, reusing the original angle.",
    requiredContext: ["priorContact", "continuity"],
    orderedSlots: FOLLOW_UP_SLOTS,
    eligible: (_lead: Lead, _continuity: ContinuityMetadata | null) => true,
    forbiddenClaims: NO_FABRICATION,
    fallbackBehavior:
      "Uses the stored original angle when continuity metadata exists; otherwise recomputes the angle deterministically from the current signal.",
  },

  follow_up_5day: {
    key: "follow_up_5day",
    purpose: "Final, materially lower-pressure follow-up. Shorter than the 2-day, with no urgency.",
    requiredContext: ["priorContact"],
    orderedSlots: ["opening", "continuity", "cta", "signoff"],
    eligible: (_lead: Lead, _continuity: ContinuityMetadata | null) => true,
    forbiddenClaims: [...NO_FABRICATION, "any urgency, deadline, or scarcity framing"],
    fallbackBehavior: "Drops the angle and value slots entirely so it cannot duplicate the 2-day message.",
  },

  buried_bump: {
    key: "buried_bump",
    purpose: "One-line resurface of a message that may have been buried.",
    requiredContext: ["priorContact"],
    orderedSlots: SHORT_FOLLOW_UP_SLOTS,
    eligible: (_lead: Lead, _continuity: ContinuityMetadata | null) => true,
    forbiddenClaims: [...NO_FABRICATION, "any angle, observation, or value claim"],
    fallbackBehavior: "Carries opening, continuity, and CTA only — never an angle, observation, or value slot.",
  },

  reengagement: {
    key: "reengagement",
    purpose: "Re-open a conversation that has gone cold, using the existing 14-day precedent.",
    requiredContext: ["priorContact", "daysSinceContact>=14"],
    eligible: (_lead: Lead, _continuity: ContinuityMetadata | null) => true,
    orderedSlots: ["opening", "continuity", "angle", "cta", "signoff"],
    forbiddenClaims: [...NO_FABRICATION, "any invented reason for reaching back out"],
    fallbackBehavior:
      "Includes an angle only when a genuinely new deterministic signal differs from the stored original angle; otherwise omits the angle rather than dressing generic copy up as a new reason.",
  },

  pricing_transition: {
    key: "pricing_transition",
    purpose: "Communicate an explicit, already-decided pricing change.",
    requiredContext: ["explicitPricingContext"],
    orderedSlots: ["opening", "continuity", "value", "cta", "signoff"],
    eligible: (_lead: Lead, _continuity: ContinuityMetadata | null) => true,
    forbiddenClaims: [...NO_FABRICATION, "any pricing, rate, discount, or deadline that was not explicitly supplied"],
    fallbackBehavior:
      "There is no pricing-transition setting in the product, so this template is always ineligible — no field is invented or inferred.",
  },
};

/**
 * Eligibility with the full deterministic context. `TemplateDefinition.eligible`
 * only sees (lead, continuity) per its shared contract, so the
 * context-dependent conditions live here where `lastSendAt` and
 * `explicitPricingContext` are actually available.
 */
export function isTemplateEligible(
  key: FreeTemplateKey,
  lead: Lead,
  context: EligibilityContext,
  now: Date = new Date(),
): TemplateEligibilityResult {
  const definition = TEMPLATE_DEFINITIONS[key];
  const base = definition.eligible(lead, context.continuity);
  if (base !== true) return base;

  switch (key) {
    case "initial":
      return true;

    case "follow_up_2day":
    case "follow_up_5day":
    case "buried_bump":
      return requirePriorContact(context);

    case "reengagement": {
      const prior = requirePriorContact(context);
      if (prior !== true) return prior;
      const days = daysSince(context.lastSendAt, now);
      if (days === null || days < REENGAGEMENT_MIN_DAYS) {
        return {
          refusalReason: `Re-engagement becomes available ${REENGAGEMENT_MIN_DAYS} days after the last outreach.`,
        };
      }
      return true;
    }

    case "pricing_transition":
      if (!context.explicitPricingContext) {
        return {
          refusalReason:
            "Pricing Transition needs explicit pricing-transition context, which this workspace doesn't have.",
        };
      }
      return true;
  }
}

export { TEMPLATE_DEFINITIONS };

export const FREE_TEMPLATE_KEYS: readonly FreeTemplateKey[] = [
  "initial",
  "follow_up_2day",
  "follow_up_5day",
  "buried_bump",
  "reengagement",
  "pricing_transition",
];

export function isFreeTemplateKey(value: string): value is FreeTemplateKey {
  return (FREE_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export function getTemplateDefinition(key: FreeTemplateKey): TemplateDefinition {
  return TEMPLATE_DEFINITIONS[key];
}
