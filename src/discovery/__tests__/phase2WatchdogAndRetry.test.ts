/**
 * Acceptance tests for Phase 2: Watchdog and Retry Alignment.
 *
 * Verifies:
 * 1. Startup assertion: cardAttemptDeadlineMs >= card timeout x attempts (+ margin)
 *    and recoveryDeadlineMs covers return-to-results rounds.
 * 2. Slow-but-recovering card simulation: card operation taking > 60s is NOT killed
 *    by watchdog under the aligned budget (150s), and succeeds upon card_processed.
 * 3. Area worker retry bounding: failed areas (SCRAPER_FAILURE, WATCHDOG_TIMEOUT)
 *    are re-queued with bounded retries (max 2) and backoff before terminal FAILED.
 * 4. Area worker retry recovery: area that fails once but succeeds on retry is marked
 *    healthy (failed: false) in the final pool result.
 * 5. USER_CANCELLED areas are NEVER retried.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeWatchdogBudgets,
  assertWatchdogBudgetsValid,
  DEFAULT_SCRAPER_RETRY_BUDGET,
  WatchdogStateMachine,
  dispatchWatchdogProgressEvent,
  runEngineQuery,
  resolveAreaAttemptCeilingMs,
} from "../../scraperBridge/pythonBridge.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";
import { GoogleMapsProvider } from "../providers/googleMaps/googleMapsProvider.js";
import { cityTransitionFor } from "../cityScheduling.js";

describe("Phase 2: Watchdog and Retry Alignment", () => {
  describe("Watchdog Budget Derivation and Startup Assertion", () => {
    test("computeWatchdogBudgets derives deadlines covering scraper retry budget", () => {
      const budgets = computeWatchdogBudgets();
      assert.ok(
        budgets.cardAttemptDeadlineMs >=
          DEFAULT_SCRAPER_RETRY_BUDGET.cardOperationTimeoutMs *
            DEFAULT_SCRAPER_RETRY_BUDGET.maxCardAttempts +
            DEFAULT_SCRAPER_RETRY_BUDGET.cardMarginMs,
        "cardAttemptDeadlineMs must cover card timeouts x attempts + margin",
      );
      assert.ok(
        budgets.recoveryDeadlineMs >=
          DEFAULT_SCRAPER_RETRY_BUDGET.maxReturnToResultsRounds *
            DEFAULT_SCRAPER_RETRY_BUDGET.mapsTimeoutMs +
            DEFAULT_SCRAPER_RETRY_BUDGET.recoveryMarginMs,
        "recoveryDeadlineMs must cover return-to-results rounds",
      );
      // Must not throw for valid budgets
      assert.doesNotThrow(() => assertWatchdogBudgetsValid(budgets));
    });

    test("assertWatchdogBudgetsValid throws if cardAttemptDeadlineMs is under-budgeted", () => {
      assert.throws(
        () =>
          assertWatchdogBudgetsValid({
            cardAttemptDeadlineMs: 60_000, // old hardcoded 60s
            recoveryDeadlineMs: 100_000,
          }),
        /cardAttemptDeadlineMs \(60000ms\) must be >= card timeout x attempts \+ margin/,
      );
    });

    test("assertWatchdogBudgetsValid throws if recoveryDeadlineMs is under-budgeted", () => {
      assert.throws(
        () =>
          assertWatchdogBudgetsValid({
            cardAttemptDeadlineMs: 150_000,
            recoveryDeadlineMs: 70_000, // old hardcoded 70s
          }),
        /recoveryDeadlineMs \(70000ms\) must cover return-to-results rounds/,
      );
    });

    test("assertWatchdogBudgetsValid throws if progressTimeoutMs is under-budgeted", () => {
      assert.throws(
        () =>
          assertWatchdogBudgetsValid({
            cardAttemptDeadlineMs: 150_000,
            recoveryDeadlineMs: 100_000,
            progressTimeoutMs: 90_000, // old hardcoded 90s progress timeout
          }),
        /progressTimeoutMs \(90000ms\) must be >= card timeout x attempts \+ margin/,
      );
    });

    test("simulates a slow-but-recovering card and confirms it is not killed at 60s or 90s", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;
      let timedOutDetail: string | null = null;

      const watchdog = new WatchdogStateMachine({
        // Uses default aligned budget (cardAttemptDeadlineMs = 150_000ms, progressTimeoutMs = 150_000ms)
        livenessTimeoutMs: 300_000,
        onTimeout: (reason, detail) => {
          timedOutReason = reason;
          timedOutDetail = detail;
        },
      });

      // 1. Service ready -> scrolling
      dispatchWatchdogProgressEvent(watchdog, { event: "service_ready" });
      assert.equal(watchdog.getState(), "SCROLLING");

      // 2. Card attempt starts at t=10s
      t.mock.timers.tick(10_000);
      dispatchWatchdogProgressEvent(watchdog, {
        event: "card_attempt_started",
        item_id: "0x123:1",
      });
      assert.equal(watchdog.getState(), "CARD_ATTEMPT");

      // 3. Advance clock by 70s (total t=80s, 70s into card attempt).
      // Under the OLD 60s watchdog, this would have fired DISCOVERY_PROGRESS_TIMEOUT.
      t.mock.timers.tick(70_000);
      assert.equal(
        watchdog.isTimedOut(),
        false,
        "Watchdog must NOT fire at 70s into card attempt under aligned budget",
      );
      assert.equal(timedOutReason, null);

      // 4. Send heartbeats showing process is still alive and advance to 120s into card attempt
      // (surpassing BOTH the old 60s card deadline and the old 90s progress timeout)
      dispatchWatchdogProgressEvent(watchdog, { event: "heartbeat", seq: 1 });
      t.mock.timers.tick(30_000); // 100s into card attempt
      assert.equal(watchdog.isTimedOut(), false);
      dispatchWatchdogProgressEvent(watchdog, { event: "heartbeat", seq: 2 });
      t.mock.timers.tick(20_000); // 120s into card attempt
      assert.equal(
        watchdog.isTimedOut(),
        false,
        "Watchdog must NOT fire at 120s into slow card attempt with heartbeats",
      );

      // 5. Card successfully processes at t=120s before the 150s deadline
      dispatchWatchdogProgressEvent(watchdog, {
        event: "card_processed",
        item_id: "0x123:1:verified",
      });
      assert.equal(watchdog.getState(), "SCROLLING");

      // 6. Verify watchdog never fired
      assert.equal(watchdog.isTimedOut(), false);
      assert.equal(timedOutReason, null);
    });

    test("fires DISCOVERY_PROGRESS_TIMEOUT at initialSearchDeadlineMs when zero places/cards are discovered", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;
      let timedOutDetail: string | null = null;

      const watchdog = new WatchdogStateMachine({
        initialSearchDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        onTimeout: (reason, detail) => {
          timedOutReason = reason;
          timedOutDetail = detail;
        },
      });

      // 1. Service ready -> scrolling
      dispatchWatchdogProgressEvent(watchdog, { event: "service_ready" });
      assert.equal(watchdog.getState(), "SCROLLING");

      // 2. Advance clock by 44s: not yet timed out
      t.mock.timers.tick(44_000);
      assert.equal(watchdog.isTimedOut(), false);

      // 3. Advance clock past 45s (e.g. +2s to 46s total) with zero cards/anchors found
      t.mock.timers.tick(2_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.match(timedOutDetail ?? "", /initial search yield deadline \(45000ms\) exceeded/);
    });
  });

  describe("Bounded Area Retries in Area Worker Pool", () => {
    test("simulate repeated failure: confirms exactly 2 retries (3 total attempts) then terminal FAILED", async () => {
      const attemptsByArea: Record<string, number> = {};
      const requeuedEvents: any[] = [];

      const result = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: 1,
        availableCapacity: 2,
        maxAreaRetries: 2,
        areaBackoffBaseMs: 10, // fast in test
        claimNextArea: async (usedAreas) => (usedAreas.has("Downtown") ? undefined : "Downtown"),
        runArea: async (area, _slot, retryCount = 0) => {
          attemptsByArea[area] = (attemptsByArea[area] ?? 0) + 1;
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            exhausted: false,
            failed: true,
            error: "SCRAPER_FAILURE",
            failureReason: "SCRAPER_FAILURE",
          };
        },
        onEvent: (event) => {
          if (event.type === "area_requeued") {
            requeuedEvents.push(event);
          }
        },
      });

      assert.equal(attemptsByArea["Downtown"], 3, "area must run initial + 2 retries = 3 attempts total");
      assert.equal(requeuedEvents.length, 2, "must emit exactly 2 area_requeued events");
      assert.equal(result.allFailed, true, "pool result must report allFailed: true when retries exhausted");
      assert.equal(result.failedAreaCount, 1, "failedAreaCount must be 1");
      assert.equal(result.retryCount, 2, "total retries performed must be 2");
      assert.equal(result.perArea.length, 1);
      assert.equal(result.perArea[0].outcome.failed, true);
    });

    test("simulate failure then recovery: area fails once then succeeds on retry 1", async () => {
      const attemptsByArea: Record<string, number> = {};
      const requeuedEvents: any[] = [];

      const result = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: 1,
        availableCapacity: 2,
        maxAreaRetries: 2,
        areaBackoffBaseMs: 10,
        claimNextArea: async (usedAreas) => (usedAreas.has("Downtown") ? undefined : "Downtown"),
        runArea: async (area, _slot, retryCount = 0) => {
          attemptsByArea[area] = (attemptsByArea[area] ?? 0) + 1;
          if (retryCount === 0) {
            return {
              discovered: 0,
              accepted: 0,
              rejected: 0,
              duplicates: 0,
              exhausted: false,
              failed: true,
              error: "WATCHDOG_TIMEOUT",
              failureReason: "WATCHDOG_TIMEOUT",
            };
          }
          return {
            discovered: 5,
            accepted: 3,
            rejected: 2,
            duplicates: 0,
            exhausted: false,
            failed: false,
          };
        },
        onEvent: (event) => {
          if (event.type === "area_requeued") {
            requeuedEvents.push(event);
          }
        },
      });

      assert.equal(attemptsByArea["Downtown"], 2, "initial attempt + 1 successful retry = 2 attempts total");
      assert.equal(requeuedEvents.length, 1, "must emit 1 area_requeued event");
      assert.equal(result.allFailed, false, "pool result must report allFailed: false on recovery");
      assert.equal(result.failedAreaCount, 0, "failedAreaCount must be 0");
      assert.equal(result.retryCount, 1, "total retries performed must be 1");
      assert.equal(result.totals.accepted, 3);
      assert.equal(result.perArea[0].outcome.failed, false);
    });

    test("simulate PANEL_VERIFICATION_FAILED: retryable failure bounded by maxAreaRetries and marks failed on exhaustion", async () => {
      const attemptsByArea: Record<string, number> = {};
      const requeuedEvents: any[] = [];

      const result = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: 1,
        availableCapacity: 2,
        maxAreaRetries: 2,
        areaBackoffBaseMs: 10,
        claimNextArea: async (usedAreas) => (usedAreas.has("Downtown") ? undefined : "Downtown"),
        runArea: async (area, _slot, retryCount = 0) => {
          attemptsByArea[area] = (attemptsByArea[area] ?? 0) + 1;
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            exhausted: false,
            failed: true,
            error: "PANEL_VERIFICATION_FAILED",
            failureReason: "PANEL_VERIFICATION_FAILED",
          };
        },
        onEvent: (event) => {
          if (event.type === "area_requeued") {
            requeuedEvents.push(event);
          }
        },
      });

      assert.equal(attemptsByArea["Downtown"], 3, "must run initial + 2 retries = 3 attempts total");
      assert.equal(requeuedEvents.length, 2, "must emit 2 area_requeued events");
      assert.equal(result.allFailed, true);
      assert.equal(result.failedAreaCount, 1);
      assert.equal(result.perArea[0].outcome.failureReason, "PANEL_VERIFICATION_FAILED");
    });

    test("USER_CANCELLED must NEVER retry", async () => {
      const attemptsByArea: Record<string, number> = {};
      const requeuedEvents: any[] = [];

      const result = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: 1,
        availableCapacity: 2,
        maxAreaRetries: 2,
        areaBackoffBaseMs: 10,
        claimNextArea: async (usedAreas) => (usedAreas.has("Downtown") ? undefined : "Downtown"),
        runArea: async (area) => {
          attemptsByArea[area] = (attemptsByArea[area] ?? 0) + 1;
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            exhausted: false,
            failed: true,
            error: "USER_CANCELLED",
            failureReason: "USER_CANCELLED",
          };
        },
        onEvent: (event) => {
          if (event.type === "area_requeued") {
            requeuedEvents.push(event);
          }
        },
      });

      assert.equal(attemptsByArea["Downtown"], 1, "USER_CANCELLED must run exactly once with 0 retries");
      assert.equal(requeuedEvents.length, 0, "must NOT emit area_requeued for USER_CANCELLED");
      assert.equal(result.retryCount, 0);
    });

    test("per-area total wall-time cap: (a) preserves original failureReason and sets wallTimeCapExceeded=true", async () => {
      const attemptsByArea: Record<string, number> = {};
      const requeuedEvents: any[] = [];

      const result = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: 1,
        availableCapacity: 2,
        maxAreaRetries: 2,
        areaBackoffBaseMs: 10,
        maxAreaWallTimeMs: 50, // 50ms cap for test
        claimNextArea: async (usedAreas) => (usedAreas.has("Downtown") ? undefined : "Downtown"),
        runArea: async (area) => {
          attemptsByArea[area] = (attemptsByArea[area] ?? 0) + 1;
          // Simulate taking 60ms, exceeding the 50ms wall-time cap
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            exhausted: false,
            failed: true,
            error: "SCRAPER_FAILURE",
            failureReason: "SCRAPER_FAILURE",
          };
        },
        onEvent: (event) => {
          if (event.type === "area_requeued") {
            requeuedEvents.push(event);
          }
        },
      });

      assert.equal(attemptsByArea["Downtown"], 1, "area must NOT be retried once wall-time cap is exceeded");
      assert.equal(requeuedEvents.length, 0, "no requeue event should be emitted when wall-time cap is exceeded");
      assert.equal(result.allFailed, true);
      assert.equal(result.failedAreaCount, 1);
      assert.equal(result.perArea[0].outcome.failed, true);
      // Requirement (a): preserve original failureReason and set wallTimeCapExceeded=true
      assert.equal(result.perArea[0].outcome.failureReason, "SCRAPER_FAILURE", "must preserve original failureReason");
      assert.equal(result.perArea[0].outcome.wallTimeCapExceeded, true, "must flag wallTimeCapExceeded: true");
      assert.match(result.perArea[0].outcome.error ?? "", /area wall-time cap exceeded/);
    });

    test("per-area total wall-time cap: (b) never relabels USER_CANCELLED outcomes", async () => {
      const attemptsByArea: Record<string, number> = {};

      const result = await runAreaWorkerPool({
        configuredWorkers: 2,
        totalCuratedAreas: 1,
        availableCapacity: 2,
        maxAreaRetries: 2,
        areaBackoffBaseMs: 10,
        maxAreaWallTimeMs: 50,
        claimNextArea: async (usedAreas) => (usedAreas.has("Downtown") ? undefined : "Downtown"),
        runArea: async (area) => {
          attemptsByArea[area] = (attemptsByArea[area] ?? 0) + 1;
          // Simulate taking 60ms (> 50ms cap) before returning user cancellation
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            discovered: 0,
            accepted: 0,
            rejected: 0,
            duplicates: 0,
            exhausted: false,
            failed: true,
            error: "USER_CANCELLED",
            failureReason: "USER_CANCELLED",
          };
        },
      });

      assert.equal(attemptsByArea["Downtown"], 1);
      assert.equal(result.perArea[0].outcome.failed, true);
      // Requirement (b): never relabel USER_CANCELLED
      assert.equal(result.perArea[0].outcome.failureReason, "USER_CANCELLED", "USER_CANCELLED failureReason must never be relabeled");
      assert.equal(result.perArea[0].outcome.error, "USER_CANCELLED");
      assert.equal(result.perArea[0].outcome.wallTimeCapExceeded, true);
    });

    test("per-area total wall-time cap: (c) enforces cap while attempt is running by passing remaining budget to watchdog", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;
      let timedOutDetail: string | null = null;

      // Watchdog initialized with remainingAreaBudgetMs (e.g. 50_000ms remaining for the area)
      const remainingAreaBudgetMs = 50_000;
      const watchdog = new WatchdogStateMachine({
        livenessTimeoutMs: 100_000,
        progressTimeoutMs: 100_000,
        absoluteCeilingMs: remainingAreaBudgetMs,
        onTimeout: (reason, detail) => {
          timedOutReason = reason;
          timedOutDetail = detail;
        },
      });

      dispatchWatchdogProgressEvent(watchdog, { event: "service_ready" });
      assert.equal(watchdog.getState(), "SCROLLING");

      // Advance by 49s: not yet timed out
      t.mock.timers.tick(49_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Advance by 2s (total 51s, exceeding 50s remaining area budget while running)
      t.mock.timers.tick(2_000);
      assert.equal(watchdog.isTimedOut(), true, "Watchdog must fire when running attempt exceeds remaining area budget");
      assert.equal(timedOutReason, "WATCHDOG_TIMEOUT");
      assert.match(timedOutDetail ?? "", /absolute safety ceiling \(50000ms\) reached/);
    });

    test("per-area total wall-time cap: (c2) runAreaWorkerPool calculates and passes remainingAreaBudgetMs to runArea", async () => {
      let receivedRemainingBudget: number | undefined;

      await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: 1,
        availableCapacity: 1,
        maxAreaWallTimeMs: 100_000,
        claimNextArea: async (used) => (used.has("A1") ? undefined : "A1"),
        runArea: async (_area, _slot, _retry, remainingBudget) => {
          receivedRemainingBudget = remainingBudget;
          return {
            discovered: 1,
            accepted: 1,
            rejected: 0,
            duplicates: 0,
            exhausted: true,
            failed: false,
          };
        },
      });

      assert.ok(receivedRemainingBudget !== undefined, "runArea must receive remainingAreaBudgetMs");
      assert.ok(receivedRemainingBudget! <= 100_000 && receivedRemainingBudget! > 90_000);
    });

    test("per-area cap semantics: area yielding leads at cap is not retried, keeps delivered leads, counts in failedAreaCount and partialAreaCount", async () => {
      let callCount = 0;
      const poolResult = await runAreaWorkerPool({
        configuredWorkers: 1,
        totalCuratedAreas: 1,
        availableCapacity: 1,
        maxAreaWallTimeMs: 10,
        maxAreaRetries: 2,
        claimNextArea: async (used) => (used.has("A1") ? undefined : "A1"),
        runArea: async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 20));
          return {
            discovered: 5,
            accepted: 3,
            rejected: 2,
            duplicates: 0,
            exhausted: false,
            failed: true,
            failureReason: "WATCHDOG_TIMEOUT",
          };
        },
      });

      // (a) Confirm area is NOT retried
      assert.equal(callCount, 1, "Area must not be retried when wall-time cap is exceeded");
      assert.equal(poolResult.retryCount, 0, "No retries should be performed");

      // (b) Confirm area keeps already-delivered leads
      assert.equal(poolResult.totals.discovered, 5);
      assert.equal(poolResult.totals.accepted, 3);
      assert.equal(poolResult.totals.rejected, 2);

      // (c) Accounting: failedAreaCount counts every failed area; partialAreaCount counts failed areas with leads
      assert.equal(poolResult.failedAreaCount, 1, "failedAreaCount must count every failed area regardless of leads");
      assert.equal(poolResult.partialAreaCount, 1, "partialAreaCount tracks failed areas that delivered leads");
      assert.equal(poolResult.allFailed, false, "allFailed must be false because pool delivered usable leads (accepted > 0)");
      const areaOutcome = poolResult.perArea[0].outcome;
      assert.equal(areaOutcome.wallTimeCapExceeded, true, "wallTimeCapExceeded must be true");
      assert.equal(areaOutcome.failed, true, "outcome.failed must be preserved");
      assert.equal(areaOutcome.exhausted, false, "outcome.exhausted must remain false on capped area");
      assert.equal(areaOutcome.failureReason, "WATCHDOG_TIMEOUT", "real failureReason must be preserved");

      // City state: if any leads were delivered the city is productive, but degraded=true is flagged
      const transition = cityTransitionFor(
        { candidatesFound: poolResult.totals.discovered, acceptedLeads: poolResult.totals.accepted },
        areaOutcome.exhausted,
        undefined,
        {
          failedAreaCount: poolResult.failedAreaCount,
          totalAreas: 1,
          crashCount: 0,
        },
      );
      assert.equal(transition, "CITY_PRODUCTIVE", "City transition with accepted leads must be CITY_PRODUCTIVE");

      const isDegraded = (poolResult.failedAreaCount ?? 0) > 0;
      assert.equal(isDegraded, true, "degraded=true must be flagged when failedAreaCount > 0 despite delivering leads");
    });

    test("pythonBridge.ts fails closed immediately as WATCHDOG_TIMEOUT when remainingAreaBudgetMs is 0 or negative", async () => {
      let doneInfo: any;
      const gen = runEngineQuery(
        { niche: "cafe", location: "NYC", limit: 5 },
        undefined,
        (info) => {
          doneInfo = info;
        },
        { remainingAreaBudgetMs: 0 },
      );
      const leads = [];
      for await (const lead of gen) {
        leads.push(lead);
      }
      assert.equal(leads.length, 0);
      assert.ok(doneInfo, "onDone must be called");
      assert.equal(doneInfo.success, false);
      assert.equal(doneInfo.failureReason, "WATCHDOG_TIMEOUT");
      assert.equal(doneInfo.terminationReason, "WATCHDOG_TIMEOUT");
      assert.match(doneInfo.failureDetail ?? "", /remainingAreaBudgetMs is non-positive/);

      // Also verify negative budget
      let negativeDoneInfo: any;
      const genNeg = runEngineQuery(
        { niche: "cafe", location: "NYC", limit: 5 },
        undefined,
        (info) => {
          negativeDoneInfo = info;
        },
        { remainingAreaBudgetMs: -100 },
      );
      for await (const _ of genNeg) {}
      assert.equal(negativeDoneInfo?.failureReason, "WATCHDOG_TIMEOUT");
    });

    test("googleMapsProvider forwards remainingAreaBudgetMs to runEngineQuery", async () => {
      const provider = new GoogleMapsProvider();
      let doneInfo: any;
      const gen = provider.search(
        { niche: "cafe", location: "NYC" },
        { area: "Downtown" },
        { requestId: "req-test-1", limit: 10, remainingAreaBudgetMs: -50 },
        undefined,
        (info) => {
          doneInfo = info;
        },
      );
      const leads = [];
      for await (const lead of gen) {
        leads.push(lead);
      }
      assert.equal(leads.length, 0);
      assert.ok(doneInfo, "onDone must be called through forwarded remainingAreaBudgetMs");
      assert.equal(doneInfo.failureReason, "WATCHDOG_TIMEOUT");
      assert.match(doneInfo.failureDetail ?? "", /remainingAreaBudgetMs is non-positive/);
    });

    test("resolveAreaAttemptCeilingMs derives absoluteCeilingMs as min with SCRAPER_SUBPROCESS_MAX_MS", () => {
      const maxMs = 600_000;
      // Budget less than max: returns the remaining area budget
      assert.equal(resolveAreaAttemptCeilingMs(50_000, maxMs), 50_000);
      assert.equal(resolveAreaAttemptCeilingMs(300_000, maxMs), 300_000);

      // Budget greater than max: capped at maxMs
      assert.equal(resolveAreaAttemptCeilingMs(900_000, maxMs), 600_000);

      // Budget undefined: returns default maxMs
      assert.equal(resolveAreaAttemptCeilingMs(undefined, maxMs), 600_000);

      // Budget 0 or negative: clamped to 0 (never falls back to maxMs)
      assert.equal(resolveAreaAttemptCeilingMs(0, maxMs), 0);
      assert.equal(resolveAreaAttemptCeilingMs(-100, maxMs), 0);
    });
  });
});
