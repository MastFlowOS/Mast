import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { trySharedPidAdmission, setMemoryCapacityForTesting, __testing_sharedPidAdmission } = await import("../../lib/resourceCapacity.js");
const { runAreaWorkerPool } = await import("../googleAreaPool.js");
const { createBrowserSlotPool } = await import("../../lib/browserSlotPool.js");
const { resolveZeroSlotCityScheduling } = await import("../cityScheduling.js");

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
          failed: true,
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
  });
});
