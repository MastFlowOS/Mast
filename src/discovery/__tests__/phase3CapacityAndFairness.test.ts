import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { trySharedPidAdmission, setMemoryCapacityForTesting, computeSafeResourceCapacity, __testing_sharedPidAdmission } = await import("../../lib/resourceCapacity.js");
const { runAreaWorkerPool } = await import("../googleAreaPool.js");
const { createBrowserSlotPool } = await import("../../lib/browserSlotPool.js");
const { resolveZeroSlotCityScheduling, computeCitySlotCap } = await import("../cityScheduling.js");

describe("Phase 3: Crash Resilience and Capacity Fairness", () => {
  describe("Memory Headroom Resource Admission", () => {
    it("rejects admission when cgroup memory headroom is insufficient", () => {
      // Limit: 512MB, Current: 350MB, Reserve: 100MB, PerBrowser: 120MB
      // Available = 512 - 100 - 350 = 62MB < 120MB -> Insufficient!
      setMemoryCapacityForTesting({
        limitMb: 512,
        currentMb: 350,
        reserveMb: 100,
        perBrowserMb: 120,
      });

      try {
        const result = trySharedPidAdmission(1, 4);
        assert.equal(result.granted, false);
        assert.match(result.reason ?? "", /insufficient cgroup memory headroom/);
      } finally {
        setMemoryCapacityForTesting(null);
      }
    });

    it("admits when cgroup memory headroom is sufficient", () => {
      // Limit: 1024MB, Current: 300MB, Reserve: 100MB, PerBrowser: 120MB
      // Available = 1024 - 100 - 300 = 624MB >= 120MB -> Admitted!
      setMemoryCapacityForTesting({
        limitMb: 1024,
        currentMb: 300,
        reserveMb: 100,
        perBrowserMb: 120,
      });

      try {
        const result = trySharedPidAdmission(1, 4);
        assert.equal(result.granted, true);
        if (result.granted) {
          result.release();
        }
      } finally {
        setMemoryCapacityForTesting(null);
      }
    });

    it("falls back to PID headroom when cgroup memory is unreadable/null", () => {
      setMemoryCapacityForTesting(null);
      __testing_sharedPidAdmission.setPidCapacity({ pidsMax: 1000, pidsCurrent: 100 });

      try {
        // Concurrency 1 under safe limit
        const result = trySharedPidAdmission(1, 4);
        assert.equal(result.granted, true);
        if (result.granted) {
          result.release();
        }
      } finally {
        __testing_sharedPidAdmission.setPidCapacity(undefined);
      }
    });
  });

  describe("Capacity Fairness and Anti-Starvation", () => {
    it("yields slots when consecutive zero-yield areas reach threshold", async () => {
      const areas = ["area-1", "area-2", "area-3", "area-4", "area-5"];
      let claimIdx = 0;

      const poolResult = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: areas.length,
        availableCapacity: 2,
        maxConsecutiveZeroYieldAreas: 3,
        claimNextArea: async () => {
          if (claimIdx >= areas.length) return undefined;
          return areas[claimIdx++];
        },
        runArea: async (_area) => {
          // Simulate zero candidates discovered
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            failed: false,
          };
        },
      });

      assert.equal(poolResult.yieldedSlotsForFairness, true);
      assert.equal(poolResult.stoppedReason, "zero_yield_limit");
      assert.ok(poolResult.areasProcessed.length <= 4, "Stopped early to prevent holding slots");
      assert.ok(poolResult.consecutiveZeroYieldCount >= 3);
    });

    it("resets consecutive zero-yield count when an area produces accepted leads", async () => {
      const areas = ["area-1", "area-2", "area-3", "area-4"];
      let claimIdx = 0;

      const poolResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: areas.length,
        availableCapacity: 1,
        maxConsecutiveZeroYieldAreas: 3,
        claimNextArea: async () => {
          if (claimIdx >= areas.length) return undefined;
          return areas[claimIdx++];
        },
        runArea: async (area) => {
          // Area 2 produces a lead, resetting the consecutive zero-yield counter
          if (area === "area-2") {
            return { discovered: 1, accepted: 1, rejected: 0, duplicates: 0, failed: false };
          }
          return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, failed: false };
        },
      });

      // Since area-2 yielded 1 accepted lead, it did not hit 3 consecutive zero-yield areas!
      assert.equal(poolResult.yieldedSlotsForFairness, false);
      assert.equal(poolResult.stoppedReason, "areas_exhausted");
      assert.equal(poolResult.totals.accepted, 1);
    });

    it("anti-starvation test: failing City A yields slot, unblocking deferred City B (Los Angeles)", async () => {
      const slotPool = createBrowserSlotPool(1); // Exactly 1 shared slot

      // City A areas all fail with 0 yield
      const cityAAreas = ["ny-1", "ny-2", "ny-3", "ny-4"];
      let claimAIdx = 0;

      // City B is deferred while City A runs
      let cityBDeferredAttempts = 0;
      const initialCityBDecision = resolveZeroSlotCityScheduling({
        hasRemainingWork: true,
        deferredNoSlot: true,
        priorDeferrals: cityBDeferredAttempts,
        isPlanTerminal: false,
      });
      assert.equal(initialCityBDecision.action, "defer");
      cityBDeferredAttempts = initialCityBDecision.nextDeferrals;

      // Run City A pool with maxConsecutiveZeroYieldAreas = 2
      const poolAResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: cityAAreas.length,
        availableCapacity: slotPool.available(),
        tryAcquireSlot: () => slotPool.tryAcquire(),
        maxConsecutiveZeroYieldAreas: 2,
        claimNextArea: async () => {
          if (claimAIdx >= cityAAreas.length) return undefined;
          return cityAAreas[claimAIdx++];
        },
        runArea: async () => ({
          discovered: 0,
          accepted: 0,
          rejected: 0,
          duplicates: 0,
          failed: false,
        }),
      });

      assert.equal(poolAResult.yieldedSlotsForFairness, true);
      assert.equal(poolAResult.stoppedReason, "zero_yield_limit");

      // Verify City A defers fairly without consuming attempts
      const cityADecision = resolveZeroSlotCityScheduling({
        hasRemainingWork: true,
        deferredNoSlot: true,
        priorDeferrals: 0,
        isPlanTerminal: false,
      });
      assert.equal(cityADecision.action, "defer");
      assert.equal(cityADecision.consumeAttempt, false);

      // City A has stopped and released the slot!
      assert.equal(slotPool.available(), 1, "Slot is freed after City A yields");

      // Now City B (Los Angeles) runs and acquires the slot
      const cityBAreas = ["la-downtown", "la-hollywood"];
      let claimBIdx = 0;

      const poolBResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: cityBAreas.length,
        availableCapacity: slotPool.available(),
        tryAcquireSlot: () => slotPool.tryAcquire(),
        claimNextArea: async () => {
          if (claimBIdx >= cityBAreas.length) return undefined;
          return cityBAreas[claimBIdx++];
        },
        runArea: async () => ({
          discovered: 5,
          accepted: 5,
          rejected: 0,
          duplicates: 0,
          failed: false,
        }),
      });

      assert.equal(poolBResult.totals.accepted, 10);
      assert.equal(poolBResult.stoppedReason, "areas_exhausted");
      assert.equal(slotPool.available(), 1, "Slot is freed after City B completes");
    });

    it("Phase 5: computeSafeResourceCapacity scales properly with cgroup memory limits", () => {
      // 954MB limit with base 60, reserve 128, perBrowser 260 -> (954-60-128)/260 = 2.946 -> cap 2
      const res954 = computeSafeResourceCapacity({
        cgroupMemoryLimitMb: 954,
        baseMemoryMb: 60,
        reserveMemoryMb: 128,
        perBrowserMb: 260,
        pidsMax: 1000,
        pidsCurrent: 100,
        pidsPerAreaWorker: 20,
        reservePids: 300,
        fallbackCeiling: 2,
      });
      assert.equal(res954.cgroupMemoryWorkerCeiling, 2);
      assert.equal(res954.safeAreaWorkers, 2);

      // 2GB (2048MB) limit -> (2048-60-128)/260 = 7.15 -> capped at configured max 6
      const res2GB = computeSafeResourceCapacity({
        cgroupMemoryLimitMb: 2048,
        baseMemoryMb: 60,
        reserveMemoryMb: 128,
        perBrowserMb: 260,
        configuredCeiling: 6,
        pidsMax: 1000,
        pidsCurrent: 100,
        pidsPerAreaWorker: 20,
        reservePids: 300,
        fallbackCeiling: 2,
      });
      assert.equal(res2GB.safeAreaWorkers, 6);

      // Cgroup unreadable (null) -> falls back to PID-based capacity
      const resUnreadable = computeSafeResourceCapacity({
        cgroupMemoryLimitMb: null,
        pidsMax: 1000,
        pidsCurrent: 100,
        pidsPerAreaWorker: 20,
        reservePids: 300,
        fallbackCeiling: 2,
      });
      assert.equal(resUnreadable.cgroupMemoryWorkerCeiling, null);
      assert.ok(resUnreadable.safeAreaWorkers >= 1);
    });

    it("Phase 6: fair city slot allocation prevents city slot monopolization (3 cities, 2 slots)", () => {
      // 3 pending cities, 2 total slots -> each city gets floor(2/3) min 1 = 1 slot cap
      const cap = computeCitySlotCap(2, 3);
      assert.equal(cap, 1, "Each city must get at most 1 slot so all cities get fair access");
    });

    it("Phase 6: infra failures do NOT trip zero_yield_limit", async () => {
      const areas = ["area-infra-1", "area-infra-2", "area-infra-3"];
      let claimIdx = 0;

      const poolResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: areas.length,
        availableCapacity: 1,
        maxConsecutiveZeroYieldAreas: 2,
        claimNextArea: async () => {
          if (claimIdx >= areas.length) return undefined;
          return areas[claimIdx++];
        },
        runArea: async (area) => {
          if (area === "area-infra-1") {
            return {
              discovered: 0,
              accepted: 0,
              rejected: 0,
              duplicates: 0,
              failed: true,
              failureReason: "PANEL_VERIFICATION_FAILED",
              error: "Panel verification failed",
            };
          }
          if (area === "area-infra-2") {
            return {
              discovered: 0,
              accepted: 0,
              rejected: 0,
              duplicates: 0,
              failed: true,
              failureReason: "WATCHDOG_TIMEOUT",
              error: "Watchdog timeout",
            };
          }
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            failed: true,
            error: "Chromium target crashed",
          };
        },
      });

      // Infra failures do NOT increment consecutiveZeroYieldCount, so zero_yield_limit does NOT trip!
      assert.equal(poolResult.yieldedSlotsForFairness, false);
      assert.notEqual(poolResult.stoppedReason, "zero_yield_limit");
      assert.equal(poolResult.consecutiveZeroYieldCount, 0);
      assert.equal(poolResult.failedAreaCount, 3);
    });

    it("Phase 6: re-queued areas run after a yield when passed as carryover", async () => {
      const processed: string[] = [];

      // Initial pass: area-1 fails and is re-queued, area-2 is empty and trips zero-yield
      const poolResult1 = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: 2,
        availableCapacity: 1,
        maxAreaRetries: 1,
        maxConsecutiveZeroYieldAreas: 1,
        claimNextArea: async () => {
          if (processed.includes("area-1") && !processed.includes("area-2")) return "area-2";
          if (!processed.includes("area-1")) return "area-1";
          return undefined;
        },
        runArea: async (area, _slot, retryCount) => {
          processed.push(area);
          if (area === "area-1" && retryCount === 0) {
            return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, failed: true, error: "transient network" };
          }
          return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, failed: false };
        },
      });

      // Pool 1 yields for fairness and has area-1 in requeuedAreas
      assert.equal(poolResult1.yieldedSlotsForFairness, true);
      assert.ok(poolResult1.requeuedAreas?.includes("area-1"));

      // Second pass receives carryoverAreas and runs area-1 first
      const runOrder: string[] = [];
      const poolResult2 = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: 2,
        availableCapacity: 1,
        carryoverAreas: poolResult1.requeuedAreas,
        claimNextArea: async () => "area-3",
        runArea: async (area) => {
          runOrder.push(area);
          return { discovered: 2, accepted: 2, rejected: 0, duplicates: 0, failed: false };
        },
      });

      assert.equal(runOrder[0], "area-1", "Carryover area must be run first before claiming new areas");
      assert.equal(poolResult2.totals.accepted, 4);
    });

    it("Phase 6 / Task 5: city with ONLY infra failures yields slot at maxCitySlotHoldingMs cap, unblocking deferred city, and re-queued areas survive", async () => {
      const slotPool = createBrowserSlotPool(1);
      const processedOrder: string[] = [];
      const cityAAreas = ["infra-area-1", "infra-area-2", "infra-area-3"];
      let claimAIdx = 0;

      const poolAResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: cityAAreas.length,
        availableCapacity: slotPool.available(),
        tryAcquireSlot: () => slotPool.tryAcquire(),
        maxAreaRetries: 2,
        areaBackoffBaseMs: 5,
        maxCitySlotHoldingMs: 30,
        claimNextArea: async () => {
          if (claimAIdx >= cityAAreas.length) return undefined;
          return cityAAreas[claimAIdx++];
        },
        runArea: async (area) => {
          processedOrder.push(area);
          await new Promise((r) => setTimeout(r, 35));
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            failed: true,
            failureReason: "PANEL_VERIFICATION_FAILED",
            error: "Panel verification failed",
          };
        },
      });

      assert.equal(poolAResult.yieldedSlotsForFairness, true);
      assert.equal(poolAResult.stoppedReason, "zero_yield_limit");
      assert.equal(poolAResult.consecutiveZeroYieldCount, 0);
      assert.ok(poolAResult.requeuedAreas && poolAResult.requeuedAreas.length > 0, "Re-queued areas must survive");
      assert.ok(poolAResult.requeuedAreas.includes("infra-area-2"));
      assert.equal(slotPool.available(), 1, "Browser slot is freed after City A yields");

      const poolBResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: 1,
        availableCapacity: slotPool.available(),
        tryAcquireSlot: () => slotPool.tryAcquire(),
        claimNextArea: async () => "la-downtown",
        runArea: async () => ({
          discovered: 3,
          accepted: 3,
          rejected: 0,
          duplicates: 0,
          failed: false,
        }),
      });

      assert.equal(poolBResult.totals.accepted, 3);
      assert.equal(poolBResult.stoppedReason, "areas_exhausted");
      assert.equal(slotPool.available(), 1);
    });
  });
});
