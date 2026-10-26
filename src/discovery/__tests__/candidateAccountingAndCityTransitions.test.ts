import test from "node:test";
import assert from "node:assert/strict";
import { cityTransitionFor, reconcileDiscoveryCounters } from "../cityScheduling.js";
import { isAddressOnStreet, isLowValueStreet } from "../streetClassifier.js";
import { buildGoogleMapsEngineParams } from "../providers/googleMaps/googleMapsProvider.js";

test("Priority 1: reconcileDiscoveryCounters correctly accounts for every candidate bucket", () => {
  // Case 1: 22 candidates discovered, 0 accepted, 22 outside street scope => valid accounting, 0 discrepancy
  const r1 = reconcileDiscoveryCounters({
    stalePanelMismatches: 0,
    verifiedCandidatesYielded: 22,
    accepted: 0,
    duplicates: 0,
    rejectedByChannelOrQuality: 22,
    failed: 0,
    skipped: 0,
  });
  assert.equal(r1.valid, true);
  assert.equal(r1.discrepancy, 0);
  assert.equal(r1.discovered, 22);
  assert.equal(r1.accounted, 22);

  // Case 2: Mixed outcomes with failed and skipped (e.g. 5 accepted, 3 duplicates, 4 rejected, 2 failed, 1 skipped)
  const r2 = reconcileDiscoveryCounters({
    stalePanelMismatches: 2,
    verifiedCandidatesYielded: 15,
    accepted: 5,
    duplicates: 3,
    rejectedByChannelOrQuality: 4,
    failed: 2,
    skipped: 1,
  });
  assert.equal(r2.valid, true);
  assert.equal(r2.discrepancy, 0);
  assert.equal(r2.discovered, 15);
  assert.equal(r2.accounted, 15);
  assert.equal(r2.stalePanelMismatchesExcluded, true);

  // Case 3: Missing count (unaccounted candidate) => invalid
  const r3 = reconcileDiscoveryCounters({
    stalePanelMismatches: 0,
    verifiedCandidatesYielded: 10,
    accepted: 4,
    duplicates: 2,
    rejectedByChannelOrQuality: 2,
  });
  assert.equal(r3.valid, false);
  assert.equal(r3.discrepancy, 2);
});

test("Priority 2: cityTransitionFor maps RETURN_TO_RESULTS_FAILED to SCRAPER_FAILURE", () => {
  assert.equal(
    cityTransitionFor({ candidatesFound: 5, acceptedLeads: 0 }, false, "RETURN_TO_RESULTS_FAILED"),
    "SCRAPER_FAILURE",
  );
  assert.equal(
    cityTransitionFor({ candidatesFound: 0, acceptedLeads: 0 }, false, "RETURN_TO_RESULTS_FAILED"),
    "SCRAPER_FAILURE",
  );
  assert.equal(
    cityTransitionFor({ candidatesFound: 0, acceptedLeads: 0 }, true, "RETURN_TO_RESULTS_FAILED"),
    "SCRAPER_FAILURE",
  );
  assert.equal(
    cityTransitionFor({ candidatesFound: 1, acceptedLeads: 1 }, false, "RETURN_TO_RESULTS_FAILED"),
    "CITY_PRODUCTIVE",
  );
});

test("Priority 4: buildGoogleMapsEngineParams sets street and street_mode=true in street mode", () => {
  const streetParams = buildGoogleMapsEngineParams(
    { query: "hvac in Chicago", niche: "hvac" },
    { niche: "hvac", city: "Chicago", street: "Michigan Ave" },
    { maxResults: 30, discoveryOnly: true },
  );
  assert.equal(streetParams.street, "Michigan Ave");
  assert.equal(streetParams.street_mode, true);

  const areaParams = buildGoogleMapsEngineParams(
    { query: "hvac in Chicago", niche: "hvac" },
    { niche: "hvac", city: "Chicago", area: "Loop" },
    { maxResults: 30, discoveryOnly: true },
  );
  assert.equal(streetParams.street, "Michigan Ave");
  assert.equal(areaParams.street, undefined);
  assert.equal(areaParams.street_mode, undefined);
});

test("Priority 5: isLowValueStreet catches airport lanes, dropoffs, service roads", () => {
  assert.equal(isLowValueStreet("Bus Dropoff Lane 4").isLowValue, true);
  assert.equal(isLowValueStreet("Terminal 2 Bus Dropoff").isLowValue, true);
  assert.equal(isLowValueStreet("Airport Service Road").isLowValue, true);
  assert.equal(isLowValueStreet("35th Street Access Path").isLowValue, true);
  assert.equal(isLowValueStreet("South Michigan Avenue").isLowValue, false);
});
