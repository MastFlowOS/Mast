import test from "node:test";
import assert from "node:assert/strict";
import { computeAndStoreBusinessHealth } from "../storeBusinessHealth.js";
import { computeAndStoreOpportunityScores } from "../storeOpportunityScores.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import type { EngineScoreResult } from "../../scraperBridge/pythonBridge.js";

function makeMockEngineResult(
  businessId: string,
  opportunityScore: number,
  healthScore: number,
  marker: string,
): EngineScoreResult {
  return {
    business_id: businessId,
    is_disqualified: false,
    health_score: healthScore,
    universal_breakdown: {
      markerValue: healthScore,
      branding: healthScore,
      website: opportunityScore,
      outreach: opportunityScore,
    },
    profession_scores: {
      web_developer: {
        score: opportunityScore,
        breakdown: { markerValue: opportunityScore },
        summary: `Summary for ${marker}`,
        reasons: [`Reason ${marker}`],
      },
    },
  };
}

test("concurrency regression - overlapping scoring operations for the same business ID never cross-contaminate", async () => {
  const businessId = "biz-concurrent-shared-1";
  const resultA = makeMockEngineResult(businessId, 40, 42, "OP_A");
  const resultB = makeMockEngineResult(businessId, 95, 99, "OP_B");

  const healthUpserts: { caller: string; row: any }[] = [];
  const oppUpserts: { caller: string; rows: any[] }[] = [];

  const origFrom = supabaseAdmin.from;
  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "business_health_scores") {
        return {
          upsert: async (row: any) => {
            const caller = row.health_score === 42 ? "OP_A" : row.health_score === 99 ? "OP_B" : "UNKNOWN";
            healthUpserts.push({ caller, row });
            return { error: null };
          },
        };
      }
      if (table === "business_opportunity_scores") {
        return {
          upsert: async (rows: any[]) => {
            const caller = rows[0]?.opportunity_score === 40 ? "OP_A" : rows[0]?.opportunity_score === 95 ? "OP_B" : "UNKNOWN";
            oppUpserts.push({ caller, rows });
            return { error: null };
          },
        };
      }
      if (table === "businesses") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: businessId, website: "https://example.com" },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    };

    // Operation 1 simulation: uses mock runner returning resultA
    const runOp1 = async () => {
      const runnerA = async () => resultA;
      const scoreResultA = await computeAndStoreOpportunityScores(businessId, runnerA);
      // Introduce an async micro-delay between opportunity score and health score
      // to simulate real async pipeline interleaving with Operation 2
      await new Promise((r) => setTimeout(r, 15));
      await computeAndStoreBusinessHealth(businessId, scoreResultA);
      return scoreResultA;
    };

    // Operation 2 simulation: uses mock runner returning resultB concurrently
    const runOp2 = async () => {
      const runnerB = async () => resultB;
      const scoreResultB = await computeAndStoreOpportunityScores(businessId, runnerB);
      await new Promise((r) => setTimeout(r, 5));
      await computeAndStoreBusinessHealth(businessId, scoreResultB);
      return scoreResultB;
    };

    // Execute both overlapping operations concurrently on the same business ID
    const [finalA, finalB] = await Promise.all([runOp1(), runOp2()]);

    assert.equal(finalA.health_score, 42);
    assert.equal(finalB.health_score, 99);

    assert.equal(healthUpserts.length, 2, "Expected exactly 2 health score upserts");

    const healthA = healthUpserts.find((u) => u.caller === "OP_A");
    const healthB = healthUpserts.find((u) => u.caller === "OP_B");

    assert.ok(healthA, "Operation A health upsert must be present");
    assert.ok(healthB, "Operation B health upsert must be present");

    // Strict proof: Op A received ONLY Op A's health score (42), never Op B's (99)
    assert.equal(healthA.row.health_score, 42);
    assert.equal(healthA.row.breakdown.markerValue, 42);

    // Strict proof: Op B received ONLY Op B's health score (99), never Op A's (42)
    assert.equal(healthB.row.health_score, 99);
    assert.equal(healthB.row.breakdown.markerValue, 99);
  } finally {
    (supabaseAdmin as any).from = origFrom;
  }
});

test("consistency - opportunity and health scores written originate from the exact same result object", async () => {
  const businessId = "biz-consistent-1";
  const result = makeMockEngineResult(businessId, 88, 77, "CONSISTENCY_CHECK");

  let healthUpsertRow: any = null;
  const origFrom = supabaseAdmin.from;
  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "business_health_scores") {
        return {
          upsert: async (row: any) => {
            healthUpsertRow = row;
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    };

    await computeAndStoreBusinessHealth(businessId, result);

    assert.ok(healthUpsertRow);
    assert.equal(healthUpsertRow.business_id, businessId);
    assert.equal(healthUpsertRow.health_score, result.health_score);
    assert.deepEqual(healthUpsertRow.breakdown, result.universal_breakdown);
  } finally {
    (supabaseAdmin as any).from = origFrom;
  }
});

test("standalone fallback - computeAndStoreBusinessHealth without precomputed result queries DB and delegates to engine", async () => {
  const businessId = "biz-standalone-1";
  const fallbackResult = makeMockEngineResult(businessId, 60, 65, "STANDALONE_FALLBACK");

  let businessQueried = false;
  let healthUpsertRow: any = null;
  let runnerInvoked = false;

  const origFrom = supabaseAdmin.from;
  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "businesses") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              single: async () => {
                assert.equal(id, businessId);
                businessQueried = true;
                return {
                  data: {
                    id: businessId,
                    website: "https://standalone.example.com",
                    signals: { tech_stack: "wordpress" },
                  },
                  error: null,
                };
              },
            }),
          }),
        };
      }
      if (table === "business_health_scores") {
        return {
          upsert: async (row: any) => {
            healthUpsertRow = row;
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    };

    const mockRunner = async (params: any) => {
      assert.equal(params.id, businessId);
      assert.equal(params.website, "https://standalone.example.com");
      runnerInvoked = true;
      return fallbackResult;
    };

    // Invoke without precomputed (standalone fallback)
    await computeAndStoreBusinessHealth(businessId, undefined, mockRunner);

    assert.ok(businessQueried, "Expected standalone call to query businesses table");
    assert.ok(runnerInvoked, "Expected standalone call to invoke scoreRunner");
    assert.ok(healthUpsertRow, "Expected standalone call to upsert business_health_scores");
    assert.equal(healthUpsertRow.health_score, 65);
    assert.deepEqual(healthUpsertRow.breakdown, fallbackResult.universal_breakdown);
  } finally {
    (supabaseAdmin as any).from = origFrom;
  }
});

test("failure isolation - database errors in opportunity scoring reject cleanly with no stale state leak", async () => {
  const businessId = "biz-fail-iso-1";
  const origFrom = supabaseAdmin.from;

  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "businesses") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: businessId, website: "https://fail.example.com" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "business_opportunity_scores") {
        return {
          upsert: async () => ({
            error: new Error("PostgreSQL unique constraint violation / connection timeout"),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    };

    const mockRunner = async () => {
      return makeMockEngineResult(businessId, 50, 50, "FAIL_ATTEMPT");
    };

    // Must reject cleanly
    await assert.rejects(
      async () => {
        await computeAndStoreOpportunityScores(businessId, mockRunner);
      },
      /PostgreSQL unique constraint violation/,
    );
  } finally {
    (supabaseAdmin as any).from = origFrom;
  }
});

test("failure isolation - database errors in health scoring reject cleanly", async () => {
  const businessId = "biz-fail-health-1";
  const result = makeMockEngineResult(businessId, 75, 80, "HEALTH_FAIL");

  const origFrom = supabaseAdmin.from;
  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === "business_health_scores") {
        return {
          upsert: async () => ({
            error: new Error("PostgreSQL disk full / connection terminated"),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    };

    await assert.rejects(
      async () => {
        await computeAndStoreBusinessHealth(businessId, result);
      },
      /PostgreSQL disk full/,
    );
  } finally {
    (supabaseAdmin as any).from = origFrom;
  }
});
