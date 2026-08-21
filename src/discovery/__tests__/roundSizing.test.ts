/**
 * PHASE 5 — target-aware discovery stopping.
 * PHASE 10 — run-to-run stability: reverts the `child_requested=5`
 * regression Phase 5 introduced.
 *
 * Three things are tested here:
 *
 *  1. The pure per-round sizing formulas (roundSizing.ts) — proving
 *     `streamTarget`/`askFor` (and therefore `deliver_target`) now track
 *     the FIXED, authoritative global `target`, never a shrinking live
 *     remaining, and never collapse to a tiny floor for a normal-sized
 *     request (the exact regression production hit: a 10-lead request's
 *     `child_requested` collapsing to 5).
 *
 *  2. Global-target-reached sibling stopping keeps working — using the
 *     SAME `runAreaWorkerPool` harness pattern already established in
 *     discoveryAreaPoolProductionPath.test.ts — proving that even though
 *     every child now asks for the full target, concurrent siblings still
 *     stop the instant the shared "remaining" counter hits 0, and no
 *     overshoot happens.
 *
 *  3. `deliver_target` and `max_results` (`askFor`) are computed
 *     independently — `askFor` is always a multiple of `streamTarget`,
 *     never a value the engine could confuse for `deliver_target` itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { areaStreamTarget, cityStreamTarget, computeAskFor } from "../roundSizing.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";

const STREAM_BATCH_FLOOR = 5;

// ── 1. Pure formula tests ──────────────────────────────────────────────

test("areaStreamTarget: a normal 10-lead request asks each child for the full 10, never collapses to the floor", () => {
  // THE CORE REGRESSION FIX: previously Math.min(target, floor) collapsed
  // this to 5 (STREAM_BATCH_FLOOR) even though 10 leads were requested.
  assert.equal(areaStreamTarget(10, STREAM_BATCH_FLOOR), 10);
  assert.notEqual(areaStreamTarget(10, STREAM_BATCH_FLOOR), 5, "child_requested must never collapse to the floor for a normal-sized request");
});

test("areaStreamTarget never returns less than the floor even for a tiny target", () => {
  assert.equal(areaStreamTarget(1, STREAM_BATCH_FLOOR), 5);
  assert.equal(areaStreamTarget(0, STREAM_BATCH_FLOOR), 5);
});

test("areaStreamTarget scales up for larger requests too — floor/target are both true minimums, never caps", () => {
  assert.equal(areaStreamTarget(25, STREAM_BATCH_FLOOR), 25);
  assert.equal(areaStreamTarget(100, STREAM_BATCH_FLOOR), 100);
});

test("cityStreamTarget: a normal 10-lead request is not shrunk by a small fairness chunk", () => {
  // target=10, chunk=2 (fairness share) -> must still be 10, not min(10, max(2,5))=5 (the old bug).
  assert.equal(cityStreamTarget(10, 2, STREAM_BATCH_FLOOR), 10);
  // A generous chunk/floor never shrinks below the authoritative target either.
  assert.equal(cityStreamTarget(10, 20, STREAM_BATCH_FLOOR), 20, "chunk/floor are minimums — the larger of target/chunk/floor wins");
});

test("computeAskFor scales with streamTarget and is always independent of / larger than deliver_target", () => {
  assert.equal(computeAskFor(10), 40); // 10*4 — a normal 10-lead request's real scan budget
  assert.equal(computeAskFor(5), 20);  // 5*4
  assert.equal(computeAskFor(1), 4);   // 1*4
});

test("askFor is always >= streamTarget (never asks for less raw supply than the qualified target itself)", () => {
  for (const target of [1, 2, 5, 10, 20, 100]) {
    const st = areaStreamTarget(target, STREAM_BATCH_FLOOR);
    const askFor = computeAskFor(st);
    assert.ok(askFor >= st);
  }
});

// ── 2. Global-target-reached sibling stopping (coordination contract) ──
//
// Mirrors how poolExpandJob.ts actually wires runAreaWorkerPool:
// `isTerminal` reads a live "remaining" function (stillNeededNow() in
// production) that is now DECOUPLED from each child's own deliver_target
// (childRequested/streamTarget, sized off the fixed `target`) — the two
// concerns are independent, and this section proves stopping still works
// correctly with that decoupling in place.

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

test("TEST 2 — a productive single area asking for the full target can satisfy the whole request alone", async () => {
  // Simulates PHASE 10's fix directly: one area asked for the full
  // target (deliver_target=10, not shrunk to 5) delivers all 10 itself.
  const harness = makeHarness(10, 10);
  await harness.run();

  assert.equal(harness.getRemaining(), 0);
  assert.equal(harness.startedAreas.length, 1, "one productive area, given a real budget, should be able to satisfy the whole request");
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

test("TEST 5 — no overshoot even though every child now asks for the full authoritative target", async () => {
  // Each area is given deliver_target = areaStreamTarget(target=7, floor)
  // = 7 (the full, fixed target) — NOT clamped down as remaining shrinks.
  // Overshoot protection comes from isTerminal() / the engine's own
  // LeadAcceptanceGate honoring deliver_target as a per-CALL cap, and — in
  // production — abortController.abort() the instant the plan-level
  // target is met. This harness proves the pool-level coordination half
  // of that: no sibling starts once remaining hits 0.
  const target = 7;
  let remaining = target;
  const delivered: number[] = [];
  const availableAreas = ["A1", "A2", "A3"];
  let nextIdx = 0;

  await runAreaWorkerPool({
    configuredWorkers: 1,
    totalCuratedAreas: availableAreas.length,
    availableCapacity: 1,
    requestedQuantity: target,
    claimNextArea: async (used) => {
      while (nextIdx < availableAreas.length) {
        const a = availableAreas[nextIdx++];
        if (!used.has(a)) return a;
      }
      return undefined;
    },
    runArea: async (): Promise<AreaRunOutcome> => {
      // Exactly what poolExpandJob.ts does post-fix: ask for
      // areaStreamTarget(target, floor) — the fixed authoritative target
      // — but a real engine session still only delivers what's actually
      // still needed globally (simulated here by clamping to `remaining`,
      // mirroring the engine's own LeadAcceptanceGate honoring the plan's
      // live delivered count via abort, not via a shrunk deliver_target).
      const streamTarget = areaStreamTarget(target, STREAM_BATCH_FLOOR);
      const thisAreaDelivers = Math.min(streamTarget, remaining);
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
  assert.equal(delivered.length, 1, "one area asked for the full target should satisfy this request without needing siblings");
});
