import assert from "node:assert/strict";
import test, { describe, beforeEach, afterEach, it } from "node:test";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";
process.env.SCRAPER_SUBPROCESS_INACTIVITY_MS ??= "10000";
process.env.SCRAPER_SUBPROCESS_MAX_MS ??= "30000";
process.env.SCRAPER_GRACEFUL_SHUTDOWN_MS ??= "1000";

import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { deliverLead, type DeliveryContext } from "../../scraperBridge/deliverLead.js";
import { FakeDb, installFakeSupabase } from "../../lib/__tests__/helpers/fakeSupabaseAdmin.js";
import {
  setServiceNeedGateTelemetrySink,
  recordServiceNeedGateObservation,
  candidateSignalsFromEngineLead,
  type ServiceNeedGateTelemetryRecord,
} from "../serviceNeedGate.js";
import type { EngineLead } from "../../scraperBridge/pythonBridge.js";

describe("Phase 2 Service-Need Gate Telemetry Integration", () => {
  let db: InstanceType<typeof FakeDb>;
  let restoreSupabase: () => void;
  const capturedTelemetry: ServiceNeedGateTelemetryRecord[] = [];

  const defaultCtx: DeliveryContext = {
    userId: "user_test_telemetry",
    professionSlug: "programming_tech",
    discoveryMode: "live",
    scrapeJobId: "job_telemetry_123",
    opportunityScore: 88,
    dailyLimit: 50,
    monthlyLimit: 500,
  };

  function buildMockEngineLead(overrides: Partial<EngineLead> = {}): EngineLead {
    return {
      name: "Standard Cafe",
      address: "100 Court St, Brooklyn, NY",
      city: "Brooklyn",
      country: "USA",
      country_code: "US",
      query: "cafes in brooklyn",
      region: "Brooklyn",
      phone: "+1 718-555-0199",
      email: "hello@standardcafe.com",
      website: "https://standardcafe.com",
      instagram: "https://instagram.com/standardcafe",
      facebook: "",
      linkedin: "",
      contact_form: "",
      maps_link: "https://maps.google.com/?cid=1001",
      rating: 4.6,
      reviews: 42,
      category: "Coffee Shop",
      price_range: "$$",
      has_photos: true,
      has_popular_times: true,
      owner_responds_to_reviews: true,
      is_google_verified: true,
      multi_location: false,
      closed: false,
      ig_followers: 1200,
      ig_bio: "Specialty coffee and pastries",
      ig_activity: "Active",
      ig_last_post_days: 3,
      ig_legitimacy: 85,
      tech_stack: {},
      score: 78,
      quality: "high",
      tier: "tier_1",
      action: "reach_out",
      fingerprints: ["fp:test:1001"],
      is_disqualified: false,
      _pipeline_id: "pipe_1001",
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new FakeDb();
    restoreSupabase = installFakeSupabase(supabaseAdmin, db);
    capturedTelemetry.length = 0;
    setServiceNeedGateTelemetrySink((record) => {
      capturedTelemetry.push(record);
    });
  });

  afterEach(() => {
    setServiceNeedGateTelemetrySink(null);
    restoreSupabase();
  });

  // ---------------------------------------------------------------------------
  // 1. All Four Outcomes Recorded Correctly in Telemetry
  // ---------------------------------------------------------------------------
  describe("1. All Four Gate Outcomes Recorded Correctly", () => {
    it("records QUALIFIED outcome when a confirmed service gap exists", async () => {
      const qualifiedLead = buildMockEngineLead({
        name: "No Website Bakery",
        website: "", // confirmed absent website
        reviews: 35, // active real business
        fingerprints: ["fp:telemetry:qual"],
      });

      const res = await deliverLead(qualifiedLead, defaultCtx, "Brooklyn");
      assert.equal(res.wasNewForUser, true);
      assert.equal(capturedTelemetry.length, 1);

      const record = capturedTelemetry[0];
      assert.equal(record.outcome, "QUALIFIED");
      assert.equal(record.professionSlug, "programming_tech");
      assert.ok(record.matchedGaps.includes("confirmed_no_website"));
      assert.equal(record.signalStates.website, "absent");
      assert.equal(record.scrapeJobId, "job_telemetry_123");
      assert.equal(record.opportunityScore, 88);

      // Verify privacy / no PII (type-safe property-existence assertions)
      assert.equal("email" in record, false);
      assert.equal("phone" in record, false);
      assert.equal("html" in record, false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, "email"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, "phone"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(record, "html"), false);
    });

    it("records REJECTED outcome when explicit unsuitability is detected", async () => {
      const rejectedLead = buildMockEngineLead({
        name: "Acme Web Design Agency", // Self-service digital agency conflict
        category: "Web Development Agency",
        fingerprints: ["fp:telemetry:rej"],
      });

      const res = await deliverLead(rejectedLead, defaultCtx, "Brooklyn");
      // CRITICAL: delivery must STILL succeed
      assert.equal(res.wasNewForUser, true);
      assert.equal(capturedTelemetry.length, 1);

      const record = capturedTelemetry[0];
      assert.equal(record.outcome, "REJECTED");
      assert.equal(record.professionSlug, "programming_tech");
      assert.ok(
        record.unsuitabilityReasons.some((r) => r.includes("self_service_conflict")),
        `expected self_service_conflict in ${JSON.stringify(record.unsuitabilityReasons)}`,
      );
    });

    it("records UNCERTAIN outcome for eligible candidate with strong assets", async () => {
      const uncertainLead = buildMockEngineLead({
        name: "Modern Bistro",
        website: "https://modernbistro.com",
        load_time_ms: 450,
        ssl_valid: true,
        fingerprints: ["fp:telemetry:unc"],
      });

      const res = await deliverLead(
        uncertainLead,
        { ...defaultCtx, professionSlug: "digital_marketing" },
        "Brooklyn",
      );
      assert.equal(res.wasNewForUser, true);
      assert.equal(capturedTelemetry.length, 1);

      const record = capturedTelemetry[0];
      assert.equal(record.outcome, "UNCERTAIN");
      assert.equal(record.professionSlug, "digital_marketing");
      assert.equal(record.matchedGaps.length, 0);
      assert.equal(record.unsuitabilityReasons.length, 0);
    });

    it("records NOT_APPLICABLE outcome when profession is unset or null", async () => {
      const noProfLead = buildMockEngineLead({
        name: "General Store",
        fingerprints: ["fp:telemetry:notapp"],
      });

      const res = await deliverLead(
        noProfLead,
        { ...defaultCtx, professionSlug: null },
        "Brooklyn",
      );
      assert.equal(res.wasNewForUser, true);
      assert.equal(capturedTelemetry.length, 1);

      const record = capturedTelemetry[0];
      assert.equal(record.outcome, "NOT_APPLICABLE");
      assert.equal(record.professionSlug, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. REJECTED Gate Outcome Does NOT Prevent Delivery
  // ---------------------------------------------------------------------------
  describe("2. Telemetry Invariant: REJECTED Does Not Block Delivery", () => {
    it("delivers lead and inserts CRM row even when gate outcome is REJECTED", async () => {
      const enterpriseLead = buildMockEngineLead({
        name: "Megacorp Coffee",
        is_chain: true,
        ig_followers: 250_000, // excessive scale
        fingerprints: ["fp:telemetry:enterprise"],
      });

      const res = await deliverLead(enterpriseLead, defaultCtx, "Brooklyn");

      // Lead is still delivered
      assert.equal(res.wasNewForUser, true);
      assert.ok(res.businessId);

      // Lead is in CRM leads table
      const inLeads = db.leads.find((l) => l.business_id === res.businessId);
      assert.ok(inLeads, "lead row must be present in database");
      assert.equal(inLeads.business_name, "Megacorp Coffee");

      // Telemetry recorded the rejection
      assert.equal(capturedTelemetry.length, 1);
      assert.equal(capturedTelemetry[0].outcome, "REJECTED");
      assert.ok(
        capturedTelemetry[0].unsuitabilityReasons.includes("scale_mismatch_excessive_followers"),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Failsafe: Evaluation Error or Logging Failure Never Blocks Delivery
  // ---------------------------------------------------------------------------
  describe("3. Failsafe Robustness", () => {
    it("delivers lead without error even if the telemetry sink throws an exception", async () => {
      setServiceNeedGateTelemetrySink(() => {
        throw new Error("Simulated telemetry database disk full");
      });

      const lead = buildMockEngineLead({
        name: "Resilient Diner",
        fingerprints: ["fp:telemetry:resilient"],
      });

      // Must NOT throw
      const res = await deliverLead(lead, defaultCtx, "Brooklyn");
      assert.equal(res.wasNewForUser, true);
      assert.ok(res.businessId);
    });

    it("recordServiceNeedGateObservation catches internal evaluation errors gracefully", () => {
      // Create a pathological proxy that throws on property access
      const explodingLead = new Proxy({} as unknown as EngineLead, {
        get() {
          throw new Error("Simulated memory corruption / proxy error");
        },
      });

      const result = recordServiceNeedGateObservation(explodingLead, defaultCtx, "biz_exploding");
      assert.equal(result, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Duplicate Delivery and Credit Accounting Unchanged
  // ---------------------------------------------------------------------------
  describe("4. Duplicate Delivery and Credit Accounting Paths", () => {
    it("preserves exact duplicate detection and credit charging behavior", async () => {
      const lead = buildMockEngineLead({
        name: "Repeat Boutique",
        fingerprints: ["fp:telemetry:repeat"],
      });

      // First delivery: new for user, credit charged
      const firstResult = await deliverLead(lead, defaultCtx, "Brooklyn");
      assert.equal(firstResult.wasNewForUser, true);
      assert.equal(db.usageUsed, 1);
      assert.equal(capturedTelemetry.length, 1);

      // Second delivery: duplicate for user, 0 credit charged
      const secondResult = await deliverLead(lead, defaultCtx, "Brooklyn");
      assert.equal(secondResult.wasNewForUser, false);
      assert.equal(db.usageUsed, 1); // credit count unchanged
      assert.equal(capturedTelemetry.length, 2); // telemetry recorded both observations
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Unset or Missing Profession
  // ---------------------------------------------------------------------------
  describe("5. Unset Profession Handling", () => {
    it("handles undefined professionSlug cleanly without altering delivery", async () => {
      const lead = buildMockEngineLead({
        name: "Uncategorized Shop",
        fingerprints: ["fp:telemetry:undef_prof"],
      });

      const res = await deliverLead(
        lead,
        { ...defaultCtx, professionSlug: undefined as unknown as null },
        "Brooklyn",
      );

      assert.equal(res.wasNewForUser, true);
      assert.equal(capturedTelemetry.length, 1);
      assert.equal(capturedTelemetry[0].outcome, "NOT_APPLICABLE");
      assert.equal(capturedTelemetry[0].professionSlug, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Immutability: Gate Does Not Overwrite or Mutate Candidate or Ctx
  // ---------------------------------------------------------------------------
  describe("6. Gate Immutability Invariant", () => {
    it("does not mutate candidate attributes, opportunity scores, or delivery context", () => {
      const originalLead = buildMockEngineLead({
        name: "Immutable Bistro",
        score: 95,
        website: "https://immutablebistro.com",
        tech_stack: { analytics: true, booking: true },
        growth_signals: { hiring: true },
      });

      const leadSnapshot = JSON.parse(JSON.stringify(originalLead));
      const ctxSnapshot = JSON.parse(JSON.stringify(defaultCtx));

      recordServiceNeedGateObservation(originalLead, defaultCtx, "biz_immutable_1");

      assert.deepEqual(originalLead, leadSnapshot, "lead object must be completely untouched");
      assert.deepEqual(defaultCtx, ctxSnapshot, "context object must be completely untouched");
    });

    it("candidateSignalsFromEngineLead maps fields into a fresh detached object", () => {
      const lead = buildMockEngineLead({
        name: "Detached Cafe",
        reviews: 50,
      });

      const signals = candidateSignalsFromEngineLead(lead, "biz_detached");
      assert.notEqual(signals, lead as unknown);
      assert.equal(signals.id, "biz_detached");
      assert.equal(signals.reviews_count, 50);

      // Mutating signals object does not affect engine lead
      signals.name = "Mutated Name";
      assert.equal(lead.name, "Detached Cafe");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Signal Semantics Honesty in Telemetry
  // ---------------------------------------------------------------------------
  describe("7. Signal Semantics Honesty (Social, Photos, Missing vs Weak Website)", () => {
    it("records social as unknown when social URLs are empty or missing, and present when detected", () => {
      const noSocialLead = buildMockEngineLead({
        instagram: "",
        facebook: "",
        linkedin: "",
      });
      recordServiceNeedGateObservation(noSocialLead, defaultCtx, "biz_nosocial");
      assert.equal(capturedTelemetry[0].signalStates.social, "unknown");

      const withSocialLead = buildMockEngineLead({
        instagram: "https://instagram.com/bakery",
        facebook: "",
        linkedin: "",
      });
      recordServiceNeedGateObservation(withSocialLead, defaultCtx, "biz_withsocial");
      assert.equal(capturedTelemetry[1].signalStates.social, "present");
    });

    it("records has_photos: false as unknown and has_photos: true as present", () => {
      const falsePhotosLead = buildMockEngineLead({
        has_photos: false,
      });
      recordServiceNeedGateObservation(falsePhotosLead, defaultCtx, "biz_photos_false");
      assert.equal(capturedTelemetry[0].signalStates.has_photos, "unknown");

      const truePhotosLead = buildMockEngineLead({
        has_photos: true,
      });
      recordServiceNeedGateObservation(truePhotosLead, defaultCtx, "biz_photos_true");
      assert.equal(capturedTelemetry[1].signalStates.has_photos, "present");
    });

    it("distinguishes missing website from existing weak-domain website even when upstream sets website_is_weak: true", () => {
      const missingSiteLead = buildMockEngineLead({
        website: "",
        website_is_weak: true, // upstream Python default when URL is empty
      });
      recordServiceNeedGateObservation(missingSiteLead, defaultCtx, "biz_missing_site");
      assert.equal(capturedTelemetry[0].signalStates.website, "absent");
      assert.equal(capturedTelemetry[0].signalStates.website_is_weak, "unknown");
      assert.deepEqual(capturedTelemetry[0].matchedGaps, ["confirmed_no_website"]);

      const weakDomainSiteLead = buildMockEngineLead({
        website: "https://mybakery.wixsite.com",
        website_is_weak: true,
      });
      recordServiceNeedGateObservation(weakDomainSiteLead, defaultCtx, "biz_weak_site");
      assert.equal(capturedTelemetry[1].signalStates.website, "present");
      assert.equal(capturedTelemetry[1].signalStates.website_is_weak, "present");
      assert.deepEqual(capturedTelemetry[1].matchedGaps, ["confirmed_weak_or_free_website"]);
    });

    it("observes real enriched signals (reachable, ssl, seo) when attached to lead", () => {
      const enrichedLead = buildMockEngineLead({
        website: "https://artisan-roasters.com",
        website_reachable: true,
        ssl_valid: true,
        website_is_weak: false,
        seo: {
          has_title: true,
          has_meta_description: true,
          title: "Artisan Roasters - Fresh Daily",
          meta_description: "Finest roasted coffee beans and cafe specialties.",
        },
      });
      recordServiceNeedGateObservation(enrichedLead, defaultCtx, "biz_enriched_real");
      assert.equal(capturedTelemetry[0].signalStates.website, "present");
      assert.equal(capturedTelemetry[0].signalStates.website_reachable, "present");
      assert.equal(capturedTelemetry[0].signalStates.ssl_valid, "present");
      assert.equal(capturedTelemetry[0].signalStates.website_is_weak, "absent");
      assert.equal(capturedTelemetry[0].signalStates.seo_meta, "present");
    });
  });
});
