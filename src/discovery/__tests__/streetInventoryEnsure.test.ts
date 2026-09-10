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
import { ensureStreetInventory } from "../streetDiscovery.js";

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
