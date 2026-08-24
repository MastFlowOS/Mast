/**
 * PHASE 34 — RESTORE AREA EXPLORATION RUNWAY.
 * (Building on Phase 32 shared-budget and Phase 30 yield rotation models)
 *
 * Proves that:
 * 1. Small targets (target=10, 3 areas) provide each area with >= exploration floor (50).
 * 2. Large targets (target=100, 3 areas) retain shared allocation without flat 4x duplication.
 * 3. Exploration floor never exceeds per-area hard ceiling.
 * 4. Low-yield area rotates after exploring sufficient candidate volume (50) and time (90s).
 * 5. Productive area can expand from shared headroom.
 * 6. Marginal area remains eligible for continuation and expansion.
 * 7. Global target stops everything (coordinator never decides target stop).
 * 8. Zero/empty areas remain safe.
 * 9. Phase 30/32/34 interaction is deterministic.
 * 10. Worker count / resource capacity is untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeGlobalScanBudget,
  createAreaScanBudgetCoordinator,
  allocateInitialAreaScanBudget,
  requestAreaScanBudgetExpansion,
  type AreaScanBudgetLimits,
} from "../areaScanBudget.js";
import {
  createAreaProductivityState,
  recordProductiveActivity,
  classifyAreaYield,
  evaluateAreaYieldStop,
} from "../areaProductivity.js";
import { computeAskFor } from "../roundSizing.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";

const DEFAULT_LIMITS: AreaScanBudgetLimits = {
  multiplier: 4,
  minAreaBudgetFactor: 1,
  maxAreaBudgetFactor: 4,
  expansionChunkFactor: 1,
  minExplorationCandidates: 50,
};

// ── Test 1: target=10, 3 areas → each area gets >= exploration floor (50) ──

test("1. target=10, 3 areas: each area gets >= exploration floor (50) when headroom allows", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS, 3);
  // Option B: globalScanBudget = max(10 * 4, 3 * 50) = 150
  assert.equal(coordinator.globalScanBudget, 150);

  const budgetA = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  const budgetB = allocateInitialAreaScanBudget(coordinator, "area-b", 3);
  const budgetC = allocateInitialAreaScanBudget(coordinator, "area-c", 3);

  assert.equal(budgetA, 50, "area A receives exploration floor 50");
  assert.equal(budgetB, 50, "area B receives exploration floor 50");
  assert.equal(budgetC, 50, "area C receives exploration floor 50");
  assert.equal(budgetA + budgetB + budgetC, 150);
});

// ── Test 2: target=100, 3 areas → no area gets a flat 4x-target allocation by default ──

test("2. target=100, 3 areas: no area gets flat 4x target by default; areas receive fair share >= exploration floor", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS, 3);
  // globalScanBudget = max(100 * 4, 3 * 50) = 400
  assert.equal(coordinator.globalScanBudget, 400);

  const budgetA = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  const budgetB = allocateInitialAreaScanBudget(coordinator, "area-b", 3);
  const budgetC = allocateInitialAreaScanBudget(coordinator, "area-c", 3);

  for (const b of [budgetA, budgetB, budgetC]) {
    assert.ok(b >= DEFAULT_LIMITS.minExplorationCandidates, `expected at least exploration floor, got ${b}`);
    assert.ok(b < 400, `expected fair share far below flat 400, got ${b}`);
  }
  assert.equal(budgetA + budgetB + budgetC, coordinator.globalScanBudget);
});

// ── Test 3: exploration floor never exceeds per-area hard ceiling ──

test("3. exploration floor never exceeds per-area hard ceiling", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS, 3);
  const budget = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  assert.equal(budget, 50);

  // Cumulative cap is max(floor, streamTarget * maxAreaBudgetFactor) = max(50, 40) = 50
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.equal(grant, 0, "area already at its cap ceiling cannot expand further without additional headroom");
});

// ── Test 4: low-yield area can still rotate after sufficient exploration ──

test("4. low-yield area can still rotate after exploring sufficient candidate volume and elapsed time", () => {
  const state = createAreaProductivityState(0);
  const yieldLimits = {
    minElapsedMsForEvaluation: 90_000,
    minCandidateVolumeForEvaluation: 50,
    lowYieldMaxRate: 0.05,
    marginalMaxRate: 0.15,
  };

  // Stage A: 20 candidates (< 50 floor) at 100s -> still classified productive (cannot rotate yet)
  for (let i = 0; i < 20; i++) recordProductiveActivity(state, "candidate_discovered", 100_000);
  assert.equal(classifyAreaYield(state, 100_000, yieldLimits), "productive");
  assert.equal(evaluateAreaYieldStop(state, 100_000, yieldLimits), null);

  // Stage B: 50 candidates (>= 50 floor) at 100s with 0 qualified -> classified low_yield and stopped
  for (let i = 0; i < 30; i++) recordProductiveActivity(state, "candidate_discovered", 100_000);
  assert.equal(classifyAreaYield(state, 100_000, yieldLimits), "low_yield");
  assert.equal(evaluateAreaYieldStop(state, 100_000, yieldLimits), "area_productivity_low_yield");
});

// ── Test 5: productive area can expand ──

test("5. productive area exhausting its slice with shared headroom remaining gets expansion grant", () => {
  const streamTarget = 50;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS, 4); // global = 200
  allocateInitialAreaScanBudget(coordinator, "area-a", 4); // initial = 50
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.ok(grant > 0, "expected positive expansion grant for productive area");
});

// ── Test 6: marginal area remains eligible for continuation ──

test("6. marginal area remains eligible for continuation and expansion", () => {
  const streamTarget = 50;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS, 4);
  allocateInitialAreaScanBudget(coordinator, "area-a", 4);
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "marginal");
  assert.ok(grant > 0, "marginal area should receive expansion chunk");
});

// ── Test 7: global target still stops everything ──

test("7. coordinator never computes or exposes anything resembling a deliver_target / stop signal", () => {
  const coordinator = createAreaScanBudgetCoordinator(50, DEFAULT_LIMITS);
  const keys = Object.keys(coordinator);
  for (const key of keys) {
    assert.ok(
      !/deliver|stop|target_reached/i.test(key) || key === "streamTarget",
      `coordinator should not own stopping semantics, unexpected key: ${key}`,
    );
  }
});

// ── Test 8: zero/empty area lists remain safe ──

test("8. allocateInitialAreaScanBudget is safe with activeAreaCount of 0 (defensively treated as 1)", () => {
  const coordinator = createAreaScanBudgetCoordinator(10, DEFAULT_LIMITS, 0);
  const budget = allocateInitialAreaScanBudget(coordinator, "area-a", 0);
  assert.ok(Number.isFinite(budget) && budget > 0);
});

test("8b. requestAreaScanBudgetExpansion is safe for an area that was never allocated (returns 0)", () => {
  const coordinator = createAreaScanBudgetCoordinator(10, DEFAULT_LIMITS);
  const grant = requestAreaScanBudgetExpansion(coordinator, "never-allocated", "productive");
  assert.equal(grant, 0);
});

// ── Test 9: Phase 30/32/34 interaction is deterministic ──

test("9. Phase 30/32/34 yield classification interaction with expansion coordinator is deterministic", () => {
  const coordinator = createAreaScanBudgetCoordinator(20, DEFAULT_LIMITS, 2);
  allocateInitialAreaScanBudget(coordinator, "area-a", 2);

  // low_yield always receives 0 expansion
  const lowYieldGrant = requestAreaScanBudgetExpansion(coordinator, "area-a", "low_yield");
  assert.equal(lowYieldGrant, 0);

  // productive receives positive expansion
  const productiveGrant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.ok(productiveGrant > 0);
});

// ── Test 10: worker count / resource capacity is untouched ──

test("10. scan-budget allocation is independent of, and never widens, runAreaWorkerPool's own worker/concurrency sizing", async () => {
  const areas = ["a", "b", "c", "d", "e"];
  const usedAreas = new Set<string>();
  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    safeResourceWorkers: 2, // hard PID/thread ceiling — must still be respected
    totalCuratedAreas: areas.length,
    availableCapacity: 8,
    claimNextArea: async (used) => areas.find((a) => !used.has(a) && !usedAreas.has(a)),
    runArea: async (): Promise<AreaRunOutcome> => {
      usedAreas.add("x");
      return { discovered: 1, accepted: 1, rejected: 0, duplicates: 0, exhausted: true, failed: false };
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.ok(result.poolSize <= 2, "safeResourceWorkers must still cap concurrency regardless of scan-budget sizing");
});

// =============================================================================
// PHASE 36 — SCALABLE DISCOVERY RUNWAY & EXPANSION TESTS
// =============================================================================

const P36_BUDGET_LIMITS: AreaScanBudgetLimits = {
  multiplier: 4,
  minAreaBudgetFactor: 1,
  maxAreaBudgetFactor: 4,
  expansionChunkFactor: 1,
  minExplorationCandidates: 50,
  productiveMaxFactor: 4,
  maxProductiveCandidates: 400,
};

// ── Test 7: productive area expands beyond initial ~133 budget ───────────────
test("P36-7: productive area expands beyond initial ~133 budget up to productive max", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, P36_BUDGET_LIMITS, 3);
  const initial = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  assert.equal(initial, 134, "initial allocation is ~134");

  // Area is productive -> expands beyond 134
  const grant1 = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.equal(grant1, 100, "granted first 100 expansion chunk");
  assert.equal(coordinator.perArea.get("area-a")?.final, 234);

  const grant2 = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.equal(grant2, 100, "granted second 100 expansion chunk");
  assert.equal(coordinator.perArea.get("area-a")?.final, 334);

  const grant3 = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.equal(grant3, 66, "granted remaining chunk to reach 400 ceiling");
  assert.equal(coordinator.perArea.get("area-a")?.final, 400);
});

// ── Test 8: productive area cannot exceed productive max ceiling (400) ──────
test("P36-8: productive area cannot exceed productive max ceiling (400)", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, P36_BUDGET_LIMITS, 3);
  allocateInitialAreaScanBudget(coordinator, "area-a", 3); // 134

  // Exhaust all expansions up to 400
  requestAreaScanBudgetExpansion(coordinator, "area-a", "productive"); // 234
  requestAreaScanBudgetExpansion(coordinator, "area-a", "productive"); // 334
  requestAreaScanBudgetExpansion(coordinator, "area-a", "productive"); // 400

  // Next expansion attempt must be rejected (grant = 0)
  const grantPastCeiling = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.equal(grantPastCeiling, 0, "productive area cannot exceed productive max ceiling");
  assert.equal(coordinator.perArea.get("area-a")?.final, 400);
});

// ── Test 9: low-yield area cannot expand ────────────────────────────────────
test("P36-9: low-yield area receives 0 expansion grant", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, P36_BUDGET_LIMITS, 3);
  allocateInitialAreaScanBudget(coordinator, "area-low-yield", 3); // 134

  const grant = requestAreaScanBudgetExpansion(coordinator, "area-low-yield", "low_yield");
  assert.equal(grant, 0, "low-yield area must receive 0 expansion");
  assert.equal(coordinator.perArea.get("area-low-yield")?.final, 134);
});

// ── Test 10: multiple areas share expansion headroom fairly ─────────────────
test("P36-10: multiple productive areas share expansion headroom fairly", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, P36_BUDGET_LIMITS, 2); // global = 800
  const initA = allocateInitialAreaScanBudget(coordinator, "area-a", 2); // 200
  const initB = allocateInitialAreaScanBudget(coordinator, "area-b", 2); // 200

  assert.equal(initA, 200);
  assert.equal(initB, 200);

  // Both areas expand in turn
  const grantA1 = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  const grantB1 = requestAreaScanBudgetExpansion(coordinator, "area-b", "productive");
  assert.equal(grantA1, 100);
  assert.equal(grantB1, 100);

  const grantA2 = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  const grantB2 = requestAreaScanBudgetExpansion(coordinator, "area-b", "productive");
  assert.equal(grantA2, 100);
  assert.equal(grantB2, 100);

  assert.equal(coordinator.perArea.get("area-a")?.final, 400);
  assert.equal(coordinator.perArea.get("area-b")?.final, 400);
  assert.equal(coordinator.allocated, 800);
});

// ── Test 11: target=10 retains exploration floor 50 ─────────────────────────
test("P36-11: target=10 retains exploration floor 50", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, P36_BUDGET_LIMITS, 3);
  const budgetA = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  const budgetB = allocateInitialAreaScanBudget(coordinator, "area-b", 3);
  const budgetC = allocateInitialAreaScanBudget(coordinator, "area-c", 3);

  assert.equal(budgetA, 50, "area A receives exploration floor 50");
  assert.equal(budgetB, 50, "area B receives exploration floor 50");
  assert.equal(budgetC, 50, "area C receives exploration floor 50");
});

// ── Test 12: target=100 no longer terminally caps productive areas at ~133 ──
test("P36-12: target=100 no longer terminally caps productive areas at ~133", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, P36_BUDGET_LIMITS, 3);
  const initial = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  assert.equal(initial, 134);

  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.ok(grant > 0, "productive area MUST receive expansion beyond initial 134");
  assert.ok(coordinator.perArea.get("area-a")!.final > 134);
});

// ── Test 13: global headroom cannot be exceeded ─────────────────────────────
test("P36-13: global scan budget headroom cannot be exceeded across expansions", () => {
  const streamTarget = 50;
  const limits: AreaScanBudgetLimits = {
    ...P36_BUDGET_LIMITS,
    multiplier: 2, // global = 100 + 100 = 200
  };
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, limits, 2);
  allocateInitialAreaScanBudget(coordinator, "area-a", 2); // 50
  allocateInitialAreaScanBudget(coordinator, "area-b", 2); // 50

  // Expand both
  while (coordinator.allocated < coordinator.globalScanBudget) {
    const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
    if (grant <= 0) break;
  }

  assert.ok(coordinator.allocated <= coordinator.globalScanBudget);
  const excessGrant = requestAreaScanBudgetExpansion(coordinator, "area-b", "productive");
  assert.equal(excessGrant, 0, "no expansion possible once global headroom is exhausted");
});

// ── Test 14: sibling isolation remains unchanged ────────────────────────────
test("P36-14: sibling isolation remains unchanged (coordinators are isolated per city/request)", () => {
  const coordCity1 = createAreaScanBudgetCoordinator(100, P36_BUDGET_LIMITS, 2);
  const coordCity2 = createAreaScanBudgetCoordinator(100, P36_BUDGET_LIMITS, 2);

  allocateInitialAreaScanBudget(coordCity1, "area-1", 2);
  requestAreaScanBudgetExpansion(coordCity1, "area-1", "productive");

  assert.equal(coordCity1.allocated > 0, true);
  assert.equal(coordCity2.allocated, 0, "City 2 coordinator is completely unpolluted by City 1 allocations");
});
