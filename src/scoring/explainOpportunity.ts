import type { OpportunityScoreResult, ScorableBusiness } from "./opportunityScore.js";
import { PROFESSION_WEIGHTS, type ProfessionSlug } from "./professionWeights.js";

/**
 * Turns an already-computed Opportunity Score breakdown into human-readable
 * reasons — the Phase 8 "Opportunity Explanations" requirement.
 *
 * Deliberately NOT an LLM call: the doc requires explanations to "come from
 * the actual Opportunity Score components rather than being fabricated."
 * A template over real numbers is more trustworthy than a generative
 * paraphrase of them, and it's free/instant/always-fresh — this runs on
 * every delivery, not just for Premium.
 *
 * Reused by:
 *  - GET /v1/discover/explain/:businessId  (all tiers)
 *  - lib/ai.ts's opportunity-insight prompt (Premium), which is grounded by
 *    passing this function's output in as context rather than re-deriving
 *    reasons itself.
 */

export type ExplanationReason = {
  component: keyof OpportunityScoreResult["breakdown"];
  label: string;
  detail: string;
  /** How much this component actually moved the final score for THIS profession (0..1). */
  weight: number;
  /** The raw 0-100 component value. */
  value: number;
};

const COMPONENT_LABELS: Record<keyof OpportunityScoreResult["breakdown"], string> = {
  website: "Website",
  branding: "Branding",
  social: "Social presence",
  growth: "Growth signals",
  newness: "Business maturity",
};

function websiteDetail(b: ScorableBusiness, value: number): string {
  const site = (b.website ?? "").trim();
  if (!site) return "No website found — a common gap this profession can close.";
  if (value >= 60) return "Website exists but runs on a free/templated builder rather than a custom site.";
  return "Has an established, custom-domain website.";
}

function brandingDetail(b: ScorableBusiness, value: number): string {
  if (value >= 70) return "Little visible brand investment: no photos, inactive or missing social, no rating signal.";
  if (value >= 40) return "Some brand presence, but inconsistent across channels.";
  return "Already has a fairly consistent, professional brand presence.";
}

function socialDetail(b: ScorableBusiness, value: number): string {
  const hasAny = Boolean((b.instagram ?? "").trim()) || Boolean((b.facebook ?? "").trim());
  if (!hasAny) return "No social media presence detected on any channel.";
  const days = b.signals?.ig_last_post_days;
  if (days == null) return "Has social channels, but activity level is unknown.";
  if (days > 60) return `Social presence exists but looks dormant (~${days} days since last activity).`;
  return "Social presence is active and reasonably maintained.";
}

function growthDetail(b: ScorableBusiness, value: number): string {
  const g = b.signals?.growth_signals;
  if (!g || value === 0) return "No detected growth signals (hiring, new location, funding, rebrand).";
  const signals: string[] = [];
  if (g.hiring) signals.push("hiring");
  if (g.new_location) signals.push("opening a new location");
  if (g.recently_rebranded) signals.push("recently rebranded");
  if (g.funding) signals.push("recent funding");
  return `Showing growth signals: ${signals.join(", ")} — likely has budget to spend.`;
}

function newnessDetail(b: ScorableBusiness, value: number): string {
  const count = b.reviews_count ?? 0;
  if (count === 0) return "No reviews yet — likely a newer or very small business.";
  if (value >= 60) return `Relatively few reviews (${count}) suggest an earlier-stage business.`;
  return `Established review history (${count} reviews) suggests a more mature business.`;
}

const DETAIL_FNS: Record<keyof OpportunityScoreResult["breakdown"], (b: ScorableBusiness, v: number) => string> = {
  website: websiteDetail,
  branding: brandingDetail,
  social: socialDetail,
  growth: growthDetail,
  newness: newnessDetail,
};

export type OpportunityExplanation = {
  score: number;
  professionSlug: ProfessionSlug;
  professionMatch: "strong" | "moderate" | "weak";
  reasons: ExplanationReason[];
  summary: string;
};

/**
 * @param business    the raw scorable fields (same shape scoring reads)
 * @param result      the already-computed score + breakdown for this profession
 * @param professionSlug  which profession this explanation is for — the same
 *                     business gets a different explanation per profession,
 *                     same as it gets a different score.
 */
export function explainOpportunity(
  business: ScorableBusiness,
  result: OpportunityScoreResult,
  professionSlug: ProfessionSlug,
): OpportunityExplanation {
  const weights = PROFESSION_WEIGHTS[professionSlug];

  const contributions = (Object.keys(result.breakdown) as Array<keyof OpportunityScoreResult["breakdown"]>).map(
    (component) => {
      const value = result.breakdown[component];
      const weight = weights[component];
      return {
        component,
        label: COMPONENT_LABELS[component],
        detail: DETAIL_FNS[component](business, value),
        weight,
        value,
        contribution: value * weight,
      };
    },
  );

  // Rank by actual contribution to THIS profession's score, not raw value —
  // a business with zero social presence still shouldn't lead a
  // programmer's explanation if programming barely weights social.
  const ranked = [...contributions].sort((a, b) => b.contribution - a.contribution);
  const topWeight = Math.max(...Object.values(weights));
  const professionMatch: OpportunityExplanation["professionMatch"] =
    ranked[0].weight >= topWeight * 0.8 ? "strong" : ranked[0].weight >= topWeight * 0.4 ? "moderate" : "weak";

  const reasons: ExplanationReason[] = ranked
    .filter((c) => c.contribution > 5) // drop components that barely moved the needle
    .slice(0, 3)
    .map(({ component, label, detail, weight, value }) => ({ component, label, detail, weight, value }));

  const summary =
    reasons.length === 0
      ? "This business scored low for your profession — limited overlap with the signals that matter most here."
      : `Surfaced mainly for: ${reasons.map((r) => r.label.toLowerCase()).join(", ")}.`;

  return { score: result.score, professionSlug, professionMatch, reasons, summary };
}
