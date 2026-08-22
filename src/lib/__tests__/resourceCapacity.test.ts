/**
 * Phase 16 — Unit tests for resourceCapacity.ts and discovery capacity scaling.
 * Pure-logic tests for computeSafePidWorkerCeiling, computeSafeResourceCapacity,
 * and capacity boundary invariants.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSafePidWorkerCeiling,
  computeSafeResourceCapacity,
} from "../resourceCapacity.js";
import {
  computeDynamicDiscoveryCapacity,
  computeAreaPoolSize,
  desiredWorkersForQuantity,
  runAreaWorkerPool,
} from "../../discovery/googleAreaPool.js";
import { createBrowserSlotPool } from "../browserSlotPool.js";
import {
  newAreaRunId,
  recordBeforeAreaStart,
  recordAfterAreaStart,
  recordAfterAreaCleanup,
  getAreaWorkerTelemetrySummary,
  __testing_areaWorkerTelemetry,
} from "../areaWorkerTelemetry.js";

// ── Baseline computeSafePidWorkerCeiling tests ────────────────────────────────

test("computeSafePidWorkerCeiling: derives a ceiling from real pids.max/pids.current", () => {
  const { ceiling, basis } = computeSafePidWorkerCeiling(4096, 300, 220, 300, 2);
  assert.equal(basis, "measured");
  assert.equal(ceiling, 15);
});

test("computeSafePidWorkerCeiling: a small pids.max produces a small ceiling even with huge free memory", () => {
  const { ceiling, basis } = computeSafePidWorkerCeiling(512, 100, 220, 100, 2);
  assert.equal(basis, "measured");
  assert.equal(ceiling, 1);
});

test("computeSafePidWorkerCeiling: returns 0 when current usage exceeds the budget", () => {
  const { ceiling } = computeSafePidWorkerCeiling(500, 480, 220, 100, 2);
  assert.equal(ceiling, 0);
});

test("computeSafePidWorkerCeiling: pidsMax === null falls back to fallbackCeiling", () => {
  const { ceiling, basis } = computeSafePidWorkerCeiling(null, null, 220, 300, 2);
  assert.equal(basis, "fallback_unavailable");
  assert.equal(ceiling, 2);
});

test("computeSafePidWorkerCeiling: pidsCurrent unreadable treats current usage as 0", () => {
  const { ceiling, basis } = computeSafePidWorkerCeiling(4096, null, 220, 300, 2);
  assert.equal(basis, "measured");
  assert.equal(ceiling, Math.floor((4096 - 300) / 220));
});

test("computeSafePidWorkerCeiling: scales down as pidsPerAreaWorker grows", () => {
  const cheap = computeSafePidWorkerCeiling(4096, 300, 100, 300, 2);
  const expensive = computeSafePidWorkerCeiling(4096, 300, 400, 300, 2);
  assert.ok(cheap.ceiling > expensive.ceiling);
});

// ── Phase 16 Specific Requirements (Items 1 to 12) ───────────────────────────

// Requirement 1: current 1000-PID environment produces safeWorkers=3 using exact pinned inputs
test("1. Pinned 1000-PID baseline snapshot (pidsMax=1000, pidsCurrent=11, reserve=300, pidsPerWorker=220) produces safeWorkers=3", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 1000,
    pidsCurrent: 11,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
  });
  // floor((1000 - 11 - 300) / 220) = floor(689 / 220) = 3
  assert.equal(result.pidWorkerCeiling, 3);
  assert.equal(result.pidCeilingBasis, "measured");
  assert.equal(result.safeAreaWorkers, 3);
});

// Requirement 2: larger PID limit allows more workers
test("2. Larger PID limit allows more workers to safely run", () => {
  const midContainer = computeSafeResourceCapacity({
    pidsMax: 2048,
    pidsCurrent: 50,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
  });
  // floor((2048 - 50 - 300) / 220) = floor(1698 / 220) = 7
  assert.equal(midContainer.pidWorkerCeiling, 7);
  assert.equal(midContainer.safeAreaWorkers, 7);

  const largeContainer = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 50,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 16,
  });
  // floor((4096 - 50 - 300) / 220) = floor(3746 / 220) = 17
  assert.equal(largeContainer.pidWorkerCeiling, 17);
  assert.equal(largeContainer.safeAreaWorkers, 16); // capped by configuredCeiling 16
});

// Requirement 3: memory-limited container still caps workers
test("3. Memory-limited container caps workers even when PID ceiling is high", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 50,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
    cgroupMemoryLimitMb: 1024,
    cgroupMemoryCurrentMb: 200,
    reserveMemoryMb: 256,
    perBrowserMb: 350,
  });
  // PID budget allows 17 workers
  assert.equal(result.pidWorkerCeiling, 17);
  // Memory budget: floor((1024 - 200 - 256) / 350) = floor(568 / 350) = 1 worker
  assert.equal(result.cgroupMemoryWorkerCeiling, 1);
  assert.equal(result.rawResourceCeiling, 1);
  assert.equal(result.safeAreaWorkers, 1);
});

// Requirement 4: browser-slot-limited container still caps workers
test("4. Browser-slot-limited container caps final workers", () => {
  const finalWorkers = computeDynamicDiscoveryCapacity(
    100, // desired 10
    10,  // available areas
    2,   // only 2 browser slots available
    8,   // configured 8
    8,   // safeResourceWorkers 8
  );
  assert.equal(finalWorkers, 2);
});

// Requirement 5: manual GOOGLE_MAPS_SAFE_RESOURCE_WORKERS cap still wins
test("5. Manual GOOGLE_MAPS_SAFE_RESOURCE_WORKERS cap takes precedence and can lower ceiling", () => {
  const cappedLow = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 50,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
    manualCap: 2,
  });
  assert.equal(cappedLow.pidWorkerCeiling, 17);
  assert.equal(cappedLow.safeAreaWorkers, 2);

  // Manual cap cannot raise beyond measured resource limit
  const attemptedRaise = computeSafeResourceCapacity({
    pidsMax: 1000,
    pidsCurrent: 11,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
    manualCap: 10,
  });
  assert.equal(attemptedRaise.pidWorkerCeiling, 3);
  assert.equal(attemptedRaise.safeAreaWorkers, 3);
});

// Requirement 6: requestedWorkers cannot exceed safeResourceWorkers
test("6. requestedWorkers cannot exceed safeResourceWorkers", () => {
  const finalWorkers10 = computeDynamicDiscoveryCapacity(10, 10, 10, 8, 2);
  assert.equal(finalWorkers10, 2);

  const finalWorkers100 = computeDynamicDiscoveryCapacity(100, 10, 10, 8, 3);
  assert.equal(finalWorkers100, 3);
});

// Requirement 7: configuredWorkers cannot exceed safeResourceWorkers
test("7. configuredWorkers cannot exceed safeResourceWorkers and vice versa", () => {
  // Configured ceiling lower than safeResourceWorkers
  const finalWorkersLowConfig = computeDynamicDiscoveryCapacity(100, 10, 10, 2, 8);
  assert.equal(finalWorkersLowConfig, 2);

  // SafeResourceWorkers lower than configured
  const finalWorkersLowSafe = computeDynamicDiscoveryCapacity(100, 10, 10, 8, 3);
  assert.equal(finalWorkersLowSafe, 3);
});

// Requirement 8: current PID consumption is accounted for
test("8. Current PID consumption reduces available worker headroom", () => {
  const lowUsage = computeSafeResourceCapacity({
    pidsMax: 1000,
    pidsCurrent: 11,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
  });
  // floor((1000 - 11 - 300) / 220) = 3
  assert.equal(lowUsage.safeAreaWorkers, 3);

  const highUsage = computeSafeResourceCapacity({
    pidsMax: 1000,
    pidsCurrent: 300,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
  });
  // floor((1000 - 300 - 300) / 220) = floor(400 / 220) = 1
  assert.equal(highUsage.safeAreaWorkers, 1);
});

// Requirement 9: reservePids is respected
test("9. reservePids is strictly respected before allocating workers", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 1000,
    pidsCurrent: 0,
    pidsPerAreaWorker: 220,
    reservePids: 600,
    fallbackCeiling: 2,
    configuredCeiling: 8,
  });
  // floor((1000 - 0 - 600) / 220) = floor(400 / 220) = 1
  assert.equal(result.safeAreaWorkers, 1);
});

// Requirement 10: no resource limit bypass is possible
test("10. No resource limit bypass is possible across all capacity dimensions", () => {
  // Available areas limit
  assert.equal(computeDynamicDiscoveryCapacity(100, 1, 10, 8, 8), 1);
  // Browser slots limit
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 1, 8, 8), 1);
  // Configured ceiling limit
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 10, 1, 8), 1);
  // Resource ceiling limit
  assert.equal(computeDynamicDiscoveryCapacity(100, 10, 10, 8, 1), 1);
  // Static formula computeAreaPoolSize respects same limits
  assert.equal(computeAreaPoolSize(8, 8, 8, 2), 2);
});

// Requirement 11: 10/25/50/100 lead desired worker tiers remain intact
test("11. 10/25/50/100 lead desired worker tiers remain intact", () => {
  assert.equal(desiredWorkersForQuantity(5), 3);
  assert.equal(desiredWorkersForQuantity(10), 3);
  assert.equal(desiredWorkersForQuantity(25), 4);
  assert.equal(desiredWorkersForQuantity(50), 6);
  assert.equal(desiredWorkersForQuantity(100), 10);
  assert.equal(desiredWorkersForQuantity(150), 12);
});

// Requirement 12: areaWorkerTelemetry remains observational only
test("12. areaWorkerTelemetry remains observational only and does not alter outcomes", () => {
  __testing_areaWorkerTelemetry.reset();
  const runId = newAreaRunId();
  recordBeforeAreaStart(runId, "area-1");
  recordAfterAreaStart(runId, "area-1");
  recordAfterAreaCleanup(runId, "area-1");

  const summary = getAreaWorkerTelemetrySummary();
  assert.equal(summary.cleanDeltas.length, 1);
  assert.equal(summary.cleanDeltas[0]?.area, "area-1");
  // Telemetry is purely observational data structure
  assert.equal(typeof summary.sampleCount, "number");
});

// ── Explicit Regression Test: Zero Resource Capacity ─────────────────────────

test("Regression: zero headroom produces safeAreaWorkers=0, poolSize=0, and launches no workers", async () => {
  // When PID or memory headroom is 0, safeAreaWorkers must be 0 (never clamped to 1)
  const zeroPidCapacity = computeSafeResourceCapacity({
    pidsMax: 500,
    pidsCurrent: 400,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
  });
  assert.equal(zeroPidCapacity.pidWorkerCeiling, 0);
  assert.equal(zeroPidCapacity.rawResourceCeiling, 0);
  assert.equal(zeroPidCapacity.safeAreaWorkers, 0);

  const zeroMemCapacity = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 50,
    pidsPerAreaWorker: 220,
    reservePids: 300,
    fallbackCeiling: 2,
    configuredCeiling: 8,
    cgroupMemoryLimitMb: 512,
    cgroupMemoryCurrentMb: 400,
    reserveMemoryMb: 256,
    perBrowserMb: 350,
  });
  assert.equal(zeroMemCapacity.cgroupMemoryWorkerCeiling, 0);
  assert.equal(zeroMemCapacity.rawResourceCeiling, 0);
  assert.equal(zeroMemCapacity.safeAreaWorkers, 0);

  // When safeResourceWorkers is 0, computeDynamicDiscoveryCapacity and computeAreaPoolSize return 0
  const dynamicZero = computeDynamicDiscoveryCapacity(100, 10, 10, 8, 0);
  assert.equal(dynamicZero, 0);

  const staticZero = computeAreaPoolSize(8, 10, 10, 0);
  assert.equal(staticZero, 0);

  // runAreaWorkerPool with safeResourceWorkers=0 launches 0 workers and makes 0 claims/runs
  let workerStarted = false;
  let areaClaimed = false;
  let poolStoppedReason: string | undefined;
  const slotPool = createBrowserSlotPool(4);

  const result = await runAreaWorkerPool({
    configuredWorkers: 8,
    safeResourceWorkers: 0,
    totalCuratedAreas: 5,
    availableCapacity: slotPool.available(),
    requestedQuantity: 10,
    claimNextArea: async () => {
      areaClaimed = true;
      return "Area-1";
    },
    runArea: async () => {
      workerStarted = true;
      return { discovered: 1, accepted: 1, rejected: 0, duplicates: 0, exhausted: false, failed: false };
    },
    tryAcquireSlot: () => slotPool.tryAcquire(),
    isTerminal: () => false,
    onEvent: (e) => {
      if (e.type === "pool_stopped") poolStoppedReason = e.reason;
    },
  });

  assert.equal(result.poolSize, 0);
  assert.equal(result.startedWorkers, 0);
  assert.equal(result.areasProcessed.length, 0);
  assert.equal(poolStoppedReason, "pool_size_zero");
  assert.equal(areaClaimed, false, "claimNextArea must never be called when poolSize=0");
  assert.equal(workerStarted, false, "runArea must never be called when poolSize=0");
});
