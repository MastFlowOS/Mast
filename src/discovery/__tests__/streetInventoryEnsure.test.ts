/**
 * CRITMODE Phase 4 — PART A unit coverage for ensureStreetInventory():
 * the one new production caller onto street_inventory/build.py's real
 * OSM/Overpass pipeline. Uses fakes for both the DB (count-only probe) and
 * the subprocess bridge (injected `buildFn`) — no network, no Supabase, no
 * Python — matching this repo's own precedent (validate_street_inventory.py
 * / build.py's `repository` injection) for testing this exact boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureStreetInventory,
  streetInventoryFreshCount,
  CURRENT_STREET_BOUNDARY_VERSION,
} from "../streetDiscovery.js";

// streetInventoryCount() awaits the chained builder directly (no `.then`
// call syntax) — Supabase's query builder is itself thenable. Reproduce
// that exactly so `await db.from(...).select(...).eq(...).eq(...)` resolves
// through the same fake.
function makeThenableDb(countsByKey: Record<string, number>) {
  const calls: { countryCode?: string; city?: string }[] = [];
  function builder(state: { country_code?: string; city?: string }) {
    return {
      select: () => builder(state),
      eq: (column: string, value: string) => builder({ ...state, [column]: value }),
      then: (resolve: (v: any) => void) => {
        calls.push(state);
        const key = `${state.country_code}:${state.city}`;
        resolve({ count: countsByKey[key] ?? 0, error: null });
      },
    };
  }
  return { calls, client: { from: () => builder({}) } };
}

/**
 * CRITMODE — contaminated New York street inventory follow-up.
 *
 * A richer fake that tracks rows individually (not just a bare count),
 * so it can distinguish `streetInventoryCount()` (any row, any
 * `boundary_version`) from `streetInventoryFreshCount()` (only rows
 * tagged with the current version) — reproducing the exact production
 * shape: a scope can have a large raw row count while having ZERO rows
 * built under the current, boundary-verified logic.
 */
function makeVersionAwareDb(
  rowsByCityKey: Record<string, { boundary_version: string }[]>,
) {
  function builder(state: { country_code?: string; city?: string; boundary_version?: string }) {
    return {
      select: () => builder(state),
      eq: (column: string, value: string) => builder({ ...state, [column]: value }),
      then: (resolve: (v: any) => void) => {
        const key = `${state.country_code}:${state.city}`;
        const rows = rowsByCityKey[key] ?? [];
        const filtered = state.boundary_version
          ? rows.filter((r) => r.boundary_version === state.boundary_version)
          : rows;
        resolve({ count: filtered.length, error: null });
      },
    };
  }
  return { from: () => builder({}) };
}

test("existing inventory (count > 0) short-circuits — never calls the builder", async () => {
  const { client } = makeThenableDb({ "US:Queens": 42 });
  let buildCalls = 0;
  const outcome = await ensureStreetInventory(client, "US", "Queens", undefined, async () => {
    buildCalls += 1;
    return { status: "ok", fetched: 0, upserted: 0, batches: 0 };
  });
  assert.equal(buildCalls, 0, "must not re-fetch/re-upsert inventory that already exists");
  assert.deepEqual(outcome, { mode: "street", count: 42 });
});

test("empty inventory triggers exactly one build call, scoped to the requested city", async () => {
  const { client } = makeThenableDb({}); // 0 rows for every city
  const buildCalls: any[] = [];
  const outcome = await ensureStreetInventory(
    client,
    "US",
    "Queens",
    { countryName: "United States", region: "NY" },
    async (params) => {
      buildCalls.push(params);
      return { status: "ok", fetched: 5, upserted: 5, batches: 1 };
    },
  );
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].country_code, "US");
  assert.equal(buildCalls[0].city, "Queens");
  assert.equal(buildCalls[0].region, "NY");
  // After a successful build, count is empty in this fake (no post-build
  // row was ever inserted into countsByKey) — mirrors a builder that
  // reports success but the recount still legitimately finds 0 rows.
  assert.equal(outcome.mode, "area");
  assert.equal((outcome as any).fallbackReason, "empty_after_build");
});

test("builder status=unavailable falls back to area with the reason surfaced, not silently", async () => {
  const { client } = makeThenableDb({});
  const outcome = await ensureStreetInventory(client, "US", "Nowhereville", undefined, async () => ({
    status: "unavailable",
    reason: "no resolvable OSM area name",
  }));
  assert.equal(outcome.mode, "area");
  assert.match((outcome as any).fallbackReason, /^unavailable:/);
  assert.match((outcome as any).fallbackReason, /no resolvable OSM area name/);
});

test("a builder error is caught and reported as an explicit area fallback, never thrown", async () => {
  const { client } = makeThenableDb({});
  const outcome = await ensureStreetInventory(client, "US", "Queens", undefined, async () => {
    throw new Error("subprocess exited with code 1");
  });
  assert.equal(outcome.mode, "area");
  assert.equal((outcome as any).fallbackReason, "build_error");
});

test("concurrent callers for the SAME city collapse into one build invocation", async () => {
  const { client } = makeThenableDb({});
  let buildCalls = 0;
  let resolveBuild!: (v: any) => void;
  const gate = new Promise((resolve) => {
    resolveBuild = resolve;
  });
  const buildFn = async () => {
    buildCalls += 1;
    return gate as Promise<any>;
  };

  const p1 = ensureStreetInventory(client, "US", "Queens", undefined, buildFn as any);
  const p2 = ensureStreetInventory(client, "US", "Queens", undefined, buildFn as any);
  resolveBuild({ status: "unavailable", reason: "test" });
  await Promise.all([p1, p2]);

  assert.equal(buildCalls, 1, "two concurrent callers for the same city must share one subprocess spawn");
});

// ---------------------------------------------------------------------------
// CRITMODE — contaminated New York street inventory follow-up.
//
// These reproduce the exact production shape at the unit level: a scope
// with a large EXISTING row count that was built entirely under stale/
// pre-fix boundary logic. Before this fix, `ensureStreetInventory()`'s
// bare `count > 0` check would treat that scope as already having usable
// inventory forever, regardless of how the boundary-resolution code
// changed underneath it — exactly how New York's 114,103-row state-wide
// inventory survived the geography fix in overpass_source.py undetected.
// ---------------------------------------------------------------------------

test("stale/unversioned inventory (raw count > 0, fresh count == 0) triggers a real rebuild, not a short-circuit", async () => {
  const db = makeVersionAwareDb({
    "US:New York": Array.from({ length: 114_103 }, () => ({ boundary_version: "unversioned" })),
  });
  let buildCalls = 0;
  const outcome = await ensureStreetInventory(db, "US", "New York", { region: "NY" }, async () => {
    buildCalls += 1;
    return { status: "ok", fetched: 9000, upserted: 9000, batches: 18 };
  });
  assert.equal(
    buildCalls,
    1,
    "a scope whose only existing rows are stale (wrong boundary_version) must still trigger a rebuild",
  );
  // The fake's countsByKey never grows post-build (no row insertion
  // modeled), so the post-build recount is legitimately 0 here — the
  // important assertion is buildCalls, not this outcome shape.
  assert.equal(outcome.mode, "area");
  assert.equal((outcome as any).fallbackReason, "empty_after_build");
});

test("fresh, current-boundary-version inventory short-circuits exactly like the original count>0 check", async () => {
  const db = makeVersionAwareDb({
    "US:New York": Array.from({ length: 42 }, () => ({ boundary_version: CURRENT_STREET_BOUNDARY_VERSION })),
  });
  let buildCalls = 0;
  const outcome = await ensureStreetInventory(db, "US", "New York", undefined, async () => {
    buildCalls += 1;
    return { status: "ok", fetched: 0, upserted: 0, batches: 0 };
  });
  assert.equal(buildCalls, 0, "current-version rows must still short-circuit — no unnecessary rebuild");
  assert.deepEqual(outcome, { mode: "street", count: 42 });
});

test("a mix of stale legacy rows and fresh rows is recognized as already fresh (no rebuild) once ANY current-version rows exist", async () => {
  const db = makeVersionAwareDb({
    "US:New York": [
      ...Array.from({ length: 114_103 }, () => ({ boundary_version: "unversioned" })),
      ...Array.from({ length: 500 }, () => ({ boundary_version: CURRENT_STREET_BOUNDARY_VERSION })),
    ],
  });
  let buildCalls = 0;
  const outcome = await ensureStreetInventory(db, "US", "New York", undefined, async () => {
    buildCalls += 1;
    return { status: "ok", fetched: 0, upserted: 0, batches: 0 };
  });
  assert.equal(buildCalls, 0);
  assert.deepEqual(outcome, { mode: "street", count: 500 }, "count must reflect only the fresh rows, not the stale ones");
});

test("streetInventoryFreshCount defaults to CURRENT_STREET_BOUNDARY_VERSION and ignores stale rows", async () => {
  const db = makeVersionAwareDb({
    "US:Queens": [
      { boundary_version: "unversioned" },
      { boundary_version: "unversioned" },
      { boundary_version: CURRENT_STREET_BOUNDARY_VERSION },
    ],
  });
  const fresh = await streetInventoryFreshCount(db, "US", "Queens");
  assert.equal(fresh, 1);
});

test("a boundary fix bumping the version again correctly re-triggers a rebuild for a scope built under the PREVIOUS current version", async () => {
  // Simulates the very failure mode requirement 10 asks about: a future
  // boundary correction must not be silently absorbed by a scope that
  // is merely non-empty under an OLDER (but not "unversioned") version.
  // These rows are tagged with a version PRIOR to whatever
  // CURRENT_STREET_BOUNDARY_VERSION happens to be today, simulating a
  // scope built by a still-earlier boundary-logic revision.
  const PRIOR_VERSION = `${CURRENT_STREET_BOUNDARY_VERSION}-prior`;
  const db = makeVersionAwareDb({
    "US:New York": Array.from({ length: 9000 }, () => ({ boundary_version: PRIOR_VERSION })),
  });
  let buildCalls = 0;
  const freshUnderCurrent = await streetInventoryFreshCount(db, "US", "New York");
  assert.equal(
    freshUnderCurrent,
    0,
    "rows built under a prior version must not count as fresh under the current one",
  );
  const outcome = await ensureStreetInventory(db, "US", "New York", undefined, async () => {
    buildCalls += 1;
    return { status: "unavailable", reason: "test" };
  });
  // ensureStreetInventory() always checks against
  // CURRENT_STREET_BOUNDARY_VERSION internally — since these rows are
  // tagged with an older version, it must rebuild rather than trust them,
  // exactly the mechanism that prevents this incident from recurring
  // silently on the next boundary correction.
  assert.equal(buildCalls, 1);
  assert.equal(outcome.mode, "area");
});

test("other cities' inventory is never affected by a stale New York scope (cross-city isolation)", async () => {
  const db = makeVersionAwareDb({
    "US:New York": Array.from({ length: 114_103 }, () => ({ boundary_version: "unversioned" })),
    "US:Brooklyn": Array.from({ length: 300 }, () => ({ boundary_version: CURRENT_STREET_BOUNDARY_VERSION })),
  });
  let nyBuildCalls = 0;
  let brooklynBuildCalls = 0;
  const nyOutcome = await ensureStreetInventory(db, "US", "New York", undefined, async () => {
    nyBuildCalls += 1;
    return { status: "unavailable", reason: "test" };
  });
  const brooklynOutcome = await ensureStreetInventory(db, "US", "Brooklyn", undefined, async () => {
    brooklynBuildCalls += 1;
    return { status: "unavailable", reason: "test" };
  });
  assert.equal(nyBuildCalls, 1, "New York's stale inventory must trigger its own rebuild");
  assert.equal(brooklynBuildCalls, 0, "Brooklyn's fresh inventory must be completely unaffected by New York's staleness");
  assert.equal(nyOutcome.mode, "area");
  assert.deepEqual(brooklynOutcome, { mode: "street", count: 300 });
});

test("a DIFFERENT city is never collapsed with an in-flight build for another city (city stickiness)", async () => {
  const { client } = makeThenableDb({});
  const seenCities: string[] = [];
  const outcomeQueens = await ensureStreetInventory(client, "US", "Queens", undefined, async (params) => {
    seenCities.push(params.city);
    return { status: "unavailable", reason: "test" };
  });
  const outcomeBrooklyn = await ensureStreetInventory(client, "US", "Brooklyn", undefined, async (params) => {
    seenCities.push(params.city);
    return { status: "unavailable", reason: "test" };
  });
  assert.deepEqual(seenCities, ["Queens", "Brooklyn"]);
  assert.equal(outcomeQueens.mode, "area");
  assert.equal(outcomeBrooklyn.mode, "area");
});
