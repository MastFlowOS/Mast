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
  /**
   * I1 fix: tech-stack evidence (chatbot/booking-flow/analytics presence,
   * already fingerprinted per-page by site_crawler.py's `detect_tech_stack`
   * but never fed into scoring before this pass) — no chatbot -> AI
   * Automation opportunity, no booking flow -> AI Automation/web dev
   * opportunity, per the brief's Priority 5 examples.
   */
  tech: number;
};

/**
 * Raw (not-yet-normalized) per-profession weights, INCLUDING the new `tech`
 * dimension. Adding a 6th component by hand-editing 12 rows of weights that
 * must each sum to exactly 1.0 is exactly the kind of arithmetic error this
 * avoids: weights below are written by relative importance only, then
 * `normalizeWeights()` scales each profession's row so it sums to 1.0. This
 * also means adding a 7th component later never requires re-deriving 12
 * existing rows by hand again.
 */
const RAW_WEIGHTS: Record<ProfessionSlug, WeightVector> = {
  graphic_design:            { website: 0.10, branding: 0.45, social: 0.20, growth: 0.10, newness: 0.15, tech: 0.03 },
  digital_marketing:         { website: 0.15, branding: 0.20, social: 0.40, growth: 0.15, newness: 0.10, tech: 0.05 },
  writing_translation:       { website: 0.30, branding: 0.20, social: 0.20, growth: 0.15, newness: 0.15, tech: 0.03 },
  video_animation:           { website: 0.10, branding: 0.30, social: 0.35, growth: 0.10, newness: 0.15, tech: 0.03 },
  music_audio:               { website: 0.15, branding: 0.25, social: 0.35, growth: 0.10, newness: 0.15, tech: 0.03 },
  // Programmer/dev: tech-stack gaps (no chatbot, no booking flow, stale CMS)
  // are as direct a signal as website quality itself — weighted heavily.
  programming_tech:          { website: 0.45, branding: 0.08, social: 0.08, growth: 0.12, newness: 0.08, tech: 0.30 },
  data:                      { website: 0.30, branding: 0.08, social: 0.08, growth: 0.28, newness: 0.13, tech: 0.15 },
  // Closest existing fit for "AI Automation" (no dedicated profession slug
  // yet — see deliverables doc): manual workflows / no booking / no chatbot
  // are exactly this profile's opportunity signal.
  business:                  { website: 0.15, branding: 0.15, social: 0.12, growth: 0.28, newness: 0.12, tech: 0.20 },
  personal_growth_hobbies:   { website: 0.18, branding: 0.28, social: 0.28, growth: 0.05, newness: 0.15, tech: 0.03 },
  photography:               { website: 0.10, branding: 0.35, social: 0.28, growth: 0.05, newness: 0.19, tech: 0.02 },
  finance:                   { website: 0.13, branding: 0.08, social: 0.08, growth: 0.35, newness: 0.22, tech: 0.10 },
  end_to_end_project:        { website: 0.18, branding: 0.18, social: 0.18, growth: 0.18, newness: 0.18, tech: 0.10 },
};

function normalizeWeights(raw: Record<ProfessionSlug, WeightVector>): Record<ProfessionSlug, WeightVector> {
  const out = {} as Record<ProfessionSlug, WeightVector>;
  for (const slug of Object.keys(raw) as ProfessionSlug[]) {
    const w = raw[slug];
    const sum = w.website + w.branding + w.social + w.growth + w.newness + w.tech;
    out[slug] = {
      website: w.website / sum,
      branding: w.branding / sum,
      social: w.social / sum,
      growth: w.growth / sum,
      newness: w.newness / sum,
      tech: w.tech / sum,
    };
  }
  return out;
}

/** Guaranteed to sum to 1.0 per profession by construction (normalizeWeights), not by hand-checked arithmetic. */
export const PROFESSION_WEIGHTS: Record<ProfessionSlug, WeightVector> = normalizeWeights(RAW_WEIGHTS);
