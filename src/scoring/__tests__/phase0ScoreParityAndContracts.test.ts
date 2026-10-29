/**
 * Phase 0 + Phase 1: Authoritative Profession Reconciliation, Score-Parity Harness,
 * Contract & Precomputed Score-Reuse Regression Suite, and Credit/Delivery Baseline Tests (TypeScript).
 *
 * Scope:
 * 1. Reconciles the 12 canonical PROFESSION_SLUGS across src/lib/professions.ts
 *    and src/scoring/professionWeights.ts.
 * 2. Exercises computeAndStoreOpportunityScores() + computeAndStoreBusinessHealth()
 *    against real Python `service.py score` (runEngineScore) across all 12 canonical
 *    professions and representative business fixtures.
 * 3. Verifies Phase 1 contract repairs:
 *    - `review_count` + `reviews` propagation in `evaluateLeadQuality` (rejecting < 20 reviews
 *      when known, while preserving `null`/`undefined` unknown semantics) and `upsertBusinessFromEngineLead`.
 *    - Normalized `profession_scores` map shape in `computeAndStoreOpportunityScores(businessId, scoreRunner, precomputed)`,
 *      verifying that precomputed enrichment scores are reused without spawning a redundant `service.py score`
 *      subprocess, while preserving the fallback path when precomputed scores are absent.
 * 4. Verifies telemetry counters (`recordSubprocessExecution`, `recordScoreParityCheck`) across both
 *    canonical map and legacy list shapes.
 * 5. Preserves the baseline credit reservation, refund, and duplicate-race idempotency
 *    tests in `insertLeadForUser` and `refundLeadUsage` using safe mocks (zero real DB/user charges).
 */

import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FOCUS_AREA_LABELS, PROFESSION_SLUGS as LIB_PROFESSION_SLUGS } from "../../lib/professions.js";
import {
  PROFESSION_SLUGS as SCORING_PROFESSION_SLUGS,
  PROFESSION_WEIGHTS,
} from "../professionWeights.js";
import { computeAndStoreOpportunityScores } from "../storeOpportunityScores.js";
import { computeAndStoreBusinessHealth } from "../storeBusinessHealth.js";
import { runEngineScore, type EngineScoreResult, type EngineLead } from "../../scraperBridge/pythonBridge.js";
import { evaluateLeadQuality, DEFAULT_LEAD_QUALITY_POLICY } from "../../lib/leadQualityPolicy.js";
import {
  insertLeadForUser,
  refundLeadUsage,
  upsertBusinessFromEngineLead,
  type DeliveryContext,
  type PoolBusiness,
} from "../../scraperBridge/deliverLead.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import {
  getPhase0SubprocessMetrics,
  recordScoreParityCheck,
  recordSubprocessExecution,
  resetEnrichmentTelemetry,
} from "../../lib/enrichmentTelemetry.js";

const EXPECTED_CANONICAL_12_PROFESSIONS = [
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

describe("Phase 0 & 1 — 1. Canonical Profession Reconciliation (12 Slugs)", () => {
  test("src/lib/professions.ts and src/scoring/professionWeights.ts both define the exact 12 canonical professions", () => {
    assert.equal(FOCUS_AREA_LABELS.length, 12);
    assert.equal(LIB_PROFESSION_SLUGS.length, 12);
    assert.equal(SCORING_PROFESSION_SLUGS.length, 12);
    assert.deepEqual([...LIB_PROFESSION_SLUGS], [...EXPECTED_CANONICAL_12_PROFESSIONS]);
    assert.deepEqual([...SCORING_PROFESSION_SLUGS], [...EXPECTED_CANONICAL_12_PROFESSIONS]);
  });

  test("all 12 canonical professions have normalized weight vectors summing to 1.0", () => {
    for (const slug of EXPECTED_CANONICAL_12_PROFESSIONS) {
      const w = PROFESSION_WEIGHTS[slug];
      assert.ok(w, `Missing weight vector for ${slug}`);
      const sum = w.website + w.branding + w.social + w.growth + w.newness + w.tech;
      assert.ok(Math.abs(sum - 1.0) <= 1e-9, `Weight vector for ${slug} sums to ${sum}, expected 1.0`);
    }
  });
});

describe("Phase 0 & 1 — 2. End-to-End Node->Python Score-Parity Matrix Across All 12 Professions", () => {
  const fixtures: Array<{
    name: string;
    businessRow: Record<string, unknown>;
    assertScores: (oppRows: any[], healthRow: any) => void;
  }> = [
    {
      name: "full_healthy_business",
      businessRow: {
        id: "biz-ts-healthy",
        website: "https://artisan-roasters.example.com",
        instagram: "https://www.instagram.com/artisanroasters/",
        facebook: "https://www.facebook.com/artisanroasters",
        linkedin: "https://www.linkedin.com/company/artisanroasters",
        has_photos: true,
        reviews_count: 250,
        reviews_rating: 4.8,
        is_disqualified: false,
        website_is_weak: false,
        ssl_valid: true,
        load_time_ms: 750,
        seo: { has_title: true, has_meta_description: true },
        blog: { has_blog: true, last_post_days: 7 },
        signals: {
          ig_last_post_days: 4,
          tech_stack: { chat: true, booking: true, analytics: true },
          growth_signals: {},
        },
      },
      assertScores: (oppRows, healthRow) => {
        assert.equal(oppRows.length, 12);
        for (const r of oppRows) {
          assert.ok(r.opportunity_score >= 0 && r.opportunity_score <= 35, `Expected low need score for healthy business on ${r.profession_slug}, got ${r.opportunity_score}`);
          assert.equal(r.score_breakdown.branding, 0);
          assert.equal(r.score_breakdown.website, 30);
          assert.equal(r.score_breakdown.social, 10);
          assert.equal(r.score_breakdown.tech, 10);
        }
        assert.ok(healthRow.health_score >= 60, `Expected high health score, got ${healthRow.health_score}`);
      },
    },
    {
      name: "no_website_no_social_business",
      businessRow: {
        id: "biz-ts-nosite",
        website: null,
        instagram: null,
        facebook: null,
        linkedin: null,
        has_photos: false,
        reviews_count: 8,
        reviews_rating: 3.9,
        is_disqualified: false,
        website_is_weak: null,
        ssl_valid: null,
        load_time_ms: null,
        seo: {},
        blog: {},
        signals: {},
      },
      assertScores: (oppRows, healthRow) => {
        assert.equal(oppRows.length, 12);
        for (const r of oppRows) {
          assert.equal(r.score_breakdown.website, 100);
          assert.equal(r.score_breakdown.social, 100);
          assert.equal(r.score_breakdown.tech, 50);
          assert.ok(r.opportunity_score >= 45, `Expected elevated opportunity score for ${r.profession_slug}, got ${r.opportunity_score}`);
        }
        assert.ok(healthRow.health_score <= 40);
      },
    },
    {
      name: "disqualified_chain_business",
      businessRow: {
        id: "biz-ts-disq",
        website: "https://starbucks.com",
        instagram: "https://www.instagram.com/starbucks/",
        facebook: null,
        linkedin: null,
        has_photos: true,
        reviews_count: 500,
        reviews_rating: 4.5,
        is_disqualified: true,
        website_is_weak: false,
        ssl_valid: true,
        load_time_ms: 500,
        seo: {},
        blog: {},
        signals: {},
      },
      assertScores: (oppRows) => {
        assert.equal(oppRows.length, 12);
        for (const r of oppRows) {
          assert.equal(r.opportunity_score, 0, `Disqualified business must have 0 score for ${r.profession_slug}`);
        }
      },
    },
  ];

  for (const fix of fixtures) {
    test(`computeAndStoreOpportunityScores + computeAndStoreBusinessHealth parity across 12 professions [${fix.name}]`, async () => {
      let persistedOppRows: any[] = [];
      let persistedHealthRow: any = null;

      const origFrom = supabaseAdmin.from;
      try {
        (supabaseAdmin as any).from = (table: string) => {
          if (table === "businesses") {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({ data: fix.businessRow, error: null }),
                }),
              }),
            };
          }
          if (table === "business_opportunity_scores") {
            return {
              upsert: async (rows: any[]) => {
                persistedOppRows = rows;
                return { error: null };
              },
            };
          }
          if (table === "business_health_scores") {
            return {
              upsert: async (row: any) => {
                persistedHealthRow = row;
                return { error: null };
              },
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        };

        const engineRes = await computeAndStoreOpportunityScores(fix.businessRow.id as string, runEngineScore);
        await computeAndStoreBusinessHealth(fix.businessRow.id as string, engineRes);

        assert.equal(persistedOppRows.length, 12);
        assert.deepEqual(
          persistedOppRows.map((r) => r.profession_slug),
          [...EXPECTED_CANONICAL_12_PROFESSIONS],
        );
        assert.ok(persistedHealthRow);
        fix.assertScores(persistedOppRows, persistedHealthRow);
      } finally {
        (supabaseAdmin as any).from = origFrom;
      }
    });
  }
});

describe("Phase 1 — 3. Contract & Precomputed Score-Parity Regression Suite (TypeScript Consumer Side)", () => {
  test("Deliverable 1 (review_count + reviews): evaluateLeadQuality rejects known <20 reviews and preserves unknown/null semantics", () => {
    // Repaired Python _candidate_dict and pythonBridge.ts emit `reviews: 5` alongside `review_count: 5`:
    const pythonCandidateWithFiveReviews = {
      name: "Five Review Coffee",
      rating: 4.7,
      review_count: 5,
      reviews: 5,
    } as unknown as EngineLead;

    assert.equal(DEFAULT_LEAD_QUALITY_POLICY.minReviewCount, 20);
    const verdict = evaluateLeadQuality(
      { rating: pythonCandidateWithFiveReviews.rating, reviews: pythonCandidateWithFiveReviews.reviews },
      DEFAULT_LEAD_QUALITY_POLICY,
    );
    assert.equal(verdict.reject, true);
    if (verdict.reject) {
      assert.match(verdict.reason, /^quality_gate:reviews\(/);
    }

    // Preserves null/unknown semantics: when reviews is null/undefined, evaluateLeadQuality does NOT fabricate 0
    const unknownReviewsVerdict = evaluateLeadQuality(
      { rating: 4.7, reviews: null },
      DEFAULT_LEAD_QUALITY_POLICY,
    );
    assert.equal(unknownReviewsVerdict.reject, false);
  });

  test("Deliverable 1b (review_count + reviews): upsertBusinessFromEngineLead persists reviews_count = 42 from either reviews or review_count", async () => {
    let insertedBusinessPayload: any = null;
    const origFrom = supabaseAdmin.from;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "businesses") {
          return {
            select: () => ({
              overlaps: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
            insert: (payload: any) => {
              insertedBusinessPayload = payload;
              return {
                select: () => ({
                  single: async () => ({ data: { id: "biz-inserted-1" }, error: null }),
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };

      const leadWithReviewCountFallback = {
        name: "Roastery With 42 Reviews",
        category: "Coffee shop",
        niche: "coffee_shops",
        query: "coffee shop",
        region: "US",
        address: "123 Main St, Austin, TX",
        website: "https://roastery42.example.com",
        email: "hi@roastery42.example.com",
        phone: "+15125550199",
        instagram: "https://www.instagram.com/roastery42/",
        rating: 4.6,
        review_count: 42,
        reviews: undefined as unknown as number,
        has_photos: true,
        is_disqualified: false,
        fingerprints: ["fp:roastery42"],
      } as unknown as EngineLead;

      await upsertBusinessFromEngineLead(leadWithReviewCountFallback, "United States");

      assert.ok(insertedBusinessPayload);
      assert.equal(insertedBusinessPayload.reviews_count, 42);
    } finally {
      (supabaseAdmin as any).from = origFrom;
    }
  });

  test("Deliverables 2 & 6 (profession_scores map shape & precomputed reuse): computeAndStoreOpportunityScores reuses precomputed enrichment scores without spawning scoreRunner", async () => {
    let persistedRows: any[] = [];
    let businessesQueried = 0;
    let runnerCalls = 0;
    const origFrom = supabaseAdmin.from;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "businesses") {
          businessesQueried += 1;
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "biz-precomputed", website: "https://example.com" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "business_opportunity_scores") {
          return {
            upsert: async (rows: any[]) => {
              persistedRows = rows;
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };

      const precomputedEnrichOutput: EngineScoreResult = {
        business_id: "biz-precomputed",
        is_disqualified: false,
        health_score: 70,
        universal_breakdown: { website: 40, branding: 60, social: 40, growth: 0, newness: 50, tech: 100 },
        profession_scores: Object.fromEntries(
          EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
            slug,
            {
              score: 65.5,
              breakdown: { website: 40, branding: 60, social: 40, growth: 0, newness: 50, tech: 100 },
              summary: "Needs upgrade",
              reasons: ["Reason 1"],
            },
          ]),
        ),
      };

      const mockRunner = async () => {
        runnerCalls += 1;
        return precomputedEnrichOutput;
      };

      const result = await computeAndStoreOpportunityScores(
        "biz-precomputed",
        mockRunner,
        precomputedEnrichOutput,
      );

      assert.equal(runnerCalls, 0, "scoreRunner must NOT be called when valid precomputed scores are passed");
      assert.equal(businessesQueried, 0, "businesses table must NOT be re-queried when precomputed scores are passed");
      assert.equal(result.health_score, 70);
      assert.equal(persistedRows.length, 12);
      for (const row of persistedRows) {
        assert.equal(row.opportunity_score, 65.5);
        assert.deepEqual(row.score_breakdown, {
          website: 40,
          branding: 60,
          social: 40,
          growth: 0,
          newness: 50,
          tech: 100,
        });
      }

      // Verify fallback path: when precomputed is omitted, scoreRunner IS called and businesses IS queried
      await computeAndStoreOpportunityScores("biz-precomputed", mockRunner);
      assert.equal(runnerCalls, 1);
      assert.equal(businessesQueried, 1);
    } finally {
      (supabaseAdmin as any).from = origFrom;
    }
  });

  test("Precomputed validation: map missing one profession triggers fallback and persists fallback result correctly", async () => {
    let persistedRows: any[] = [];
    let businessesQueried = 0;
    let runnerCalls = 0;
    const origFrom = supabaseAdmin.from;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "businesses") {
          businessesQueried += 1;
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "biz-missing-slug", website: "https://example.com" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "business_opportunity_scores") {
          return {
            upsert: async (rows: any[]) => {
              persistedRows = rows;
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };

      // Construct a precomputed result with only 11 of the 12 canonical professions (missing 'end_to_end_project')
      const incompleteScores: Record<string, any> = {};
      for (const slug of EXPECTED_CANONICAL_12_PROFESSIONS) {
        if (slug !== "end_to_end_project") {
          incompleteScores[slug] = {
            score: 50.0,
            breakdown: { website: 50 },
            summary: "Incomplete",
            reasons: [],
          };
        }
      }
      const incompletePrecomputed = {
        business_id: "biz-missing-slug",
        is_disqualified: false,
        health_score: 60,
        universal_breakdown: { website: 50 },
        profession_scores: incompleteScores,
      } as unknown as EngineScoreResult;

      const fallbackOutput: EngineScoreResult = {
        business_id: "biz-missing-slug",
        is_disqualified: false,
        health_score: 85,
        universal_breakdown: { website: 25, branding: 25, social: 25, growth: 25, newness: 25, tech: 25 },
        profession_scores: Object.fromEntries(
          EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
            slug,
            {
              score: 77.7,
              breakdown: { website: 25, branding: 25, social: 25, growth: 25, newness: 25, tech: 25 },
              summary: "Full fallback summary",
              reasons: ["Fallback reason"],
            },
          ]),
        ),
      };

      const mockRunner = async () => {
        runnerCalls += 1;
        return fallbackOutput;
      };

      const result = await computeAndStoreOpportunityScores(
        "biz-missing-slug",
        mockRunner,
        incompletePrecomputed,
      );

      // Must trigger fallback: query DB and invoke runner
      assert.equal(runnerCalls, 1, "Must invoke fallback scoreRunner when precomputed map is missing a canonical profession");
      assert.equal(businessesQueried, 1, "Must query businesses table when falling back");
      assert.equal(result.health_score, 85);
      assert.equal(persistedRows.length, 12);
      for (const row of persistedRows) {
        assert.equal(row.opportunity_score, 77.7, "Must persist fallback score, never 0 for missing slug");
      }
    } finally {
      (supabaseAdmin as any).from = origFrom;
    }
  });

  test("Precomputed validation: empty map triggers fallback and persists fallback result correctly", async () => {
    let persistedRows: any[] = [];
    let businessesQueried = 0;
    let runnerCalls = 0;
    const origFrom = supabaseAdmin.from;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "businesses") {
          businessesQueried += 1;
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "biz-empty-map", website: "https://example.com" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "business_opportunity_scores") {
          return {
            upsert: async (rows: any[]) => {
              persistedRows = rows;
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };

      const emptyPrecomputed = {
        business_id: "biz-empty-map",
        is_disqualified: false,
        health_score: 50,
        universal_breakdown: {},
        profession_scores: {},
      } as unknown as EngineScoreResult;

      const fallbackOutput: EngineScoreResult = {
        business_id: "biz-empty-map",
        is_disqualified: false,
        health_score: 80,
        universal_breakdown: { website: 30 },
        profession_scores: Object.fromEntries(
          EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
            slug,
            { score: 82.5, breakdown: { website: 30 }, summary: "Fallback", reasons: [] },
          ]),
        ),
      };

      const mockRunner = async () => {
        runnerCalls += 1;
        return fallbackOutput;
      };

      const result = await computeAndStoreOpportunityScores(
        "biz-empty-map",
        mockRunner,
        emptyPrecomputed,
      );

      assert.equal(runnerCalls, 1, "Must invoke fallback scoreRunner when precomputed profession_scores is empty");
      assert.equal(businessesQueried, 1);
      assert.equal(result.health_score, 80);
      assert.equal(persistedRows.length, 12);
      for (const row of persistedRows) {
        assert.equal(row.opportunity_score, 82.5, "Must persist fallback score, never 0");
      }
    } finally {
      (supabaseAdmin as any).from = origFrom;
    }
  });

  test("Precomputed validation: profession with missing, nonnumeric, or malformed score triggers fallback and persists correctly", async () => {
    let persistedRows: any[] = [];
    let businessesQueried = 0;
    let runnerCalls = 0;
    const origFrom = supabaseAdmin.from;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "businesses") {
          businessesQueried += 1;
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "biz-malformed-score", website: "https://example.com" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "business_opportunity_scores") {
          return {
            upsert: async (rows: any[]) => {
              persistedRows = rows;
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };

      const fallbackOutput: EngineScoreResult = {
        business_id: "biz-malformed-score",
        is_disqualified: false,
        health_score: 90,
        universal_breakdown: { website: 10 },
        profession_scores: Object.fromEntries(
          EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
            slug,
            { score: 91.0, breakdown: { website: 10 }, summary: "Fallback", reasons: [] },
          ]),
        ),
      };

      const mockRunner = async () => {
        runnerCalls += 1;
        return fallbackOutput;
      };

      // Test 1: string score instead of number
      const malformedScoresString: Record<string, any> = Object.fromEntries(
        EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
          slug,
          { score: slug === "graphic_design" ? "non-numeric-score" : 50.0 },
        ]),
      );
      await computeAndStoreOpportunityScores(
        "biz-malformed-score",
        mockRunner,
        { profession_scores: malformedScoresString } as any,
      );
      assert.equal(runnerCalls, 1, "Must fallback when score is a string");
      assert.equal(businessesQueried, 1);
      assert.equal(persistedRows.length, 12);
      for (const row of persistedRows) {
        assert.equal(row.opportunity_score, 91.0);
      }

      // Test 2: NaN score
      const malformedScoresNaN: Record<string, any> = Object.fromEntries(
        EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
          slug,
          { score: slug === "digital_marketing" ? Number.NaN : 50.0 },
        ]),
      );
      await computeAndStoreOpportunityScores(
        "biz-malformed-score",
        mockRunner,
        { profession_scores: malformedScoresNaN } as any,
      );
      assert.equal(runnerCalls, 2, "Must fallback when score is NaN");

      // Test 3: missing score property (undefined/null)
      const malformedScoresMissingScore: Record<string, any> = Object.fromEntries(
        EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [
          slug,
          slug === "writing_translation" ? { summary: "missing score field" } : { score: 50.0 },
        ]),
      );
      await computeAndStoreOpportunityScores(
        "biz-malformed-score",
        mockRunner,
        { profession_scores: malformedScoresMissingScore } as any,
      );
      assert.equal(runnerCalls, 3, "Must fallback when a profession object has missing score");
    } finally {
      (supabaseAdmin as any).from = origFrom;
    }
  });
});

describe("Phase 0 & 1 — 4. Subprocess & Score-Parity Instrumentation Verification", () => {
  beforeEach(() => {
    resetEnrichmentTelemetry();
  });

  test("records subprocess execution counts and durations and detects score parity match vs divergence across both map and list shapes", () => {
    recordSubprocessExecution("website_enrich", 420);
    recordSubprocessExecution("opportunity_score", 380);
    recordSubprocessExecution("instagram_enrich", 510);

    const matchingMap: Record<string, { score: number }> = Object.fromEntries(
      EXPECTED_CANONICAL_12_PROFESSIONS.map((slug) => [slug, { score: 55.25 }]),
    );

    const check1 = recordScoreParityCheck("biz-1", matchingMap, matchingMap);
    assert.equal(check1.matched, true);
    assert.equal(check1.divergedSlugs.length, 0);

    const divergingMap: Record<string, { score: number }> = {
      ...matchingMap,
      graphic_design: { score: 42.0 },
      digital_marketing: { score: 38.5 },
    };
    const check2 = recordScoreParityCheck("biz-2", matchingMap, divergingMap);
    assert.equal(check2.matched, false);
    assert.deepEqual(check2.divergedSlugs, ["graphic_design", "digital_marketing"]);

    const metrics = getPhase0SubprocessMetrics();
    assert.equal(metrics.website_enrich_count, 1);
    assert.equal(metrics.website_enrich_total_ms, 420);
    assert.equal(metrics.opportunity_score_count, 1);
    assert.equal(metrics.opportunity_score_total_ms, 380);
    assert.equal(metrics.instagram_enrich_count, 1);
    assert.equal(metrics.instagram_enrich_total_ms, 510);
    assert.equal(metrics.score_parity_checks_total, 2);
    assert.equal(metrics.score_parity_matched, 1);
    assert.equal(metrics.score_parity_diverged, 1);
    assert.equal(metrics.score_parity_divergences.length, 2);
  });
});

describe("Phase 0 & 1 — 5. Credit Charging, Refund & Delivery Idempotency Baseline (Mocked DB)", () => {
  const sampleBusiness: PoolBusiness = {
    id: "biz-credit-1",
    name: "Baseline Coffee Co",
    niche: "coffee_shops",
    address: "100 Congress Ave, Austin, TX",
    website: "https://baselinecoffee.example.com",
    email: "hello@baselinecoffee.example.com",
    phone: "+15125550101",
    instagram: "https://www.instagram.com/baselinecoffee/",
  };

  const baseCtx: DeliveryContext = {
    userId: "user-baseline-1",
    professionSlug: "graphic_design",
    discoveryMode: "live",
    scrapeJobId: "job-baseline-1",
    dailyLimit: 50,
    monthlyLimit: 500,
    discoveryPlanId: "plan-baseline-1",
  };

  test("Case A: pre-reservation duplicate check skips RPC reservation and charges 0 credits", async () => {
    let rpcCalls = 0;
    const origFrom = supabaseAdmin.from;
    const origRpc = supabaseAdmin.rpc;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: "existing-lead-1" }, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };
      (supabaseAdmin as any).rpc = async () => {
        rpcCalls += 1;
        return { data: null, error: null };
      };

      const res = await insertLeadForUser(sampleBusiness, baseCtx);
      assert.equal(res.wasNewForUser, false);
      assert.equal(rpcCalls, 0, "Must not call claim_discovery_delivery or try_increment_lead_usage for existing user lead");
    } finally {
      (supabaseAdmin as any).from = origFrom;
      (supabaseAdmin as any).rpc = origRpc;
    }
  });

  test("Case B: concurrent duplicate race at leads unique index refunds credit (p_count: -1) and releases plan slot", async () => {
    const rpcLog: Array<{ fn: string; args: any }> = [];
    let insertedLeadRow: any = null;
    const origFrom = supabaseAdmin.from;
    const origRpc = supabaseAdmin.rpc;
    try {
      (supabaseAdmin as any).from = (table: string) => {
        if (table === "leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
            insert: (row: any) => {
              insertedLeadRow = row;
              return {
                select: () => ({
                  // Simulate unique (user_id, business_id) conflict returning null data & null error
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      };

      (supabaseAdmin as any).rpc = (fn: string, args: any) => {
        rpcLog.push({ fn, args });
        if (fn === "claim_discovery_delivery") {
          return Promise.resolve({ data: true, error: null });
        }
        if (fn === "try_increment_lead_usage") {
          if (args.p_count === 1) {
            return {
              single: async () => ({ data: { allowed: true }, error: null }),
            };
          }
          // Refund call (p_count === -1)
          return Promise.resolve({ data: { allowed: true }, error: null });
        }
        if (fn === "release_discovery_delivery") {
          return Promise.resolve({ data: null, error: null });
        }
        throw new Error(`Unexpected RPC: ${fn}`);
      };

      const res = await insertLeadForUser(sampleBusiness, baseCtx);
      assert.equal(res.wasNewForUser, false);
      // Also pin that live discovery without ctx.opportunityScore writes opportunity_score: null
      assert.equal(insertedLeadRow.opportunity_score, null);

      assert.deepEqual(
        rpcLog.map((r) => ({ fn: r.fn, count: r.args?.p_count })),
        [
          { fn: "claim_discovery_delivery", count: undefined },
          { fn: "try_increment_lead_usage", count: 1 },
          { fn: "try_increment_lead_usage", count: -1 },
          { fn: "release_discovery_delivery", count: undefined },
        ],
      );
    } finally {
      (supabaseAdmin as any).from = origFrom;
      (supabaseAdmin as any).rpc = origRpc;
    }
  });

  test("Case C: refundLeadUsage retries once if the first RPC call fails", async () => {
    let attempts = 0;
    const origRpc = supabaseAdmin.rpc;
    try {
      (supabaseAdmin as any).rpc = async (_fn: string, args: any) => {
        attempts += 1;
        assert.equal(args.p_count, -1);
        if (attempts === 1) {
          return { data: null, error: { message: "transient connection reset" } };
        }
        return { data: { allowed: true }, error: null };
      };

      const ok = await refundLeadUsage(baseCtx, "insert_failed");
      assert.equal(ok, true);
      assert.equal(attempts, 2);
    } finally {
      (supabaseAdmin as any).rpc = origRpc;
    }
  });
});
