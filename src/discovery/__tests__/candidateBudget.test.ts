/**
 * Phase 3C-1 STEP 3 — candidate-budget audit + adaptive sizing.
 *
 * Pure-logic tests for computeCandidateBudget()/cityYieldFor(), matching
 * the style of dispatchConcurrency.test.ts / requestLifecycle.test.ts
 * elsewhere in this directory: no Postgres/pg-boss required.
 */
import assert from "node:assert/strict";
import test from "node:test";

// planner.ts pulls in supabaseAdmin/queue.ts/env.ts (zod-validated config)
// at module-load time, same as pythonBridge.lifecycle.test.ts's own
// documented reason for doing this — these must be set before the first
// (dynamic) import of planner.js below.
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const {
  computeCandidateBudget,
  cityYieldFor,
  DEFAULT_CANDIDATE_BUDGET_FLOOR,
  CANDIDATE_BUDGET_MULTIPLIER,
  MIN_YIELD_SAMPLE_SEARCHES,
  HIGH_YIELD_THRESHOLD,
  PRODUCTIVE_CITY_BUDGET_FACTOR,
} = await import("../planner.js");
type LocationStat = { country_code: string; city: string; accepted_count: number; searches: number; last_searched_at: string | null };

test("base budget formula is unchanged for a city with no history", () => {
  assert.equal(computeCandidateBudget(10, undefined), Math.max(20, 40));
  assert.equal(computeCandidateBudget(1, undefined), DEFAULT_CANDIDATE_BUDGET_FLOOR);
  assert.equal(computeCandidateBudget(50, undefined), 50 * CANDIDATE_BUDGET_MULTIPLIER);
});

test("productive city does not unnecessarily consume its full scan budget", () => {
  // Test requirement #2: a reliably-productive city (high yield, enough
  // sample size) gets a smaller, but still floored, raw scan budget.
  const base = Math.max(DEFAULT_CANDIDATE_BUDGET_FLOOR, 20 * CANDIDATE_BUDGET_MULTIPLIER); // 80
  const reduced = computeCandidateBudget(20, 0.9);
  assert.ok(reduced < base, "productive city budget must shrink below the base");
  assert.equal(reduced, Math.round(base * PRODUCTIVE_CITY_BUDGET_FACTOR));
});

test("productive-city reduction never drops below the floor", () => {
  // quantity=1 -> base is already the floor (20); a 0.6x reduction would
  // go below 20 without the floor clamp.
  assert.equal(computeCandidateBudget(1, 0.9), DEFAULT_CANDIDATE_BUDGET_FLOOR);
});

test("poor city still receives the full, unreduced scan budget (fair opportunity)", () => {
  // Test requirement #3.
  const base = Math.max(DEFAULT_CANDIDATE_BUDGET_FLOOR, 10 * CANDIDATE_BUDGET_MULTIPLIER);
  assert.equal(computeCandidateBudget(10, 0.1), base);
  assert.equal(computeCandidateBudget(10, 0), base);
});

test("a city right at the high-yield threshold gets the reduced budget (inclusive)", () => {
  const base = Math.max(DEFAULT_CANDIDATE_BUDGET_FLOOR, 10 * CANDIDATE_BUDGET_MULTIPLIER);
  assert.equal(computeCandidateBudget(10, HIGH_YIELD_THRESHOLD), Math.round(base * PRODUCTIVE_CITY_BUDGET_FACTOR));
});

test("cityYieldFor requires a minimum sample size before trusting a city's yield", () => {
  const stats = new Map<string, LocationStat>([
    ["US:Austin", { country_code: "US", city: "Austin", accepted_count: 5, searches: 5, last_searched_at: null }],
    ["US:Waco", { country_code: "US", city: "Waco", accepted_count: 1, searches: 1, last_searched_at: null }],
  ]);
  assert.equal(cityYieldFor(stats, "US", "Austin"), 1);
  // Below MIN_YIELD_SAMPLE_SEARCHES -> untrusted -> undefined, same as no history.
  assert.equal(cityYieldFor(stats, "US", "Waco"), undefined);
  assert.ok(MIN_YIELD_SAMPLE_SEARCHES > 1);
  assert.equal(cityYieldFor(stats, "US", "Nowhere"), undefined);
});

test("cityYieldFor is exact accepted/searches, not clamped or rounded", () => {
  const stats = new Map<string, LocationStat>([
    ["US:Dallas", { country_code: "US", city: "Dallas", accepted_count: 3, searches: 4, last_searched_at: null }],
  ]);
  assert.equal(cityYieldFor(stats, "US", "Dallas"), 0.75);
});

test("a genuinely exhausted/poor city with real sample size is never starved by the adaptation", () => {
  // Regression guard: the adaptive path must only ever REDUCE a budget for
  // a proven-productive city, never for anything else — a poor city with
  // plenty of history still gets the exact same budget as one with none.
  assert.equal(computeCandidateBudget(15, 0.2), computeCandidateBudget(15, undefined));
});
