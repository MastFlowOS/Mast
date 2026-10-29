import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  evaluateServiceNeedGate,
  inspectWebsite,
  inspectWebsiteReachable,
  inspectSslValid,
  inspectWebsiteIsWeak,
  inspectHasPhotos,
  inspectSeoMetaDescription,
  inspectAnalytics,
  inspectBooking,
  inspectChat,
  inspectGrowth,
  inspectSocialPresence,
  detectSelfServiceAgencyConflict,
  detectStructuralIncompatibility,
  candidateSignalsFromEngineLead,
  type CandidateInspectionSignals,
  type ServiceNeedGateResult,
} from "../serviceNeedGate.js";
import { PROFESSION_SLUGS, type ProfessionSlug } from "../../lib/professions.js";
import type { EngineScoreResult, EngineLead } from "../../scraperBridge/pythonBridge.js";

describe("Phase 2 Service-Need Qualification Gate (serviceNeedGate)", () => {
  // Helper to build full 12-profession mock score result
  function buildMockScores(baseScore = 75): EngineScoreResult {
    const profScores: Record<
      string,
      { score: number; breakdown: Record<string, number>; summary: string; reasons: string[] }
    > = {};

    PROFESSION_SLUGS.forEach((slug, idx) => {
      profScores[slug] = {
        score: baseScore + idx,
        breakdown: { website: 60, branding: 70, social: 80, growth: 50, newness: 65, tech: 40 },
        summary: `Score for ${slug}`,
        reasons: ["Primary contribution > 5.0"],
      };
    });

    return {
      business_id: "biz_test_123",
      is_disqualified: false,
      health_score: baseScore,
      universal_breakdown: { website: 60, branding: 70, social: 80, growth: 50, newness: 65, tech: 40 },
      profession_scores: profScores,
    };
  }

  // -------------------------------------------------------------------------
  // 1. Unset Profession & Boundary Handling
  // -------------------------------------------------------------------------
  describe("1. Unset Profession & Slug Validation", () => {
    it("returns NOT_APPLICABLE when professionSlug is null", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Acme Coffee",
        website: "https://acme.com",
        reviews_count: 50,
      };
      const result = evaluateServiceNeedGate({
        candidate,
        professionSlug: null,
      });

      assert.equal(result.outcome, "NOT_APPLICABLE");
      assert.equal(result.professionSlug, null);
      assert.equal(result.reason, "profession_unset_bypassed");
      assert.equal(result.scoreSnapshot, null);
    });

    it("returns NOT_APPLICABLE when professionSlug is undefined or empty string", () => {
      const candidate: CandidateInspectionSignals = { name: "Acme Coffee" };
      assert.equal(
        evaluateServiceNeedGate({ candidate, professionSlug: undefined }).outcome,
        "NOT_APPLICABLE",
      );
      assert.equal(
        evaluateServiceNeedGate({ candidate, professionSlug: "" }).outcome,
        "NOT_APPLICABLE",
      );
    });

    it("returns NOT_APPLICABLE with descriptive reason when slug is non-canonical", () => {
      const candidate: CandidateInspectionSignals = { name: "Acme Coffee" };
      const result = evaluateServiceNeedGate({
        candidate,
        professionSlug: "non_existent_specialty",
      });
      assert.equal(result.outcome, "NOT_APPLICABLE");
      assert.ok(result.reason.includes("invalid_profession_slug"));
    });
  });

  // -------------------------------------------------------------------------
  // 2. Score Snapshot Lookup Across All 12 Canonical Professions
  // -------------------------------------------------------------------------
  describe("2. Score Snapshot Lookup for All 12 Canonical Professions", () => {
    const scores = buildMockScores(60);

    for (let i = 0; i < PROFESSION_SLUGS.length; i++) {
      const slug = PROFESSION_SLUGS[i];
      it(`faithfully extracts scoreSnapshot for canonical slug '${slug}'`, () => {
        const candidate: CandidateInspectionSignals = {
          name: "Test Business",
          category: "Retail Store",
          website: "https://example.com",
          reviews_count: 20,
        };

        const result = evaluateServiceNeedGate({
          candidate,
          scores,
          professionSlug: slug,
        });

        assert.equal(result.professionSlug, slug);
        assert.equal(result.scoreSnapshot, 60 + i);
      });
    }

    it("leaves scoreSnapshot as null when scores object is missing or lacks the slug", () => {
      const candidate: CandidateInspectionSignals = { name: "Test Business" };
      const resultA = evaluateServiceNeedGate({
        candidate,
        scores: null,
        professionSlug: "programming_tech",
      });
      assert.equal(resultA.scoreSnapshot, null);

      const emptyScores: EngineScoreResult = {
        business_id: "b1",
        is_disqualified: false,
        health_score: 50,
        universal_breakdown: {},
        profession_scores: {},
      };
      const resultB = evaluateServiceNeedGate({
        candidate,
        scores: emptyScores,
        professionSlug: "programming_tech",
      });
      assert.equal(resultB.scoreSnapshot, null);
    });

    describe("Malformed & Non-Finite Score Snapshots", () => {
      it("rejects NaN, Infinity, -Infinity, and string-encoded scores without fabricating a zero", () => {
        const candidate: CandidateInspectionSignals = { name: "Test Business" };

        const testCases = [
          { val: NaN, desc: "NaN" },
          { val: Infinity, desc: "Infinity" },
          { val: -Infinity, desc: "-Infinity" },
          { val: "90" as unknown as number, desc: 'string "90"' },
          { val: null as unknown as number, desc: "null" },
          { val: undefined as unknown as number, desc: "undefined" },
        ];

        for (const tc of testCases) {
          const malformedScores: EngineScoreResult = {
            business_id: "b_malformed",
            is_disqualified: false,
            health_score: 50,
            universal_breakdown: {},
            profession_scores: {
              programming_tech: {
                score: tc.val,
                breakdown: {},
                summary: "Bad score",
                reasons: [],
              },
            },
          };

          const res = evaluateServiceNeedGate({
            candidate,
            scores: malformedScores,
            professionSlug: "programming_tech",
          });

          assert.equal(
            res.scoreSnapshot,
            null,
            `Expected scoreSnapshot to be null for malformed score ${tc.desc}, got ${res.scoreSnapshot}`,
          );
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Three-State Signal Extraction Semantics
  // -------------------------------------------------------------------------
  describe("3. Three-State Signal Extractors (Present vs. Absent vs. Unknown)", () => {
    it("distinguishes confirmed absent website from unknown website", () => {
      assert.deepEqual(inspectWebsite({ website: "https://example.com" }), {
        state: "present",
        value: "https://example.com",
      });
      assert.deepEqual(inspectWebsite({ website: null }), { state: "absent" });
      assert.deepEqual(inspectWebsite({ website: "" }), { state: "absent" });
      assert.deepEqual(inspectWebsite({ website: undefined }), { state: "unknown" });
    });

    it("distinguishes confirmed crawl reachability from unknown crawl state", () => {
      assert.deepEqual(inspectWebsiteReachable({ website_reachable: true }), {
        state: "present",
        value: true,
      });
      assert.deepEqual(inspectWebsiteReachable({ website_reachable: false }), { state: "absent" });
      assert.deepEqual(inspectWebsiteReachable({ website_reachable: null }), { state: "unknown" });
      assert.deepEqual(inspectWebsiteReachable({}), { state: "unknown" });
    });

    it("distinguishes confirmed SSL validity from unknown SSL", () => {
      assert.deepEqual(inspectSslValid({ ssl_valid: true }), { state: "present", value: true });
      assert.deepEqual(inspectSslValid({ ssl_valid: false }), { state: "absent" });
      assert.deepEqual(inspectSslValid({ ssl_valid: null }), { state: "unknown" });
      assert.deepEqual(inspectSslValid({}), { state: "unknown" });
    });

    it("distinguishes existing weak-domain website from missing website and unknown weak site", () => {
      assert.deepEqual(
        inspectWebsiteIsWeak({ website: "https://mybiz.wixsite.com", website_is_weak: true }),
        {
          state: "present",
          value: true,
        },
      );
      assert.deepEqual(
        inspectWebsiteIsWeak({ website: "https://mybiz.com", website_is_weak: false }),
        { state: "absent" },
      );
      assert.deepEqual(
        inspectWebsiteIsWeak({ website: "https://mybiz.com", website_is_weak: null }),
        { state: "unknown" },
      );
      // A missing website must never be counted as a weak-domain website even if upstream defaults website_is_weak to true
      assert.deepEqual(
        inspectWebsiteIsWeak({ website: null, website_is_weak: true }),
        { state: "unknown" },
      );
      assert.deepEqual(
        inspectWebsiteIsWeak({ website: "", website_is_weak: true }),
        { state: "unknown" },
      );
      assert.deepEqual(inspectWebsiteIsWeak({ website_is_weak: true }), { state: "unknown" });
      assert.deepEqual(inspectWebsiteIsWeak({ website_is_weak: null }), { state: "unknown" });
    });

    it("treats has_photos === true as present and false/null/missing as unknown", () => {
      assert.deepEqual(inspectHasPhotos({ has_photos: true }), { state: "present", value: true });
      assert.deepEqual(inspectHasPhotos({ has_photos: false }), { state: "unknown" });
      assert.deepEqual(inspectHasPhotos({ has_photos: null }), { state: "unknown" });
      assert.deepEqual(inspectHasPhotos({}), { state: "unknown" });
    });

    it("distinguishes confirmed missing SEO description from unparsed SEO", () => {
      assert.deepEqual(
        inspectSeoMetaDescription({ seo: { has_meta_description: true, meta_description: "Hello" } }),
        { state: "present", value: "Hello" },
      );
      assert.deepEqual(
        inspectSeoMetaDescription({ seo: { has_meta_description: false } }),
        { state: "absent" },
      );
      assert.deepEqual(inspectSeoMetaDescription({ seo: null }), { state: "unknown" });
      assert.deepEqual(inspectSeoMetaDescription({}), { state: "unknown" });
    });

    describe("Real Crawler Payload & Tech Stack Inspection", () => {
      it("treats tech_stack.booking: null, chat: null, analytics: [] as UNKNOWN even when website_reachable === true", () => {
        // Successful static crawl completed (website_reachable === true)
        // Static regex non-detection on a single homepage can NEVER confirm absence
        const inspectedSite: CandidateInspectionSignals = {
          website: "https://mybiz.com",
          website_reachable: true,
          tech_stack: {
            cms: "wordpress",
            booking: null, // Static crawler found no booking signatures
            chat: null,    // Static crawler found no chat signatures
            analytics: [], // Static crawler found no analytics signatures
          },
        };

        assert.deepEqual(inspectBooking(inspectedSite), { state: "unknown" });
        assert.deepEqual(inspectChat(inspectedSite), { state: "unknown" });
        assert.deepEqual(inspectAnalytics(inspectedSite), { state: "unknown" });

        // Also verifies false, null, and empty inputs evaluate strictly to unknown
        assert.deepEqual(inspectBooking({ tech_stack: { booking: false } }), { state: "unknown" });
        assert.deepEqual(inspectChat({ tech_stack: { chat: false } }), { state: "unknown" });
        assert.deepEqual(inspectAnalytics({ tech_stack: { analytics: null } }), { state: "unknown" });
        assert.deepEqual(inspectAnalytics({ tech_stack: { analytics: false } }), { state: "unknown" });
      });

      it("treats uninspected sites or failed crawls as UNKNOWN for tech_stack signals", () => {
        const failedCrawlSite: CandidateInspectionSignals = {
          website: "https://mybiz.com",
          website_reachable: false,
          tech_stack: {
            booking: null,
            chat: null,
            analytics: [],
          },
        };

        assert.deepEqual(inspectBooking(failedCrawlSite), { state: "unknown" });
        assert.deepEqual(inspectChat(failedCrawlSite), { state: "unknown" });
        assert.deepEqual(inspectAnalytics(failedCrawlSite), { state: "unknown" });

        const uninspectedSite: CandidateInspectionSignals = {
          website: "https://mybiz.com",
        };
        assert.deepEqual(inspectBooking(uninspectedSite), { state: "unknown" });
        assert.deepEqual(inspectChat(uninspectedSite), { state: "unknown" });
        assert.deepEqual(inspectAnalytics(uninspectedSite), { state: "unknown" });
      });

      it("identifies positively detected booking, chat, and analytics integrations as PRESENT", () => {
        const candidate: CandidateInspectionSignals = {
          website: "https://salon.com",
          website_reachable: true,
          tech_stack: {
            booking: "calendly",
            chat: "intercom",
            analytics: ["ga4"],
          },
        };
        assert.deepEqual(inspectBooking(candidate), { state: "present", value: true });
        assert.deepEqual(inspectChat(candidate), { state: "present", value: true });
        assert.deepEqual(inspectAnalytics(candidate), { state: "present", value: true });

        // Also test boolean true and object forms for analytics
        assert.deepEqual(inspectBooking({ tech_stack: { booking: true } }), { state: "present", value: true });
        assert.deepEqual(inspectChat({ tech_stack: { chat: true } }), { state: "present", value: true });
        assert.deepEqual(inspectAnalytics({ tech_stack: { analytics: true } }), { state: "present", value: true });
        assert.deepEqual(
          inspectAnalytics({ tech_stack: { analytics: { has_analytics: true } } }),
          { state: "present", value: true },
        );
      });
    });

    it("identifies positively detected social URLs as present and missing/empty/null as unknown (never absent)", () => {
      assert.deepEqual(
        inspectSocialPresence({ instagram: "https://instagram.com/mybar" }),
        { state: "present", value: true },
      );
      assert.deepEqual(
        inspectSocialPresence({ facebook: "https://facebook.com/mybar" }),
        { state: "present", value: true },
      );
      assert.deepEqual(
        inspectSocialPresence({ linkedin: "https://linkedin.com/company/mybar" }),
        { state: "present", value: true },
      );
      // Empty strings, nulls, and omitted fields must evaluate to unknown, never absent
      assert.deepEqual(
        inspectSocialPresence({ instagram: null, facebook: null, linkedin: null }),
        { state: "unknown" },
      );
      assert.deepEqual(
        inspectSocialPresence({ instagram: "", facebook: "", linkedin: "" }),
        { state: "unknown" },
      );
      assert.deepEqual(inspectSocialPresence({}), { state: "unknown" });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Non-Fabrication Law: Unknown Signals Never Convert to Defects or Rejections
  // -------------------------------------------------------------------------
  describe("4. Non-Fabrication Law (Unknown Never Rejects)", () => {
    it("evaluates a candidate with incomplete/unreachable data as UNCERTAIN, never REJECTED", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Corner Bakery",
        category: "Bakery",
        website: "https://cornerbakery.com",
        website_reachable: false, // Crawl timed out
        ssl_valid: null, // Unknown
        has_photos: null, // Unknown
        tech_stack: null, // Unknown
        seo: null, // Unknown
        reviews_count: 45,
      };

      const result = evaluateServiceNeedGate({
        candidate,
        professionSlug: "programming_tech",
      });

      assert.equal(result.outcome, "UNCERTAIN");
      assert.ok(result.reason.startsWith("insufficient_signals:"));
      assert.ok(result.unknownSignals.includes("ssl_valid"));
      assert.ok(result.unknownSignals.includes("has_photos"));
    });

    it("never awards defect points or qualifies programming_tech based on an unreachable crawl alone", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Downtown Cafe",
        website: "https://downtowncafe.com",
        website_reachable: false, // timeout
      };

      const result = evaluateServiceNeedGate({
        candidate,
        professionSlug: "programming_tech",
      });

      assert.equal(result.outcome, "UNCERTAIN");
      assert.equal(result.matchedGaps.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Strong Existing Assets Invariance Across All 12 Canonical Professions
  // -------------------------------------------------------------------------
  describe("5. Strong Assets Policy (Never Reject on High Asset Quality Alone Across All 12 Professions)", () => {
    const flawlessBusiness: CandidateInspectionSignals = {
      name: "Starlight Coffee Roasters",
      category: "Coffee Shop",
      address: "123 Main St, Seattle, WA",
      website: "https://starlightcoffee.com",
      website_reachable: true,
      website_is_weak: false,
      ssl_valid: true,
      load_time_ms: 750,
      has_photos: true,
      reviews_count: 320,
      reviews_rating: 4.8,
      is_disqualified: false,
      is_chain: false,
      seo: {
        has_title: true,
        has_meta_description: true,
        title: "Starlight Coffee - Artisan Roasters",
        meta_description: "Award-winning coffee roaster in Seattle.",
      },
      blog: {
        has_blog: true,
        recent_posts: true,
      },
      tech_stack: {
        chat: "intercom",
        booking: "calendly",
        analytics: ["ga4", "hotjar"],
      },
      growth_signals: {
        hiring: false,
        new_location: false,
      },
      instagram: "https://instagram.com/starlightcoffee",
      facebook: "https://facebook.com/starlightcoffee",
      linkedin: null,
      ig_followers: 12000,
      ig_last_post_days: 2,
    };

    for (const slug of PROFESSION_SLUGS) {
      it(`evaluates a business with strong assets as UNCERTAIN (NEVER REJECTED) for '${slug}'`, () => {
        const result = evaluateServiceNeedGate({
          candidate: flawlessBusiness,
          professionSlug: slug,
        });
        assert.equal(result.outcome, "UNCERTAIN", `Expected UNCERTAIN for ${slug}, got ${result.outcome}`);
        assert.notEqual(result.outcome, "REJECTED", `Strong assets must never trigger REJECTED for ${slug}`);
        assert.equal(result.reason, "strong_existing_assets_unproven_service_need");
      });
    }
  });

  // -------------------------------------------------------------------------
  // 6. Explicit Incompatibility & Defensible Disqualification
  // -------------------------------------------------------------------------
  describe("6. Explicit Incompatibility & Disqualification (REJECTED Cases)", () => {
    it("rejects when is_disqualified is true", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Cannabis Dispensary",
        is_disqualified: true,
      };
      const result = evaluateServiceNeedGate({
        candidate,
        professionSlug: "programming_tech",
      });
      assert.equal(result.outcome, "REJECTED");
      assert.ok(result.reason.includes("disqualified_business"));
    });

    it("rejects when is_chain is true", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Starbucks Coffee #421",
        is_chain: true,
      };
      const result = evaluateServiceNeedGate({
        candidate,
        professionSlug: "programming_tech",
      });
      assert.equal(result.outcome, "REJECTED");
      assert.ok(result.reason.includes("disqualified_enterprise_chain"));
    });

    describe("Instagram Follower Count Boundary Tests", () => {
      it("does NOT reject when ig_followers is exactly 100,000", () => {
        const candidate: CandidateInspectionSignals = {
          name: "High Growth Retail Brand",
          category: "Retail Store",
          ig_followers: 100_000,
        };
        const result = evaluateServiceNeedGate({
          candidate,
          professionSlug: "digital_marketing",
        });
        // At exactly 100,000 it must NOT reject
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.outcome, "UNCERTAIN");
      });

      it("MUST reject when ig_followers is 100,001", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Enterprise Influencer Brand",
          category: "Retail Store",
          ig_followers: 100_001,
        };
        const result = evaluateServiceNeedGate({
          candidate,
          professionSlug: "digital_marketing",
        });
        assert.equal(result.outcome, "REJECTED");
        assert.ok(result.reason.includes("scale_mismatch_excessive_followers"));
      });
    });

    describe("Direct Competitor / Self-Service Conflict Rejections", () => {
      const conflictFixtures: Array<{ slug: ProfessionSlug; name: string; category: string; expectedReason: string }> = [
        {
          slug: "programming_tech",
          name: "Apex Software Development",
          category: "Software Company",
          expectedReason: "software_or_web_development_agency",
        },
        {
          slug: "graphic_design",
          name: "Pixel Forge Creative Studio",
          category: "Graphic Design Studio",
          expectedReason: "graphic_design_or_branding_agency",
        },
        {
          slug: "digital_marketing",
          name: "Omni Growth SEO Agency",
          category: "Marketing Agency",
          expectedReason: "digital_marketing_agency",
        },
        {
          slug: "writing_translation",
          name: "Babel Global Translation Services",
          category: "Translation Agency",
          expectedReason: "translation_or_writing_agency",
        },
        {
          slug: "video_animation",
          name: "Visionary Film Production Company",
          category: "Animation Studio",
          expectedReason: "video_production_or_animation_studio",
        },
        {
          slug: "music_audio",
          name: "SoundScape Recording Studio",
          category: "Audio Production Company",
          expectedReason: "recording_or_audio_studio",
        },
        {
          slug: "photography",
          name: "Lumina Commercial Photography Studio",
          category: "Photo Agency",
          expectedReason: "commercial_photography_studio",
        },
        {
          slug: "finance",
          name: "Harrison & Associates CPA Firm",
          category: "Accounting Firm",
          expectedReason: "cpa_or_accounting_firm",
        },
        {
          slug: "data",
          name: "DataMind Analytics Consulting",
          category: "Data Science Consultancy",
          expectedReason: "data_science_consultancy",
        },
        {
          slug: "business",
          name: "Beacon Management Consulting Firm",
          category: "Corporate Strategy Consulting",
          expectedReason: "management_consulting_firm",
        },
        {
          slug: "personal_growth_hobbies",
          name: "Metro State College",
          category: "Accredited University",
          expectedReason: "accredited_academic_institution",
        },
        {
          slug: "end_to_end_project",
          name: "Catalyst Full-Service Digital Agency",
          category: "Digital Transformation Consultancy",
          expectedReason: "full_service_digital_agency",
        },
      ];

      for (const fix of conflictFixtures) {
        it(`rejects self-service agency for slug '${fix.slug}'`, () => {
          const candidate: CandidateInspectionSignals = {
            name: fix.name,
            category: fix.category,
          };
          const result = evaluateServiceNeedGate({
            candidate,
            professionSlug: fix.slug,
          });
          assert.equal(result.outcome, "REJECTED");
          assert.ok(result.reason.includes(fix.expectedReason));
        });
      }
    });

    describe("Structural Domain Incompatibility Rejections", () => {
      it("rejects music_audio for industrial trade (e.g. plumbing / scrap metal)", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Express Septic & Plumbing",
          category: "Plumbing Service",
        };
        const result = evaluateServiceNeedGate({
          candidate,
          professionSlug: "music_audio",
        });
        assert.equal(result.outcome, "REJECTED");
        assert.ok(result.reason.includes("industrial_heavy_trade"));
      });

      it("rejects video_animation for heavy industrial scrap/warehousing", () => {
        const candidate: CandidateInspectionSignals = {
          name: "All-Metals Scrap Yard",
          category: "Scrap Metal Recycling",
        };
        const result = evaluateServiceNeedGate({
          candidate,
          professionSlug: "video_animation",
        });
        assert.equal(result.outcome, "REJECTED");
        assert.ok(result.reason.includes("heavy_industrial_wholesale"));
      });
    });
  });

  // -------------------------------------------------------------------------
  // 7. Verified Service-Need Qualification for Supported Professions
  // -------------------------------------------------------------------------
  describe("7. Verified Service-Need Qualification for Supported Professions", () => {
    it("1. programming_tech: qualifies when website is confirmed absent on active Maps listing", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Tony's Pizzeria",
        category: "Pizza Restaurant",
        website: null, // confirmed absent
        reviews_count: 85,
        reviews_rating: 4.5,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "programming_tech" });
      assert.equal(result.outcome, "QUALIFIED");
      assert.ok(result.matchedGaps.includes("confirmed_no_website"));
    });

    it("1b. programming_tech: qualifies when existing website has confirmed invalid SSL", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Vintage Auto Repair",
        website: "http://vintageautorepair.com",
        website_reachable: true,
        ssl_valid: false, // confirmed broken/unencrypted
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "programming_tech" });
      assert.equal(result.outcome, "QUALIFIED");
      assert.ok(result.matchedGaps.includes("confirmed_invalid_or_missing_ssl"));
    });

    it("1c. programming_tech: missing website is distinct from existing weak-domain website even when upstream sets website_is_weak: true", () => {
      const noWebsiteCandidate = candidateSignalsFromEngineLead({
        name: "Tony's Pizzeria",
        category: "Pizza Restaurant",
        website: "",
        website_is_weak: true, // Python is_weak_site("") defaults to true
        reviews: 45,
      } as unknown as EngineLead);

      const noSiteResult = evaluateServiceNeedGate({
        candidate: noWebsiteCandidate,
        professionSlug: "programming_tech",
      });
      assert.equal(noSiteResult.outcome, "QUALIFIED");
      assert.deepEqual(noSiteResult.matchedGaps, ["confirmed_no_website"]);
      assert.ok(!noSiteResult.matchedGaps.includes("confirmed_weak_or_free_website"));

      const weakDomainCandidate = candidateSignalsFromEngineLead({
        name: "Tony's Pizzeria",
        category: "Pizza Restaurant",
        website: "https://tonyspizzeria.wixsite.com",
        website_is_weak: true,
        reviews: 45,
      } as unknown as EngineLead);

      const weakSiteResult = evaluateServiceNeedGate({
        candidate: weakDomainCandidate,
        professionSlug: "programming_tech",
      });
      assert.equal(weakSiteResult.outcome, "QUALIFIED");
      assert.deepEqual(weakSiteResult.matchedGaps, ["confirmed_weak_or_free_website"]);
      assert.ok(!weakSiteResult.matchedGaps.includes("confirmed_no_website"));
    });

    it("2. graphic_design: qualifies when existing site is a free builder in a visual consumer category, and ignores unverified has_photos: false", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Urban Boutique",
        category: "Boutique Clothing Store",
        website: "https://urbanboutique.wixsite.com",
        website_is_weak: true, // confirmed linktree/wix free
        has_photos: false,     // unverified (defaults to false upstream -> unknown)
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "graphic_design" });
      assert.equal(result.outcome, "QUALIFIED");
      assert.deepEqual(result.matchedGaps, ["confirmed_unbranded_free_website"]);
      assert.ok(result.unknownSignals.includes("has_photos"));
    });

    it("3. digital_marketing: business with no detected social links and has_meta_description: false returns UNCERTAIN (non-detection is not absence)", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Old Town Tailor",
        category: "Tailor",
        website: "https://oldtowntailor.com",
        website_reachable: true,
        reviews_count: 45,
        seo: { has_meta_description: false },
        instagram: null,
        facebook: null,
        linkedin: null,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "digital_marketing" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.notEqual(result.outcome, "REJECTED");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("3b. digital_marketing: business with strong marketing presence does not get rejected merely for missing signals", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Bright Star Retail",
        category: "Clothing Store",
        website: "https://brightstar.com",
        website_reachable: true,
        reviews_count: 120,
        instagram: "https://instagram.com/brightstar",
        tech_stack: { analytics: ["ga4"] },
        seo: { has_title: true, has_meta_description: true },
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "digital_marketing" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.notEqual(result.outcome, "REJECTED");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("3c. digital_marketing: analytics non-detection (analytics: []) does NOT qualify digital_marketing", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Old Town Tailor",
        category: "Tailor",
        website: "https://oldtowntailor.com",
        website_reachable: true,
        reviews_count: 45,
        tech_stack: { analytics: [] }, // static non-detection is unknown, NOT absence
        instagram: "https://instagram.com/oldtowntailor",
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "digital_marketing" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("4. writing_translation: qualifies reachable custom site with missing meta description", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Riverview Dental",
        category: "Dentist",
        website: "https://riverviewdental.com",
        website_reachable: true,
        seo: { has_meta_description: false }, // confirmed absent
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "writing_translation" });
      assert.equal(result.outcome, "QUALIFIED");
      assert.ok(result.matchedGaps.includes("confirmed_missing_meta_copy"));
    });

    it("7. data: evaluates honestly to UNCERTAIN for high-volume business with analytics: [] (non-detection is not absence)", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Grand Central Hardware",
        category: "Hardware Store",
        website: "https://grandcentralhardware.com",
        website_reachable: true,
        reviews_count: 140,
        tech_stack: { analytics: [] }, // static crawler found no ga4 regex match
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "data" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.notEqual(result.outcome, "REJECTED");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("8. business: evaluates honestly to UNCERTAIN for high-volume business with booking: null & chat: null (non-detection is not absence)", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Evergreen Medical Clinic",
        category: "Medical Clinic",
        website: "https://evergreenclinic.com",
        website_reachable: true, // verified successful crawl
        reviews_count: 110,
        tech_stack: { cms: "wordpress", booking: null, chat: null, analytics: [] },
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "business" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.notEqual(result.outcome, "REJECTED");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("9. personal_growth_hobbies: booking: null alone on reachable site does NOT qualify solo practitioner", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Sarah Jenkins Coaching",
        category: "Life Coach",
        website: "https://sarahcoach.com",
        website_reachable: true,
        tech_stack: { booking: null }, // static non-detection is unknown, NOT absence
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "personal_growth_hobbies" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("9b. personal_growth_hobbies: qualifies solo practitioner with confirmed weak website", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Sarah Jenkins Coaching",
        category: "Life Coach",
        website: "https://sarahcoach.linktree.com",
        website_is_weak: true,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "personal_growth_hobbies" });
      assert.equal(result.outcome, "QUALIFIED");
      assert.ok(result.matchedGaps.includes("confirmed_weak_personal_brand_website"));
    });

    it("10. photography: qualifies visual hotel/hospitality with confirmed free template website, while has_photos: false alone is UNCERTAIN", () => {
      const photosOnlyCandidate: CandidateInspectionSignals = {
        name: "Pinecrest Bed & Breakfast",
        category: "Boutique Hotel",
        website: "https://pinecrest.com",
        website_is_weak: false,
        has_photos: false, // unverified (defaults to false upstream -> unknown)
      };
      const photosOnlyResult = evaluateServiceNeedGate({
        candidate: photosOnlyCandidate,
        professionSlug: "photography",
      });
      assert.equal(photosOnlyResult.outcome, "UNCERTAIN");
      assert.equal(photosOnlyResult.matchedGaps.length, 0);

      const weakSiteVisualCandidate: CandidateInspectionSignals = {
        name: "Pinecrest Bed & Breakfast",
        category: "Boutique Hotel",
        website: "https://pinecrest.wixsite.com",
        website_is_weak: true,
      };
      const weakSiteResult = evaluateServiceNeedGate({
        candidate: weakSiteVisualCandidate,
        professionSlug: "photography",
      });
      assert.equal(weakSiteResult.outcome, "QUALIFIED");
      assert.ok(weakSiteResult.matchedGaps.includes("confirmed_free_template_in_visual_category"));
    });

    it("12. end_to_end_project: healthy custom website with valid SSL and has_photos: false does not qualify (photos may be unprobed)", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Metropolitan Law Firm",
        category: "Law Firm",
        website: "https://metrolaw.com",
        website_reachable: true,
        website_is_weak: false, // Custom website!
        ssl_valid: true,        // Valid SSL!
        has_photos: false,      // May be unprobed / skipped on Maps
        reviews_count: 65,
        instagram: null,
        facebook: null,
        linkedin: null,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.notEqual(result.outcome, "QUALIFIED");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("12b. end_to_end_project: healthy custom website with no detected social links does not qualify", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Boutique Architecture Studio",
        category: "Architect",
        website: "https://boutiquearch.com",
        website_reachable: true,
        website_is_weak: false,
        ssl_valid: true,
        reviews_count: 40,
        instagram: null,
        facebook: null,
        linkedin: null, // No social detected
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.notEqual(result.outcome, "QUALIFIED");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("12c. end_to_end_project: confirmed weak website plus verified invalid SSL qualifies", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Valley Landscaping",
        category: "Landscaper",
        website: "http://valleylandscaping.wixsite.com",
        website_reachable: true,
        website_is_weak: true, // Foundational website gap!
        ssl_valid: false,      // Verified independent deficiency!
        reviews_count: 35,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "QUALIFIED");
      assert.ok(result.matchedGaps[0].startsWith("confirmed_compound_multi_pillar_deficits"));
    });

    it("12c2. end_to_end_project: confirmed weak website with missing/null social links does NOT qualify (social non-detection is unknown)", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Cedar Valley Nursery",
        category: "Garden Center",
        website: "https://cedarvalley.linktree.com",
        website_reachable: true,
        website_is_weak: true, // Foundational website gap!
        ssl_valid: true,       // Valid SSL (no secondary deficiency)
        instagram: null,
        facebook: null,
        linkedin: null,        // Static non-detection -> unknown, NOT a verified deficit
        reviews_count: 35,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("12d. end_to_end_project: missing website with missing social and has_photos: false does NOT qualify (unknown signals cannot count as deficits)", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Tony's Auto Repair",
        category: "Auto Repair",
        website: null,          // Foundational website gap: missing website!
        has_photos: false,      // Unknown
        instagram: "",
        facebook: "",
        linkedin: "",           // Unknown
        reviews_count: 50,      // Threshold met (>= 20)
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("12e. end_to_end_project: foundational website gap alone is insufficient without a secondary verified deficiency", () => {
      // Case A: Missing website alone, but social is present (not absent)
      const candidateA: CandidateInspectionSignals = {
        name: "Tony's Pizzeria",
        category: "Pizza Restaurant",
        website: null, // Foundational website gap
        instagram: "https://instagram.com/tonyspizza", // Social is PRESENT, not deficient
        reviews_count: 50,
      };
      const resultA = evaluateServiceNeedGate({ candidate: candidateA, professionSlug: "end_to_end_project" });
      assert.equal(resultA.outcome, "UNCERTAIN");
      assert.equal(resultA.matchedGaps.length, 0);

      // Case B: Weak website alone, but SSL is valid and social is present
      const candidateB: CandidateInspectionSignals = {
        name: "Tony's Bakery",
        category: "Bakery",
        website: "https://tonysbakery.wixsite.com",
        website_reachable: true,
        website_is_weak: true, // Foundational gap
        ssl_valid: true,       // SSL is valid!
        instagram: "https://instagram.com/tonysbakery", // Social is PRESENT!
        reviews_count: 50,
      };
      const resultB = evaluateServiceNeedGate({ candidate: candidateB, professionSlug: "end_to_end_project" });
      assert.equal(resultB.outcome, "UNCERTAIN");
      assert.equal(resultB.matchedGaps.length, 0);
    });

    it("12f. end_to_end_project: unknown and malformed signals never count as verified deficits", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Corner Market",
        category: "Grocery",
        website: null,       // Foundational gap
        reviews_count: 30,
        ssl_valid: null,     // Unknown
        has_photos: null,    // Unknown
        // Instagram / Facebook / LinkedIn omitted (undefined -> unknown, NOT null)
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "UNCERTAIN");
      assert.equal(result.matchedGaps.length, 0);
    });

    it("12g. end_to_end_project: explicit disqualifiers (e.g. digital agency conflict) still return REJECTED", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Catalyst Full-Service Digital Agency",
        category: "Digital Transformation Consultancy",
        website: null,
        reviews_count: 50,
      };
      const result = evaluateServiceNeedGate({ candidate, professionSlug: "end_to_end_project" });
      assert.equal(result.outcome, "REJECTED");
      assert.ok(result.reason.includes("full_service_digital_agency"));
    });

    describe("Evidence-Based Honesty (No Invented Signals or Proxies)", () => {
      it("digital_marketing: evaluates honestly to UNCERTAIN for eligible businesses without unsupported signals", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Highland Dental Practice",
          category: "Dentist",
          website: "https://highlanddental.com",
          website_reachable: true,
          reviews_count: 75,
        };
        const result = evaluateServiceNeedGate({ candidate, professionSlug: "digital_marketing" });
        assert.equal(result.outcome, "UNCERTAIN");
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.matchedGaps.length, 0);
      });
      it("video_animation: evaluates honestly to UNCERTAIN for eligible businesses without unsupported signals", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Elevate Boutique Fitness",
          category: "Fitness Studio",
          reviews_count: 55,
          website: "https://elevatefit.com",
          website_reachable: true,
          instagram: "https://instagram.com/elevatefit",
        };
        const result = evaluateServiceNeedGate({ candidate, professionSlug: "video_animation" });
        assert.equal(result.outcome, "UNCERTAIN");
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.matchedGaps.length, 0);
      });

      it("music_audio: evaluates honestly to UNCERTAIN for eligible venues without unsupported signals", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Velvet Cocktail Lounge",
          category: "Cocktail Lounge",
          reviews_count: 40,
          website: "https://velvetlounge.com",
          website_reachable: true,
          instagram: "https://instagram.com/velvetlounge",
        };
        const result = evaluateServiceNeedGate({ candidate, professionSlug: "music_audio" });
        assert.equal(result.outcome, "UNCERTAIN");
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.matchedGaps.length, 0);
      });

      it("finance: evaluates honestly to UNCERTAIN for expanding businesses without unsupported signals", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Apex Logistics & Hauling",
          category: "Logistics Company",
          website: "https://apexhauling.com",
          website_reachable: true,
          reviews_count: 65,
          growth_signals: { hiring: true, new_location: false },
        };
        const result = evaluateServiceNeedGate({ candidate, professionSlug: "finance" });
        assert.equal(result.outcome, "UNCERTAIN");
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.matchedGaps.length, 0);
      });

      it("data: evaluates honestly to UNCERTAIN for eligible businesses without unsupported signals", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Harbor Logistics Group",
          category: "Logistics Company",
          website: "https://harborlogistics.com",
          website_reachable: true,
          reviews_count: 120,
          growth_signals: { hiring: true, new_location: true },
        };
        const result = evaluateServiceNeedGate({ candidate, professionSlug: "data" });
        assert.equal(result.outcome, "UNCERTAIN");
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.matchedGaps.length, 0);
      });

      it("business: evaluates honestly to UNCERTAIN for eligible businesses without unsupported signals", () => {
        const candidate: CandidateInspectionSignals = {
          name: "Valley Veterinary Hospital",
          category: "Veterinary Care",
          website: "https://valleyvet.com",
          website_reachable: true,
          reviews_count: 150,
        };
        const result = evaluateServiceNeedGate({ candidate, professionSlug: "business" });
        assert.equal(result.outcome, "UNCERTAIN");
        assert.notEqual(result.outcome, "REJECTED");
        assert.equal(result.matchedGaps.length, 0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 8. Determinism and Side-Effect Freedom
  // -------------------------------------------------------------------------
  describe("8. Determinism & Mutation-Free Invariance", () => {
    it("produces identical outputs given identical inputs with zero mutation", () => {
      const candidate: CandidateInspectionSignals = {
        name: "Immutable Bistro",
        category: "Bistro",
        website: "https://immutablebistro.com",
        website_reachable: true,
        reviews_count: 80,
        ssl_valid: true,
      };

      const candidateFrozen = JSON.parse(JSON.stringify(candidate));

      const run1 = evaluateServiceNeedGate({
        candidate,
        professionSlug: "programming_tech",
      });
      const run2 = evaluateServiceNeedGate({
        candidate,
        professionSlug: "programming_tech",
      });

      assert.deepEqual(run1, run2);
      assert.deepEqual(candidate, candidateFrozen, "Input candidate must not be mutated");
    });
  });
});
