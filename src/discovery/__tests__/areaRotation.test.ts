/**
 * Phase 3C-4C-B — geographic search rotation.
 *
 * Pure-logic tests for selectAreaFromStats()/hasCuratedAreas(), matching
 * the style of candidateBudget.test.ts / dispatchConcurrency.test.ts
 * elsewhere in this directory: no Postgres/pg-boss required. Also covers
 * the query-construction change in googleMapsSearchGenerator.ts (Test H)
 * and the small-city fallback (Test G), since both are pure/DB-free too.
 *
 * Covers test plan items A, B, C, D, G, H from the phase prompt. Items E
 * (persistence across a fresh connection) and F (concurrent DB claim)
 * require a real Postgres instance and live in
 * areaRotation.integration.test.ts instead — see that file's own header
 * for why they can't be simulated here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { selectAreaFromStats, hasCuratedAreas, DEFAULT_AREA_COOLDOWN_MS, type AreaStat } from "../areaRotation.js";
import { GoogleMapsSearchGenerator } from "../providers/googleMaps/googleMapsSearchGenerator.js";
import { getAreasForCity } from "../../lib/geo/cityAreas.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function statsMap(entries: Record<string, string | null>): Map<string, AreaStat> {
  return new Map(Object.entries(entries).map(([area, last_searched_at]) => [area, { last_searched_at }]));
}

// ── A: repeated selections choose different eligible areas ────────────────
test("A: repeated selection spreads across never-searched areas before repeating any", () => {
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const seen = new Set<string>();
  let stats = statsMap({});
  for (let i = 0; i < areas.length; i++) {
    const chosen = selectAreaFromStats(areas, stats, NOW);
    assert.ok(!seen.has(chosen), `area "${chosen}" was chosen twice before every area was covered once`);
    seen.add(chosen);
    stats = new Map(stats);
    stats.set(chosen, { last_searched_at: new Date(NOW).toISOString() });
  }
  assert.deepEqual(seen, new Set(areas));
});

// ── B: never-searched preferred over recently searched ─────────────────────
test("B: a never-searched area is preferred over one searched moments ago", () => {
  const areas = ["Brooklyn", "Queens"];
  const stats = statsMap({ Brooklyn: new Date(NOW - 5 * 60 * 1000).toISOString() }); // 5 min ago
  // Queens has no entry at all — never searched.
  assert.equal(selectAreaFromStats(areas, stats, NOW), "Queens");
});

// ── C: cooldown excludes recently searched areas ────────────────────────────
test("C: an area inside the cooldown window is excluded in favor of an eligible one", () => {
  const areas = ["Brooklyn", "Queens"];
  const stats = statsMap({
    Brooklyn: new Date(NOW - 1 * HOUR).toISOString(), // inside a 6h cooldown
    Queens: new Date(NOW - 7 * HOUR).toISOString(), // outside a 6h cooldown
  });
  assert.equal(selectAreaFromStats(areas, stats, NOW, DEFAULT_AREA_COOLDOWN_MS), "Queens");
});

// ── D: fallback when every area is inside cooldown ──────────────────────────
test("D: when every area is inside cooldown, the least-recently-searched one is still returned (no stall)", () => {
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const stats = statsMap({
    Brooklyn: new Date(NOW - 1 * HOUR).toISOString(),
    Queens: new Date(NOW - 3 * HOUR).toISOString(), // oldest of the three, but still < 6h cooldown
    Manhattan: new Date(NOW - 2 * HOUR).toISOString(),
  });
  const chosen = selectAreaFromStats(areas, stats, NOW, DEFAULT_AREA_COOLDOWN_MS);
  assert.equal(chosen, "Queens");
});

test("D: fallback never throws and always returns one of the provided areas", () => {
  const areas = ["A", "B", "C"];
  const stats = statsMap({ A: new Date(NOW).toISOString(), B: new Date(NOW).toISOString(), C: new Date(NOW).toISOString() });
  const chosen = selectAreaFromStats(areas, stats, NOW, DEFAULT_AREA_COOLDOWN_MS);
  assert.ok(areas.includes(chosen));
});

test("selectAreaFromStats throws on an empty area list rather than silently returning undefined", () => {
  assert.throws(() => selectAreaFromStats([], new Map(), NOW));
});

// ── G: small-city fallback (no curated areas) ───────────────────────────────
test("G: a city with no curated area list is correctly reported as not participating in rotation", () => {
  assert.equal(hasCuratedAreas(getAreasForCity("US", "Topeka")), false);
  assert.equal(hasCuratedAreas(undefined), false);
  assert.equal(hasCuratedAreas([]), false);
});

test("G: a curated city IS reported as participating", () => {
  const areas = getAreasForCity("US", "New York");
  assert.ok(hasCuratedAreas(areas));
  assert.ok(areas!.length >= 3);
});

// ── H: query construction ───────────────────────────────────────────────────
test("H: the chosen area appears correctly in the Maps search query", () => {
  const generator = new GoogleMapsSearchGenerator();
  const [query] = generator.generate({
    niche: "Coffee Shop",
    city: "New York",
    countryCode: "US",
    region: "North America",
    area: "Brooklyn",
  });
  assert.equal(query.queryString, "Coffee Shop in Brooklyn, New York");
});

test("H: a city with no claimed area produces the exact same query as before this phase", () => {
  const generator = new GoogleMapsSearchGenerator();
  const [query] = generator.generate({
    niche: "Coffee Shop",
    city: "New York",
    countryCode: "US",
    region: "North America",
  });
  assert.equal(query.queryString, "Coffee Shop New York");
});
