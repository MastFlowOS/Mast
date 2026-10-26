import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildGoogleMapsEngineParams } from "../providers/googleMaps/googleMapsProvider.js";
import { getKnownPlaceIdsForTask } from "../../jobs/discoveryPlanJob.js";
import {
  ensureStreetInventory,
  discoveryModeForStreetInventory,
  streetInventoryFreshCount,
} from "../streetDiscovery.js";
import {
  getCityGeographicContext,
  resolveCitySubdivision,
  resolveCityOsmRelationId,
} from "../../lib/geo/cityMetadata.js";

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
            assert.ok(fields.includes("place_id"));
            return {
              eq: (col1: string, val1: any) => ({
                eq: (col2: string, val2: any) => ({
                  limit: async (limitCount: number) => {
                    assert.equal(limitCount, 500);
                    return {
                      data: [
                        { place_id: "ChIJdirect789", fingerprints: ["place:ChIJabc123", "map:0x123:0x456", "name:some_business"], address: "123 N Michigan Ave, Chicago, IL" },
                        { fingerprints: ["place:ChIJdef456", "place:ChIJabc123"], address: "456 S State St, Chicago, IL" },
                        { fingerprints: null },
                      ],
                      error: null,
                    };
                  },
                }),
              }),
            };
          },
        };
      },
    };

    const ids = await getKnownPlaceIdsForTask(mockDb, "user-1", "US", "Chicago");
    assert.equal(ids.length, 4);
    assert.ok(ids.includes("ChIJdirect789"));
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
              limit: async () => ({
                data: null,
                error: new Error("DB connection timeout"),
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

  test("resolveCitySubdivision and getCityGeographicContext provide authoritative metadata for major cities", () => {
    const chicagoMeta = getCityGeographicContext("US", "Chicago");
    assert.ok(chicagoMeta);
    assert.equal(chicagoMeta.subdivision, "IL");
    assert.equal(chicagoMeta.iso3166_2, "US-IL");
    assert.equal(chicagoMeta.osmRelationId, 122604);
    assert.equal(chicagoMeta.adminLevel, 8);
    assert.equal(resolveCitySubdivision("US", "Chicago"), "IL");
    assert.equal(resolveCityOsmRelationId("US", "Chicago"), 122604);

    const nyMeta = getCityGeographicContext("US", "New York");
    assert.ok(nyMeta);
    assert.equal(nyMeta.subdivision, "NY");
    assert.equal(nyMeta.iso3166_2, "US-NY");
    assert.equal(nyMeta.osmRelationId, 175905);

    const laMeta = getCityGeographicContext("US", "Los Angeles");
    assert.ok(laMeta);
    assert.equal(laMeta.subdivision, "CA");
    assert.equal(laMeta.osmRelationId, 207359);

    const torontoMeta = getCityGeographicContext("CA", "Toronto");
    assert.ok(torontoMeta);
    assert.equal(torontoMeta.subdivision, "ON");
    assert.equal(torontoMeta.osmRelationId, 3235142);

    assert.equal(resolveCitySubdivision("US", "UnknownVille"), undefined);
    assert.equal(resolveCityOsmRelationId("US", "UnknownVille"), undefined);
  });

  test("Discovery plan job passes resolved subdivision and osmRelationId when building Chicago street inventory", async () => {
    let capturedParams: any = null;
    const mockBuildFn = async (params: any) => {
      capturedParams = params;
      return { status: "ok" as const, fetched: 500, upserted: 500, batches: 5 };
    };

    let count = 0;
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                then: (resolve: any) => resolve({ count, error: null }),
              }),
              then: (resolve: any) => resolve({ count, error: null }),
            }),
          }),
        }),
      }),
    };

    const cityContext = getCityGeographicContext("US", "Chicago");
    const outcome = await ensureStreetInventory(
      mockDb as any,
      "US",
      "Chicago",
      {
        countryName: "United States",
        region: cityContext?.subdivision,
        osmRelationId: cityContext?.osmRelationId,
      },
      mockBuildFn,
    );

    assert.ok(capturedParams);
    assert.equal(capturedParams.country_code, "US");
    assert.equal(capturedParams.city, "Chicago");
    assert.equal(capturedParams.region, "IL");
    assert.equal(capturedParams.osm_relation_id, 122604);
  });
});
