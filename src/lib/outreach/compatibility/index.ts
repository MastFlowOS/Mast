/**
 * Profession × category compatibility, as a short list of pure conditional
 * rules applied in order — deliberately NOT a 12 × 13 matrix. Each rule is
 * a small predicate over (profession, category, nicheValue); the resolver
 * folds their outputs together.
 *
 * The rules exist to stop the generator saying something that would be
 * tone-deaf or presumptuous: teaching a designer about design, telling a
 * dev agency its website is weak, attaching outcome language to a
 * regulated practice, or using sales framing with a nonprofit.
 */

import type { ProfessionSlug } from "@/lib/professions";
import type { CompatibilityResult, OpportunityComponent, ToneCaution } from "@/lib/outreach/types";
import type { OutreachCategoryKey } from "../niches/nicheCategories";
import { getCategoryProfile } from "../niches/nicheCategories";

export type CompatibilityInput = {
  readonly profession: ProfessionSlug;
  readonly category: OutreachCategoryKey;
  /** The resolved controlled niche value, when the raw niche matched one. */
  readonly nicheValue: string | null;
};

type Rule = (input: CompatibilityInput) => {
  suppress?: OpportunityComponent[];
  terminologyOverride?: string;
  toneOverride?: ToneCaution;
  establishedQuality?: boolean;
};

/**
 * Categories where an unprompted "your website / branding / technology is
 * weak" angle is not a safe default. When no explicit opportunity signal
 * supports those components, the ladder should reach for growth / social /
 * newness instead.
 */
const ESTABLISHED_QUALITY_CATEGORIES: ReadonlySet<OutreachCategoryKey> = new Set([
  "property",
  "agency_tech",
  "financial_legal",
]);

const SAME_DOMAIN_RULES: readonly Rule[] = [
  // A designer does not tell a design-led business its branding needs work.
  ({ profession, category }) =>
    profession === "graphic_design" && category === "creative_services" ? { suppress: ["branding"] } : {},

  // A photographer does not tell a photography/visual studio its imagery needs work.
  ({ profession, category, nicheValue }) => {
    if (profession !== "photography" || category !== "creative_services") return {};
    const visualNiches = ["photography", "videography", "graphic_design", "branding_studio", "art_gallery", "interior_design"];
    return nicheValue && visualNiches.includes(nicheValue)
      ? { suppress: ["branding", "social"] }
      : { suppress: ["branding"] };
  },

  // An audio professional does not pitch sound to a music studio.
  ({ profession, category, nicheValue }) => {
    if (profession !== "music_audio" || category !== "creative_services") return {};
    return nicheValue === "music_studio" ? { suppress: ["branding", "social"] } : { suppress: ["branding"] };
  },

  // Video/animation overlaps videography studios specifically.
  ({ profession, category, nicheValue }) =>
    profession === "video_animation" && category === "creative_services" && nicheValue === "videography"
      ? { suppress: ["social"] }
      : {},

  // A writer does not pitch copy to a copy/branding studio's own craft.
  ({ profession, category, nicheValue }) =>
    profession === "writing_translation" && category === "creative_services" && nicheValue === "branding_studio"
      ? { suppress: ["branding"] }
      : {},

  // A marketer does not pitch social to a marketing/PR/digital agency.
  ({ profession, category, nicheValue }) => {
    if (profession !== "digital_marketing" || category !== "agency_tech") return {};
    const marketingNiches = ["marketing_agency", "pr_agency", "digital_agency"];
    return nicheValue && marketingNiches.includes(nicheValue) ? { suppress: ["social", "growth"] } : {};
  },

  // A developer does not teach technical professionals their own domain.
  ({ profession, category, nicheValue }) => {
    if (profession !== "programming_tech" || category !== "agency_tech") return {};
    const technicalNiches = ["saas", "digital_agency"];
    return nicheValue && technicalNiches.includes(nicheValue)
      ? { suppress: ["website", "tech"] }
      : { suppress: ["tech"] };
  },

  // Data does not assume a technical business is missing infrastructure.
  ({ profession, category, nicheValue }) => {
    if (profession !== "data" || category !== "agency_tech") return {};
    const technicalNiches = ["saas", "digital_agency", "marketing_agency"];
    return nicheValue && technicalNiches.includes(nicheValue) ? { suppress: ["tech"] } : {};
  },

  // Finance does not tell a finance/legal professional they need better
  // financial processes.
  ({ profession, category }) =>
    profession === "finance" && category === "financial_legal" ? { suppress: ["growth", "newness"] } : {},

  // A business consultant does not pitch operations to a consultancy-style agency.
  ({ profession, category, nicheValue }) =>
    profession === "business" && category === "agency_tech" && nicheValue === "saas" ? { suppress: ["growth"] } : {},
];

const TONE_RULES: readonly Rule[] = [
  ({ category, nicheValue }) => {
    if (category === "healthcare") return { toneOverride: "elevated-sensitivity" };
    if (category === "financial_legal") return { toneOverride: "formal-preferred" };
    if (category === "community_other" && (nicheValue === "nonprofit" || nicheValue === "religious_org")) {
      return { toneOverride: "formal-preferred" };
    }
    // Otherwise defer to whatever the category profile itself declares.
    const declared = getCategoryProfile(category).toneCaution;
    return declared ? { toneOverride: declared } : {};
  },
];

const TERMINOLOGY_RULES: readonly Rule[] = [
  ({ category, nicheValue }) => {
    const profile = getCategoryProfile(category);
    const exception = nicheValue ? profile.terminologyException?.[nicheValue] : undefined;
    return { terminologyOverride: exception ?? profile.terminologyPreference };
  },
];

const ESTABLISHED_QUALITY_RULES: readonly Rule[] = [
  ({ category }) => (ESTABLISHED_QUALITY_CATEGORIES.has(category) ? { establishedQuality: true } : {}),
];

const ALL_RULES: readonly Rule[] = [
  ...SAME_DOMAIN_RULES,
  ...TONE_RULES,
  ...TERMINOLOGY_RULES,
  ...ESTABLISHED_QUALITY_RULES,
];

/**
 * The single exported resolver. Pure — same inputs always produce the same
 * result, and it reads nothing but authored content.
 */
export function resolveCompatibility(input: CompatibilityInput): CompatibilityResult {
  const suppressed = new Set<OpportunityComponent>();
  let terminologyOverride: string | undefined;
  let toneOverride: ToneCaution | undefined;
  let establishedQuality = false;

  for (const rule of ALL_RULES) {
    const outcome = rule(input);
    for (const component of outcome.suppress ?? []) suppressed.add(component);
    if (outcome.terminologyOverride) terminologyOverride = outcome.terminologyOverride;
    if (outcome.toneOverride) toneOverride = outcome.toneOverride;
    if (outcome.establishedQuality) establishedQuality = true;
  }

  return {
    suppressedComponents: [...suppressed],
    ...(terminologyOverride ? { terminologyOverride } : {}),
    ...(toneOverride ? { toneOverride } : {}),
    establishedQuality,
  };
}

/**
 * Components that should not be *assumed* (i.e. reached for without an
 * explicit opportunity signal) for established-quality categories.
 */
export const ASSUMPTION_GUARDED_COMPONENTS: readonly OpportunityComponent[] = ["website", "branding", "tech"];

export { ESTABLISHED_QUALITY_CATEGORIES };
