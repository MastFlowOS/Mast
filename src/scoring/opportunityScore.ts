import { PROFESSION_SLUGS, PROFESSION_WEIGHTS, type ProfessionSlug } from "./professionWeights.js";

export type ScorableBusiness = {
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin?: string | null;
  has_photos: boolean | null;
  reviews_count: number | null;
  reviews_rating: number | null;
  is_disqualified: boolean | null;
  // O2 fix: single source of truth for "weak/templated site" now comes
  // from the engine (utils/parsing.py::is_weak_site), stored on the row.
  // Falls back to a local heuristic only for rows crawled before this
  // column existed (website_is_weak is null).
  website_is_weak?: boolean | null;
  ssl_valid?: boolean | null;
  load_time_ms?: number | null;
  seo?: { has_title?: boolean; has_meta_description?: boolean } | null;
  blog?: { has_blog?: boolean; last_post_days?: number } | null;
  signals: {
    ig_activity?: string | null;
    ig_last_post_days?: number | null;
    tech_stack?: Record<string, unknown> | null;
    // C3 fix: only the two growth signals the engine can actually detect
    // and verify — see enrichment/site_crawler.py's `_detect_growth_signals`.
    growth_signals?: {
      hiring?: boolean;
      new_location?: boolean;
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
    tech: number;
  };
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * 100 = no website at all (maximum opportunity for anyone who builds/fixes
 * websites), 70 = a weak/templated placeholder (linktree, a bare social
 * page used as "the website", a free site-builder subdomain), scaling down
 * to ~15 for a real, custom-domain, HTTPS site.
 *
 * O2 fix: `website_is_weak` is now read directly from the engine's own
 * `utils/parsing.py::is_weak_site` (the maintained domain list) instead of
 * this file keeping its own separately hand-written, already-drifted copy.
 * The local pattern list below is kept ONLY as a fallback for rows scored
 * before `website_is_weak` existed on the table.
 */
function websiteOpportunity(b: ScorableBusiness): number {
  const site = (b.website ?? "").trim().toLowerCase();
  if (!site) return 100;

  if (b.website_is_weak === true) return 70;
  if (b.website_is_weak === false) {
    let score = 40;
    if (site.startsWith("https://")) score -= 10;
    if (b.ssl_valid === false) score += 20; // I2 fix: real cert probe, not a string check
    if (typeof b.load_time_ms === "number" && b.load_time_ms > 4000) score += 10; // I3 fix
    return clamp(score);
  }

  // Fallback for rows scored before website_is_weak existed.
  const weakPatterns = [
    "linktr.ee", "wixsite.com", "weebly.com", "godaddysites.com",
    "business.site", "sites.google.com", "facebook.com/", "instagram.com/", "square.site",
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
 * activity, no rating signal, weak on-page SEO) — the doc's "weak
 * branding" / "poor SEO, missing metadata" cases. Scales down as more
 * brand-strength signals show up.
 */
function brandingOpportunity(b: ScorableBusiness): number {
  const hasPhotos = Boolean(b.has_photos);
  const hasInstagram = Boolean((b.instagram ?? "").trim());
  const recentActivity = (b.signals?.ig_last_post_days ?? null) !== null && (b.signals!.ig_last_post_days as number) <= 30;
  const strongRating = (b.reviews_rating ?? 0) >= 4.3;
  // O1 fix: missing title/meta description is trivial, verifiable evidence
  // from HTML already fetched (site_crawler.py's `_detect_seo_signals`) —
  // folded into branding rather than a whole new weighted component so
  // profession weight vectors didn't need re-deriving from scratch.
  const seo = b.seo;
  const goodSeo = seo ? Boolean(seo.has_title && seo.has_meta_description) : true; // unknown = neutral, not a penalty

  const signals = [hasPhotos, hasInstagram, recentActivity, strongRating, goodSeo];
  const strength = signals.filter(Boolean).length / signals.length; // 0..1

  return clamp(100 * (1 - strength));
}

/**
 * 100 = zero social presence on any channel (the doc's "no social media"
 * case) — highest priority for marketers. Scales down with recent
 * activity; an unknown activity state (channel exists, but we don't know
 * how active) gets a neutral middle value rather than 0 or 100.
 *
 * C4 fix: LinkedIn now counts as a channel here (it used to sit in
 * `signals.linkedin`, unread by anything) — a B2B-focused business with a
 * LinkedIn page but no Instagram/Facebook should not score as if it had
 * zero social presence.
 */
function socialOpportunity(b: ScorableBusiness): number {
  const hasAnySocial =
    Boolean((b.instagram ?? "").trim()) || Boolean((b.facebook ?? "").trim()) || Boolean((b.linkedin ?? "").trim());
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
 * The one POSITIVE-direction component: hiring/expansion signals mean a
 * business likely has budget — the doc explicitly lists "businesses
 * showing growth" as higher, not lower, opportunity. Absence of detected
 * growth signals is neutral (0), never a penalty.
 *
 * C3 fix: `recently_rebranded` and `funding` were removed here (see
 * professionWeights.ts/scorer.py's matching fix) — nothing in the engine
 * can verify either today, so they're gone rather than permanently
 * contributing zero while pretending to have been checked.
 */
function growthOpportunity(b: ScorableBusiness): number {
  const g = b.signals?.growth_signals;
  if (!g) return 0;
  let score = 0;
  if (g.hiring) score += 45;
  if (g.new_location) score += 45;
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
 * I1 fix: tech-stack fingerprint (chatbot/booking/analytics presence) was
 * captured on every crawl (`detect_tech_stack`) and never used for
 * scoring. 100 = no automation tooling detected at all (max opportunity
 * for an AI Automation-style engagement — no chatbot, no booking flow, per
 * the brief's Priority 5 examples); scales down as more is found.
 */
function techOpportunity(b: ScorableBusiness): number {
  const stack = (b.signals?.tech_stack ?? {}) as Record<string, unknown>;
  if (!b.website) return 50; // no site at all is already fully captured by websiteOpportunity; neutral here
  const hasChat = Boolean(stack.chat);
  const hasBooking = Boolean(stack.booking);
  const hasAnalytics = Array.isArray(stack.analytics) ? stack.analytics.length > 0 : Boolean(stack.analytics);

  const present = [hasChat, hasBooking, hasAnalytics].filter(Boolean).length;
  return clamp(100 - present * 30);
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
      results[slug] = { score: 0, breakdown: { website: 0, branding: 0, social: 0, growth: 0, newness: 0, tech: 0 } };
    }
    return results;
  }

  const breakdown = {
    website: websiteOpportunity(business),
    branding: brandingOpportunity(business),
    social: socialOpportunity(business),
    growth: growthOpportunity(business),
    newness: newnessOpportunity(business),
    tech: techOpportunity(business),
  };

  for (const slug of PROFESSION_SLUGS) {
    const w = PROFESSION_WEIGHTS[slug];
    const score = clamp(
      breakdown.website * w.website +
        breakdown.branding * w.branding +
        breakdown.social * w.social +
        breakdown.growth * w.growth +
        breakdown.newness * w.newness +
        breakdown.tech * w.tech,
    );
    results[slug] = { score: Math.round(score * 100) / 100, breakdown };
  }

  return results;
}
