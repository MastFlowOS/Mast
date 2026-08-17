import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDynamicDiscoveryCapacity,
  computeAreaPoolSize,
  runAreaWorkerPool,
  type AreaRunOutcome,
} from "../googleAreaPool.js";
import { createBrowserSlotPool } from "../../lib/browserSlotPool.js";

test("computeDynamicDiscoveryCapacity: scales concurrency safely by requested quantity", () => {
  // 10 leads requested -> low concurrency, now up to 3 workers when
  // >= 3 areas and >= 3 browser slots are actually available.
  assert.equal(computeDynamicDiscoveryCapacity(10, 5, 4, 8), 3);
  assert.equal(computeDynamicDiscoveryCapacity(5, 5, 4, 8), 3);

  // 25 leads requested -> moderate concurrency (3)
  assert.equal(computeDynamicDiscoveryCapacity(25, 5, 4, 8), 3);

  // 50 leads requested -> higher concurrency (4)
  assert.equal(computeDynamicDiscoveryCapacity(50, 6, 4, 8), 4);
  assert.equal(computeDynamicDiscoveryCapacity(50, 6, 8, 8), 4);

  // 100 leads requested -> max safe concurrency
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 6, 8), 6);
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 8, 8), 8);

  // Bounded by available curated areas
  assert.equal(computeDynamicDiscoveryCapacity(100, 3, 8, 8), 3);

  // Bounded by browser slot capacity
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 2, 8), 2);

  // Saturated capacity (0 slots) -> 0
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 0, 8), 0);
  assert.equal(computeDynamicDiscoveryCapacity(0, 10, 4, 8), 0);
});

test("computeDynamicDiscoveryCapacity: 10-lead 3-worker upgrade is still fully dynamic, not hardcoded", () => {
  // The new ceiling (3) for <= 10 leads is only reached when BOTH the
  // area bound and the browser-slot bound independently allow it.

  // Baseline from the 2-worker production baseline: exactly 3 areas and
  // 3+ slots free -> the pool now expands to 3 workers.
  assert.equal(computeDynamicDiscoveryCapacity(10, 3, 3, 8), 3);
  assert.equal(computeDynamicDiscoveryCapacity(10, 3, 10, 8), 3);

  // Area bound still wins: only 2 curated areas available, regardless of
  // browser slots or the new higher desired concurrency -> capped at 2,
  // matching the original production baseline exactly.
  assert.equal(computeDynamicDiscoveryCapacity(10, 2, 10, 8), 2);
  assert.equal(computeDynamicDiscoveryCapacity(10, 1, 10, 8), 1);

  // Browser-slot bound still wins: plenty of areas but only 1-2 free
  // slots -> capped at the slot count, same as before this change.
  assert.equal(computeDynamicDiscoveryCapacity(10, 6, 1, 8), 1);
  assert.equal(computeDynamicDiscoveryCapacity(10, 6, 2, 8), 2);

  // A low configured ceiling still wins over the new desired-3 tier.
  assert.equal(computeDynamicDiscoveryCapacity(10, 6, 6, 2), 2);

  // Both bounds loose (>=3 areas, >=3 slots) -> the dynamic ceiling for
  // this tier (3), never hardcoded past what areas/capacity allow.
  assert.equal(computeDynamicDiscoveryCapacity(10, 4, 4, 8), 3);
  assert.equal(computeDynamicDiscoveryCapacity(1, 3, 3, 8), 3);
});

test("runAreaWorkerPool: deterministic 10-lead run with dynamic capacity expands to 3 workers", async () => {
  const slotPool = createBrowserSlotPool(4);
  const areas = ["Downtown", "Midtown", "Uptown", "Westside"];
  let targetCount = 0;
  const targetMax = 10;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 10,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      const remaining = targetMax - targetCount;
      const accepted = Math.min(5, Math.max(0, remaining));
      targetCount += accepted;
      return {
        discovered: accepted + 2,
        accepted,
        rejected: 1,
        duplicates: 1,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  // 10 leads + >= 3 available areas + >= 3 free browser slots -> 3 workers
  assert.equal(result.poolSize, 3);
  assert.equal(result.totals.accepted, 10);
  assert.equal(result.allFailed, false);
});

test("runAreaWorkerPool: 10-lead run stays at 2 workers when only 2 areas are available (area bound still wins)", async () => {
  const slotPool = createBrowserSlotPool(4);
  const areas = ["Downtown", "Midtown"]; // only 2 curated areas for this city
  let targetCount = 0;
  const targetMax = 10;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 10,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      const remaining = targetMax - targetCount;
      const accepted = Math.min(5, Math.max(0, remaining));
      targetCount += accepted;
      return {
        discovered: accepted + 2,
        accepted,
        rejected: 1,
        duplicates: 1,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  // The dynamic ceiling for <= 10 leads is 3, but only 2 curated areas
  // exist, so the pool must not exceed 2 -- exactly the pre-change
  // production baseline for this city shape.
  assert.equal(result.poolSize, 2);
  assert.equal(result.startedWorkers, 2);
  assert.equal(result.areasProcessed.length, 2);
});

test("runAreaWorkerPool: 10-lead run stays at 2 workers when only 2 browser slots are free (browser-slot bound still wins)", async () => {
  const slotPool = createBrowserSlotPool(2); // only 2 free browser slots
  const areas = ["Downtown", "Midtown", "Uptown", "Westside"]; // plenty of areas
  let targetCount = 0;
  const targetMax = 10;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 10,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      const remaining = targetMax - targetCount;
      const accepted = Math.min(5, Math.max(0, remaining));
      targetCount += accepted;
      return {
        discovered: accepted + 2,
        accepted,
        rejected: 1,
        duplicates: 1,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  // Plenty of areas, but only 2 browser slots free -> capped at 2.
  assert.equal(result.poolSize, 2);
});

test("runAreaWorkerPool: deterministic 25-lead run scales to 3 workers", async () => {
  const slotPool = createBrowserSlotPool(6);
  const areas = ["Area1", "Area2", "Area3", "Area4", "Area5", "Area6"];
  let targetCount = 0;
  const targetMax = 25;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 25,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      const remaining = targetMax - targetCount;
      const accepted = Math.min(10, Math.max(0, remaining));
      targetCount += accepted;
      return {
        discovered: accepted + 3,
        accepted,
        rejected: 2,
        duplicates: 1,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  assert.equal(result.poolSize, 3); // 25 leads -> 3 workers
  assert.equal(result.totals.accepted, 25);
  assert.equal(result.allFailed, false);
});

test("runAreaWorkerPool: deterministic 50-lead run scales to 4 workers", async () => {
  const slotPool = createBrowserSlotPool(8);
  const areas = ["Area1", "Area2", "Area3", "Area4", "Area5", "Area6", "Area7", "Area8"];
  let targetCount = 0;
  const targetMax = 50;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 50,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      const remaining = targetMax - targetCount;
      const accepted = Math.min(15, Math.max(0, remaining));
      targetCount += accepted;
      return {
        discovered: accepted + 5,
        accepted,
        rejected: 3,
        duplicates: 2,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  assert.equal(result.poolSize, 4); // 50 leads -> 4 workers
  assert.equal(result.totals.accepted, 50);
  assert.equal(result.allFailed, false);
});

test("runAreaWorkerPool: deterministic 100-lead run uses max safe browser capacity", async () => {
  const slotPool = createBrowserSlotPool(6); // 6 safe browser slots
  const areas = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];
  let targetCount = 0;
  const targetMax = 100;

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 100,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      const remaining = targetMax - targetCount;
      const accepted = Math.min(20, Math.max(0, remaining));
      targetCount += accepted;
      return {
        discovered: accepted + 8,
        accepted,
        rejected: 5,
        duplicates: 3,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  assert.equal(result.poolSize, 6); // 100 leads -> bounded by 6 slots
  assert.equal(result.totals.accepted, 100);
  assert.equal(result.allFailed, false);
});

test("runAreaWorkerPool: slow area does not block fast concurrent area worker", async () => {
  const slotPool = createBrowserSlotPool(4);
  const areas = ["SlowArea", "FastArea1", "FastArea2", "FastArea3"];
  let targetCount = 0;
  const targetMax = 10;
  const areaExecutionLog: string[] = [];

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 10,
    claimNextArea: async (used) => areas.find((a) => !used.has(a)),
    runArea: async (area) => {
      areaExecutionLog.push(`start:${area}`);
      if (area === "SlowArea") {
        // Slow area simulates a 100ms lag producing only 2 leads
        await new Promise((r) => setTimeout(r, 100));
        const remaining = targetMax - targetCount;
        const accepted = Math.min(2, Math.max(0, remaining));
        targetCount += accepted;
        areaExecutionLog.push(`finish:${area}`);
        return { discovered: 4, accepted, rejected: 1, duplicates: 1, exhausted: false, failed: false };
      } else {
        // Fast area immediately yields 8 leads to satisfy the target
        const remaining = targetMax - targetCount;
        const accepted = Math.min(8, Math.max(0, remaining));
        targetCount += accepted;
        areaExecutionLog.push(`finish:${area}`);
        return { discovered: 10, accepted, rejected: 1, duplicates: 1, exhausted: false, failed: false };
      }
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => targetCount >= targetMax,
  });

  assert.equal(result.poolSize, 3);
  assert.equal(result.totals.accepted, 10);
  // Both SlowArea and FastArea1 started concurrently
  assert.ok(areaExecutionLog.includes("start:SlowArea"));
  assert.ok(areaExecutionLog.includes("start:FastArea1"));
  // FastArea finished and target was reached without waiting on further unstarted areas
  assert.ok(targetCount >= 10);
});

test("runAreaWorkerPool: shared target stops all workers with no overshoot or duplicate claims", async () => {
  const slotPool = createBrowserSlotPool(4);
  const areas = ["AreaA", "AreaB", "AreaC", "AreaD"];
  let sharedAccepted = 0;
  const target = 10;
  const claimed: string[] = [];

  const inFlight = new Set<string>();
  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    totalCuratedAreas: areas.length,
    availableCapacity: slotPool.available(),
    requestedQuantity: 10,
    claimNextArea: async (used) => {
      const next = areas.find((a) => !used.has(a) && !inFlight.has(a));
      if (next) {
        inFlight.add(next);
        claimed.push(next);
      }
      return next;
    },
    runArea: async (area) => {
      const toAccept = Math.min(5, target - sharedAccepted);
      sharedAccepted += toAccept;
      return {
        discovered: toAccept + 3,
        accepted: toAccept,
        rejected: 2,
        duplicates: 1,
        exhausted: false,
        failed: false,
      };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => sharedAccepted >= target,
  });

  // 4 areas + 4 free slots + 10 leads -> the new 3-worker ceiling applies
  // here too; confirms shared-target stopping and dedup hold at 3 workers,
  // not just the old 2-worker baseline.
  assert.equal(result.poolSize, 3);
  assert.equal(result.totals.accepted, 10);
  assert.equal(sharedAccepted, 10);
  // No duplicate area claims
  const uniqueClaimed = new Set(claimed);
  assert.equal(uniqueClaimed.size, claimed.length);
});

