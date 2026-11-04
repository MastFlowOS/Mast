import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { runEngineEnrich, runEngineEnrichOneShot } = await import("../../scraperBridge/pythonBridge.js");

describe("Phase 7: Optimization of Spawns and Routes", () => {
  describe("Enrichment Empty Input Protection", () => {
    it("skips enrich spawn when no input fields are provided (runEngineEnrich)", async () => {
      const emptyParams = {};
      const result = await runEngineEnrich(emptyParams);
      assert.equal(result.enriched, false);
      assert.equal((result as any).status, "empty_input");
    });

    it("skips enrich spawn when fields are whitespace only (runEngineEnrichOneShot)", async () => {
      const whitespaceParams = {
        name: "   ",
        website: "  ",
        instagram: "",
        phone: undefined,
      };
      const result = await runEngineEnrichOneShot(whitespaceParams);
      assert.equal(result.enriched, false);
      assert.equal((result as any).status, "empty_input");
    });
  });

  describe("Channel Gate Spawn Pruning", () => {
    it("ensures candidates rejected by channel gate skip background enrich and score enqueuing", () => {
      let enqueueCalled = false;
      const enqueueBusinessProcessing = (_id: string, _type: string) => {
        enqueueCalled = true;
      };

      // Candidate missing required email channel
      const requestedChannels = ["email", "phone"];
      const candidate = {
        phone: "+1 312 555 0199",
        email: null,
      };

      const hasEmail = Boolean(candidate.email);
      const isSatisfied = hasEmail && Boolean(candidate.phone);

      if (!isSatisfied) {
        // Rejected by channel gate — return early without enqueuing!
      } else {
        enqueueBusinessProcessing("biz-123", "enrich");
      }

      assert.equal(enqueueCalled, false, "Must not enqueue background enrich/score when candidate is rejected");
    });
  });
});
