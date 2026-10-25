import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildGoogleMapsEngineParams } from "../providers/googleMaps/googleMapsProvider.js";
import { getKnownPlaceIdsForTask } from "../../jobs/discoveryPlanJob.js";
import {
  ensureStreetInventory,
  discoveryModeForStreetInventory,
  streetInventoryFreshCount,
} from "../streetDiscovery.js";

describe("Discovery Plan Job & Google Maps Pre-Click Integration", () => {
  test("buildGoogleMapsEngineParams maps knownPlaceIds to known_place_ids only when non-empty", () => {
    const query = { queryString: "dentist Chicago", niche: "dentist" };
    const target = { city: "Chicago", countryCode: "US", niche: "dentist" };

    // With knownPlaceIds
    const paramsWithKnown = buildGoogleMapsEngineParams(query, target, {
      maxResults: 10,
      knownPlaceIds: ["ChIJ12345", "0x880e2c3cd0f4c5f1:0x39659b8a1c89078f"],
    });
    assert.deepEqual(paramsWithKnown.known_place_ids, [
      "ChIJ12345",
      "0x880e2c3cd0f4c5f1:0x39659b8a1c89078f",
    ]);

    // Without knownPlaceIds (undefined or empty)
    const paramsWithout = buildGoogleMapsEngineParams(query, target, {
      maxResults: 10,
    });
    assert.equal(paramsWithout.known_place_ids, undefined);

    const paramsEmpty = buildGoogleMapsEngineParams(query, target, {
      maxResults: 10,
      knownPlaceIds: [],
    });
    assert.equal(paramsEmpty.known_place_ids, undefined);
  });

  test("getKnownPlaceIdsForTask returns empty array if userId is undefined", async () => {
    const result = await getKnownPlaceIdsForTask({} as any, undefined, "US", "Chicago");
    assert.deepEqual(result, []);
  });

  test("getKnownPlaceIdsForTask parses place: and map: fingerprints and deduplicates them", async () => {
    const mockDb = {
      from: (table: string) => {
        assert.equal(table, "businesses");
        return {
          select: (fields: string) => {
            assert.ok(fields.includes("fingerprints"));
            return {
              eq: (col1: string, val1: any) => ({
                eq: (col2: string, val2: any) => ({
                  eq: (col3: string, val3: any) => ({
                    limit: async (limitCount: number) => {
                      assert.equal(limitCount, 500);
                      return {
                        data: [
                          { fingerprints: ["place:ChIJabc123", "map:0x123:0x456", "name:some_business"] },
                          { fingerprints: ["place:ChIJdef456", "place:ChIJabc123"] },
                          { fingerprints: null },
                        ],
                        error: null,
                      };
                    },
                  }),
                }),
              }),
            };
          },
        };
      },
    };

    const ids = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.equal(ids.length, 3);
    assert.ok(ids.includes("ChIJabc123"));
    assert.ok(ids.includes("0x123:0x456"));
    assert.ok(ids.includes("ChIJdef456"));
  });

  test("getKnownPlaceIdsForTask fails open on DB error", async () => {
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({
                  data: null,
                  error: new Error("DB connection timeout"),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const ids = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.deepEqual(ids, []);
  });

  test("Zero street inventory triggers inventory builder before mode decision and selects street mode if populated", async () => {
    let freshCount = 0;
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: (col: string, val: any) => {
            return {
              eq: (col2: string, val2: any) => {
                return {
                  eq: (col3: string, val3: any) => ({
                    then: (resolve: any) => resolve({ count: freshCount, error: null }),
                  }),
                  then: (resolve: any) => resolve({ count: freshCount, error: null }),
                };
              },
            };
          },
        }),
      }),
    };

    let buildCalled = false;
    const mockBuildFn = async (params: { country_code: string; city: string }) => {
      buildCalled = true;
      assert.equal(params.city, "ChicagoMock");
      assert.equal(params.country_code, "US");
      freshCount = 150; // Populated by builder
      return { status: "ok" as const, fetched: 150, upserted: 150 };
    };

    // Simulate discoveryPlanJob mode decision logic
    let streetCount = await streetInventoryFreshCount(mockDb as any, "US", "ChicagoMock");
    assert.equal(streetCount, 0);

    let fallbackReason = "none";
    if (streetCount === 0) {
      const initResult = await ensureStreetInventory(mockDb as any, "US", "ChicagoMock", undefined, mockBuildFn);
      if (initResult.mode === "street") {
        streetCount = initResult.count;
        fallbackReason = "none";
      } else {
        streetCount = initResult.count;
        fallbackReason = initResult.fallbackReason;
      }
    }

    const useStreetPool = discoveryModeForStreetInventory("google_maps", streetCount) === "street";
    if (!useStreetPool && fallbackReason === "none") fallbackReason = "zero_inventory";

    assert.ok(buildCalled, "ensureStreetInventory should have been called");
    assert.equal(streetCount, 150);
    assert.equal(useStreetPool, true);
    assert.equal(fallbackReason, "none");
  });

  test("Zero street inventory with failed/unavailable builder explicitly falls back to area with reason", async () => {
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                then: (resolve: any) => resolve({ count: 0, error: null }),
              }),
              then: (resolve: any) => resolve({ count: 0, error: null }),
            }),
          }),
        }),
      }),
    };

    const mockBuildFn = async () => {
      return { status: "unavailable" as const, reason: "osm_overpass_timeout" };
    };

    let streetCount = await streetInventoryFreshCount(mockDb as any, "US", "SmallTownMock");
    assert.equal(streetCount, 0);

    let fallbackReason = "none";
    if (streetCount === 0) {
      const initResult = await ensureStreetInventory(mockDb as any, "US", "SmallTownMock", undefined, mockBuildFn);
      if (initResult.mode === "street") {
        streetCount = initResult.count;
        fallbackReason = "none";
      } else {
        streetCount = initResult.count;
        fallbackReason = initResult.fallbackReason;
      }
    }

    const useStreetPool = discoveryModeForStreetInventory("google_maps", streetCount) === "street";
    if (!useStreetPool && fallbackReason === "none") fallbackReason = "zero_inventory";

    assert.equal(streetCount, 0);
    assert.equal(useStreetPool, false);
    assert.equal(fallbackReason, "unavailable:osm_overpass_timeout");
  });
});
