/**
 * PHASE 5 — target-aware discovery stopping.
 *
 * Two things are tested here, matching the audit's TESTS requirements:
 *
 *  1. The pure per-round sizing formulas (roundSizing.ts) that
 *     poolExpandJob.ts now uses for BOTH the legacy sequential path and
 *     the curated-area pooled path — proving `streamTarget`/`askFor`
 *     shrink with the live remaining target (never the fixed original
 *     job target), and that `deliver_target` (== streamTarget) is what
 *     gets sent to the engine, decoupled from the generous scan budget.
 *
 *  2. Global-target-reached sibling stopping, using the SAME
 *     `runAreaWorkerPool` harness pattern already established in
 *     discoveryAreaPoolProductionPath.test.ts — proving that once a
 *     shared "remaining" counter hits 0 (simulating another sibling
 *     area/city having already delivered enough), no further area is
 *     claimed, and that a remaining of exactly 1 lets exactly one more
 *     area run before stopping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { areaStreamTarget, cityStreamTarget, computeAskFor } from "../roundSizing.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";

const STREAM_BATCH_FLOOR = 5;

// ── 1. Pure formula tests ──────────────────────────────────────────────

test("areaStreamTarget clamps to the streaming floor, never the full original target", () => {
  // Plenty still remaining (10) — clamped to the floor (5), not 10.
  assert.equal(areaStreamTarget(10, STREAM_BATCH_FLOOR), 5);
  // Only 1 still remaining — must ask for exactly 1, not the floor.
  assert.equal(areaStreamTarget(1, STREAM_BATCH_FLOOR), 1);
  // Exactly at the floor.
  assert.equal(areaStreamTarget(5, STREAM_BATCH_FLOOR), 5);
});

test("areaStreamTarget never returns less than 1 even for a degenerate remaining", () => {
  // stillNeededNow() <= 0 is guarded by the caller before this is ever
  // invoked in production, but the formula itself must not return 0 or
  // negative (an engine deliver_target of 0 has different semantics —
  // LeadAcceptanceGate(0) is immediately target_reached).
  assert.equal(areaStreamTarget(0, STREAM_BATCH_FLOOR), 1);
});

test("cityStreamTarget follows the smaller of remaining vs the fairness/floor share", () => {
  // remaining=10, chunk=2 (fairness share) -> floor(5) wins over chunk, but remaining(10) is bigger than floor -> min(10, max(2,5)) = 5
  assert.equal(cityStreamTarget(10, 2, STREAM_BATCH_FLOOR), 5);
  // remaining=1 -> must never exceed the true remaining need regardless of chunk/floor
  assert.equal(cityStreamTarget(1, 2, STREAM_BATCH_FLOOR), 1);
  assert.equal(cityStreamTarget(1, 10, STREAM_BATCH_FLOOR), 1);
});

test("computeAskFor scales with the dynamic streamTarget, not a fixed original job target", () => {
  // THE CORE FIX: previously askFor floored on the full, fixed
  // `payload.shortfall` (e.g. 10) regardless of how small streamTarget
  // had shrunk to. Now it floors on streamTarget itself.
  assert.equal(computeAskFor(5), 20); // 5*4
  assert.equal(computeAskFor(1), 4);  // 1*4 -- NOT 10 (the old fixed-target floor)
  assert.equal(computeAskFor(1) < 10, true, "askFor for a near-satisfied round must not still be sized for the full original job");
});

test("askFor is always >= streamTarget (never asks for less raw supply than the qualified target itself)", () => {
  for (const remaining of [1, 2, 5, 20]) {
    const st = areaStreamTarget(remaining, STREAM_BATCH_FLOOR);
    const askFor = computeAskFor(st);
    assert.ok(askFor >= st);
  }
});

// ── 2. Global-target-reached sibling stopping (coordination contract) ──
//
// Mirrors how poolExpandJob.ts actually wires runAreaWorkerPool: `isTerminal`
// reads a live "remaining" function (stillNeededNow() in production);
// each simulated area decrements a SHARED remaining counter by however
// many it "delivers", exactly like processLead()/abortController do in
// production once newForUser reaches payload.shortfall.

function makeHarness(totalRemaining: number, perAreaDeliver: number) {
  let remaining = totalRemaining;
  const startedAreas: string[] = [];
  const availableAreas = ["A1", "A2", "A3", "A4", "A5", "A6"];
  let nextIdx = 0;

  return {
    getRemaining: () => remaining,
    startedAreas,
    run: () =>
      runAreaWorkerPool({
        configuredWorkers: 1, // sequential, deterministic ordering for this test
        totalCuratedAreas: availableAreas.length,
        availableCapacity: 1,
        requestedQuantity: totalRemaining,
        claimNextArea: async (used) => {
          while (nextIdx < availableAreas.length) {
            const a = availableAreas[nextIdx++];
            if (!used.has(a)) return a;
          }
          return undefined;
        },
        runArea: async (area): Promise<AreaRunOutcome> => {
          startedAreas.push(area);
          const delivered = Math.min(perAreaDeliver, Math.max(remaining, 0));
          remaining -= delivered;
          return { discovered: delivered, accepted: delivered, rejected: 0, duplicates: 0, exhausted: true, failed: false };
        },
        tryAcquireSlot: () => () => {},
        // Exactly what poolExpandJob.ts passes: isTerminal reads the LIVE
        // remaining, not a value captured once at pool-start time.
        isTerminal: () => remaining <= 0,
      }),
  };
}

test("TEST 1 — global target reached stops all further sibling discovery (no new area claimed)", async () => {
  // 10 total remaining, each area delivers 5 -> after 2 areas, remaining
  // hits 0 and isTerminal() must prevent a 3rd area from ever starting.
  const harness = makeHarness(10, 5);
  await harness.run();

  assert.equal(harness.getRemaining(), 0);
  assert.equal(harness.startedAreas.length, 2, "no third area should ever have been claimed once the global target was satisfied");
});

test("TEST 3 — one remaining global lead allows exactly one more area to run, then stops", async () => {
  const harness = makeHarness(1, 5); // one area can easily over-deliver if not clamped
  await harness.run();

  assert.equal(harness.getRemaining(), 0);
  assert.equal(harness.startedAreas.length, 1, "exactly one area must run for a remaining of 1, then siblings stop");
});

test("TEST 4 — zero remaining global target stops immediately (no area ever claimed)", async () => {
  const harness = makeHarness(0, 5);
  const result = await harness.run();

  assert.equal(harness.startedAreas.length, 0, "isTerminal() must already be true before any area is claimed");
  assert.equal(result.startedWorkers, 0);
});

test("TEST 5 — no overshoot: delivered never exceeds what was actually still needed", async () => {
  // A generous per-area delivery (STREAM_BATCH_FLOOR-sized, 5) against a
  // total remaining of 7 must not jointly exceed 7 — the second area's
  // own streamTarget (via areaStreamTarget(remaining=2, floor=5) === 2)
  // is what production code passes as deliver_target, capping it exactly
  // at what's left. This test simulates that clamped-at-source behavior
  // (an area is only ever ASKED for min(remaining, floor), never floor
  // unconditionally) — see areaStreamTarget itself, tested above.
  let remaining = 7;
  const delivered: number[] = [];
  const availableAreas = ["A1", "A2", "A3"];
  let nextIdx = 0;

  await runAreaWorkerPool({
    configuredWorkers: 1,
    totalCuratedAreas: availableAreas.length,
    availableCapacity: 1,
    requestedQuantity: 7,
    claimNextArea: async (used) => {
      while (nextIdx < availableAreas.length) {
        const a = availableAreas[nextIdx++];
        if (!used.has(a)) return a;
      }
      return undefined;
    },
    runArea: async (): Promise<AreaRunOutcome> => {
      // Exactly what poolExpandJob.ts does: ask for areaStreamTarget(remaining, floor), not the raw floor.
      const streamTarget = areaStreamTarget(remaining, STREAM_BATCH_FLOOR);
      const thisAreaDelivers = streamTarget; // engine honors deliver_target exactly (see Python-side test)
      delivered.push(thisAreaDelivers);
      remaining -= thisAreaDelivers;
      return { discovered: thisAreaDelivers, accepted: thisAreaDelivers, rejected: 0, duplicates: 0, exhausted: true, failed: false };
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => remaining <= 0,
  });

  const totalDelivered = delivered.reduce((a, b) => a + b, 0);
  assert.equal(totalDelivered, 7, "total delivered must equal exactly what was needed, no more");
  assert.equal(remaining, 0);
});
