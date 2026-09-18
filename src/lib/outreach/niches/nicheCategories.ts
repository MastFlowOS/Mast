/**
 * The 13 authored outreach category profiles.
 *
 * These are outreach *content*, keyed by the 13 category keys the
 * normalization layer (nicheMap.ts) produces. They are not a second niche
 * list — the controlled CRM niche vocabulary stays owned by
 * `NICHES` in src/lib/lead-workspace.ts and is never re-typed here.
 *
 * Every rule in this file is conservative by construction: a category
 * profile describes what is safe to say about a *kind* of business in
 * general, never what is true about a specific lead. Nothing here asserts
 * that a lead has a storefront, staff, bookings, inventory, listings, or
 * traffic.
 */

import type { OpportunityComponent, ToneCaution } from "@/lib/outreach/types";

/** The 13 outreach categories. Owned here; nicheMap.ts maps into these. */
export const CATEGORY_KEYS = [
  "food_beverage",
  "beauty_wellness",
  "fitness_movement",
  "retail_goods",
  "creative_services",
  "property",
  "financial_legal",
  "healthcare",
  "family_education",
  "coaching_events",
  "home_trades",
  "agency_tech",
  "community_other",
] as const;

export type OutreachCategoryKey = (typeof CATEGORY_KEYS)[number];

/** One safe, category-level framing for a single opportunity component. */
export type ServiceOpportunityContext = {
  readonly component: OpportunityComponent;
  readonly concept: string;
  readonly safeWhen: string;
};

export type CategoryProfile = {
  readonly categoryKey: OutreachCategoryKey;
  /** What this category's audience should be called by default. */
  readonly terminologyPreference: string;
  /** Narrower term for specific niches inside the category, keyed by raw niche value. */
  readonly terminologyException?: Readonly<Record<string, string>>;
  /** What is safe to assume about this kind of business — and explicitly what is not. */
  readonly safeGeneralBusinessContext: string;
  /** Category-level floor used before the profession generic fallback. */
  readonly genericFallbackAngle: string;
  readonly serviceOpportunityContext: readonly ServiceOpportunityContext[];
  readonly toneCaution: ToneCaution | null;
};

const CATEGORY_PROFILES: Record<OutreachCategoryKey, CategoryProfile> = {
  food_beverage: {
    categoryKey: "food_beverage",
    terminologyPreference: "customers",
    safeGeneralBusinessContext:
      "a business working in food or drink. Do not assume a storefront, seating, reservations, delivery, or an online ordering system.",
    genericFallbackAngle: "how people first come across a food or drink business tends to shape whether they try it",
    serviceOpportunityContext: [
      {
        component: "social",
        concept: "food and drink businesses are often found through images before anything else",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "branding",
        concept: "the look of a food or drink business carries a lot of what people expect from it",
        safeWhen: "only with a branding signal; never assert the current look is poor",
      },
      {
        component: "website",
        concept: "people looking up a food or drink business usually want a short set of basics quickly",
        safeWhen: "only with a website signal; never assume ordering or reservations exist",
      },
    ],
    toneCaution: null,
  },

  beauty_wellness: {
    categoryKey: "beauty_wellness",
    terminologyPreference: "clients",
    safeGeneralBusinessContext:
      "a personal-care or wellness business. Do not assume online booking exists, and do not assume the size of the team.",
    genericFallbackAngle: "personal-care work is usually chosen on how it looks and how easy it is to arrange",
    serviceOpportunityContext: [
      {
        component: "social",
        concept: "this kind of work is often judged on the images of it that are public",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "branding",
        concept: "a consistent look carries a lot for a personal-care business",
        safeWhen: "only with a branding signal",
      },
      {
        component: "website",
        concept: "people usually want services and how to get in touch in one place",
        safeWhen: "only with a website signal; never assume a booking system exists",
      },
    ],
    toneCaution: null,
  },

  fitness_movement: {
    categoryKey: "fitness_movement",
    terminologyPreference: "clients",
    terminologyException: { yoga_studio: "students", dance_studio: "students", martial_arts: "students" },
    safeGeneralBusinessContext:
      "a fitness or movement business, which may be a single independent instructor rather than a studio with staff. Do not assume a team, a space, or a class schedule.",
    genericFallbackAngle: "people choosing a class or trainer usually want a clear sense of what it is before they show up",
    serviceOpportunityContext: [
      {
        component: "social",
        concept: "this kind of business is often found through the content it posts",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "growth",
        concept: "reaching people who have not already heard of it tends to be the constraint",
        safeWhen: "only with a growth signal; never assert the business is not growing",
      },
      {
        component: "website",
        concept: "what the sessions are and how to start are the things people look for first",
        safeWhen: "only with a website signal; never assume a booking system",
      },
    ],
    toneCaution: null,
  },

  retail_goods: {
    categoryKey: "retail_goods",
    terminologyPreference: "customers",
    safeGeneralBusinessContext:
      "a business selling goods, which may be online-only. Do not assume a physical storefront, stock levels, or a shipping operation.",
    genericFallbackAngle: "how products are presented tends to do most of the work of selling them",
    serviceOpportunityContext: [
      {
        component: "social",
        concept: "goods are frequently discovered through images rather than search",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "branding",
        concept: "a consistent look across product presentation carries recognition",
        safeWhen: "only with a branding signal",
      },
      {
        component: "website",
        concept: "people want to see what is available and how to buy it without hunting",
        safeWhen: "only with a website signal; never assume an e-commerce setup exists",
      },
    ],
    toneCaution: null,
  },

  creative_services: {
    categoryKey: "creative_services",
    terminologyPreference: "clients",
    safeGeneralBusinessContext:
      "a creative or design-led business. These overlap heavily with several freelancer professions — the compatibility layer suppresses same-domain angles, so never frame this kind of business as needing help with its own craft.",
    genericFallbackAngle: "creative work is usually won on what can be shown, and on being found by the right people",
    serviceOpportunityContext: [
      {
        component: "growth",
        concept: "reaching the clients who would value the work is often the harder half",
        safeWhen: "only with a growth signal",
      },
      {
        component: "social",
        concept: "a portfolio is easier to find when it is being shown regularly",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "newness",
        concept: "a newer creative business is usually still building a body of public work",
        safeWhen: "only with a newness signal",
      },
    ],
    toneCaution: null,
  },

  property: {
    categoryKey: "property",
    terminologyPreference: "clients",
    safeGeneralBusinessContext:
      "a property business. Do not assume listings, inventory, photography, enquiry volume, or an established weakness in its website, branding, or technology.",
    genericFallbackAngle: "property work is usually won on presentation and on being in front of the right people at the right time",
    serviceOpportunityContext: [
      {
        component: "growth",
        concept: "reaching the right people at the point they are looking is the usual constraint",
        safeWhen: "only with a growth signal",
      },
      {
        component: "social",
        concept: "property is often browsed visually before anyone gets in touch",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "newness",
        concept: "a newer property business is still building its presence in an area",
        safeWhen: "only with a newness signal",
      },
    ],
    toneCaution: null,
  },

  financial_legal: {
    categoryKey: "financial_legal",
    terminologyPreference: "clients",
    safeGeneralBusinessContext:
      "a regulated professional-services business. Never make outcome, compliance, regulatory, or results claims of any kind, and do not assume an established weakness in its website, branding, or technology.",
    genericFallbackAngle: "professional-services firms are usually chosen on clarity and credibility rather than volume",
    serviceOpportunityContext: [
      {
        component: "growth",
        concept: "reaching the right clients is generally the constraint rather than capability",
        safeWhen: "only with a growth signal; never attach any outcome claim",
      },
      {
        component: "newness",
        concept: "a newer firm is still establishing how it is known",
        safeWhen: "only with a newness signal",
      },
      {
        component: "social",
        concept: "a professional presence is often the first thing a prospective client checks",
        safeWhen: "only when a social presence is known to exist",
      },
    ],
    toneCaution: "formal-preferred",
  },

  healthcare: {
    categoryKey: "healthcare",
    terminologyPreference: "patients",
    terminologyException: { veterinary: "pet owners" },
    safeGeneralBusinessContext:
      "a healthcare or clinical practice. Never make clinical, treatment, or outcome claims, and never reference conditions, care, or patient information.",
    genericFallbackAngle: "practices are usually found by people who want to know what is offered and how to get in touch",
    serviceOpportunityContext: [
      {
        component: "website",
        concept: "people looking up a practice want services and contact details plainly",
        safeWhen: "only with a website signal; never assume a booking system and never reference care",
      },
      {
        component: "growth",
        concept: "being found by the people nearby who are looking is the usual constraint",
        safeWhen: "only with a growth signal; never attach any clinical or outcome framing",
      },
      {
        component: "newness",
        concept: "a newer practice is still becoming known locally",
        safeWhen: "only with a newness signal",
      },
    ],
    toneCaution: "elevated-sensitivity",
  },

  family_education: {
    categoryKey: "family_education",
    terminologyPreference: "families",
    terminologyException: { tutoring: "students" },
    safeGeneralBusinessContext:
      "a family or education business. Remain conservative: never mention children, ages, groups, or any child-specific detail, and never assume anything about who attends.",
    genericFallbackAngle: "families deciding on a provider usually want a clear picture of what is offered before they enquire",
    serviceOpportunityContext: [
      {
        component: "website",
        concept: "what is offered and how to get in touch are what people look for first",
        safeWhen: "only with a website signal; never reference children specifically",
      },
      {
        component: "growth",
        concept: "being found by nearby families who are looking is the usual constraint",
        safeWhen: "only with a growth signal",
      },
      {
        component: "newness",
        concept: "a newer provider is still becoming known in its area",
        safeWhen: "only with a newness signal",
      },
    ],
    toneCaution: null,
  },

  coaching_events: {
    categoryKey: "coaching_events",
    terminologyPreference: "clients",
    safeGeneralBusinessContext:
      "a coaching or events business, often run by one person. Do not assume a storefront, staff, recurring traffic, or a fixed schedule.",
    genericFallbackAngle: "this kind of work is usually chosen on how clearly the offering is explained",
    serviceOpportunityContext: [
      {
        component: "social",
        concept: "people tend to look at what is being shared before enquiring",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "website",
        concept: "one clear place explaining the offering saves people piecing it together",
        safeWhen: "only with a website signal",
      },
      {
        component: "growth",
        concept: "reaching people beyond referrals is the usual constraint",
        safeWhen: "only with a growth signal",
      },
    ],
    toneCaution: null,
  },

  home_trades: {
    categoryKey: "home_trades",
    terminologyPreference: "customers",
    safeGeneralBusinessContext:
      "a trade or home-services business, usually working across a service area rather than from a storefront. Do not assume a shop, a fleet, or a team.",
    genericFallbackAngle: "trades work is usually found at the moment someone needs it, so being easy to find and contact matters",
    serviceOpportunityContext: [
      {
        component: "website",
        concept: "people looking for a trade want the service area and a way to get in touch quickly",
        safeWhen: "only with a website signal; never assume a storefront",
      },
      {
        component: "growth",
        concept: "reaching people beyond word of mouth is the usual constraint",
        safeWhen: "only with a growth signal",
      },
      {
        component: "social",
        concept: "finished work is often the most persuasive thing this kind of business can show",
        safeWhen: "only when a social presence is known to exist",
      },
    ],
    toneCaution: null,
  },

  agency_tech: {
    categoryKey: "agency_tech",
    terminologyPreference: "clients",
    safeGeneralBusinessContext:
      "an agency or technology business. Be conservative: never assume a weak website, weak branding, or weak technology — this kind of business generally does that work itself.",
    genericFallbackAngle: "agency and technology businesses are usually constrained by reach rather than by capability",
    serviceOpportunityContext: [
      {
        component: "growth",
        concept: "reaching new clients competes with delivering work for existing ones",
        safeWhen: "only with a growth signal",
      },
      {
        component: "social",
        concept: "the work itself is often the strongest thing this kind of business can show publicly",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "newness",
        concept: "a newer agency or product is still establishing how it is known",
        safeWhen: "only with a newness signal",
      },
    ],
    toneCaution: null,
  },

  community_other: {
    categoryKey: "community_other",
    terminologyPreference: "people",
    terminologyException: { nonprofit: "supporters", religious_org: "members" },
    safeGeneralBusinessContext:
      "an organisation that does not fit the other categories, including nonprofits and religious organisations. For those, avoid sales, revenue, or customer framing entirely.",
    genericFallbackAngle: "being easy to find and clear about what is offered helps any organisation reach the people looking for it",
    serviceOpportunityContext: [
      {
        component: "website",
        concept: "a clear explanation of what an organisation does helps the people looking for it",
        safeWhen: "only with a website signal",
      },
      {
        component: "social",
        concept: "sharing what an organisation is doing helps the people who care about it stay connected",
        safeWhen: "only when a social presence is known to exist",
      },
      {
        component: "newness",
        concept: "a newer organisation is still becoming known",
        safeWhen: "only with a newness signal",
      },
    ],
    toneCaution: null,
  },
};

// ─── Validation (import-time, same fail-loudly pattern as professions.ts) ────

for (const key of CATEGORY_KEYS) {
  const profile = CATEGORY_PROFILES[key];
  if (!profile) throw new Error(`nicheCategories.ts: missing category profile for "${key}"`);
  if (profile.categoryKey !== key) {
    throw new Error(`nicheCategories.ts: "${key}" profile has mismatched categoryKey "${profile.categoryKey}"`);
  }
  if (profile.serviceOpportunityContext.length === 0) {
    throw new Error(`nicheCategories.ts: "${key}" has no serviceOpportunityContext entries`);
  }
}

export { CATEGORY_PROFILES };

export function getCategoryProfile(key: OutreachCategoryKey): CategoryProfile {
  return CATEGORY_PROFILES[key];
}
