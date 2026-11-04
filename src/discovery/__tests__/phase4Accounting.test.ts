import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { cityTransitionFor, reconcileDiscoveryCounters } = await import("../cityScheduling.js");
const { areaCompletedEvent } = await import("../liveDiscoveryEvent.js");

describe("Phase 4: Honest Failure Accounting", () => {
  describe("Terminal State Classification (cityTransitionFor)", () => {
    it("State 1: CITY_PRODUCTIVE when accepted leads > 0", () => {
      const reason = cityTransitionFor(
        { candidatesFound: 5, acceptedLeads: 2 },
        false,
        undefined,
        { failedAreaCount: 0, totalAreas: 3, crashCount: 0 },
      );
      assert.equal(reason, "CITY_PRODUCTIVE");
    });

    it("State 2: CITY_EXHAUSTED when all areas complete, scraper healthy, genuinely 0 candidates", () => {
      const reason = cityTransitionFor(
        { candidatesFound: 0, acceptedLeads: 0 },
        true, // genuinely exhausted
        undefined,
        { failedAreaCount: 0, totalAreas: 3, crashCount: 0 },
      );
      assert.equal(reason, "CITY_EXHAUSTED");
    });

    it("State 3: CITY_FAILED when all areas hard-failed", () => {
      const reason = cityTransitionFor(
        { candidatesFound: 0, acceptedLeads: 0 },
        false,
        undefined,
        { failedAreaCount: 3, totalAreas: 3, crashCount: 0 },
      );
      assert.equal(reason, "CITY_FAILED");
    });

    it("State 4a: CITY_DEGRADED when some areas failed (infra failure)", () => {
      // 1 of 3 areas failed, 0 accepted leads -> Must be CITY_DEGRADED, never CITY_EXHAUSTED!
      const reason = cityTransitionFor(
        { candidatesFound: 0, acceptedLeads: 0 },
        true, // even if exhausted flag was set
        undefined,
        { failedAreaCount: 1, totalAreas: 3, crashCount: 0 },
      );
      assert.equal(reason, "CITY_DEGRADED");
    });

    it("State 4b: CITY_DEGRADED when browser page crashes occurred", () => {
      // 0 failed areas, but 2 crashes happened -> Must be CITY_DEGRADED
      const reason = cityTransitionFor(
        { candidatesFound: 0, acceptedLeads: 0 },
        true,
        undefined,
        { failedAreaCount: 0, totalAreas: 3, crashCount: 2 },
      );
      assert.equal(reason, "CITY_DEGRADED");
    });
  });

  describe("validAccounting Integrity with Failed Areas", () => {
    it("validAccounting is true when 0 failed areas and counters balance", () => {
      const result = reconcileDiscoveryCounters({
        stalePanelMismatches: 0,
        verifiedCandidatesYielded: 5,
        accepted: 3,
        duplicates: 1,
        rejectedByChannelOrQuality: 1,
        failedAreaCount: 0,
      });
      assert.equal(result.valid, true);
      assert.equal(result.discrepancy, 0);
    });

    it("validAccounting is false when failed areas exist, even if counters balance", () => {
      const result = reconcileDiscoveryCounters({
        stalePanelMismatches: 0,
        verifiedCandidatesYielded: 0,
        accepted: 0,
        duplicates: 0,
        rejectedByChannelOrQuality: 0,
        failedAreaCount: 1, // 1 area failed
      });
      assert.equal(result.valid, false, "validAccounting must be false when failed areas exist");
    });
  });

  describe("Live Discovery Event Surfaces Degraded Reason", () => {
    it("areaCompletedEvent flags degraded status and carries failure reason", () => {
      const event = areaCompletedEvent(
        "plan-123",
        1,
        "Midtown",
        {
          discovered: 0,
          accepted: 0,
          rejected: 0,
          duplicates: 0,
          exhausted: false,
          failed: true,
          error: "Chromium target crashed",
        },
        undefined,
        {
          isDegraded: true,
          reason: "Chromium target crashed",
        },
      );

      assert.equal(event.degraded, true);
      assert.equal(event.degradedReason, "Chromium target crashed");
      assert.equal(event.areaOutcome?.failed, true);
      assert.equal(event.areaOutcome?.error, "Chromium target crashed");
    });
  });
});
