import { PROFESSION_SLUGS, PROFESSION_WEIGHTS, type ProfessionSlug } from "./professionWeights.js";

export type ScorableBusiness = {
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  has_photos: boolean | null;
  reviews_count: number | null;
  reviews_rating: number | null;
  is_disqualified: boolean | null;
  signals: {
    ig_activity?: string | null;
    ig_last_post_days?: number | null;
    growth_signals?: {
      hiring?: boolean;
      new_location?: boolean;
      recently_rebranded?: boolean;
      funding?: boolean;
    } | null;
  } | null;
};

export type OpportunityScoreResult = {
  score: number;
  breakdown: {
    website: number;
    branding: number;
    social: number;
    growth: number;
    newness: number;
  };
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * 100 = no website at all (maximum opportunity for anyone who builds/fixes
 * websites), 70 = a weak/templated placeholder (linktree, a bare social
 * page used as "the website", a free site-builder subdomain), scaling down
 * to ~15 for a real, custom-domain, HTTPS site.
 *
 * This is a lightweight TS heuristic, NOT a port of Part 1's
 * `utils/parsing.py::is_weak_site` — that function stays untouched and
 * unexported. Good enough to rank within a batch; not claimed to be as
 * precise as the engine's own internal quality proxy.
 */
function websiteOpportunity(b: ScorableBusiness): number {
  const site = (b.website ?? "").trim().toLowerCase();
  if (!site) return 100;

  const weakPatterns = [
    "linktr.ee",
    "wixsite.com",
    "weebly.com",
    "godaddysites.com",
    "business.site",
    "sites.google.com",
    "facebook.com/",
    "instagram.com/",
    "square.site",
  ];
  if (weakPatterns.some((p) => site.includes(p))) return 70;

  let score = 40;
  if (site.startsWith("https://")) score -= 10;
  const cheapTlds = [".tk", ".ml", ".ga", ".cf", ".gq", ".info"];
  if (cheapTlds.some((t) => site.includes(t))) score += 25;

  return clamp(score);
}

/**
 * 100 = no visible brand investment at all (no photos, no social, no
 * activity, no rating signal) — the doc's "weak branding" case. Scales
 * down as more brand-strength signals show up.
 */
function brandingOpportunity(b: ScorableBusiness): number {
  const hasPhotos = Boolean(b.has_photos);
  const hasInstagram = Boolean((b.instagram ?? "").trim());
  const recentActivity = (b.signals?.ig_last_post_days ?? null) !== null && (b.signals!.ig_last_post_days as number) <= 30;
  const strongRating = (b.reviews_rating ?? 0) >= 4.3;

  const signals = [hasPhotos, hasInstagram, recentActivity, strongRating];
  const strength = signals.filter(Boolean).length / signals.length; // 0..1

  return clamp(100 * (1 - strength));
}

/**
 * 100 = zero social presence on any channel (the doc's "no social media"
 * case) — highest priority for marketers. Scales down with recent
 * activity; an unknown activity state (channel exists, but we don't know
 * how active) gets a neutral middle value rather than 0 or 100.
 */
function socialOpportunity(b: ScorableBusiness): number {
  const hasAnySocial = Boolean((b.instagram ?? "").trim()) || Boolean((b.facebook ?? "").trim());
  if (!hasAnySocial) return 100;

  const days = b.signals?.ig_last_post_days;
  if (days == null) return 40;
  if (days <= 14) return 10;
  if (days <= 30) return 25;
  if (days <= 60) return 45;
  if (days <= 90) return 65;
  return 85;
}

/**
 * The one POSITIVE-direction component: hiring/expansion/funding/rebrand
 * signals mean a business likely has budget — the doc explicitly lists
 * "businesses showing growth" as higher, not lower, opportunity. Absence
 * of detected growth signals is neutral (0), never a penalty — Part 1
 * rarely populates this today, so treating "unknown" as a penalty would
 * unfairly tank nearly every business's growth component.
 */
function growthOpportunity(b: ScorableBusiness): number {
  const g = b.signals?.growth_signals;
  if (!g) return 0;
  let score = 0;
  if (g.hiring) score += 25;
  if (g.new_location) score += 25;
  if (g.recently_rebranded) score += 20;
  if (g.funding) score += 30;
  return clamp(score);
}

/**
 * Proxy for "newer/smaller business" using review count (we don't have a
 * true founding date from Part 1) — 100 for zero reviews, falling off
 * logarithmically the same way scorer.py's review_score does, just
 * inverted (fewer reviews = more opportunity here, vs. more reviews =
 * more points there).
 */
function newnessOpportunity(b: ScorableBusiness): number {
  const count = Math.min(500, Math.max(0, b.reviews_count ?? 0));
  if (count === 0) return 100;
  const logRatio = Math.log10(count + 1) / Math.log10(501); // 0..1
  return clamp(100 * (1 - logRatio));
}

/**
 * Computes the Opportunity Score for a single business, once per
 * profession. Hard-disqualified businesses (chain/cannabis, flagged by
 * Part 1's own is_chain/is_cannabis via service.py) score 0 across the
 * board regardless of profession — no freelancer's outreach targets a
 * Starbucks.
 */
export function computeOpportunityScores(business: ScorableBusiness): Record<ProfessionSlug, OpportunityScoreResult> {
  const results = {} as Record<ProfessionSlug, OpportunityScoreResult>;

  if (business.is_disqualified) {
    for (const slug of PROFESSION_SLUGS) {
      results[slug] = { score: 0, breakdown: { website: 0, branding: 0, social: 0, growth: 0, newness: 0 } };
    }
    return results;
  }

  const breakdown = {
    website: websiteOpportunity(business),
    branding: brandingOpportunity(business),
    social: socialOpportunity(business),
    growth: growthOpportunity(business),
    newness: newnessOpportunity(business),
  };

  for (const slug of PROFESSION_SLUGS) {
    const w = PROFESSION_WEIGHTS[slug];
    const score = clamp(
      breakdown.website * w.website +
        breakdown.branding * w.branding +
        breakdown.social * w.social +
        breakdown.growth * w.growth +
        breakdown.newness * w.newness,
    );
    results[slug] = { score: Math.round(score * 100) / 100, breakdown };
  }

  return results;
}
