/**
 * Shared type contracts for the deterministic Free-plan outreach generator
 * (src/lib/outreach/**). This file defines nothing else — no data, no
 * logic — so every later module (professions/, niches/, compatibility/,
 * signals/, templates/, channels/, continuity/, pipeline.ts) can import
 * from here without pulling in anything runtime-heavy.
 *
 * Canonical types owned by the rest of the codebase are re-exported, not
 * duplicated:
 *  - `ProfessionSlug` / `PROFESSION_SLUGS` stay owned by src/lib/professions.ts.
 *  - `Lead`, `OutreachChannel`, `LeadActivity`, `LeadActivityType`,
 *    `OpportunityExplanation`, `OpportunityExplanationReason` stay owned by
 *    src/lib/api.ts.
 * This module only re-exports the ones the outreach layer actually needs,
 * so later files can `import type { ... } from "./types"` (or
 * "../types") as a single entry point instead of reaching into `@/lib/api`
 * and `@/lib/professions` directly.
 */

import type { ProfessionSlug } from "@/lib/professions";
import type {
  Lead,
  OutreachChannel,
  LeadActivity,
  LeadActivityType,
  OpportunityExplanationReason,
} from "@/lib/api";

export type { ProfessionSlug } from "@/lib/professions";
export type {
  Lead,
  OutreachChannel,
  LeadActivity,
  LeadActivityType,
  OpportunityExplanationReason,
} from "@/lib/api";

// ─── Opportunity components ─────────────────────────────────────────────────

/**
 * The six-value component union used by the outreach-authored content
 * (profession/category profiles, ProfessionSlug × component maps, etc).
 *
 * NOTE — a real discrepancy exists between two parts of the already-built
 * system, confirmed by reading the code directly (not just the design
 * doc):
 *  - The scoring engine (src/scoring/professionWeights.ts /
 *    opportunityScore.ts) DOES compute a 6th `tech` component — it has
 *    real weights per profession and a real `techOpportunity()` scorer.
 *  - But the *client-side* contract for the explain endpoint,
 *    `OpportunityExplanationReason.component` in src/lib/api.ts, is typed
 *    with only 5 values (`website | branding | social | growth | newness`)
 *    — `tech` is never surfaced as a `reason` the frontend can read, even
 *    though the backend scores it.
 *
 * `OpportunityComponent` is kept as the 6-value union here so
 * category-authored `tech` content (compatibility rules, profession
 * angles, etc.) isn't discarded — but any code that derives a component
 * from `OpportunityExplanationReason.component` (i.e. from the live
 * signal, not authored content) can only ever produce one of the 5 values
 * that type declares. `tech` can only be reached through a category
 * profile's non-opportunity fallback path, never as a scored signal read
 * from the explain endpoint. Do not "fix" this by widening
 * `OpportunityExplanationReason` here — that type is owned by
 * src/lib/api.ts and mirrors the backend response body; changing it is
 * out of scope for the outreach generator.
 */
export type OpportunityComponent = "website" | "branding" | "social" | "growth" | "newness" | "tech";

/**
 * Where a chosen angle/component ultimately came from. Mirrors the ladder
 * used both live (opportunitySignal.ts's fallback) and in stored send
 * history (`ContinuityMetadata.originalAngleSource` below) — the two use
 * the same three values so a stored value can be compared directly against
 * a freshly-computed one.
 */
export type AngleSource = "opportunity" | "category-fallback" | "profession-generic";

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * Every value in `TEMPLATES` (src/lib/lead-workspace.ts). Kept here as an
 * explicit literal union (that file's `TEMPLATES` array is plain
 * `{value, label}[]`, not `as const`, so it exposes no type of its own to
 * import) — if a template is ever added or renamed there, this union must
 * be updated to match by hand; nothing enforces the two automatically.
 */
export type TemplateKey =
  | "initial"
  | "follow_up_2day"
  | "follow_up_5day"
  | "buried_bump"
  | "objection_handling"
  | "reengagement"
  | "pricing_transition";

/**
 * The six Free-tier templates the deterministic generator is actually
 * responsible for. `objection_handling` is Paid/AI-only and is
 * deliberately excluded — the Free pipeline never imports or references
 * it, which is what makes "Free generation can't reach the AI path"
 * structural rather than a runtime check.
 */
export type FreeTemplateKey = Exclude<TemplateKey, "objection_handling">;

/**
 * A template's `eligible()` predicate result — `true`, or a refusal with a
 * human-readable reason the UI can surface inline next to the disabled
 * Generate button (see the template-dropdown eligibility behavior).
 */
export type TemplateEligibilityResult = true | { refusalReason: string };

/**
 * The ordered, channel-agnostic slot content a template's `render()`
 * produces. No line breaks, no subject line, no channel-specific
 * phrasing — assembling those is exclusively `channels/formatters.ts`'s
 * job, never a template's.
 */
export type SlotType = "opening" | "continuity" | "observation" | "angle" | "value" | "cta" | "signoff";

export type SlotContent = {
  opening: string;
  continuity?: string;
  observation?: string;
  angle?: string;
  value?: string;
  cta: string;
  signoff?: string;
};

/**
 * The shape every entry in templates/index.ts conforms to. Stored as
 * plain data (no message strings baked in), per the locked template spec.
 * `eligible` and `render` are functions rather than data because they
 * depend on the specific lead/continuity/compatibility inputs at
 * generation time.
 */
export type TemplateDefinition = {
  key: FreeTemplateKey;
  purpose: string;
  /** Named inputs this template needs beyond the lead itself (e.g. "continuity", "explicitPricingContext"). */
  requiredContext: string[];
  /** The slots this template fills, in the order they should be assembled. */
  orderedSlots: SlotType[];
  eligible: (lead: Lead, continuity: ContinuityMetadata | null) => TemplateEligibilityResult;
  /** Claims this template must never make (guards against inventing lead facts) — enforced by slot authoring, not runtime-checked here. */
  forbiddenClaims: string[];
  /** Human-readable description of what happens when a preferred angle/context isn't available. */
  fallbackBehavior: string;
};

// ─── Profession × category compatibility ────────────────────────────────────

/**
 * A category key produced by niche normalization. Deliberately left as a
 * plain `string` here rather than a literal union: the 13 authored
 * category profiles (niches/nicheCategories.ts) and the "community_other"
 * fallback value referenced throughout the blueprint are authored content,
 * not a structural contract this file should be guessing at. The module
 * that authors those categories can narrow this further with its own
 * exported literal union once it exists; every other module should keep
 * importing `CategoryKey` from here so that narrowing only has to happen
 * in one place.
 */
export type CategoryKey = string;

/**
 * A niche's raw `value` (or, defensively, its `label`) as stored on a
 * lead — sourced from `NICHES` in src/lib/lead-workspace.ts. Left as
 * `string` for the same reason as `CategoryKey`: that array isn't
 * `as const`, so it exposes no literal type to import, and re-typing all
 * 71 values here would be duplicated data this step is explicitly not
 * meant to author.
 */
export type NicheValue = string;

/**
 * Tone-caution flags a category profile can carry, overriding a
 * template's default register. Exactly the two values referenced by the
 * compatibility rules (elevated sensitivity for regulated/sensitive
 * niches, a formal-preferred register for others).
 */
export type ToneCaution = "elevated-sensitivity" | "formal-preferred";

/**
 * The result of `resolveCompatibility(profession, category)` —
 * compatibility/index.ts's one exported function. A handful of rule
 * functions applied in order, not a profession × category matrix.
 */
export type CompatibilityResult = {
  suppressedComponents: OpportunityComponent[];
  terminologyOverride?: string;
  toneOverride?: ToneCaution;
  establishedQuality: boolean;
};

// ─── Opportunity signal ──────────────────────────────────────────────────────

/**
 * The result of signals/opportunitySignal.ts's best-effort read of
 * `getOpportunityExplanation()`, after suppression (from
 * `CompatibilityResult.suppressedComponents`) has been applied. Both a
 * missing/failed explanation (404/400/network/still-loading) and every
 * component being suppressed fold into `topComponent: null` — the
 * pipeline treats those identically as "no usable opportunity signal" and
 * proceeds to the next ladder rung.
 */
export type OpportunitySignalResult = {
  topComponent: OpportunityComponent | null;
  reason: OpportunityExplanationReason | null;
  source: AngleSource;
};

// ─── Continuity / send history ───────────────────────────────────────────────

/**
 * Shape of the `metadata` object attached to a genuine-send activity
 * (email_sent / instagram_sent / call_completed / contact_form_sent).
 * Written going forward (continuity/write.ts); read defensively
 * (continuity/read.ts), since rows sent before this existed won't have
 * it — a missing field is treated as "no stored angle," never an error.
 */
export type ContinuityMetadata = {
  originalTemplate: TemplateKey;
  originalAngleComponent: OpportunityComponent | "generic";
  originalAngleSource: AngleSource;
  /** ISO timestamp — redundant with the activity's own `timestamp`, kept for stability if metadata is ever read independently of its parent row. */
  sentAt: string;
  channel: OutreachChannel;
  /** id of the variation.ts fragment picked for the CTA slot, kept for exact-reproduction tests/debugging. */
  ctaStyle?: string;
};

/**
 * The four literal activity-type values that actually count as a genuine
 * send for continuity purposes. Deliberately NOT typed as (a subset of)
 * `LeadActivityType` — that union, per the prior audit, is known
 * incomplete (it declares `email_sent` but omits `instagram_sent`,
 * `call_completed`, and `contact_form_sent`, all of which are real
 * runtime values written elsewhere in the app). Continuity code should
 * compare `activity.type` against these literals directly rather than
 * relying on `LeadActivityType` to enumerate them.
 */
export type GenuineSendActivityType = "email_sent" | "instagram_sent" | "call_completed" | "contact_form_sent";

/**
 * A `LeadActivity` known (by its `type`) to be a genuine send, with the
 * outreach module's own `ContinuityMetadata` shape on `metadata` rather
 * than the loose `Record<string, unknown> | null` the base type declares.
 * Produced by continuity/read.ts after filtering + a type guard; never
 * assume an arbitrary `LeadActivity`'s `metadata` matches this shape.
 */
export type GenuineSendActivity = Omit<LeadActivity, "type" | "metadata"> & {
  type: GenuineSendActivityType;
  metadata: ContinuityMetadata | null;
};

// ─── Normalized opportunity signal (outreach adapter contract) ───────────────

/**
 * The outreach layer's normalized view of the deterministic Opportunity
 * Explanation endpoint (`GET /v1/intelligence/explain/:leadId`, read via
 * `getOpportunityExplanation`). The explain endpoint's own response body
 * stays owned by src/lib/api.ts and is not modified here; this is purely
 * the shape signals/opportunitySignal.ts normalizes it *into* so the rest
 * of the pipeline never has to handle a raw response, a 404, or a network
 * failure.
 *
 * `available: false` is the single "no usable signal" state — a missing
 * explanation, a failed request, an empty `reasons` array, and every
 * component being suppressed all fold into it. Generation must never be
 * blocked by this; it simply moves down the fallback ladder.
 */
export type NormalizedOpportunitySignal = {
  readonly available: boolean;
  /** Components ordered strongest-first, already filtered of suppressed ones. */
  readonly rankedComponents: readonly OpportunityComponent[];
  readonly topComponent: OpportunityComponent | null;
  readonly score: number | null;
};

// ─── Free generation result ──────────────────────────────────────────────────

/** Why the deterministic Free generator refused to produce a message. */
export type GenerationRefusalReason = "no_profession" | "template_ineligible";

export type GenerationRefusal = {
  readonly ok: false;
  readonly reason: GenerationRefusalReason;
  readonly detail: string;
};
