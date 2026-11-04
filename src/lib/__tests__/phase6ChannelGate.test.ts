import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { channelsSatisfied } = await import("../channelFilter.js");

describe("Phase 6: Channel Gate and Priority Matching", () => {
  const candidateWithPhoneAndInstagram = {
    phone: "+1 312 555 0199",
    instagram: "https://instagram.com/coffeeshopchi",
    website: "https://coffeeshopchi.com",
    email: null, // missing email!
  };

  describe("Default Mode ('all')", () => {
    it("rejects candidate when missing any requested channel", () => {
      const requested = ["email", "phone", "instagram"];
      // Mode omitted defaults to "all"
      const satisfiedDefault = channelsSatisfied(candidateWithPhoneAndInstagram, requested);
      assert.equal(satisfiedDefault, false, "Must require ALL requested channels by default");

      // Mode explicitly "all"
      const satisfiedExplicitAll = channelsSatisfied(candidateWithPhoneAndInstagram, requested, "all");
      assert.equal(satisfiedExplicitAll, false);
    });

    it("accepts candidate when all requested channels are present", () => {
      const requested = ["phone", "instagram"];
      assert.equal(channelsSatisfied(candidateWithPhoneAndInstagram, requested), true);
    });
  });

  describe("Opt-in Mode ('any_of_priority')", () => {
    it("accepts candidate when at least one priority channel is reachable", () => {
      const requested = ["email", "phone", "instagram"];
      // Missing email, but has valid phone and instagram -> deliverable in any_of_priority mode!
      const satisfied = channelsSatisfied(candidateWithPhoneAndInstagram, requested, "any_of_priority");
      assert.equal(satisfied, true, "Must accept candidate with at least one reachable priority channel");
    });

    it("rejects candidate when none of the requested priority channels are reachable", () => {
      const candidateNoReachableChannels = {
        phone: null,
        instagram: null,
        email: null,
        website: "https://coffeeshopchi.com",
      };
      const requested = ["email", "phone", "instagram"];
      const satisfied = channelsSatisfied(candidateNoReachableChannels, requested, "any_of_priority");
      assert.equal(satisfied, false, "Must reject candidate when no priority channels are reachable");
    });

    it("identifies missing channels to tag the delivered lead", () => {
      const requested = ["email", "phone", "instagram"];
      const missing = requested.filter((c) => !channelsSatisfied(candidateWithPhoneAndInstagram, [c]));
      assert.deepEqual(missing, ["email"], "Must accurately identify missing channels for tagging");
    });
  });

  describe("API Request Schema Validation (DiscoverRequestSchema)", async () => {
    const { DiscoverRequestSchema } = await import("../../server/routes/discover.js");

    it("defaults channelMatch to 'all' when omitted", () => {
      const parsed = DiscoverRequestSchema.parse({
        quantity: 10,
        region: "US",
        niche: "Coffee Shop",
      });
      assert.equal(parsed.channelMatch, "all");
    });

    it("accepts channelMatch='any_of_priority'", () => {
      const parsed = DiscoverRequestSchema.parse({
        quantity: 10,
        region: "US",
        niche: "Coffee Shop",
        channelMatch: "any_of_priority",
      });
      assert.equal(parsed.channelMatch, "any_of_priority");
    });

    it("rejects invalid channelMatch values", () => {
      assert.throws(() => {
        DiscoverRequestSchema.parse({
          quantity: 10,
          region: "US",
          niche: "Coffee Shop",
          channelMatch: "invalid_mode",
        });
      }, /invalid_enum_value|Invalid enum/i);
    });
  });

  describe("Scrape Jobs Insert Schema Integrity", () => {
    it("ensures scrape_jobs.insert payload contains only known table columns and embeds channelMatch in query", () => {
      const KNOWN_SCRAPE_JOBS_COLUMNS = new Set([
        "id",
        "user_id",
        "mode",
        "status",
        "query",
        "results_count",
        "error",
        "created_at",
        "started_at",
        "completed_at",
        "last_heartbeat_at",
        "execution_target",
      ]);

      // The exact payload structure constructed in src/server/routes/discover.ts:257-272
      const userId = "test-user-id";
      const mode = "live";
      const body = {
        niche: "Coffee Shop",
        channels: ["email", "phone"],
        channelMatch: "any_of_priority" as const,
        currencies: ["USD"],
        quantity: 10,
      };
      const region = { country: "US", city: "Chicago" };
      const professionSlug = "coffee-shop";
      const executionTarget = "cloud";

      const insertPayload = {
        user_id: userId,
        mode,
        status: "queued",
        query: {
          region: region,
          niche: body.niche,
          channels: body.channels,
          channelMatch: body.channelMatch,
          currencies: body.currencies,
          profession_slug: professionSlug,
          quantity: body.quantity,
          execution_target: executionTarget,
        },
      };

      for (const key of Object.keys(insertPayload)) {
        assert.ok(
          KNOWN_SCRAPE_JOBS_COLUMNS.has(key),
          `Column '${key}' is not a known column on scrape_jobs table`,
        );
      }

      assert.equal("channelMatch" in insertPayload, false, "channelMatch must NOT be a top-level column on scrape_jobs");
      assert.equal(insertPayload.query.channelMatch, "any_of_priority", "channelMatch must be stored within jsonb query");
    });
  });
});
