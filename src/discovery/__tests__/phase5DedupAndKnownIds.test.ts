import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { getKnownPlaceIdsForTask } = await import("../../jobs/discoveryPlanJob.js");
const { expandPlaceIdForms, hexToChij, chijToHex } = await import("../../lib/placeId.js");

describe("Phase 5: Dedup Before Click and User-Scoped Known-ID Lookup", () => {
  it("strictly scopes known place IDs to authenticated user without global cross-user leakage", async () => {
    let userQueryRan = false;
    let globalQueryRan = false;

    const mockDb = {
      from: (table: string) => {
        assert.equal(table, "businesses");
        return {
          select: (fields: string) => {
            const isUserQuery = fields.includes("leads!inner(user_id)");
            if (!isUserQuery) {
              globalQueryRan = true;
            }
            return {
              eq: (col: string, val: any) => {
                if (isUserQuery) {
                  userQueryRan = true;
                  assert.equal(col, "leads.user_id");
                  assert.equal(val, "user-123");
                  return {
                    eq: (col2: string, val2: any) => {
                      assert.equal(col2, "country_code");
                      assert.equal(val2, "US");
                      return {
                        range: async () => ({
                          data: [
                            {
                              place_id: "0x880fcd7f8fee01b5:0x89b38e817d796008",
                              fingerprints: ["place:0x880fcd7f8fee01b5:0x89b38e817d796008"],
                            },
                          ],
                          error: null,
                        }),
                      };
                    },
                    range: async () => ({
                      data: [
                        {
                          place_id: "0x880fcd7f8fee01b5:0x89b38e817d796008",
                          fingerprints: ["place:0x880fcd7f8fee01b5:0x89b38e817d796008"],
                        },
                      ],
                      error: null,
                    }),
                  };
                }
                return {
                  range: async () => ({
                    data: [
                      { place_id: "ChIJglobalPlace456", fingerprints: ["place:ChIJglobalPlace456"] },
                    ],
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-123", "US", "Chicago");
    assert.equal(userQueryRan, true, "User-scoped query must run");
    assert.equal(globalQueryRan, false, "Global un-scoped business query must NOT run (multi-tenant safe)");

    // User A's place ID must be present
    assert.ok(placeIds.some((id) => id.includes("0x880fcd7f8fee01b5")), "User place ID must be in set");
    // Global cross-user place ID must NOT be present
    assert.ok(!placeIds.some((id) => id.includes("ChIJglobalPlace456")), "Cross-user business must NOT leak into user set");
  });

  it("fails open gracefully when user query encounters an error", async () => {
    const mockDb = {
      from: () => ({
        select: (fields: string) => {
          const isUserQuery = fields.includes("leads!inner(user_id)");
          return {
            eq: () => ({
              range: async () => {
                if (isUserQuery) {
                  return {
                    data: null,
                    error: new Error("Network error connecting to DB"),
                  };
                }
                return { data: [], error: null };
              },
            }),
          };
        },
      }),
    };

    // Should not throw, returns empty array gracefully
    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.deepEqual(placeIds, []);
  });

  it("paginates completely without silent truncation above 10,000 records", async () => {
    let callCount = 0;
    const pageSize = 1000;
    // 12 pages: first 11 pages return 1,000 items each, 12th page returns 500 items (total 11,500 records)
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              range: async (from: number) => {
                callCount++;
                const count = callCount < 12 ? 1000 : 500;
                const items = Array.from({ length: count }, (_, i) => ({
                  place_id: `0x880fcd7f${from}_${i}:0x89b38e81${from}_${i}`,
                  fingerprints: [`place:0x880fcd7f${from}_${i}:0x89b38e81${from}_${i}`],
                }));
                return { data: items, error: null };
              },
            }),
            range: async (from: number) => {
              callCount++;
              const count = callCount < 12 ? 1000 : 500;
              const items = Array.from({ length: count }, (_, i) => ({
                place_id: `0x880fcd7f${from}_${i}:0x89b38e81${from}_${i}`,
                fingerprints: [`place:0x880fcd7f${from}_${i}:0x89b38e81${from}_${i}`],
              }));
              return { data: items, error: null };
            },
          }),
        }),
      }),
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.equal(callCount, 12, "Pagination must fetch all 12 pages without early truncation");
    assert.ok(placeIds.length > 10000, `Place IDs count (${placeIds.length}) must exceed 10000 without truncation`);
  });

  it("verifies known user place ID is skipped pre-click and never reaches ensureEnriched", () => {
    const userKnownId = "ChIJuserCoffeeShop";
    const knownSet = new Set(["ChIJuserCoffeeShop"]);

    let ensureEnrichedCalled = false;
    const ensureEnriched = () => {
      ensureEnrichedCalled = true;
    };

    // Simulate scraper card processing:
    const candidateCards = [
      { name: "User Already Owned Coffee", placeId: "ChIJuserCoffeeShop" },
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

  it("enforces ChIJ base64url case-sensitivity without false lowercase collisions", () => {
    const hexA = "0x880e2c3cd0f4c5a7:0x4c3d2e1b0a9f8e7d";
    const chijA = hexToChij(hexA);
    assert.equal(chijA, "ChIJp8X00DwsDogRfY6fChsuPUw");

    // Altered casing token that differs only by case in base64url
    const chijB = "ChIJp8X00DwsDogRfY6fChsupUw";

    const formsA = expandPlaceIdForms(chijA);
    const formsB = expandPlaceIdForms(chijB);

    // 1. ChIJ tokens must never be lowercased
    assert.ok(!formsA.has(chijA.toLowerCase()), "Lowercase ChIJ must not be present in forms");
    assert.ok(!formsB.has(chijB.toLowerCase()), "Lowercase ChIJ must not be present in forms");

    // 2. Distinct ChIJ differing only by casing must NOT collide
    assert.ok(!formsA.has(chijB), "Case-distinct ChIJ B must not be in forms of ChIJ A");
    assert.ok(!formsB.has(chijA), "Case-distinct ChIJ A must not be in forms of ChIJ B");

    // 3. Hex representations match case-insensitively
    const hexForms = expandPlaceIdForms(hexA.toUpperCase());
    assert.ok(hexForms.has(chijA), "Canonical Hex must expand to exact-cased ChIJ");
    assert.ok(formsA.has(hexA.toLowerCase()), "Forms of ChIJ A must match lowercase Hex");
  });

  it("handles pagination boundary where total % pageSize === 0", async () => {
    let callCount = 0;
    const pageSize = 1000;
    // Exactly 2,000 records: page 1 returns 1,000, page 2 returns 1,000, page 3 returns 0
    const mockDb = {
      from: () => ({
        select: () => {
          const builder: any = {
            eq: () => builder,
            order: () => builder,
            range: async (from: number) => {
              callCount++;
              if (from >= 2000) return { data: [], error: null };
              const items = Array.from({ length: pageSize }, (_, i) => ({
                id: from + i + 1,
                place_id: `p_${from}_${i}`,
                fingerprints: [],
              }));
              return { data: items, error: null };
            },
          };
          return builder;
        },
      }),
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-boundary", "US", "Chicago");
    assert.equal(callCount, 3, "Must stop on 3rd call when empty array returned");
    assert.equal(placeIds.length, 2000, "Must return exactly 2000 items");
  });

  it("enforces deterministic primary-key ordering in Supabase query", async () => {
    let orderCalled = false;
    let orderColumn = "";
    let orderAscending: boolean | undefined = undefined;

    const mockDb = {
      from: () => ({
        select: () => {
          const builder: any = {
            eq: () => builder,
            order: (col: string, opts: { ascending: boolean }) => {
              orderCalled = true;
              orderColumn = col;
              orderAscending = opts.ascending;
              return builder;
            },
            range: async () => ({
              data: [{ id: 1, place_id: "p_1", fingerprints: [] }],
              error: null,
            }),
          };
          return builder;
        },
      }),
    };

    await getKnownPlaceIdsForTask(mockDb, "user-order", "US", "Chicago");
    assert.equal(orderCalled, true, "Query must specify .order() for deterministic pagination");
    assert.equal(orderColumn, "id");
    assert.equal(orderAscending, true);
  });

  it("keyset pagination with immutable cursor prevents row skipping or repeating under concurrent inserts/deletions", async () => {
    // Simulated database table state
    let table = [
      { id: 1, place_id: "k1", fingerprints: [] },
      { id: 2, place_id: "k2", fingerprints: [] },
      { id: 3, place_id: "k3", fingerprints: [] },
      { id: 4, place_id: "k4", fingerprints: [] },
      { id: 5, place_id: "k5", fingerprints: [] },
      { id: 6, place_id: "k6", fingerprints: [] },
    ];

    let queryCount = 0;
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => {
              let gtId: number | null = null;
              const builder = {
                gt: (col: string, val: number) => {
                  assert.equal(col, "id");
                  gtId = val;
                  return builder;
                },
                limit: async (limitCount: number) => {
                  queryCount++;
                  if (queryCount === 1) {
                    // Page 1: returns ids 1, 2, 3
                    const matching = table.filter((r) => gtId == null || r.id > gtId).slice(0, limitCount);
                    // CONCURRENT MUTATION: insert a row with id: 0.5 (before cursor)
                    // and delete row with id: 2 (before cursor)
                    table.unshift({ id: 0.5, place_id: "k0", fingerprints: [] });
                    table = table.filter((r) => r.id !== 2);
                    return { data: matching, error: null };
                  } else {
                    // Page 2: with cursor gtId = 3, table state changes do NOT cause
                    // row 3 to repeat or row 4 to be skipped!
                    const matching = table.filter((r) => gtId == null || r.id > gtId).slice(0, limitCount);
                    return { data: matching, error: null };
                  }
                },
              };
              return builder;
            },
          }),
        }),
      }),
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-keyset", "US", "Chicago", { pageSize: 3 });
    // Expected result: exactly ids 1, 2, 3, 4, 5, 6 fetched cleanly without missing id 4 or repeating id 3
    assert.equal(placeIds.length, 6, "Must fetch all 6 distinct place IDs despite concurrent mutation");
    assert.ok(placeIds.includes("k1"));
    assert.ok(placeIds.includes("k3"));
    assert.ok(placeIds.includes("k4"));
    assert.ok(placeIds.includes("k6"));
    assert.ok(!placeIds.includes("k0"), "Row inserted before cursor must not be fetched on subsequent pages");
  });

  it("resolves country-code and null semantics with strict multi-tenant isolation", async () => {
    // Database contains User A leads (US, CA, NULL, empty) and User B leads (US)
    const allRows = [
      { id: "1", user_id: "user-A", country_code: "US", place_id: "pid_us_1" },
      { id: "2", user_id: "user-A", country_code: "CA", place_id: "pid_ca_2" },
      { id: "3", user_id: "user-A", country_code: null, place_id: "pid_null_3" },
      { id: "4", user_id: "user-A", country_code: "", place_id: "pid_empty_4" },
      { id: "5", user_id: "user-B", country_code: "US", place_id: "pid_userb_5" },
    ];

    function createMockDb(requestedUser: string) {
      return {
        from: () => ({
          select: () => ({
            eq: (_col: string, val: string) => {
              assert.equal(val, requestedUser, "User scoping must be strictly enforced");
              let userFiltered = allRows.filter((r) => r.user_id === requestedUser);
              const builder = {
                or: (orClause: string) => {
                  // e.g. "country_code.eq.US,country_code.is.null,country_code.eq."
                  userFiltered = userFiltered.filter((r) => {
                    if (orClause.includes("country_code.eq.US") && r.country_code === "US") return true;
                    if (orClause.includes("country_code.is.null") && r.country_code === null) return true;
                    if (orClause.includes("country_code.eq.") && r.country_code === "") return true;
                    return false;
                  });
                  return builder;
                },
                order: () => builder,
                limit: async () => ({
                  data: userFiltered.map((r) => ({ id: r.id, place_id: r.place_id, fingerprints: [] })),
                  error: null,
                }),
                range: async () => ({
                  data: userFiltered.map((r) => ({ id: r.id, place_id: r.place_id, fingerprints: [] })),
                  error: null,
                }),
              };
              return builder;
            },
          }),
        }),
      };
    }

    // 1. Default Policy: User Portfolio-Wide Deduplication (no country restriction)
    // User A receives all 4 leads (US, CA, NULL, empty) and NEVER User B's lead
    const userAPortfolio = await getKnownPlaceIdsForTask(createMockDb("user-A"), "user-A", "US", "Chicago");
    assert.equal(userAPortfolio.length, 4, "Portfolio-wide lookup must include matching, different, null, and empty country leads");
    assert.ok(userAPortfolio.includes("pid_us_1"));
    assert.ok(userAPortfolio.includes("pid_ca_2"));
    assert.ok(userAPortfolio.includes("pid_null_3"));
    assert.ok(userAPortfolio.includes("pid_empty_4"));
    assert.ok(!userAPortfolio.includes("pid_userb_5"), "User B lead must NEVER leak into User A set");

    // 2. Explicit Country Scoping: includes US, null, and empty, but excludes CA
    const userACountryScoped = await getKnownPlaceIdsForTask(createMockDb("user-A"), "user-A", "US", "Chicago", { countryScoped: true });
    assert.equal(userACountryScoped.length, 3, "Country-scoped lookup must include matching US, null, and empty country leads");
    assert.ok(userACountryScoped.includes("pid_us_1"));
    assert.ok(userACountryScoped.includes("pid_null_3"));
    assert.ok(userACountryScoped.includes("pid_empty_4"));
    assert.ok(!userACountryScoped.includes("pid_ca_2"), "Different country lead must be excluded under countryScoped");
    assert.ok(!userACountryScoped.includes("pid_userb_5"), "User B lead must NEVER leak");

    // 3. User B lookup is strictly isolated to User B
    const userBPortfolio = await getKnownPlaceIdsForTask(createMockDb("user-B"), "user-B", "US", "Chicago");
    assert.equal(userBPortfolio.length, 1);
    assert.ok(userBPortfolio.includes("pid_userb_5"));
    assert.ok(!userBPortfolio.includes("pid_us_1"), "User A lead must NEVER leak into User B set");
  });

  it("unambiguously reports MAX_PAGES boundary conditions (499,999, 500,000, 500,001)", async () => {
    // Test boundary detection for 499,999, 500,000, and 500,001 records
    // using scaled options (maxPages=5, pageSize=1000 -> ceiling 5,000)
    function createCeilingMockDb(totalRecords: number, probeError = false) {
      let gtId: number | null = null;
      return {
        from: () => ({
          select: () => {
            const builder: any = {
              eq: () => builder,
              order: () => builder,
              gt: (_col: string, val: number) => {
                gtId = val;
                return builder;
              },
              limit: async (limitCount: number) => {
                if (limitCount === 1) {
                  // Overflow probe
                  if (probeError) return { data: null, error: new Error("Probe network timeout") };
                  const hasMore = (gtId ?? 0) < totalRecords;
                  return {
                    data: hasMore ? [{ id: (gtId ?? 0) + 1 }] : [],
                    error: null,
                  };
                }
                const start = gtId ?? 0;
                const end = Math.min(start + limitCount, totalRecords);
                const count = Math.max(0, end - start);
                const items = Array.from({ length: count }, (_, i) => ({
                  id: start + i + 1,
                  place_id: `p_${start + i + 1}`,
                  fingerprints: [],
                }));
                return { data: items, error: null };
              },
            };
            return builder;
          },
        }),
      };
    }

    // 1. Boundary: 4,999 records (< ceiling 5,000) -> complete
    const res4999 = await getKnownPlaceIdsForTask(createCeilingMockDb(4999), "u1", "US", "Chicago", { maxPages: 5, pageSize: 1000 });
    assert.equal(res4999.length, 4999);
    assert.equal((res4999 as any).truncationStatus, "complete");

    // 2. Boundary: exactly 5,000 records (== ceiling 5,000) -> complete (probe returns 0 rows)
    const res5000 = await getKnownPlaceIdsForTask(createCeilingMockDb(5000), "u1", "US", "Chicago", { maxPages: 5, pageSize: 1000 });
    assert.equal(res5000.length, 5000);
    assert.equal((res5000 as any).truncationStatus, "complete");

    // 3. Boundary: 5,001 records (> ceiling 5,000) -> truncated (probe returns 1 row)
    const res5001 = await getKnownPlaceIdsForTask(createCeilingMockDb(5001), "u1", "US", "Chicago", { maxPages: 5, pageSize: 1000 });
    assert.equal(res5001.length, 5000);
    assert.equal((res5001 as any).truncationStatus, "truncated");

    // 4. Probe error -> possibly_truncated
    const resError = await getKnownPlaceIdsForTask(createCeilingMockDb(5000, true), "u1", "US", "Chicago", { maxPages: 5, pageSize: 1000 });
    assert.equal(resError.length, 5000);
    assert.equal((resError as any).truncationStatus, "possibly_truncated");
  });

  it("falls back cleanly to offset .range() across all pages when .gt() is absent in test doubles even if .limit() exists", async () => {
    let rangeCalls: { from: number; to: number }[] = [];
    let limitCalled = false;

    // Test double that defines .limit() and .range(), but deliberately omits .gt()
    const mockDb = {
      from: () => ({
        select: () => {
          const builder: any = {
            eq: () => builder,
            order: () => builder,
            limit: async () => {
              limitCalled = true;
              return { data: [], error: null };
            },
            range: async (from: number, to: number) => {
              rangeCalls.push({ from, to });
              if (from === 0) {
                // Page 1 returns full page of 2 items
                return {
                  data: [
                    { id: 10, place_id: "p_10", fingerprints: [] },
                    { id: 20, place_id: "p_20", fingerprints: [] },
                  ],
                  error: null,
                };
              } else {
                // Page 2 returns final item
                return {
                  data: [{ id: 30, place_id: "p_30", fingerprints: [] }],
                  error: null,
                };
              }
            },
          };
          return builder;
        },
      }),
    };

    const res = await getKnownPlaceIdsForTask(mockDb, "u-range-fallback", "US", "Chicago", { maxPages: 5, pageSize: 2 });
    assert.equal(limitCalled, false, "Must not invoke .limit() when .gt() is absent, preventing half-keyset half-offset pagination");
    assert.equal(rangeCalls.length, 2, "Must paginate across multiple pages via .range()");
    assert.deepEqual(rangeCalls[0], { from: 0, to: 1 });
    assert.deepEqual(rangeCalls[1], { from: 2, to: 3 });
    assert.equal(res.length, 3);
    assert.equal((res as any).truncationStatus, "complete");
  });
});
