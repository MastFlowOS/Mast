/**
 * Profession slugs mirror migrations/001_opportunity_engine.sql's
 * `professions` table exactly (which itself mirrors the frontend's
 * onboarding.tsx FOCUS_AREAS). Sourced from lib/professions.ts — the
 * single canonical list — rather than hand-copied here a second time.
 * (A second hand-copied list is exactly how this table and the
 * label->slug generator in discover.ts/intelligence.ts drifted apart in
 * the first place; see lib/professions.ts's doc comment.) Re-exported so
 * existing `from "./professionWeights.js"` imports elsewhere keep working.
 */
export { PROFESSION_SLUGS, type ProfessionSlug } from "../lib/professions.js";
import type { ProfessionSlug } from "../lib/professions.js";

/**
 * The Opportunity Score blends five 0-100 "need" components (each already
 * oriented so higher = more opportunity — see opportunityScore.ts):
 *
 *   website  — no/weak website is a bigger deal to a programmer than a
 *              photographer
 *   branding — weak visual identity/branding matters most to designers
 *   social   — inactive/absent social presence matters most to marketers
 *   growth   — hiring/expansion signals (POSITIVE direction — a growing
 *              business has budget) matter most to business/finance
 *   newness  — smaller/newer businesses (proxied by low review count)
 *              matter broadly, weighted highest for finance/business
 *
 * Weights per profession must sum to 1.0 — checked in
 * opportunityScore.ts's self-test, not re-derived at runtime.
 *
 * THIS IS A v1 HEURISTIC MODEL, not a learned one. It encodes the product
 * philosophy doc's explicit examples (weak website -> high for a
 * programmer; weak branding/no social -> high for a designer) as directly
 * as the signals available from Part 1 allow. Refining these weights with
 * real outcome data (which opportunities actually converted) is future
 * work — flagged as a Phase 6 limitation, not solved here.
 */
export type WeightVector = {
  website: number;
  branding: number;
  social: number;
  growth: number;
  newness: number;
};

export const PROFESSION_WEIGHTS: Record<ProfessionSlug, WeightVector> = {
  // Cares most about visual identity/branding; website itself is secondary.
  graphic_design: { website: 0.1, branding: 0.45, social: 0.2, growth: 0.1, newness: 0.15 },

  // Cares most about active marketing/social presence and audience-building.
  digital_marketing: { website: 0.15, branding: 0.2, social: 0.4, growth: 0.15, newness: 0.1 },

  // Website copy/content quality is the closest proxy available; otherwise general.
  writing_translation: { website: 0.3, branding: 0.2, social: 0.2, growth: 0.15, newness: 0.15 },

  // Visual/motion content — branding and social (where video would be posted) dominate.
  video_animation: { website: 0.1, branding: 0.3, social: 0.35, growth: 0.1, newness: 0.15 },

  // Audio/podcast production — closest available proxies are social presence and branding.
  music_audio: { website: 0.15, branding: 0.25, social: 0.35, growth: 0.1, newness: 0.15 },

  // The strongest, most directly measurable dimension we have: website quality itself.
  programming_tech: { website: 0.55, branding: 0.1, social: 0.1, growth: 0.15, newness: 0.1 },

  // Data/analytics work correlates more with an operationally growing business than branding.
  data: { website: 0.35, branding: 0.1, social: 0.1, growth: 0.3, newness: 0.15 },

  // General business consulting — broad weighting, leans toward growth signals.
  business: { website: 0.2, branding: 0.2, social: 0.15, growth: 0.3, newness: 0.15 },

  // Coaching/hobby-adjacent services — personal brand and social presence dominate.
  personal_growth_hobbies: { website: 0.2, branding: 0.3, social: 0.3, growth: 0.05, newness: 0.15 },

  // Visual content is the whole product — has_photos / branding dominate heavily.
  photography: { website: 0.1, branding: 0.35, social: 0.3, growth: 0.05, newness: 0.2 },

  // Financial advisory tracks operational maturity/growth more than any visual signal.
  finance: { website: 0.15, branding: 0.1, social: 0.1, growth: 0.4, newness: 0.25 },

  // No single specialty — equal weighting across all five components.
  end_to_end_project: { website: 0.2, branding: 0.2, social: 0.2, growth: 0.2, newness: 0.2 },
};
