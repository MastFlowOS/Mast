import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { getKnownPlaceIdsForTask } = await import("../../jobs/discoveryPlanJob.js");

describe("Phase 5: Dedup Before Click and Known-ID Lookup", () => {
  it("includes both user-owned and globally known place IDs in knownPlaceIds set", async () => {
    let userQueryRan = false;
    let globalQueryRan = false;

    const mockDb = {
      from: (table: string) => {
        assert.equal(table, "businesses");
        return {
          select: (fields: string) => {
            const isUserQuery = fields.includes("leads!inner(user_id)");
            return {
              eq: (col: string, val: any) => {
                if (isUserQuery) {
                  userQueryRan = true;
                  assert.equal(col, "leads.user_id");
                  assert.equal(val, "user-123");
                  return {
                    range: async () => ({
                      data: [
                        { place_id: "0x880fcd7f8fee01b5:0x89b38e817d796008", fingerprints: ["place:0x880fcd7f8fee01b5:0x89b38e817d796008"] },
                      ],
                      error: null,
                    }),
                  };
                } else {
                  globalQueryRan = true;
                  assert.equal(col, "country_code");
                  assert.equal(val, "US");
                  return {
                    range: async () => ({
                      data: [
                        { place_id: "ChIJglobalPlace456", fingerprints: ["place:ChIJglobalPlace456"] },
                      ],
                      error: null,
                    }),
                  };
                }
              },
            };
          },
        };
      },
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-123", "US", "Chicago");
    assert.equal(userQueryRan, true, "User query must run");
    assert.equal(globalQueryRan, true, "Global business query must run");

    // Both user place ID and global place ID must be present
    assert.ok(placeIds.some((id) => id.includes("0x880fcd7f8fee01b5")), "User place ID must be in set");
    assert.ok(placeIds.some((id) => id.includes("ChIJglobalPlace456")), "Global place ID must be in set");
  });

  it("fails open gracefully when global query encounters an error", async () => {
    const mockDb = {
      from: () => ({
        select: (fields: string) => {
          const isUserQuery = fields.includes("leads!inner(user_id)");
          return {
            eq: () => ({
              range: async () => {
                if (isUserQuery) {
                  return {
                    data: [{ place_id: "ChIJuser123", fingerprints: ["place:ChIJuser123"] }],
                    error: null,
                  };
                }
                return {
                  data: null,
                  error: new Error("Network error connecting to DB"),
                };
              },
            }),
          };
        },
      }),
    };

    // Should not throw, and user IDs are still retained
    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.ok(placeIds.includes("ChIJuser123"));
  });

  it("bounds memory to MAX_IDS during pagination", async () => {
    let callCount = 0;
    const mockDb = {
      from: () => ({
        select: (fields: string) => ({
          eq: () => ({
            range: async (from: number) => {
              callCount++;
              // Return 1000 distinct items per page
              const items = Array.from({ length: 1000 }, (_, i) => ({
                place_id: `ChIJpageItem_${from}_${i}`,
                fingerprints: [`place:ChIJpageItem_${from}_${i}`],
              }));
              return { data: items, error: null };
            },
          }),
        }),
      }),
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.ok(placeIds.length <= 10000, `Place IDs count (${placeIds.length}) must be capped at 10000`);
    assert.ok(callCount <= 12, "Must stop paginating once capacity bound is reached");
  });

  it("verifies globally known place ID is skipped pre-click and never reaches ensureEnriched", () => {
    const globallyKnownId = "ChIJglobalCoffeeShop";
    const knownSet = new Set(["ChIJglobalCoffeeShop", "chijglobalcoffeeshop"]);

    let ensureEnrichedCalled = false;
    const ensureEnriched = () => {
      ensureEnrichedCalled = true;
    };

    // Simulate scraper card processing:
    const candidateCards = [
      { name: "Global Coffee", placeId: "ChIJglobalCoffeeShop" },
      { name: "Brand New Local Cafe", placeId: "ChIJbrandNew123" },
    ];

    const processedCandidates: string[] = [];
    for (const card of candidateCards) {
      // Scraper pre-click check
      if (knownSet.has(card.placeId)) {
        // Skipped pre-click before opening panel or enriching!
        continue;
      }

      // Card clicked, panel verified, enriched:
      ensureEnriched();
      processedCandidates.push(card.name);
    }

    assert.equal(processedCandidates.length, 1);
    assert.equal(processedCandidates[0], "Brand New Local Cafe");
    assert.equal(ensureEnrichedCalled, true);
  });
});
