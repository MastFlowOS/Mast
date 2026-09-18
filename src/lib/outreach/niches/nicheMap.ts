/**
 * Outreach-only normalization from a lead's raw `niche` value to one of
 * the 13 outreach categories.
 *
 * This layer is additive: `NICHES` (src/lib/lead-workspace.ts) stays the
 * controlled CRM vocabulary and is imported, never re-typed, so its 71
 * `{value,label}` entries can only ever be defined in one place. Nothing
 * here touches the discovery taxonomy or NICHE_CATALOG.
 *
 * Matching is EXACT ONLY. The only normalization applied to the raw value
 * is `trim()` + lowercase. There is deliberately no fuzzy matching, no
 * substring matching, no edit distance, no synonym table, and no inference
 * from the business name — an unrecognised value falls back to
 * `community_other` rather than being guessed at. "cafes" is not "cafe".
 */

import { NICHES } from "@/lib/lead-workspace";
import { CATEGORY_KEYS, type OutreachCategoryKey } from "./nicheCategories";

/** The fallback category for null/empty/unknown/legacy niche values. */
export const FALLBACK_CATEGORY: OutreachCategoryKey = "community_other";

/**
 * Raw niche value → outreach category. Keyed by the exact `value` strings
 * in `NICHES`; validated at import time below so a niche added to
 * lead-workspace.ts without a category here fails loudly rather than
 * silently falling back.
 */
const NICHE_VALUE_TO_CATEGORY: Readonly<Record<string, OutreachCategoryKey>> = {
  // food_beverage
  cafe: "food_beverage",
  coffee_shop: "food_beverage",
  bakery: "food_beverage",
  restaurant: "food_beverage",
  bar_lounge: "food_beverage",
  food_truck: "food_beverage",
  catering: "food_beverage",
  // beauty_wellness
  hair_salon: "beauty_wellness",
  barbershop: "beauty_wellness",
  nail_salon: "beauty_wellness",
  spa_wellness: "beauty_wellness",
  tattoo_studio: "beauty_wellness",
  // fitness_movement
  yoga_studio: "fitness_movement",
  pilates_studio: "fitness_movement",
  fitness: "fitness_movement",
  crossfit: "fitness_movement",
  martial_arts: "fitness_movement",
  dance_studio: "fitness_movement",
  personal_trainer: "fitness_movement",
  // retail_goods
  boutique_retail: "retail_goods",
  clothing_brand: "retail_goods",
  jewelry: "retail_goods",
  home_decor: "retail_goods",
  florist: "retail_goods",
  gift_shop: "retail_goods",
  bookshop: "retail_goods",
  vintage_shop: "retail_goods",
  ecommerce: "retail_goods",
  // creative_services
  photography: "creative_services",
  videography: "creative_services",
  architecture: "creative_services",
  interior_design: "creative_services",
  graphic_design: "creative_services",
  branding_studio: "creative_services",
  art_gallery: "creative_services",
  music_studio: "creative_services",
  // property
  real_estate: "property",
  property_management: "property",
  mortgage_broker: "property",
  // financial_legal
  law_firm: "financial_legal",
  accounting: "financial_legal",
  financial_advisor: "financial_legal",
  insurance: "financial_legal",
  // healthcare
  medical_clinic: "healthcare",
  dental: "healthcare",
  chiropractic: "healthcare",
  mental_health: "healthcare",
  optometry: "healthcare",
  veterinary: "healthcare",
  // family_education
  childcare: "family_education",
  tutoring: "family_education",
  // coaching_events
  coaching: "coaching_events",
  event_planning: "coaching_events",
  wedding_planner: "coaching_events",
  // home_trades
  cleaning_service: "home_trades",
  landscaping: "home_trades",
  construction: "home_trades",
  plumbing: "home_trades",
  electrician: "home_trades",
  hvac: "home_trades",
  auto_repair: "home_trades",
  car_detailing: "home_trades",
  moving_service: "home_trades",
  local_services: "home_trades",
  // agency_tech
  marketing_agency: "agency_tech",
  pr_agency: "agency_tech",
  digital_agency: "agency_tech",
  saas: "agency_tech",
  // community_other
  nonprofit: "community_other",
  religious_org: "community_other",
  other: "community_other",
};

/** Exact display-label lookup, folded once at module load. */
const LABEL_TO_VALUE: ReadonlyMap<string, string> = new Map(
  NICHES.map((niche) => [niche.label.trim().toLowerCase(), niche.value]),
);

const VALUE_SET: ReadonlySet<string> = new Set(NICHES.map((niche) => niche.value));

// ─── Import-time validation ─────────────────────────────────────────────────

// Every one of the 71 controlled niche values must have a category, and no
// category key may be invented here.
for (const niche of NICHES) {
  const category = NICHE_VALUE_TO_CATEGORY[niche.value];
  if (!category) {
    throw new Error(`nicheMap.ts: niche "${niche.value}" from NICHES has no outreach category mapping`);
  }
  if (!(CATEGORY_KEYS as readonly string[]).includes(category)) {
    throw new Error(`nicheMap.ts: niche "${niche.value}" maps to unknown category "${category}"`);
  }
}
// And nothing may be mapped here that isn't a real controlled niche value.
for (const value of Object.keys(NICHE_VALUE_TO_CATEGORY)) {
  if (!VALUE_SET.has(value)) {
    throw new Error(`nicheMap.ts: "${value}" is mapped but is not a value in NICHES`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export type NicheResolution = {
  /** The controlled niche value this resolved to, or null if it didn't resolve. */
  readonly nicheValue: string | null;
  readonly category: OutreachCategoryKey;
  /** True when the raw value matched a controlled niche exactly (by value or label). */
  readonly matched: boolean;
};

/**
 * Resolve a raw `lead.niche` to a controlled niche value + outreach
 * category. Exact matching only: value first, then display label, then
 * fallback. Never guesses.
 */
export function resolveNiche(raw: string | null | undefined): NicheResolution {
  if (typeof raw !== "string") {
    return { nicheValue: null, category: FALLBACK_CATEGORY, matched: false };
  }
  const folded = raw.trim().toLowerCase();
  if (!folded) {
    return { nicheValue: null, category: FALLBACK_CATEGORY, matched: false };
  }

  // 1. exact niche value match
  if (VALUE_SET.has(folded)) {
    return { nicheValue: folded, category: NICHE_VALUE_TO_CATEGORY[folded], matched: true };
  }

  // 2. exact display-label match
  const byLabel = LABEL_TO_VALUE.get(folded);
  if (byLabel) {
    return { nicheValue: byLabel, category: NICHE_VALUE_TO_CATEGORY[byLabel], matched: true };
  }

  // 3. fallback — never a guess
  return { nicheValue: null, category: FALLBACK_CATEGORY, matched: false };
}

/** Convenience wrapper when only the category is needed. */
export function resolveCategory(raw: string | null | undefined): OutreachCategoryKey {
  return resolveNiche(raw).category;
}

export { NICHE_VALUE_TO_CATEGORY };
