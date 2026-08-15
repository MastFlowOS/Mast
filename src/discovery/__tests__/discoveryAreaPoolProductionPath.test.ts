import test from "node:test";
import assert from "node:assert/strict";
import { computeDynamicDiscoveryCapacity, runAreaWorkerPool, type AreaWorkerLogEvent } from "../googleAreaPool.js";
import { getAreasForCity, getAreasForCityOrDefault, DEFAULT_SUB_AREAS } from "../../lib/geo/cityAreas.js";
import { hasCuratedAreas } from "../areaRotation.js";

test("production area worker pool wiring: resolves sub-areas for any city", () => {
  // Curated city
  const nyAreas = getAreasForCity("US", "New York");
  assert.ok(nyAreas);
  assert.ok(hasCuratedAreas(nyAreas));
  assert.equal(getAreasForCityOrDefault("US", "New York"), nyAreas);

  // Uncurated city
  const uncuratedAreas = getAreasForCity("US", "Topeka");
  assert.equal(uncuratedAreas, undefined);
  assert.equal(hasCuratedAreas(uncuratedAreas), false);

  // Default fallback areas for uncurated city in production task handler
  const resolvedDefault = getAreasForCityOrDefault("US", "Topeka");
  assert.ok(Array.isArray(resolvedDefault));
  assert.ok(resolvedDefault.length >= 4);
  assert.deepEqual(resolvedDefault, DEFAULT_SUB_AREAS);
});

test("production 10-lead path: dynamic capacity sizes to 2 workers with concurrent overlapping execution", async () => {
  const events: AreaWorkerLogEvent[] = [];
  const startTimes = new Map<number, number>();
  const endTimes = new Map<number, number>();

  let slotsHeld = 0;
  let maxConcurrentSlots = 0;

  const totalCuratedAreas = 6;
  const availableCapacity = 10;
  const configuredWorkers = 8;
  const requestedQuantity = 10;

  // Sizing formula verification
  const computedWorkers = computeDynamicDiscoveryCapacity(
    requestedQuantity,
    totalCuratedAreas,
    availableCapacity,
    configuredWorkers,
  );
  assert.equal(computedWorkers, 2, "10-lead request must dynamically size to 2 workers");

  const availableAreas = ["Downtown", "North", "South", "East", "West", "Central"];
  let nextAreaIdx = 0;

  const result = await runAreaWorkerPool({
    configuredWorkers,
    totalCuratedAreas,
    availableCapacity,
    requestedQuantity,
    claimNextArea: async (used) => {
      while (nextAreaIdx < availableAreas.length) {
        const a = availableAreas[nextAreaIdx++];
        if (!used.has(a)) return a;
      }
      return undefined;
    },
    runArea: async (area) => {
      const workerId = slotsHeld;
      const now = Date.now();
      startTimes.set(workerId, now);

      // Simulate network / scraping latency
      await new Promise((r) => setTimeout(r, 60));

      endTimes.set(workerId, Date.now());
      return {
        discovered: 5,
        accepted: 5,
        rejected: 0,
        duplicates: 0,
        exhausted: true,
        failed: false,
      };
    },
    tryAcquireSlot: () => {
      slotsHeld++;
      maxConcurrentSlots = Math.max(maxConcurrentSlots, slotsHeld);
      return () => {
        slotsHeld--;
      };
    },
    isTerminal: () => false,
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(result.poolSize, 2);
  assert.equal(result.startedWorkers, 2);
  assert.equal(maxConcurrentSlots, 2, "Exactly 2 workers must hold browser slots concurrently");

  // Verify pool start event
  const poolStart = events.find((e) => e.type === "pool_start");
  assert.ok(poolStart);
  if (poolStart?.type === "pool_start") {
    assert.equal(poolStart.poolSize, 2);
  }

  // Verify worker started events
  const workerStarts = events.filter((e) => e.type === "worker_started");
  assert.equal(workerStarts.length, 2);

  // Verify temporal overlap: worker 1 and worker 2 were active concurrently
  const w1Start = startTimes.get(1);
  const w1End = endTimes.get(1);
  const w2Start = startTimes.get(2);
  const w2End = endTimes.get(2);

  assert.ok(w1Start != null && w1End != null);
  assert.ok(w2Start != null && w2End != null);
  assert.ok(
    (w1Start <= w2End && w2Start <= w1End),
    `Workers must overlap in time (w1: ${w1Start}-${w1End}, w2: ${w2Start}-${w2End})`,
  );
});
