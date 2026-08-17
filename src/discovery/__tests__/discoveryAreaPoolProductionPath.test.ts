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

test("production 10-lead path: dynamic capacity sizes to 3 workers with concurrent overlapping execution", async () => {
  const areaStartTimes = new Map<string, number>();
  const areaEndTimes = new Map<string, number>();
  const events: AreaWorkerLogEvent[] = [];

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
  assert.equal(
    computedWorkers,
    3,
    "10-lead request must dynamically size to 3 workers when >= 3 areas and >= 3 slots are available",
  );

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
      areaStartTimes.set(area, Date.now());

      // Simulate network / scraping latency
      await new Promise((r) => setTimeout(r, 60));

      areaEndTimes.set(area, Date.now());
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

  assert.equal(result.poolSize, 3);
  assert.equal(result.startedWorkers, 6);
  assert.equal(maxConcurrentSlots, 3, "Exactly 3 workers must hold browser slots concurrently");

  // Verify pool start event
  const poolStart = events.find((e) => e.type === "pool_start");
  assert.ok(poolStart);
  if (poolStart?.type === "pool_start") {
    assert.equal(poolStart.poolSize, 3);
  }

  // Verify worker started events
  const workerStarts = events.filter((e) => e.type === "worker_started");
  assert.equal(workerStarts.length, 6);

  // Verify temporal overlap: worker 1 (Downtown) and worker 2 (North) were active concurrently
  const dtStart = areaStartTimes.get("Downtown");
  const dtEnd = areaEndTimes.get("Downtown");
  const nStart = areaStartTimes.get("North");
  const nEnd = areaEndTimes.get("North");

  assert.ok(dtStart != null && dtEnd != null);
  assert.ok(nStart != null && nEnd != null);
  assert.ok(
    dtStart <= nEnd && nStart <= dtEnd,
    `Initial concurrent areas must overlap in time (Downtown: ${dtStart}-${dtEnd}, North: ${nStart}-${nEnd})`,
  );
});
