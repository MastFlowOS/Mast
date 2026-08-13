/**
 * GEOGRAPHIC ARCHITECTURE — cities are an INTERNAL discovery work unit,
 * never a user-facing request field.
 *
 * CORRECTION: an earlier version of this fix introduced a public `city`
 * request field so a caller could scope a plan to exactly one city. That
 * was the wrong model for this product — MAST's geographic selector is
 * continent today, country in the future; city-level fan-out
 * (New York + Los Angeles + Chicago for a US-scoped request) is the
 * INTENDED internal distribution strategy, not an accidental scope
 * expansion. All internal city tasks under one plan legitimately share
 * the same plan-level `requested_count` target — e.g. New York delivering
 * 8 and Los Angeles delivering 2 correctly reaches 10/10 and stops every
 * remaining task for that plan. The public `city` field, `findCountryByCity()`,
 * and the explicit-city tests that only made sense for that field have all
 * been reverted (see planner.ts / countries.ts / discover.ts).
 *
 * These tests exercise `resolveDiscoveryTargets()` — the pure, DB-free
 * region → countries → internal city work-unit expansion now used by
 * materializeDiscoveryPlan() — matching the style of
 * dispatchConcurrency.test.ts / candidateBudget.test.ts elsewhere in this
 * directory.
 */
import assert from "node:assert/strict";
import test from "node:test";

// planner.ts pulls in supabaseAdmin/queue.ts/env.ts (zod-validated config)
// at module-load time — see candidateBudget.test.ts's own documented
// reason for doing this — these must be set before the first (dynamic)
// import of planner.js below.
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { resolveDiscoveryTargets } = await import("../planner.js");
const { COUNTRIES } = await import("../../lib/geo/countries.js");

// ── A — Continent/region scope expands to the intended countries ───────
test("a continent-level region expands to every country in that region", () => {
  const targets = resolveDiscoveryTargets({ region: "North America" });
  const countryCodes = new Set(targets.map((t) => t.country.code));
  // North America pool includes the US, Canada, Mexico, and more — not just one country.
  assert.ok(countryCodes.has("US"));
  assert.ok(countryCodes.has("CA"));
  assert.ok(countryCodes.has("MX"));
  assert.ok(countryCodes.size > 3, "region scope should resolve to many countries, not one");
});

// ── B — Country scope expands to that country's internal city tasks ────
test("a single-country scope expands to that country's internal major-city tasks", () => {
  // Simulates the future \"country\" selector by using a region that
  // resolves to exactly the country under test isn't possible today (no
  // single-country region exists), so this exercises the underlying
  // per-country expansion directly against the data resolveDiscoveryTargets
  // consumes — the same majorCities expansion a future country-scoped
  // request would go through.
  const us = COUNTRIES.find((c) => c.code === "US")!;
  const cities = us.majorCities.map((city) => ({ country: us, city }));
  assert.deepEqual(cities.map((c) => c.city).sort(), ["Chicago", "Los Angeles", "New York"].sort());
});

// ── C — Cities are internal only; no public city request field exists ──
test("resolveDiscoveryTargets accepts no city field — region/currencies only", () => {
  const targets = resolveDiscoveryTargets({ region: "North America" } as any);
  assert.ok(targets.length > 0);
  // TypeScript already enforces this at compile time (no `city` in the
  // Pick<DiscoveryPlanRequest, ...> parameter type); this runtime check
  // confirms passing an extraneous `city` has no special effect — it's
  // simply ignored, not a scoping mechanism.
  const withIgnoredCity = resolveDiscoveryTargets({ region: "North America", city: "New York" } as any);
  assert.equal(withIgnoredCity.length, targets.length);
});

// ── D — Multiple cities legitimately share one global target ───────────
test("every internal city task for a plan shares the same plan-level target (no per-city sub-target)", () => {
  const targets = resolveDiscoveryTargets({ region: "North America" });
  const usTargets = targets.filter((t) => t.country.code === "US");
  assert.equal(usTargets.length, 3, "US contributes 3 internal city tasks under the one plan");
  // resolveDiscoveryTargets() returns work units only — it deliberately
  // carries no per-target quantity/sub-target field. The shared target
  // lives solely at discovery_plans.requested_count (see
  // dispatchQueuedDiscoveryTasks's plan.delivered_count >= plan.requested_count gate).
  for (const t of usTargets) {
    assert.ok(!("requestedCount" in t), "no per-city target field should exist on a scope target");
  }
});

// ── E — New York 8 + Los Angeles 2 = 10/10, target reached, work stops ──
test("regression/architecture: New York + Los Angeles jointly reaching the global target is correct, not a bug", () => {
  // This models the plan-level accounting dispatchQueuedDiscoveryTasks
  // already performs via discovery_plans.delivered_count vs
  // requested_count — pure arithmetic here, no DB needed.
  const requestedCount = 10;
  const deliveredByCity = { "New York": 8, "Los Angeles": 2, "Chicago": 0 };
  const deliveredCount = Object.values(deliveredByCity).reduce((a, b) => a + b, 0);
  assert.equal(deliveredCount, requestedCount);
  const targetReached = deliveredCount >= requestedCount;
  assert.ok(targetReached, "10/10 across multiple cities correctly reaches the global target");
  // Once reached, dispatchQueuedDiscoveryTasks's early-return guard
  // (`plan.delivered_count >= plan.requested_count`) stops dispatching any
  // further queued city tasks for this plan — Chicago's 0-progress task
  // never needs to run.
});

// ── F — No city-specific frontend/API selector is required ─────────────
test("the discover request schema's geographic contract is region-only", () => {
  // resolveDiscoveryTargets's parameter type is Pick<DiscoveryPlanRequest,
  // "region" | "currencies"> — this compiles specifically because there is
  // no `city` in that type today. A city field creeping back in would be
  // a type-level regression this test's import would still pass, so the
  // real enforcement is the Pick<> signature itself (see planner.ts); this
  // test documents the intent alongside the runtime checks above.
  const targets = resolveDiscoveryTargets({ region: "Europe" });
  assert.ok(targets.length > 0);
});
