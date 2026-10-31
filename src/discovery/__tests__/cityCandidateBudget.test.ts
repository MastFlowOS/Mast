import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CityCandidateBudgetCoordinator } from "../candidateBudget.js";
import { runAreaWorkerPool, type AreaWorkerLogEvent } from "../googleAreaPool.js";
import { resolveEngineOutcome } from "../../scraperBridge/pythonBridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("MAST Phase 3: City-Wide Candidate Budget & Concurrency Integration", () => {
  // Scenario 1
  test("Scenario 1: Three active area workers share one coordinator and collectively admit no more than 40 candidates", async () => {
    const cityBudget = 40;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);
    const workerCounts: Record<string, number> = { "area-1": 0, "area-2": 0, "area-3": 0 };
    const areas = ["area-1", "area-2", "area-3"];

    const abortControllers = new Map<string, AbortController>();
    for (const a of areas) {
      const ac = new AbortController();
      abortControllers.set(a, ac);
      coordinator.registerActiveWorker(a, () => ac.abort("BUDGET_EXHAUSTED"));
    }

    async function runWorker(areaId: string) {
      const ac = abortControllers.get(areaId)!;
      for (let c = 0; c < 40; c++) {
        if (ac.signal.aborted || coordinator.isExhausted()) break;
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5) + 1));
        if (!coordinator.tryAdmitCandidate()) break;
        workerCounts[areaId] += 1;
      }
    }

    await Promise.all(areas.map(runWorker));

    const totalAdmitted = Object.values(workerCounts).reduce((a, b) => a + b, 0);
    assert.equal(totalAdmitted, 40, `Expected exactly 40 candidates admitted, got ${totalAdmitted}`);
    assert.equal(coordinator.admittedCount, 40);
    assert.equal(coordinator.remainingBudget, 0);
    assert.equal(coordinator.isExhausted(), true);
    for (const a of areas) {
      assert.ok(workerCounts[a] > 0, `Area ${a} should have admitted candidates, got ${workerCounts[a]}`);
    }
  });

  // Scenario 2
  test("Scenario 2: Six areas, including later-scheduled areas, never exceed the aggregate budget", async () => {
    const cityBudget = 40;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);
    const areas = ["area-1", "area-2", "area-3", "area-4", "area-5", "area-6"];
    const admittedPerArea: Record<string, number> = {};
    for (const a of areas) admittedPerArea[a] = 0;

    const poolResult = await runAreaWorkerPool({
      configuredWorkers: 3,
      totalCuratedAreas: areas.length,
      availableCapacity: 3,
      requestedQuantity: 10,
      isBudgetExhausted: () => coordinator.isExhausted(),
      claimNextArea: async (used) => {
        const remaining = areas.filter((a) => !used.has(a));
        return remaining[0];
      },
      runArea: async (area) => {
        const ac = new AbortController();
        const unregister = coordinator.registerActiveWorker(area, () => ac.abort("BUDGET_EXHAUSTED"));
        try {
          for (let i = 0; i < 20; i++) {
            if (ac.signal.aborted || coordinator.isExhausted()) break;
            await new Promise((r) => setTimeout(r, 2));
            if (!coordinator.tryAdmitCandidate()) break;
            admittedPerArea[area] += 1;
          }
        } finally {
          unregister();
        }
        return {
          discovered: admittedPerArea[area],
          accepted: admittedPerArea[area],
          rejected: 0,
          duplicates: 0,
          exhausted: false,
          failed: false,
        };
      },
    });

    const totalAdmitted = Object.values(admittedPerArea).reduce((a, b) => a + b, 0);
    assert.equal(totalAdmitted, 40, `Expected exactly 40 total admitted across all 6 areas, got ${totalAdmitted}`);
    assert.equal(poolResult.totals.discovered, 40);
    assert.equal(poolResult.stoppedReason, "budget_exhausted");
    assert.equal(coordinator.isExhausted(), true);
  });

  // Scenario 3
  test("Scenario 3: The final admitted candidate (candidate 40) is processed successfully after budget exhaustion is triggered", async () => {
    const cityBudget = 40;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);
    const inFlight = new Set<Promise<void>>();
    const processedCandidates: { id: number; delivered: boolean }[] = [];

    const areaAbort = new AbortController();
    coordinator.registerActiveWorker("area-final-test", () => {
      areaAbort.abort("BUDGET_EXHAUSTED");
    });

    for (let c = 1; c <= 50; c++) {
      if (coordinator.isExhausted() || areaAbort.signal.aborted) break;

      if (!coordinator.tryAdmitCandidate()) {
        break; // Rejected
      }

      const candidateId = c;
      const task = (async () => {
        // Simulate async downstream validation, enrichment, delivery
        await new Promise((r) => setTimeout(r, 15));
        processedCandidates.push({ id: candidateId, delivered: true });
      })();

      const wrapped = task.finally(() => {
        inFlight.delete(wrapped);
      });
      inFlight.add(wrapped);
    }

    // Drain all in-flight candidate tasks
    await Promise.all(inFlight);

    assert.equal(coordinator.admittedCount, 40);
    assert.equal(coordinator.isExhausted(), true);
    assert.equal(processedCandidates.length, 40);
    // Specifically verify Candidate 40 was admitted and finished
    const candidate40 = processedCandidates.find((c) => c.id === 40);
    assert.ok(candidate40, "Candidate 40 must be in the processed candidates list");
    assert.equal(candidate40.delivered, true, "Candidate 40 must complete delivery processing");
    // Verify candidate 41 was never admitted
    assert.equal(processedCandidates.some((c) => c.id === 41), false, "Candidate 41 must not be admitted");
  });

  // Scenario 4
  test("Scenario 4: Active workers stop and their Python subprocesses are confirmed closed upon budget exhaustion", async () => {
    const { runEngineQuery } = await import("../../scraperBridge/pythonBridge.js");
    const { env } = await import("../../config/env.js");
    const fixturesDir = path.resolve(__dirname, "../../scraperBridge/__tests__/fixtures/target-reached-engine");
    const originalEnginePath = env.SCRAPER_ENGINE_PATH;
    env.SCRAPER_ENGINE_PATH = fixturesDir;

    const budget = 3;
    const coordinator = new CityCandidateBudgetCoordinator(budget);
    const ac = new AbortController();
    const unregister = coordinator.registerActiveWorker("area-subprocess-test", () => {
      ac.abort("BUDGET_EXHAUSTED");
    });

    let doneInfo: any = null;
    const admittedLeads: any[] = [];

    try {
      for await (const lead of runEngineQuery(
        { query: "test", city: "TestCity", max_results: 20 },
        ac.signal,
        (info) => {
          doneInfo = info;
        },
      )) {
        if (!coordinator.tryAdmitCandidate()) {
          break;
        }
        admittedLeads.push(lead);
      }
    } finally {
      unregister();
      env.SCRAPER_ENGINE_PATH = originalEnginePath;
    }

    assert.equal(admittedLeads.length, 3, "Exactly 3 leads admitted before budget exhausted");
    assert.equal(coordinator.admittedCount, 3);
    assert.equal(coordinator.isExhausted(), true);
    assert.ok(doneInfo !== null, "onDone must be called upon process completion");
    assert.equal(doneInfo.success, true, "Process exit under BUDGET_EXHAUSTED must succeed");
    assert.equal(doneInfo.terminationReason, "SUCCESS_CONSUMER_STOPPED");
    assert.equal(doneInfo.schedulerReason, "SUCCESS_CONSUMER_STOPPED");
    assert.equal(doneInfo.failureReason, undefined);
    assert.equal(doneInfo.watchdogReason, undefined);
  });

  // Scenario 5
  test("Scenario 5: The pool waits for shutdown and in-flight candidate processing to finish", async () => {
    const cityBudget = 10;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);
    let inFlightCount = 0;
    let drainedCleanly = false;

    await runAreaWorkerPool({
      configuredWorkers: 2,
      totalCuratedAreas: 2,
      availableCapacity: 2,
      requestedQuantity: 5,
      isBudgetExhausted: () => coordinator.isExhausted(),
      claimNextArea: async (used) => {
        const remaining = ["A1", "A2"].filter((a) => !used.has(a));
        return remaining[0];
      },
      runArea: async (area) => {
        const inFlight = new Set<Promise<void>>();
        for (let i = 0; i < 15; i++) {
          if (coordinator.isExhausted()) break;
          if (!coordinator.tryAdmitCandidate()) break;
          inFlightCount += 1;
          const p = (async () => {
            await new Promise((r) => setTimeout(r, 25));
            inFlightCount -= 1;
          })();
          const wrapped = p.finally(() => inFlight.delete(wrapped));
          inFlight.add(wrapped);
        }
        await Promise.all(inFlight);
        drainedCleanly = inFlight.size === 0;
        return {
          discovered: 5,
          accepted: 5,
          rejected: 0,
          duplicates: 0,
          exhausted: false,
          failed: false,
        };
      },
    });

    assert.equal(coordinator.admittedCount, 10);
    assert.equal(coordinator.isExhausted(), true);
    assert.equal(inFlightCount, 0, "All in-flight candidate tasks must be drained before pool completes");
    assert.equal(drainedCleanly, true);
  });

  // Scenario 6
  test("Scenario 6: No new area attempt starts after budget exhaustion", async () => {
    const cityBudget = 20;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);
    const areas = ["A1", "A2", "A3", "A4", "A5", "A6"];
    const startedAreas: string[] = [];

    const poolResult = await runAreaWorkerPool({
      configuredWorkers: 2,
      totalCuratedAreas: areas.length,
      availableCapacity: 2,
      requestedQuantity: 5,
      isBudgetExhausted: () => coordinator.isExhausted(),
      claimNextArea: async (used) => {
        const remaining = areas.filter((a) => !used.has(a));
        return remaining[0];
      },
      runArea: async (area) => {
        startedAreas.push(area);
        // Each of the first 2 areas admits 10 candidates -> total 20 -> exhausts budget
        for (let i = 0; i < 10; i++) {
          coordinator.tryAdmitCandidate();
        }
        return {
          discovered: 10,
          accepted: 10,
          rejected: 0,
          duplicates: 0,
          exhausted: false,
          failed: false,
        };
      },
    });

    assert.equal(coordinator.admittedCount, 20);
    assert.equal(coordinator.isExhausted(), true);
    // Only A1 and A2 should ever have started. A3-A6 must not start!
    assert.deepEqual(startedAreas, ["A1", "A2"], "Only 2 areas should have run; remaining 4 must not start");
    assert.equal(poolResult.stoppedReason, "budget_exhausted");
  });

  // Scenario 7
  test("Scenario 7: A separate city task retains an independent budget (no cross-task contamination)", async () => {
    const taskA_budget = 40;
    const taskB_budget = 40;
    const coordinatorA = new CityCandidateBudgetCoordinator(taskA_budget);
    const coordinatorB = new CityCandidateBudgetCoordinator(taskB_budget);

    // Task A consumes all 40 slots
    for (let i = 0; i < 40; i++) {
      assert.equal(coordinatorA.tryAdmitCandidate(), true);
    }
    assert.equal(coordinatorA.isExhausted(), true);
    assert.equal(coordinatorA.remainingBudget, 0);

    // Task B must be completely untouched and independent
    assert.equal(coordinatorB.isExhausted(), false);
    assert.equal(coordinatorB.remainingBudget, 40);

    // Task B can consume its own 40 slots independently
    for (let i = 0; i < 40; i++) {
      assert.equal(coordinatorB.tryAdmitCandidate(), true);
    }
    assert.equal(coordinatorB.isExhausted(), true);
    assert.equal(coordinatorB.admittedCount, 40);
  });

  // Scenario 8
  test("Scenario 8: User cancellation remains strictly distinguishable from budget exhaustion", () => {
    // 1. User cancellation outcome
    const cancelOutcome = resolveEngineOutcome({
      success: false,
      targetReached: false,
      rawFailureReason: "USER_CANCELLED",
      rawFailureDetail: "User cancelled task",
      rawTerminationReason: "USER_CANCELLED",
      timedOut: false,
      timedOutReason: null,
      isUserCancelled: true,
      isRealAbort: true,
      isTargetReachedEarlyStop: false,
    });

    assert.equal(cancelOutcome.success, false);
    assert.equal(cancelOutcome.terminationReason, "USER_CANCELLED");
    assert.equal(cancelOutcome.failureReason, "USER_CANCELLED");
    assert.equal(cancelOutcome.schedulerReason, "USER_CANCELLED");

    // 2. Budget exhaustion outcome
    const budgetOutcome = resolveEngineOutcome({
      success: true,
      targetReached: false,
      rawFailureReason: undefined,
      rawFailureDetail: undefined,
      rawTerminationReason: "SUCCESS_CONSUMER_STOPPED",
      timedOut: false,
      timedOutReason: null,
      isUserCancelled: false,
      isRealAbort: false, // isConsumerStopReason === true
      isTargetReachedEarlyStop: false,
    });

    assert.equal(budgetOutcome.success, true);
    assert.equal(budgetOutcome.terminationReason, "SUCCESS_CONSUMER_STOPPED");
    assert.equal(budgetOutcome.failureReason, undefined);
    assert.equal(budgetOutcome.schedulerReason, "SUCCESS_CONSUMER_STOPPED");
    assert.notEqual(budgetOutcome.shouldRetry, true);

    // Strict distinction
    assert.notEqual(budgetOutcome.terminationReason, cancelOutcome.terminationReason);
    assert.notEqual(budgetOutcome.success, cancelOutcome.success);
  });

  // Scenario 9
  test("Scenario 9: Normal target-reached completion remains unchanged and distinct from budget exhaustion", () => {
    const targetReachedOutcome = resolveEngineOutcome({
      success: true,
      targetReached: true,
      rawFailureReason: undefined,
      rawFailureDetail: undefined,
      rawTerminationReason: "SUCCESS_TARGET_REACHED",
      timedOut: false,
      timedOutReason: null,
      isUserCancelled: false,
      isRealAbort: false,
      isTargetReachedEarlyStop: true,
    });

    assert.equal(targetReachedOutcome.success, true);
    assert.equal(targetReachedOutcome.targetReached, true);
    assert.equal(targetReachedOutcome.terminationReason, "SUCCESS_TARGET_REACHED");
    assert.equal(targetReachedOutcome.schedulerReason, "SUCCESS_TARGET_REACHED");
    assert.equal(targetReachedOutcome.failureReason, undefined);
    assert.notEqual(targetReachedOutcome.terminationReason, "SUCCESS_CONSUMER_STOPPED");
  });

  // Underproducing area
  test("Underproducing area: Area 1 yields 5 then exhausts; Areas 2 & 3 consume remaining 35", async () => {
    const cityBudget = 40;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);
    const admitted: Record<string, number> = { "area-1": 0, "area-2": 0, "area-3": 0 };

    async function runWorker(areaId: string, maxAvailable: number) {
      const ac = new AbortController();
      const unregister = coordinator.registerActiveWorker(areaId, () => ac.abort("BUDGET_EXHAUSTED"));
      try {
        for (let i = 0; i < maxAvailable; i++) {
          if (ac.signal.aborted || coordinator.isExhausted()) break;
          await new Promise((r) => setTimeout(r, 2));
          if (!coordinator.tryAdmitCandidate()) break;
          admitted[areaId] += 1;
        }
      } finally {
        unregister();
      }
    }

    await Promise.all([
      runWorker("area-1", 5),
      runWorker("area-2", 30),
      runWorker("area-3", 30),
    ]);

    assert.equal(admitted["area-1"], 5);
    assert.equal(admitted["area-2"] + admitted["area-3"], 35);
    assert.equal(coordinator.admittedCount, 40);
    assert.equal(coordinator.remainingBudget, 0);
  });

  // Race safety (500 concurrent admissions)
  test("Race safety: 500 simultaneous candidate admissions across concurrent workers", async () => {
    const cityBudget = 40;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);

    const results = await Promise.all(
      Array.from({ length: 500 }, async () => {
        await new Promise((r) => setImmediate(r));
        return coordinator.tryAdmitCandidate();
      }),
    );

    const successful = results.filter((res) => res === true).length;
    const rejected = results.filter((res) => res === false).length;

    assert.equal(successful, 40);
    assert.equal(rejected, 460);
    assert.equal(coordinator.admittedCount, 40);
    assert.equal(coordinator.remainingBudget, 0);
    assert.equal(coordinator.isExhausted(), true);
  });

  // Pipeline accounting & deduplication
  test("Accounting and deduplication: Deduplicated / rejected candidates still consume admission slot", async () => {
    const cityBudget = 40;
    const coordinator = new CityCandidateBudgetCoordinator(cityBudget);

    let accepted = 0;
    let deduplicated = 0;
    let rejectedQuality = 0;
    let rejectedChannels = 0;
    let totalAdmitted = 0;

    for (let i = 1; i <= 60; i++) {
      if (!coordinator.tryAdmitCandidate()) break;
      totalAdmitted += 1;

      if (i % 4 === 0) deduplicated += 1;
      else if (i % 3 === 0) rejectedQuality += 1;
      else if (i % 5 === 0) rejectedChannels += 1;
      else accepted += 1;
    }

    assert.equal(totalAdmitted, 40);
    assert.equal(coordinator.admittedCount, 40);
    assert.equal(accepted + deduplicated + rejectedQuality + rejectedChannels, 40);
  });
});
