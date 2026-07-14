/**
 * Priority 7 — Business Health Score.
 *
 * Deliberately SEPARATE from the Opportunity Score (per the brief: "Do NOT
 * merge it with Opportunity Score"). Opportunity Score answers "how good a
 * sales target is this business for profession X?" — Business Health
 * answers a different question entirely: "how healthy is this business
 * digitally, full stop, regardless of who's asking?" A business can be
 * digitally very healthy (great health score) and still be a poor
 * Opportunity match for a given profession (e.g. a thriving business with a
 * flawless website is bad news for a web developer's Opportunity Score, but
 * that's an orthogonal fact from whether the business itself is healthy).
 *
 * Architecture is kept flexible per the brief: this returns a breakdown by
 * component so the Opportunity Score (or anything else) can later choose to
 * blend in Business Health as one more signal, without this module ever
 * needing to know about professions or opportunity weighting.
 */

export type HealthScorableBusiness = {
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin?: string | null;
  has_photos: boolean | null;
  reviews_count: number | null;
  reviews_rating: number | null;
  confidence?: number | null;
  website_is_weak?: boolean | null;
  ssl_valid?: boolean | null;
  load_time_ms?: number | null;
  seo?: { has_title?: boolean; has_meta_description?: boolean } | null;
  blog?: { has_blog?: boolean; last_post_days?: number } | null;
  signals: {
    tech_stack?: Record<string, unknown> | null;
    ig_activity?: string | null;
    ig_last_post_days?: number | null;
  } | null;
};

export type BusinessHealthBreakdown = {
  website: number; // 0-100, quality of the website itself (not opportunity — health)
  brand: number; // visual/photo presence
  seo: number; // on-page SEO hygiene
  social: number; // breadth + activity of social channels
  reviews: number; // review volume + rating
  trust: number; // verification confidence (businesses.confidence)
  tech: number; // modern tech stack presence (analytics, chat, booking)
  freshness: number; // recent activity (social posts, blog)
};

export type BusinessHealthResult = {
  score: number;
  breakdown: BusinessHealthBreakdown;
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

function websiteHealth(b: HealthScorableBusiness): number {
  const site = (b.website ?? "").trim();
  if (!site) return 0;
  if (b.website_is_weak) return 35;
  let score = 65;
  if (b.ssl_valid === true) score += 15;
  else if (b.ssl_valid === false) score -= 25;
  if (typeof b.load_time_ms === "number") {
    if (b.load_time_ms > 5000) score -= 15;
    else if (b.load_time_ms < 1500) score += 10;
  }
  return clamp(score);
}

function brandHealth(b: HealthScorableBusiness): number {
  let score = 0;
  if (b.has_photos) score += 50;
  if ((b.reviews_rating ?? 0) >= 4.3) score += 30;
  if ((b.instagram ?? "").trim() || (b.facebook ?? "").trim() || (b.linkedin ?? "").trim()) score += 20;
  return clamp(score);
}

function seoHealth(b: HealthScorableBusiness): number {
  const seo = b.seo;
  if (!seo) return 50; // unknown — neutral, never a fabricated pass/fail
  let score = 100;
  if (!seo.has_title) score -= 40;
  if (!seo.has_meta_description) score -= 40;
  return clamp(score);
}

function socialHealth(b: HealthScorableBusiness): number {
  const channels = [b.instagram, b.facebook, b.linkedin].filter((c) => (c ?? "").trim()).length;
  let score = channels * 25;
  const days = b.signals?.ig_last_post_days;
  if (days != null) {
    if (days <= 30) score += 25;
    else if (days > 90) score -= 15;
  }
  return clamp(score);
}

function reviewsHealth(b: HealthScorableBusiness): number {
  const count = Math.min(500, Math.max(0, b.reviews_count ?? 0));
  const rating = b.reviews_rating ?? 0;
  const countScore = count === 0 ? 0 : Math.min(60, (Math.log10(count + 1) / Math.log10(501)) * 60);
  const ratingScore = rating > 0 ? Math.min(40, (rating / 5) * 40) : 0;
  return clamp(countScore + ratingScore);
}

function trustHealth(b: HealthScorableBusiness): number {
  return clamp(b.confidence ?? 65);
}

function techHealth(b: HealthScorableBusiness): number {
  const stack = (b.signals?.tech_stack ?? {}) as Record<string, unknown>;
  let score = 20; // baseline for having a site at all is handled by websiteHealth; this rewards modern tooling
  if (stack.analytics && Array.isArray(stack.analytics) && stack.analytics.length > 0) score += 25;
  if (stack.chat) score += 25;
  if (stack.booking) score += 30;
  return clamp(score);
}

function freshnessHealth(b: HealthScorableBusiness): number {
  let score = 50;
  const days = b.signals?.ig_last_post_days;
  if (days != null) {
    if (days <= 14) score += 30;
    else if (days > 90) score -= 30;
  }
  if (b.blog?.has_blog) {
    score += 10;
    if (typeof b.blog.last_post_days === "number" && b.blog.last_post_days > 365) score -= 15;
  }
  return clamp(score);
}

/** Weights are equal by default — this is a general-purpose health read, not profession-tuned (that's what Opportunity Score is for). */
const HEALTH_WEIGHTS: BusinessHealthBreakdown = {
  website: 0.2,
  brand: 0.15,
  seo: 0.1,
  social: 0.15,
  reviews: 0.15,
  trust: 0.1,
  tech: 0.05,
  freshness: 0.1,
};

export function computeBusinessHealth(business: HealthScorableBusiness): BusinessHealthResult {
  const breakdown: BusinessHealthBreakdown = {
    website: websiteHealth(business),
    brand: brandHealth(business),
    seo: seoHealth(business),
    social: socialHealth(business),
    reviews: reviewsHealth(business),
    trust: trustHealth(business),
    tech: techHealth(business),
    freshness: freshnessHealth(business),
  };

  const score = clamp(
    Object.entries(breakdown).reduce(
      (sum, [key, value]) => sum + value * HEALTH_WEIGHTS[key as keyof BusinessHealthBreakdown],
      0,
    ),
  );

  return { score: Math.round(score * 100) / 100, breakdown };
}
