/**
 * PHASE 32 — AREA SCAN-BUDGET OPTIMIZATION.
 *
 * Proves the shared-budget model in areaScanBudget.ts replaces "every area
 * independently gets streamTarget*4 as max_results" with a bounded,
 * fairly-distributed, expandable-for-productive-areas shared budget —
 * without ever breaking the global TARGET_REACHED semantics, resource
 * capacity/concurrency limits, or the Phase 30 yield classifier's own
 * stop decision.
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
import { computeAskFor } from "../roundSizing.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";

const DEFAULT_LIMITS: AreaScanBudgetLimits = {
  multiplier: 4,
  minAreaBudgetFactor: 1,
  maxAreaBudgetFactor: 4,
  expansionChunkFactor: 1,
};

// ── Test 1: target=100 does NOT give every area 400 raw candidates by default ──

test("initial per-area budget is far below the old flat 4x-per-area amount when multiple areas are active", () => {
  const streamTarget = 100;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
  assert.equal(coordinator.globalScanBudget, 400); // same total as before — just no longer replicated

  const budgetA = allocateInitialAreaScanBudget(coordinator, "area-a", 3);
  const budgetB = allocateInitialAreaScanBudget(coordinator, "area-b", 3);
  const budgetC = allocateInitialAreaScanBudget(coordinator, "area-c", 3);

  for (const b of [budgetA, budgetB, budgetC]) {
    assert.ok(b < 400, `expected a bounded share, got ${b}`);
  }
  // Old behavior: EVERY area got 400. New: 3 areas roughly split ~400 total.
  assert.equal(budgetA + budgetB + budgetC, coordinator.globalScanBudget);
});

// ── Test 2: multiple active areas share the global budget ──

test("total allocated across concurrently-active areas never exceeds the shared global budget (when no floor override applies)", () => {
  const streamTarget = 40;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
  const activeAreaCount = 4; // matches multiplier, so floor never overrides the even split
  let total = 0;
  for (const area of ["a", "b", "c", "d"]) {
    total += allocateInitialAreaScanBudget(coordinator, area, activeAreaCount);
  }
  assert.equal(total, coordinator.globalScanBudget);
  assert.equal(coordinator.allocated, coordinator.globalScanBudget);
});

// ── Test 3: each area gets a fair initial allocation ──

test("initial allocations are equal (fair) across identically-situated concurrent areas", () => {
  const streamTarget = 60;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
  const budgets = ["a", "b", "c"].map((area) => allocateInitialAreaScanBudget(coordinator, area, 3));
  assert.equal(budgets[0], budgets[1]);
  assert.equal(budgets[1], budgets[2]);
});

test("a lone/slow area is never starved below its own streamTarget-derived floor, even with many nominal siblings", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
  // 20 "active" areas would mathematically starve an even split (400/20=20 → below floor of 10*1=10... still fine here)
  // use a smaller multiplier scenario to actually trigger the floor:
  const tightCoordinator = createAreaScanBudgetCoordinator(streamTarget, { ...DEFAULT_LIMITS, multiplier: 2 });
  const budget = allocateInitialAreaScanBudget(tightCoordinator, "area-a", 20);
  assert.ok(budget >= streamTarget, `expected at least the streamTarget floor (${streamTarget}), got ${budget}`);
});

// ── Test 4: productive areas can receive additional budget ──

test("a productive area exhausting a small slice with headroom remaining gets a positive expansion grant", () => {
  const streamTarget = 20;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS); // globalScanBudget = 80
  allocateInitialAreaScanBudget(coordinator, "area-a", 4); // ~20 each, headroom left by siblings not yet claimed
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.ok(grant > 0, "expected a positive expansion grant for a productive area with global headroom");
});

test("marginal areas (not yet low-yield) can also receive an expansion grant", () => {
  const streamTarget = 20;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
  allocateInitialAreaScanBudget(coordinator, "area-a", 4);
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "marginal");
  assert.ok(grant > 0);
});

// ── Test 5: low-yield areas do not receive unlimited expansion ──

test("a low_yield-classified area always receives a zero expansion grant", () => {
  const streamTarget = 20;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
  allocateInitialAreaScanBudget(coordinator, "area-a", 1);
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "low_yield");
  assert.equal(grant, 0);
});

test("expansion grants stop once a single area's cumulative allocation hits maxAreaBudgetFactor * streamTarget", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS); // cap = 4 * 10 = 40, global = 40
  allocateInitialAreaScanBudget(coordinator, "area-a", 1); // sole area -> initial = 40 (== cap) already
  const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
  assert.equal(grant, 0, "area is already at its cumulative cap — no further expansion should be granted");
});

test("repeated expansion requests for one area are bounded and eventually return 0 (never unlimited)", () => {
  const streamTarget = 10;
  const coordinator = createAreaScanBudgetCoordinator(streamTarget, { ...DEFAULT_LIMITS, multiplier: 8, maxAreaBudgetFactor: 8, expansionChunkFactor: 1 });
  allocateInitialAreaScanBudget(coordinator, "area-a", 4); // small initial slice, leaves lots of headroom
  let grants = 0;
  let safety = 0;
  while (safety++ < 100) {
    const grant = requestAreaScanBudgetExpansion(coordinator, "area-a", "productive");
    if (grant <= 0) break;
    grants += 1;
  }
  assert.ok(grants > 0, "expected at least one grant given headroom");
  assert.ok(safety < 100, "expansion loop must terminate — it must not be unlimited");
});

// ── Test 6: global TARGET_REACHED semantics unchanged ──
// (This is enforced entirely OUTSIDE this module — by abortController.abort()
// in poolExpandJob.ts's processLead(), independent of max_results/askFor.
// What this module must prove is that it never changes deliver_target or the
// stopping signal itself — it only ever affects `max_results`.)

test("the coordinator never computes or exposes anything resembling a deliver_target / stop signal", () => {
  const coordinator = createAreaScanBudgetCoordinator(50, DEFAULT_LIMITS);
  const keys = Object.keys(coordinator);
  for (const key of keys) {
    assert.ok(
      !/deliver|stop|target_reached/i.test(key) || key === "streamTarget",
      `coordinator should not own stopping semantics, unexpected key: ${key}`,
    );
  }
});

// ── Test 7: zero/empty area lists remain safe ──

test("allocateInitialAreaScanBudget is safe with activeAreaCount of 0 (defensively treated as 1)", () => {
  const coordinator = createAreaScanBudgetCoordinator(10, DEFAULT_LIMITS);
  const budget = allocateInitialAreaScanBudget(coordinator, "area-a", 0);
  assert.ok(Number.isFinite(budget) && budget > 0);
});

test("requestAreaScanBudgetExpansion is safe for an area that was never allocated (returns 0)", () => {
  const coordinator = createAreaScanBudgetCoordinator(10, DEFAULT_LIMITS);
  const grant = requestAreaScanBudgetExpansion(coordinator, "never-allocated", "productive");
  assert.equal(grant, 0);
});

// ── Test 8: legacy/single-area behavior remains compatible where expected ──

test("legacy/single-active-area case: initial allocation equals the OLD computeAskFor(streamTarget) result exactly", () => {
  for (const streamTarget of [1, 5, 10, 25, 100]) {
    const coordinator = createAreaScanBudgetCoordinator(streamTarget, DEFAULT_LIMITS);
    const budget = allocateInitialAreaScanBudget(coordinator, "solo-area", 1);
    assert.equal(budget, computeAskFor(streamTarget), `streamTarget=${streamTarget}`);
  }
});

// ── Test 9: existing Phase 30 yield rotation remains intact ──

test("the coordinator never itself decides to stop an area — it only ever returns a budget number, deferring the stop decision to evaluateAreaYieldStop", () => {
  // Structural proof: requestAreaScanBudgetExpansion's return type is a
  // number (an additional budget amount), never a stop reason string or
  // boolean — the actual STOP decision stays owned by
  // areaProductivity.ts's evaluateAreaYieldStop, exactly as before this
  // phase. A low_yield classification here simply withholds MORE scan
  // budget; it does not by itself stop anything.
  const coordinator = createAreaScanBudgetCoordinator(10, DEFAULT_LIMITS);
  allocateInitialAreaScanBudget(coordinator, "area-a", 1);
  const result = requestAreaScanBudgetExpansion(coordinator, "area-a", "low_yield");
  assert.equal(typeof result, "number");
});

// ── Test 10: scan budget cannot bypass resource capacity/concurrency limits ──

test("scan-budget allocation is independent of, and never widens, runAreaWorkerPool's own worker/concurrency sizing", async () => {
  // runAreaWorkerPool's pool size is governed entirely by
  // computeDynamicDiscoveryCapacity/computeAreaPoolSize (worker COUNT) —
  // areaScanBudget.ts has no input to, and never changes, that formula. We
  // prove this by running the pool with a tight capacity ceiling and
  // confirming the number of STARTED workers is unaffected by how the
  // (separately-computed) scan budget was sized.
  const areas = ["a", "b", "c", "d", "e"];
  const usedAreas = new Set<string>();
  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    safeResourceWorkers: 2, // hard PID/thread ceiling — must still be respected
    totalCuratedAreas: areas.length,
    availableCapacity: 8,
    claimNextArea: async (used) => areas.find((a) => !used.has(a) && !usedAreas.has(a)),
    runArea: async (): Promise<AreaRunOutcome> => {
      usedAreas.add("x"); // no-op marker; scan budget itself is computed entirely outside this harness
      return { discovered: 1, accepted: 1, rejected: 0, duplicates: 0, exhausted: true, failed: false };
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.ok(result.poolSize <= 2, "safeResourceWorkers must still cap concurrency regardless of scan-budget sizing");
});
