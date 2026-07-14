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
  tech: "Automation & tooling",
};

function websiteDetail(b: ScorableBusiness, value: number): string {
  const site = (b.website ?? "").trim();
  if (!site) return "No website found — a common gap this profession can close.";
  if (b.ssl_valid === false) return "Website exists but its SSL certificate is invalid or expired.";
  if (typeof b.load_time_ms === "number" && b.load_time_ms > 4000) return "Website exists but loads slowly.";
  if (value >= 60) return "Website exists but runs on a free/templated builder rather than a custom site.";
  return "Has an established, custom-domain website.";
}

function brandingDetail(b: ScorableBusiness, value: number): string {
  const seo = b.seo;
  if (seo && !(seo.has_title && seo.has_meta_description)) {
    return "Missing SEO basics (title tag or meta description) alongside weak brand presence.";
  }
  if (value >= 70) return "Little visible brand investment: no photos, inactive or missing social, no rating signal.";
  if (value >= 40) return "Some brand presence, but inconsistent across channels.";
  return "Already has a fairly consistent, professional brand presence.";
}

function socialDetail(b: ScorableBusiness, value: number): string {
  const hasAny = Boolean((b.instagram ?? "").trim()) || Boolean((b.facebook ?? "").trim()) || Boolean((b.linkedin ?? "").trim());
  if (!hasAny) return "No social media presence detected on any channel.";
  const days = b.signals?.ig_last_post_days;
  if (days == null) return "Has social channels, but activity level is unknown.";
  if (days > 60) return `Social presence exists but looks dormant (~${days} days since last activity).`;
  return "Social presence is active and reasonably maintained.";
}

function growthDetail(b: ScorableBusiness, value: number): string {
  // C3 fix: only ever describes hiring/new_location, both real detections
  // (see enrichment/site_crawler.py's `_detect_growth_signals`). Never
  // claims funding/rebrand were checked — they aren't, and saying "no
  // growth signals (hiring, new location, funding, rebrand)" when funding
  // and rebrand were never actually looked at was exactly the audit's C3
  // finding: a confident negative for something never verified.
  const g = b.signals?.growth_signals;
  if (!g || value === 0) return "No hiring or new-location signals detected on the website.";
  const signals: string[] = [];
  if (g.hiring) signals.push("hiring");
  if (g.new_location) signals.push("opening a new location");
  return `Showing growth signals: ${signals.join(", ")} — likely has budget to spend.`;
}

function newnessDetail(b: ScorableBusiness, value: number): string {
  const count = b.reviews_count ?? 0;
  if (count === 0) return "No reviews yet — likely a newer or very small business.";
  if (value >= 60) return `Relatively few reviews (${count}) suggest an earlier-stage business.`;
  return `Established review history (${count} reviews) suggests a more mature business.`;
}

function techDetail(b: ScorableBusiness, value: number): string {
  // I1 fix: tech-stack fingerprint was captured on every crawl and never
  // used in any explanation before this pass.
  if (!b.website) return "No website to evaluate for automation tooling.";
  const stack = (b.signals?.tech_stack ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  if (!stack.chat) missing.push("no chatbot");
  if (!stack.booking) missing.push("no online booking");
  if (!(Array.isArray(stack.analytics) ? stack.analytics.length > 0 : stack.analytics)) missing.push("no analytics detected");
  if (missing.length === 0) return "Already has chat, booking, and analytics tooling in place.";
  return `Manual/missing tooling detected: ${missing.join(", ")}.`;
}

const DETAIL_FNS: Record<keyof OpportunityScoreResult["breakdown"], (b: ScorableBusiness, v: number) => string> = {
  website: websiteDetail,
  branding: brandingDetail,
  social: socialDetail,
  growth: growthDetail,
  newness: newnessDetail,
  tech: techDetail,
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
