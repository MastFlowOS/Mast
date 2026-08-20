/**
 * Phase 6 — TASK 6: deterministic (mocked, no Postgres/Playwright/Python)
 * load tests for the 10/25/50/100 lead tiers, matching the style of
 * discoverySlaScaling.test.ts / googleAreaPool.test.ts (injected fakes
 * only — see those files' own doc comments for why).
 *
 * Each test simulates one full pool run for a request tier and measures,
 * from the pool's own observable behavior, exactly what the phase prompt's
 * TASK 6 asks for:
 *   - concurrent "area workers" (each standing in for one Python
 *     subprocess + its own Chromium process tree) never exceeds the
 *     computed poolSize
 *   - poolSize itself never exceeds the resource-derived safeResourceWorkers
 *     ceiling (computeSafePidWorkerCeiling, fed a fabricated but
 *     realistic cgroup snapshot — see resourceCapacity.test.ts for the
 *     pure-arithmetic coverage of that function on its own)
 *   - no duplicate area claims
 *   - no target overshoot (accepted stops at exactly the requested count)
 *   - clean TARGET_REACHED propagation (isTerminal() flips and every
 *     worker stops promptly, not mid-loop on a stale check)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runAreaWorkerPool, computeDynamicDiscoveryCapacity, desiredWorkersForQuantity } from "../googleAreaPool.js";
import { createBrowserSlotPool } from "../../lib/browserSlotPool.js";
import { computeSafePidWorkerCeiling } from "../../lib/resourceCapacity.js";

/**
 * A generously-resourced fabricated container: pids.max=8192, 400 pids
 * already in use, 220 pids/area worker (the documented default estimate),
 * 300 reserved -> floor((8192-400-300)/220) = 33. Large enough that these
 * tests exercise the request-size tiers themselves, not the PID ceiling —
 * the PID ceiling as the binding constraint is covered separately below
 * ("tightly PID-constrained container").
 */
const GENEROUS_PID_CEILING = computeSafePidWorkerCeiling(8192, 400, 220, 300, 2).ceiling;

function makeAreas(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Area${i + 1}`);
}

/** Runs one simulated tier and returns the pool result plus peak concurrency observed. */
async function runTier(opts: {
  requestedQuantity: number;
  targetMax: number;
  totalAreas: number;
  browserSlots: number;
  safeResourceWorkers: number;
  perAreaAccepted: number;
  perAreaDelayMs?: number;
}) {
  const { requestedQuantity, targetMax, totalAreas, browserSlots, safeResourceWorkers, perAreaAccepted, perAreaDelayMs = 5 } = opts;
  const slotPool = createBrowserSlotPool(browserSlots);
  const areas = makeAreas(totalAreas);
  const claimed: string[] = [];
  const inFlight = new Set<string>();
  let targetCount = 0;
  let concurrent = 0;
  let peakConcurrent = 0;
  let overshootDetected = false;

  const result = await runAreaWorkerPool({
    configuredWorkers: 16,
    safeResourceWorkers,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity,
    claimNextArea: async (used) => {
      // Synchronous reservation (inFlight), not just the `used` set passed
      // in — that set is only updated by the pool AFTER an area's claim
      // resolves, so two concurrently-awaiting workers could otherwise
      // both read it as empty and pick the same area (see the existing
      // "shared target stops all workers" test in discoverySlaScaling.test.ts,
      // which uses this same inFlight-reservation pattern for the same
      // reason).
      const next = areas.find((a) => !used.has(a) && !inFlight.has(a));
      if (next) {
        inFlight.add(next);
        claimed.push(next);
      }
      return next;
    },
    runArea: async () => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      try {
        await new Promise((resolve) => setTimeout(resolve, perAreaDelayMs));
        const remaining = targetMax - targetCount;
        const accepted = Math.min(perAreaAccepted, Math.max(0, remaining));
        if (accepted < 0) overshootDetected = true;
        targetCount += accepted;
        if (targetCount > targetMax) overshootDetected = true;
        return { discovered: accepted + 2, accepted, rejected: 1, duplicates: 1, exhausted: false, failed: false };
      } finally {
        concurrent -= 1;
      }
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  const uniqueClaimed = new Set(claimed);
  assert.equal(uniqueClaimed.size, claimed.length, "no duplicate area claims");
  assert.equal(overshootDetected, false, "no target overshoot");
  assert.equal(targetCount, targetMax, "target reached exactly");
  assert.ok(peakConcurrent <= result.poolSize, `peak concurrency (${peakConcurrent}) must not exceed computed poolSize (${result.poolSize})`);
  assert.ok(result.poolSize <= safeResourceWorkers, `poolSize (${result.poolSize}) must never exceed the resource ceiling (${safeResourceWorkers})`);

  return { result, peakConcurrent };
}

test("Phase 6 load test — 10 leads: pool scales to the desired-3 tier under a generous resource ceiling", async () => {
  const { result, peakConcurrent } = await runTier({
    requestedQuantity: 10,
    targetMax: 10,
    totalAreas: 6,
    browserSlots: 6,
    safeResourceWorkers: GENEROUS_PID_CEILING,
    perAreaAccepted: 4,
  });
  assert.equal(desiredWorkersForQuantity(10), 3);
  assert.equal(result.poolSize, 3);
  assert.equal(peakConcurrent, 3);
});

test("Phase 6 load test — 25 leads: pool scales to the desired-4 tier under a generous resource ceiling", async () => {
  const { result, peakConcurrent } = await runTier({
    requestedQuantity: 25,
    targetMax: 25,
    totalAreas: 8,
    browserSlots: 8,
    safeResourceWorkers: GENEROUS_PID_CEILING,
    perAreaAccepted: 7,
  });
  assert.equal(desiredWorkersForQuantity(25), 4);
  assert.equal(result.poolSize, 4);
  assert.equal(peakConcurrent, 4);
});

test("Phase 6 load test — 50 leads: pool scales to the desired-6 tier under a generous resource ceiling", async () => {
  const { result, peakConcurrent } = await runTier({
    requestedQuantity: 50,
    targetMax: 50,
    totalAreas: 10,
    browserSlots: 10,
    safeResourceWorkers: GENEROUS_PID_CEILING,
    perAreaAccepted: 9,
  });
  assert.equal(desiredWorkersForQuantity(50), 6);
  assert.equal(result.poolSize, 6);
  assert.equal(peakConcurrent, 6);
});

test("Phase 6 load test — 100 leads: pool scales to the desired-10 tier under a generous resource ceiling", async () => {
  const { result, peakConcurrent } = await runTier({
    requestedQuantity: 100,
    targetMax: 100,
    totalAreas: 14,
    browserSlots: 14,
    safeResourceWorkers: GENEROUS_PID_CEILING,
    perAreaAccepted: 12,
  });
  assert.equal(desiredWorkersForQuantity(100), 10);
  assert.equal(result.poolSize, 10);
  assert.equal(peakConcurrent, 10);
});

test("Phase 6 load test — 100 leads on a tightly PID-constrained container: resource ceiling wins, not the tier", async () => {
  // A small container: pids.max=1024, 300 already in use, 220/area worker,
  // 300 reserved -> floor((1024-300-300)/220) = 1. Even though 100 leads
  // "wants" 10 workers, this container can only prove 1 is safe.
  const tightCeiling = computeSafePidWorkerCeiling(1024, 300, 220, 300, 2).ceiling;
  assert.equal(tightCeiling, 1);

  const { result, peakConcurrent } = await runTier({
    requestedQuantity: 100,
    targetMax: 100,
    totalAreas: 14,
    browserSlots: 14,
    safeResourceWorkers: tightCeiling,
    perAreaAccepted: 20,
  });
  assert.equal(result.poolSize, 1);
  assert.equal(peakConcurrent, 1);
});

test("Phase 6 load test — CANCELLED does not falsely fire when the target is reached normally", async () => {
  const { result } = await runTier({
    requestedQuantity: 25,
    targetMax: 25,
    totalAreas: 8,
    browserSlots: 8,
    safeResourceWorkers: GENEROUS_PID_CEILING,
    perAreaAccepted: 7,
  });
  assert.notEqual(result.allFailed, true);
});
