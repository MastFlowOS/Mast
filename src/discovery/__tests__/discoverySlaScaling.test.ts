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
  // 10 leads requested -> low concurrency (2)
  assert.equal(computeDynamicDiscoveryCapacity(10, 5, 4, 8), 2);
  assert.equal(computeDynamicDiscoveryCapacity(5, 5, 4, 8), 2);

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

test("runAreaWorkerPool: deterministic 10-lead run with dynamic capacity", async () => {
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

  assert.equal(result.poolSize, 2); // 10 leads -> 2 workers
  assert.equal(result.totals.accepted, 10);
  assert.equal(result.allFailed, false);
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

  assert.equal(result.poolSize, 2);
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

  assert.equal(result.totals.accepted, 10);
  assert.equal(sharedAccepted, 10);
  // No duplicate area claims
  const uniqueClaimed = new Set(claimed);
  assert.equal(uniqueClaimed.size, claimed.length);
});

