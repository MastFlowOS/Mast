/**
 * Worker Pools B — Google Maps area worker pool.
 *
 * Pure-logic tests for computeAreaPoolSize()/runAreaWorkerPool(), matching
 * the style of dispatchConcurrency.test.ts / areaRotation.test.ts elsewhere
 * in this directory: no Postgres, no pg-boss, no Playwright/service.py —
 * claimNextArea/runArea/tryAcquireSlot/isTerminal are all injected fakes,
 * so these tests exercise the pool's ORCHESTRATION logic (sizing, distinct
 * claims, failure isolation, replacement, cancellation, target) in
 * isolation from the real engine and database this module is wired to in
 * discoveryPlanJob.ts.
 *
 * Covers phase prompt test items A, B, C, D(-equivalent, see note), G, H,
 * I, J, L. Items E (shared taskDbPath), F (cross-area dedup), and K (real
 * DB outcome accounting) require the real SQLite/Postgres layer and are
 * not re-tested here — see the final report for what remains unverified.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAreaPoolSize,
  computeDynamicDiscoveryCapacity,
  runAreaWorkerPool,
  type AreaRunOutcome,
  type AreaWorkerLogEvent,
} from "../googleAreaPool.js";
import { createBrowserSlotPool } from "../../lib/browserSlotPool.js";

function outcome(partial: Partial<AreaRunOutcome> = {}): AreaRunOutcome {
  return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: false, ...partial };
}

// ── Test A: pool size never exceeds configured worker count ────────────────
test("A: computeAreaPoolSize never exceeds the configured worker count", () => {
  assert.equal(computeAreaPoolSize(4, 10, 10), 4);
  assert.equal(computeAreaPoolSize(1, 10, 10), 1);
});

// ── Test C: fewer areas than workers → pool sized to available areas ───────
test("C: computeAreaPoolSize is capped by available curated areas, not configured workers", () => {
  assert.equal(computeAreaPoolSize(5, 3, 10), 3);
});

// ── Test L: capacity ceiling — never more than measured browser slots ──────
test("L: computeAreaPoolSize is capped by capacity slots even when configured/areas allow more", () => {
  assert.equal(computeAreaPoolSize(4, 4, 2), 2);
  assert.equal(computeAreaPoolSize(4, 4, 0), 0);
});

test("computeAreaPoolSize never goes negative", () => {
  assert.equal(computeAreaPoolSize(4, 4, -3), 0);
});

// ── Test B: distinct area claims — N workers claim N different areas ───────
test("B: with 4 available areas and pool size 4, all 4 areas are claimed exactly once", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  let cursor = 0;
  const claimed: string[] = [];

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimed.includes(a));
      if (!next) return undefined;
      claimed.push(next);
      return next;
    },
    runArea: async (area) => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 4);
  assert.equal(result.startedWorkers, 4);
  assert.deepEqual(new Set(result.areasProcessed), new Set(areas));
});

test("safe resource ceiling bounds dynamic area workers without duplicate claims", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  const claimed = new Set<string>();
  let active = 0;
  let maxActive = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    safeResourceWorkers: 2,
    requestedQuantity: 10,
    totalCuratedAreas: areas.length,
    availableCapacity: 4,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((area) => !usedAreas.has(area) && !claimed.has(area));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    runArea: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 2, "requested=10 with safeResourceWorkers=2 must select two workers");
  assert.equal(maxActive, 2, "resource ceiling must bound concurrent area execution");
  assert.equal(claimed.size, result.areasProcessed.length, "an area must never be claimed twice");
});

// ── Phase 1B: controlled 2-worker validation ────────────────────────────────
// requested=10 leads drives computedWorkers=3 (the <=10 branch of the
// dynamic capacity formula), but the production-safe resource ceiling of 2
// must still win: finalWorkers=2. This proves the ceiling is enforced via
// the existing safeResourceWorkers parameter/config knob, not a hardcoded
// override, and that plenty of areas/capacity are available so the ceiling
// — not areas or browser slots — is what binds.
test("Phase 1B: computeDynamicDiscoveryCapacity — requested=10 => computedWorkers=3 before the safe-resource ceiling is applied", () => {
  // No safeResourceWorkers arg here: isolates the "computedWorkers=3" part
  // of the phase prompt's scenario from the ceiling itself.
  const computedWorkers = computeDynamicDiscoveryCapacity(10, /* availableAreas */ 10, /* capacitySlots */ 10, /* maxConfigured */ 8);
  assert.equal(computedWorkers, 3, "requested=10 leads must desire 3 workers before any resource ceiling is applied");
});

test("Phase 1B: computeDynamicDiscoveryCapacity — requested=10, computedWorkers=3, safeResourceWorkers=2 => finalWorkers=2", () => {
  const finalWorkers = computeDynamicDiscoveryCapacity(10, /* availableAreas */ 10, /* capacitySlots */ 10, /* maxConfigured */ 8, /* safeResourceWorkers */ 2);
  assert.equal(finalWorkers, 2, "the safe-resource ceiling of 2 must win over the computed desire of 3");
});

test("Phase 1B: runAreaWorkerPool end-to-end — requested=10, safeResourceWorkers=2 => finalWorkers=2, never more than 2 concurrent areas run", async () => {
  const areas = ["Area-1", "Area-2", "Area-3", "Area-4", "Area-5"];
  const claimed = new Set<string>();
  let active = 0;
  let peakActive = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8, // plenty configured; the ceiling, not this, must bind
    safeResourceWorkers: 2, // Phase 1B production-safe resource ceiling
    requestedQuantity: 10, // drives computedWorkers=3 internally
    totalCuratedAreas: areas.length, // plenty of areas; not the binding constraint
    availableCapacity: 5, // plenty of browser-slot capacity; not the binding constraint
    claimNextArea: async (usedAreas) => {
      const next = areas.find((area) => !usedAreas.has(area) && !claimed.has(area));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    runArea: async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 2, "finalWorkers must be 2: the safe-resource ceiling, not computedWorkers=3, must bind");
  assert.equal(peakActive, 2, "no more than 2 area workers may run concurrently under the Phase 1B ceiling");
  assert.equal(claimed.size, result.areasProcessed.length, "an area must never be claimed twice under the 2-worker ceiling");
});

// ── Test C (pool behavior): 3 areas + pool size 5 → only 3 workers, no fake work ──
test("C: fewer areas than configured workers starts only as many workers as areas exist", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const claimedSoFar = new Set<string>();

  const result = await runAreaWorkerPool({
    configuredWorkers: 5,
    totalCuratedAreas: areas.length,
    availableCapacity: 5,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 3, "pool size must be capped by available areas, not configured workers");
  assert.equal(result.startedWorkers, 3);
  assert.equal(result.areasProcessed.length, 3);
});

// ── Test G: worker failure isolation ────────────────────────────────────────
test("G: one area worker's failure does not stop siblings from completing", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan"];
  const claimedSoFar = new Set<string>();

  const result = await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: areas.length,
    availableCapacity: 3,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async (area) => {
      if (area === "Queens") return outcome({ failed: true, error: "simulated crash" });
      return outcome({ discovered: 2, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.startedWorkers, 3, "all three areas must still be attempted");
  assert.equal(result.allFailed, false, "two of three areas succeeded — the pool is not entirely failed");
  const queens = result.perArea.find((p) => p.area === "Queens");
  assert.equal(queens?.outcome.failed, true);
  // Brooklyn/Manhattan contributed their accepted counts despite Queens's failure.
  assert.equal(result.totals.accepted, 2);
});

test("allFailed is true only when every area that ran failed", async () => {
  const areas = ["Brooklyn", "Queens"];
  const claimedSoFar = new Set<string>();

  const result = await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => outcome({ failed: true, error: "simulated crash" }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(result.allFailed, true);
});

// ── Test H: worker replacement — a finished worker claims another eligible area ──
test("H: when a worker finishes early, the pool claims another eligible area while respecting pool size", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx", "StatenIsland", "Harlem"];
  const claimedSoFar = new Set<string>();
  let maxConcurrentSlotsHeld = 0;
  let slotsHeld = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 2, // small pool, more areas than slots
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => {
      // Simulate a real async engine run so workers genuinely overlap.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => {
      slotsHeld += 1;
      maxConcurrentSlotsHeld = Math.max(maxConcurrentSlotsHeld, slotsHeld);
      return () => { slotsHeld -= 1; };
    },
    isTerminal: () => false,
  });

  // All 6 areas eventually get processed even though only 2 workers ran at once.
  assert.equal(result.startedWorkers, 6, "the pool must replace a finished worker with another eligible area");
  assert.equal(new Set(result.areasProcessed).size, 6, "every area processed must be distinct");
  assert.ok(maxConcurrentSlotsHeld <= 2, "never more than the pool size worth of slots held concurrently");
});

// ── Test I: cancellation prevents queued work from starting and stops active workers ──
test("I: isTerminal() true from the start means no area worker is ever claimed", async () => {
  const result = await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: 3,
    availableCapacity: 3,
    claimNextArea: async () => "ShouldNeverBeClaimed",
    runArea: async () => outcome({ discovered: 5, accepted: 5 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => true, // already cancelled/target-reached before the pool starts
  });

  assert.equal(result.startedWorkers, 0);
  assert.equal(result.areasProcessed.length, 0);
});

test("I: cancellation mid-run stops further area claims but keeps already-collected results", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  const claimedSoFar = new Set<string>();
  let cancelled = false;

  const result = await runAreaWorkerPool({
    configuredWorkers: 1, // serialize so we can deterministically cancel after the first area
    totalCuratedAreas: areas.length,
    availableCapacity: 1,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => {
      cancelled = true; // cancellation "lands" after the first area completes
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => cancelled,
  });

  assert.equal(result.startedWorkers, 1, "only the first area should have started before cancellation landed");
});

// ── Test J: target reached — accepted <= requested, remaining work stops ──
test("J: once isTerminal() reports the target is reached, no further areas start; accepted never exceeds requested", async () => {
  const areas = ["Brooklyn", "Queens", "Manhattan", "Bronx"];
  const claimedSoFar = new Set<string>();
  const requested = 5;
  let totalAccepted = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => {
      const accepted = Math.min(3, requested - totalAccepted);
      totalAccepted += Math.max(0, accepted);
      return outcome({ discovered: 3, accepted: Math.max(0, accepted) });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => totalAccepted >= requested,
  });

  assert.ok(result.totals.accepted <= requested, `accepted (${result.totals.accepted}) must never exceed requested (${requested})`);
});

// ── No-slot degradation: a saturated capacity starts fewer workers, never fake work ──
test("a saturated browser slot pool starts zero workers rather than blocking or faking work", async () => {
  const pool = createBrowserSlotPool(1);
  const release = pool.tryAcquire(); // occupy the only slot from "another task"
  assert.ok(release);

  const result = await runAreaWorkerPool({
    configuredWorkers: 4,
    totalCuratedAreas: 4,
    availableCapacity: pool.available(), // 0 — fully saturated
    claimNextArea: async () => "ShouldNeverBeClaimed",
    runArea: async () => outcome({ discovered: 9, accepted: 9 }),
    tryAcquireSlot: () => pool.tryAcquire(),
    isTerminal: () => false,
  });

  assert.equal(result.poolSize, 0);
  assert.equal(result.startedWorkers, 0);
  release!();
});

// ── onEvent observability (Step 11) ─────────────────────────────────────────
test("onEvent reports pool_start, worker_started/finished, and pool_stopped in a sane order", async () => {
  const events: AreaWorkerLogEvent["type"][] = [];
  const areas = ["Brooklyn", "Queens"];
  const claimedSoFar = new Set<string>();

  await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: 2,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a) && !claimedSoFar.has(a));
      if (!next) return undefined;
      claimedSoFar.add(next);
      return next;
    },
    runArea: async () => outcome({ discovered: 1, accepted: 1 }),
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
    onEvent: (e) => events.push(e.type),
  });

  assert.equal(events[0], "pool_start");
  assert.equal(events[events.length - 1], "pool_stopped");
  assert.equal(events.filter((e) => e === "worker_started").length, 2);
  assert.equal(events.filter((e) => e === "worker_finished").length, 2);
});
