/**
 * Single source of truth for the FOCUS_AREA label -> profession_slug
 * mapping.
 *
 * ROOT CAUSE this file fixes: `professions.slug` (migrations/001, seeded
 * once and never re-derived) and the `PROFESSION_SLUGS` weight-table keys
 * (scoring/professionWeights.ts) were both hand-written to *abbreviate*
 * multi-word labels by dropping "and" (e.g. "Programming & Tech" ->
 * `programming_tech`). Meanwhile src/server/routes/discover.ts and
 * src/server/routes/intelligence.ts each hand-rolled their own
 * `slugifyProfession(label)` that mechanically lowercases the label and
 * turns "&" into the literal word "and" (`programming_and_tech`, not the
 * `programming_tech` the table actually has). Every Discover request whose
 * profile had a multi-word focus area ("Programming & Tech", "Writing &
 * Translation", "Video & Animation", "Personal Growth & Hobbies")
 * therefore generated a `profession_slug` that no row in `professions`
 * has, and the later `leads` insert (profession_slug references
 * professions(slug)) failed its foreign key check every time.
 *
 * Fix: stop *generating* slugs from labels via string transformation
 * entirely. Slugs are looked up from this fixed table instead, so a
 * profession_slug can only ever be one of the values already seeded into
 * `professions` (migrations/001_opportunity_engine.sql) — it is
 * structurally impossible for this lookup to produce a slug the table
 * doesn't have, because the two lists here ARE what the seed and the
 * scoring weight table are generated from. professionWeights.ts and
 * onboarding.tsx's FOCUS_AREAS both defer to this module now.
 */

export const PROFESSION_SLUGS = [
  "graphic_design",
  "digital_marketing",
  "writing_translation",
  "video_animation",
  "music_audio",
  "programming_tech",
  "data",
  "business",
  "personal_growth_hobbies",
  "photography",
  "finance",
  "end_to_end_project",
] as const;

export type ProfessionSlug = (typeof PROFESSION_SLUGS)[number];

/**
 * Onboarding's FOCUS_AREAS labels, in the exact same order as
 * PROFESSION_SLUGS above — index i of one corresponds to index i of the
 * other. onboarding.tsx zips its icons onto these labels; nothing else
 * should hand-write this label list again.
 */
export const FOCUS_AREA_LABELS = [
  "Graphic Design",
  "Digital Marketing",
  "Writing & Translation",
  "Video & Animation",
  "Music & Audio",
  "Programming & Tech",
  "Data",
  "Business",
  "Personal Growth & Hobbies",
  "Photography",
  "Finance",
  "End-to-End Project",
] as const;

if (FOCUS_AREA_LABELS.length !== PROFESSION_SLUGS.length) {
  // Fails loudly at import time (in every process that loads this module —
  // frontend build, gateway boot, worker boot) instead of silently
  // producing mismatched data if someone edits one list without the other.
  throw new Error("professions.ts: FOCUS_AREA_LABELS and PROFESSION_SLUGS have drifted out of sync");
}

const LABEL_TO_SLUG: ReadonlyMap<string, ProfessionSlug> = new Map(
  FOCUS_AREA_LABELS.map((label, i) => [label, PROFESSION_SLUGS[i]]),
);

/**
 * Resolves a stored `settings.focusArea` label to the profession_slug that
 * actually exists in the `professions` table — or null if the label isn't
 * (or is no longer) one of the fixed FOCUS_AREAS options (e.g. legacy /
 * blank / free-text data). Never invents a slug via string manipulation,
 * so the result is always either a real row in `professions` or null.
 */
export function professionSlugForLabel(label: string | null | undefined): ProfessionSlug | null {
  if (!label) return null;
  return LABEL_TO_SLUG.get(label) ?? null;
}

export function isProfessionSlug(value: string | null | undefined): value is ProfessionSlug {
  return !!value && (PROFESSION_SLUGS as readonly string[]).includes(value);
}
