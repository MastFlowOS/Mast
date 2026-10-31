/**
 * Comprehensive regression tests for Phase 2: Watchdog Reliability Architecture.
 *
 * Verifies:
 * 1. Startup Readiness: Dedicated deadline from spawn to service_ready / first heartbeat.
 * 2. Process Liveness: Dedicated livenessTimer reset ONLY by heartbeat with monotonic seq.
 * 3. Arbitrary stdout lines and non-progress events do NOT reset liveness.
 * 4. Discovery Progress: Fires DISCOVERY_PROGRESS_TIMEOUT when heartbeats continue but
 *    search progress stalls.
 * 5. search_space_expanded resets progress timer only when new unique IDs appear;
 *    round_scanned does NOT reset progress.
 * 6. Issue 1: Watchdog timer replacement between states:
 *    - Transition to CARD_ATTEMPT cancels 90s scrolling deadline and arms 60s card deadline.
 *    - At t=90s (10s after card start), old scrolling deadline does NOT fire.
 *    - Transition to REBUILDING cancels card deadline and arms 70s recovery deadline.
 *    - Returning to SCROLLING establishes a fresh 90s progress deadline.
 *    - Deduplication prevents repeated card_attempt_started from resetting deadline.
 *    - Recovery rebuild count is strictly bounded by maxRebuilds (2).
 *    - Concurrent liveness (45s) and absolute safety ceiling (20m) monitored throughout.
 * 7. Issue 2: Preservation of exact initiating causes:
 *    - USER_CANCELLED
 *    - PROCESS_UNRESPONSIVE
 *    - DISCOVERY_PROGRESS_TIMEOUT
 *    - WATCHDOG_TIMEOUT
 *    - Both with Python completion sentinel and with synthetic !sawDone() fallback.
 *    - Downstream scheduler compatibility via schedulerReason and cityTransitionFor().
 *
 * Run with: `npx tsx --test src/scraperBridge/__tests__/watchdogReliability.test.ts`
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";
process.env.SCRAPER_SUBPROCESS_INACTIVITY_MS ??= "10000";
process.env.SCRAPER_SUBPROCESS_MAX_MS ??= "30000";
process.env.SCRAPER_GRACEFUL_SHUTDOWN_MS ??= "1000";

const {
  isGenuineProgressEvent,
  NON_PROGRESS_EVENTS,
  runEngineQuery,
  WatchdogStateMachine,
  resolveEngineOutcome,
} = await import("../pythonBridge.js");
const { cityTransitionFor } = await import("../../discovery/cityScheduling.js");
const { env } = await import("../../config/env.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

describe("Watchdog Reliability Architecture", () => {
  describe("Progress Event Classification", () => {
    test("heartbeat and round_scanned belong to NON_PROGRESS_EVENTS", () => {
      assert.ok(NON_PROGRESS_EVENTS.has("heartbeat"), "heartbeat must be in NON_PROGRESS_EVENTS");
      assert.ok(NON_PROGRESS_EVENTS.has("round_scanned"), "round_scanned must be in NON_PROGRESS_EVENTS");
      assert.ok(NON_PROGRESS_EVENTS.has("stale_panel_mismatch"), "stale_panel_mismatch must be in NON_PROGRESS_EVENTS");
      assert.ok(NON_PROGRESS_EVENTS.has("stale_panel_recovery"), "stale_panel_recovery must be in NON_PROGRESS_EVENTS");
    });

    test("isGenuineProgressEvent correctly distinguishes milestones from diagnostics and heartbeats", () => {
      assert.equal(isGenuineProgressEvent({ type: "diagnostic", event: "debug_info" }), false);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "heartbeat", seq: 1 }), false);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "round_scanned" }), false);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "search_space_expanded", new_unique_ids: 5 }), true);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "card_attempt_started", item_id: "place1:1" }), true);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "card_processed", item_id: "place1:1:verified" }), true);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "candidate_discovered", item_id: "cand1" }), true);
      assert.equal(isGenuineProgressEvent({ type: "progress", event: "attempt_rebuilding", item_id: "2" }), true);
      assert.equal(isGenuineProgressEvent({ name: "Acme Cafe", phone: "+15551234" }), true);
    });
  });

  describe("Issue 1: Watchdog State Machine & Timer Replacement (Fake Timers)", () => {
    test("SCROLLING deadline (90s) is replaced by CARD_ATTEMPT deadline (60s) and does NOT fire at t=90s", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;
      let timedOutDetail: any = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        recoveryDeadlineMs: 70_000,
        onTimeout: (reason, detail) => {
          timedOutReason = reason;
          timedOutDetail = detail;
        },
      });

      // Child signals service_ready: enters SCROLLING with 90s deadline
      watchdog.onServiceReady();
      assert.equal(watchdog.getState(), "SCROLLING");
      assert.equal(watchdog.isTimedOut(), false);

      // Advance 80 seconds in SCROLLING (10s before scrolling timeout)
      t.mock.timers.tick(80_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Emit card_attempt_started at t=80s: must cancel 90s scrolling deadline and set 60s card deadline
      const started = watchdog.onCardAttemptStarted("ChIJ123:1");
      assert.equal(started, true);
      assert.equal(watchdog.getState(), "CARD_ATTEMPT");

      // Advance 10 seconds: t=90s from spawn (when the old scrolling timer would have fired)
      t.mock.timers.tick(10_000);
      assert.equal(
        watchdog.isTimedOut(),
        false,
        "Old scrolling deadline must NOT fire at t=90s while card attempt deadline is active",
      );

      // Advance another 49 seconds (total 59s since card started): still within 60s deadline
      t.mock.timers.tick(49_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Advance 2 seconds (total 61s since card started): card deadline must fire
      t.mock.timers.tick(2_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.ok(timedOutDetail?.includes("card attempt deadline (60000ms) exceeded"));

      watchdog.clearAll();
    });

    test("CARD_ATTEMPT deadline is replaced by REBUILDING deadline (70s)", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        recoveryDeadlineMs: 70_000,
        maxRebuilds: 2,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      watchdog.onCardAttemptStarted("ChIJ456:1");
      assert.equal(watchdog.getState(), "CARD_ATTEMPT");

      // 30 seconds into card attempt
      t.mock.timers.tick(30_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Context rebuild occurs at t_card=30s
      const rebuilding = watchdog.onAttemptRebuilding();
      assert.equal(rebuilding, true);
      assert.equal(watchdog.getState(), "REBUILDING");
      assert.equal(watchdog.getRebuildCount(), 1);

      // Advance 31 seconds: t_card=61s (when the card deadline would have fired if not replaced)
      t.mock.timers.tick(31_000);
      assert.equal(
        watchdog.isTimedOut(),
        false,
        "Card deadline must NOT fire after transitioning to REBUILDING",
      );

      // Advance another 38 seconds (total 69s since rebuild started)
      t.mock.timers.tick(38_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Advance 2 seconds (total 71s since rebuild started): recovery deadline must fire
      t.mock.timers.tick(2_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");

      watchdog.clearAll();
    });

    test("Returning to SCROLLING establishes a fresh 90s progress deadline", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        recoveryDeadlineMs: 70_000,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      watchdog.onCardAttemptStarted("ChIJ789:1");

      // Card processed after 50 seconds
      t.mock.timers.tick(50_000);
      const processed = watchdog.onCardProcessed("ChIJ789:1:verified");
      assert.equal(processed, true);
      assert.equal(watchdog.getState(), "SCROLLING");

      // Advance 15 seconds (would exceed 60s card timer if card timer had not been cleared)
      t.mock.timers.tick(15_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Advance to 89s since card processed: still alive
      t.mock.timers.tick(74_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Advance 2s (total 91s since card processed): fresh scrolling deadline fires
      t.mock.timers.tick(2_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");

      watchdog.clearAll();
    });

    test("Card attempt deduplication prevents redundant starts from extending deadline", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      assert.equal(watchdog.onCardAttemptStarted("ChIJDedup:1"), true);

      // Advance 50 seconds
      t.mock.timers.tick(50_000);
      assert.equal(watchdog.isTimedOut(), false);

      // Redundant start for same attempt key: must be rejected and not reset deadline
      assert.equal(watchdog.onCardAttemptStarted("ChIJDedup:1"), false);

      // Advance 11 seconds (total 61s from original start): must timeout
      t.mock.timers.tick(11_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");

      watchdog.clearAll();
    });

    test("Recovery rebuild count is strictly bounded by maxRebuilds (2)", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        recoveryDeadlineMs: 70_000,
        maxRebuilds: 2,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      watchdog.onCardAttemptStarted("ChIJRebuild:1");

      // Rebuild 1: accepted
      assert.equal(watchdog.onAttemptRebuilding(), true);
      assert.equal(watchdog.getRebuildCount(), 1);

      t.mock.timers.tick(40_000);

      // Rebuild 2: accepted
      assert.equal(watchdog.onAttemptRebuilding(), true);
      assert.equal(watchdog.getRebuildCount(), 2);

      t.mock.timers.tick(40_000);

      // Rebuild 3: rejected, deadline not extended
      assert.equal(watchdog.onAttemptRebuilding(), false);
      assert.equal(watchdog.getRebuildCount(), 2);

      // Advance 31 seconds (total 71s since Rebuild 2): must timeout
      t.mock.timers.tick(31_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");

      watchdog.clearAll();
    });

    test("Non-scrolling progress events during CARD_ATTEMPT do NOT overwrite card deadline", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 300_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      watchdog.onCardAttemptStarted("ChIJCard:1");
      assert.equal(watchdog.getState(), "CARD_ATTEMPT");

      t.mock.timers.tick(30_000);
      // Candidate discovered or generic progress line during card attempt: must not overwrite card deadline
      watchdog.onCandidateDiscovered();
      watchdog.onGenuineProgress();
      assert.equal(watchdog.getState(), "CARD_ATTEMPT");

      // Advance 31s (total 61s from card start): card deadline must fire on schedule
      t.mock.timers.tick(31_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");

      watchdog.clearAll();
    });

    test("Heartbeats during CARD_ATTEMPT maintain liveness but do NOT reset the 60s card deadline", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 45_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      watchdog.onCardAttemptStarted("ChIJHeartbeatCard:1");

      // Heartbeat at 20s
      t.mock.timers.tick(20_000);
      assert.equal(watchdog.onHeartbeat(0), true);
      assert.equal(watchdog.isTimedOut(), false);

      // Heartbeat at 40s
      t.mock.timers.tick(20_000);
      assert.equal(watchdog.onHeartbeat(1), true);
      assert.equal(watchdog.isTimedOut(), false);

      // Advance 21s (total 61s from card attempt start): card deadline fires DISCOVERY_PROGRESS_TIMEOUT
      t.mock.timers.tick(21_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "DISCOVERY_PROGRESS_TIMEOUT");

      watchdog.clearAll();
    });

    test("Concurrent Liveness timer (45s) fires PROCESS_UNRESPONSIVE when heartbeats cease", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 45_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();
      assert.equal(watchdog.isTimedOut(), false);

      // Heartbeat at 20s
      t.mock.timers.tick(20_000);
      assert.equal(watchdog.onHeartbeat(0), true);
      assert.equal(watchdog.isTimedOut(), false);

      // Heartbeat at 40s
      t.mock.timers.tick(20_000);
      assert.equal(watchdog.onHeartbeat(1), true);
      assert.equal(watchdog.isTimedOut(), false);

      // Stale / non-increasing heartbeat rejected
      assert.equal(watchdog.onHeartbeat(1), false);

      // Now heartbeats stop: advance 46s (t_since_last_hb = 46s, total elapsed = 86s < 90s progress deadline)
      t.mock.timers.tick(46_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "PROCESS_UNRESPONSIVE");

      watchdog.clearAll();
    });

    test("Absolute safety ceiling (20 minutes) fires WATCHDOG_TIMEOUT regardless of ongoing progress", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      let timedOutReason: string | null = null;

      const watchdog = new WatchdogStateMachine({
        startupDeadlineMs: 45_000,
        livenessTimeoutMs: 45_000,
        progressTimeoutMs: 90_000,
        cardAttemptDeadlineMs: 60_000,
        absoluteCeilingMs: 1_200_000, // 20 minutes
        onTimeout: (reason) => {
          timedOutReason = reason;
        },
      });

      watchdog.onServiceReady();

      // Simulate active search with regular heartbeats and lead yields for 19.5 minutes
      for (let m = 0; m < 39; m++) {
        t.mock.timers.tick(30_000);
        watchdog.onHeartbeat(m);
        watchdog.onLeadYielded();
        assert.equal(watchdog.isTimedOut(), false);
      }

      // Tick last 35 seconds (crossing the 20 minute ceiling)
      t.mock.timers.tick(35_000);
      assert.equal(watchdog.isTimedOut(), true);
      assert.equal(timedOutReason, "WATCHDOG_TIMEOUT");

      watchdog.clearAll();
    });
  });

  describe("Issue 2: Preservation of Exact Termination Reasons & Scheduler Compatibility", () => {
    test("USER_CANCELLED outcome derivation (with and without Python __done__ sentinel)", () => {
      // 1. With cooperative __done__ sentinel
      const withSentinel = resolveEngineOutcome({
        success: false,
        rawFailureReason: "USER_CANCELLED",
        rawTerminationReason: "USER_CANCELLED",
        timedOut: false,
        timedOutReason: null,
        isUserCancelled: true,
        isRealAbort: true,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(withSentinel.success, false);
      assert.equal(withSentinel.terminationReason, "USER_CANCELLED");
      assert.equal(withSentinel.failureReason, "USER_CANCELLED");
      assert.equal(withSentinel.watchdogReason, undefined);
      assert.equal(withSentinel.schedulerReason, "USER_CANCELLED");

      // 2. Without __done__ sentinel (synthetic !sawDone() fallback)
      const syntheticFallback = resolveEngineOutcome({
        success: false,
        rawFailureReason: undefined,
        rawTerminationReason: undefined,
        timedOut: false,
        timedOutReason: null,
        isUserCancelled: true,
        isRealAbort: true,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(syntheticFallback.success, false);
      assert.equal(syntheticFallback.terminationReason, "USER_CANCELLED");
      assert.equal(syntheticFallback.failureReason, "USER_CANCELLED");
      assert.equal(syntheticFallback.watchdogReason, undefined);
      assert.equal(syntheticFallback.schedulerReason, "USER_CANCELLED");
    });

    test("PROCESS_UNRESPONSIVE outcome derivation (with and without Python __done__ sentinel)", () => {
      // 1. With cooperative __done__ sentinel
      const withSentinel = resolveEngineOutcome({
        success: false,
        rawFailureReason: "PROCESS_UNRESPONSIVE",
        rawTerminationReason: "PROCESS_UNRESPONSIVE",
        timedOut: true,
        timedOutReason: "PROCESS_UNRESPONSIVE",
        isUserCancelled: false,
        isRealAbort: false,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(withSentinel.success, false);
      assert.equal(withSentinel.terminationReason, "PROCESS_UNRESPONSIVE");
      assert.equal(withSentinel.failureReason, "PROCESS_UNRESPONSIVE");
      assert.equal(withSentinel.watchdogReason, "PROCESS_UNRESPONSIVE");
      assert.equal(withSentinel.schedulerReason, "WATCHDOG_TIMEOUT");

      // 2. Without __done__ sentinel (synthetic !sawDone() fallback)
      const syntheticFallback = resolveEngineOutcome({
        success: false,
        rawFailureReason: undefined,
        rawTerminationReason: undefined,
        timedOut: true,
        timedOutReason: "PROCESS_UNRESPONSIVE",
        isUserCancelled: false,
        isRealAbort: false,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(syntheticFallback.success, false);
      assert.equal(syntheticFallback.terminationReason, "PROCESS_UNRESPONSIVE");
      assert.equal(syntheticFallback.failureReason, "PROCESS_UNRESPONSIVE");
      assert.equal(syntheticFallback.watchdogReason, "PROCESS_UNRESPONSIVE");
      assert.equal(syntheticFallback.schedulerReason, "WATCHDOG_TIMEOUT");
    });

    test("DISCOVERY_PROGRESS_TIMEOUT outcome derivation (with and without Python __done__ sentinel)", () => {
      // 1. With cooperative __done__ sentinel
      const withSentinel = resolveEngineOutcome({
        success: false,
        rawFailureReason: "DISCOVERY_PROGRESS_TIMEOUT",
        rawTerminationReason: "DISCOVERY_PROGRESS_TIMEOUT",
        timedOut: true,
        timedOutReason: "DISCOVERY_PROGRESS_TIMEOUT",
        isUserCancelled: false,
        isRealAbort: false,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(withSentinel.success, false);
      assert.equal(withSentinel.terminationReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.equal(withSentinel.failureReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.equal(withSentinel.watchdogReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.equal(withSentinel.schedulerReason, "WATCHDOG_TIMEOUT");

      // 2. Without __done__ sentinel (synthetic !sawDone() fallback)
      const syntheticFallback = resolveEngineOutcome({
        success: false,
        rawFailureReason: undefined,
        rawTerminationReason: undefined,
        timedOut: true,
        timedOutReason: "DISCOVERY_PROGRESS_TIMEOUT",
        isUserCancelled: false,
        isRealAbort: false,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(syntheticFallback.success, false);
      assert.equal(syntheticFallback.terminationReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.equal(syntheticFallback.failureReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.equal(syntheticFallback.watchdogReason, "DISCOVERY_PROGRESS_TIMEOUT");
      assert.equal(syntheticFallback.schedulerReason, "WATCHDOG_TIMEOUT");
    });

    test("WATCHDOG_TIMEOUT absolute ceiling outcome derivation (with and without Python __done__ sentinel)", () => {
      // 1. With cooperative __done__ sentinel
      const withSentinel = resolveEngineOutcome({
        success: false,
        rawFailureReason: "WATCHDOG_TIMEOUT",
        rawTerminationReason: "WATCHDOG_TIMEOUT",
        timedOut: true,
        timedOutReason: "WATCHDOG_TIMEOUT",
        isUserCancelled: false,
        isRealAbort: false,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(withSentinel.success, false);
      assert.equal(withSentinel.terminationReason, "WATCHDOG_TIMEOUT");
      assert.equal(withSentinel.failureReason, "WATCHDOG_TIMEOUT");
      assert.equal(withSentinel.watchdogReason, "WATCHDOG_TIMEOUT");
      assert.equal(withSentinel.schedulerReason, "WATCHDOG_TIMEOUT");

      // 2. Without __done__ sentinel (synthetic !sawDone() fallback)
      const syntheticFallback = resolveEngineOutcome({
        success: false,
        rawFailureReason: undefined,
        rawTerminationReason: undefined,
        timedOut: true,
        timedOutReason: "WATCHDOG_TIMEOUT",
        isUserCancelled: false,
        isRealAbort: false,
        isTargetReachedEarlyStop: false,
      });
      assert.equal(syntheticFallback.success, false);
      assert.equal(syntheticFallback.terminationReason, "WATCHDOG_TIMEOUT");
      assert.equal(syntheticFallback.failureReason, "WATCHDOG_TIMEOUT");
      assert.equal(syntheticFallback.watchdogReason, "WATCHDOG_TIMEOUT");
      assert.equal(syntheticFallback.schedulerReason, "WATCHDOG_TIMEOUT");
    });

    test("Downstream scheduler compatibility with cityTransitionFor()", () => {
      const emptyAttempt = { candidatesFound: 0, acceptedLeads: 0 };

      // All watchdog failure reasons map to WATCHDOG_TIMEOUT for bounded retry
      assert.equal(cityTransitionFor(emptyAttempt, false, "WATCHDOG_TIMEOUT"), "WATCHDOG_TIMEOUT");
      assert.equal(cityTransitionFor(emptyAttempt, false, "PROCESS_UNRESPONSIVE"), "WATCHDOG_TIMEOUT");
      assert.equal(cityTransitionFor(emptyAttempt, false, "DISCOVERY_PROGRESS_TIMEOUT"), "WATCHDOG_TIMEOUT");

      // USER_CANCELLED must NOT map to WATCHDOG_TIMEOUT
      const userCancelTransition = cityTransitionFor(emptyAttempt, false, "USER_CANCELLED");
      assert.notEqual(userCancelTransition, "WATCHDOG_TIMEOUT");
      assert.equal(userCancelTransition, "CITY_NO_PROGRESS");

      // Productive attempts always win
      assert.equal(
        cityTransitionFor({ candidatesFound: 5, acceptedLeads: 1 }, false, "PROCESS_UNRESPONSIVE"),
        "CITY_PRODUCTIVE",
      );
    });
  });

  describe("End-to-End Watchdog Timers and Readiness Integration (Subprocess)", () => {
    test("subprocess emitting heartbeats without service_ready is terminated when startup deadline expires", async () => {
      const originalPath = env.SCRAPER_ENGINE_PATH;
      const originalStartup = (env as any).SCRAPER_SUBPROCESS_STARTUP_MS;
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "heartbeat-without-ready-engine");
      (env as any).SCRAPER_SUBPROCESS_STARTUP_MS = 300;
      try {
        let doneInfo: any = null;
        try {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            (info) => {
              doneInfo = info;
            },
          )) {
            // No leads expected
          }
        } catch {}

        assert.ok(doneInfo !== null, "onDone must be called");
        assert.equal(doneInfo.success, false);
        assert.equal(doneInfo.watchdogReason, "PROCESS_UNRESPONSIVE");
        assert.equal(doneInfo.failureReason, "PROCESS_UNRESPONSIVE");
        assert.equal(doneInfo.terminationReason, "PROCESS_UNRESPONSIVE");
        assert.equal(doneInfo.schedulerReason, "WATCHDOG_TIMEOUT");

        // Caller path verification (discoveryPlanJob / cityScheduling):
        const cityReason = cityTransitionFor({ candidatesFound: 0, acceptedLeads: 0 }, doneInfo.exhausted, doneInfo.terminationReason);
        assert.equal(cityReason, "WATCHDOG_TIMEOUT", "caller path: cityTransitionFor must classify as WATCHDOG_TIMEOUT");
        const shouldRetry = (cityReason === "WATCHDOG_TIMEOUT" || cityReason === "SCRAPER_FAILURE");
        assert.equal(shouldRetry, true, "caller path: watchdog timeout must be retried");
      } finally {
        env.SCRAPER_ENGINE_PATH = originalPath;
        (env as any).SCRAPER_SUBPROCESS_STARTUP_MS = originalStartup;
      }
    });

    test("process that emits search_exhausted but never emits __done__ is terminated by DISCOVERY_PROGRESS_TIMEOUT", async () => {
      const originalPath = env.SCRAPER_ENGINE_PATH;
      const originalInactivity = env.SCRAPER_SUBPROCESS_INACTIVITY_MS;
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "exhausted-stalled-engine");
      env.SCRAPER_SUBPROCESS_INACTIVITY_MS = 300;
      try {
        let doneInfo: any = null;
        try {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            (info) => {
              doneInfo = info;
            },
          )) {
            // No leads expected
          }
        } catch {}

        assert.ok(doneInfo !== null, "onDone must be called");
        assert.equal(doneInfo.success, false);
        assert.equal(doneInfo.watchdogReason, "DISCOVERY_PROGRESS_TIMEOUT");
        assert.equal(doneInfo.failureReason, "DISCOVERY_PROGRESS_TIMEOUT");
        assert.equal(doneInfo.terminationReason, "DISCOVERY_PROGRESS_TIMEOUT");
        assert.equal(doneInfo.schedulerReason, "WATCHDOG_TIMEOUT");

        // Caller path verification (discoveryPlanJob / cityScheduling):
        const cityReason = cityTransitionFor({ candidatesFound: 0, acceptedLeads: 0 }, doneInfo.exhausted, doneInfo.terminationReason);
        assert.equal(cityReason, "WATCHDOG_TIMEOUT", "caller path: cityTransitionFor must classify as WATCHDOG_TIMEOUT");
        const shouldRetry = (cityReason === "WATCHDOG_TIMEOUT" || cityReason === "SCRAPER_FAILURE");
        assert.equal(shouldRetry, true, "caller path: watchdog timeout must be retried");
      } finally {
        env.SCRAPER_ENGINE_PATH = originalPath;
        env.SCRAPER_SUBPROCESS_INACTIVITY_MS = originalInactivity;
      }
    });

    test("user cancellation preserves USER_CANCELLED and is never overwritten by watchdog", async () => {
      const lifecycle = await import("../../discovery/requestLifecycle.js");
      const originalPath = env.SCRAPER_ENGINE_PATH;
      const requestId = "watchdog-cancel-preserve-test";
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "heartbeat-without-ready-engine");
      try {
        const abortController = new AbortController();
        let doneInfo: any = null;
        setTimeout(() => {
          lifecycle.terminateRequest(requestId, "USER_CANCELLED");
          abortController.abort("USER_CANCELLED");
        }, 100);

        try {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville" },
            abortController.signal,
            (info) => {
              doneInfo = info;
            },
            { requestId },
          )) {
            // No leads expected
          }
        } catch {}

        assert.ok(doneInfo !== null, "onDone must be called");
        assert.equal(doneInfo.success, false);
        assert.equal(doneInfo.terminationReason, "USER_CANCELLED");
        assert.equal(doneInfo.failureReason, "USER_CANCELLED");
        assert.equal(doneInfo.watchdogReason, undefined);
        assert.equal(doneInfo.schedulerReason, "USER_CANCELLED");
        assert.equal(lifecycle.getRequestTerminalReason(requestId), "USER_CANCELLED");

        // Caller path verification (discoveryPlanJob / cityScheduling):
        const cityReason = cityTransitionFor({ candidatesFound: 0, acceptedLeads: 0 }, doneInfo.exhausted, doneInfo.terminationReason);
        assert.notEqual(cityReason, "WATCHDOG_TIMEOUT", "caller path: user cancel must never trigger watchdog retry");
        assert.notEqual(cityReason, "SCRAPER_FAILURE", "caller path: user cancel must never trigger scraper failure retry");
        const shouldRetry = (cityReason === "WATCHDOG_TIMEOUT" || cityReason === "SCRAPER_FAILURE");
        assert.equal(shouldRetry, false, "caller path: user cancellation must remain terminal and never retried");
      } finally {
        env.SCRAPER_ENGINE_PATH = originalPath;
        lifecycle.__testing.reset();
      }
    });

    test("cooperative completion under user cancellation preserves USER_CANCELLED and is never retried", async () => {
      const lifecycle = await import("../../discovery/requestLifecycle.js");
      const originalPath = env.SCRAPER_ENGINE_PATH;
      const requestId = "watchdog-cancel-cooperative-test";
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "target-reached-engine");
      try {
        const abortController = new AbortController();
        let deliveredCount = 0;
        let doneInfo: any = null;

        try {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville", max_results: 20 },
            abortController.signal,
            (info) => {
              doneInfo = info;
            },
            { requestId },
          )) {
            deliveredCount += 1;
            if (deliveredCount >= 2) {
              lifecycle.terminateRequest(requestId, "USER_CANCELLED");
              abortController.abort("USER_CANCELLED");
              break;
            }
          }
        } catch {}

        assert.equal(deliveredCount, 2);
        assert.ok(doneInfo !== null, "onDone must be called");
        assert.equal(doneInfo.success, false, "success must be false for user cancellation");
        assert.equal(doneInfo.terminationReason, "USER_CANCELLED", "terminationReason must be USER_CANCELLED");
        assert.equal(doneInfo.failureReason, "USER_CANCELLED", "failureReason must be USER_CANCELLED");
        assert.equal(doneInfo.watchdogReason, undefined, "watchdogReason must be undefined");
        assert.equal(doneInfo.schedulerReason, "USER_CANCELLED", "schedulerReason must be USER_CANCELLED");
        assert.equal(lifecycle.getRequestTerminalReason(requestId), "USER_CANCELLED");

        // Caller path verification (discoveryPlanJob / cityScheduling):
        const cityReason = cityTransitionFor({ candidatesFound: deliveredCount, acceptedLeads: 0 }, doneInfo.exhausted, doneInfo.terminationReason);
        assert.notEqual(cityReason, "WATCHDOG_TIMEOUT", "caller path: cooperative user cancel must never trigger watchdog retry");
        assert.notEqual(cityReason, "SCRAPER_FAILURE", "caller path: cooperative user cancel must never trigger scraper failure retry");
        const shouldRetry = (cityReason === "WATCHDOG_TIMEOUT" || cityReason === "SCRAPER_FAILURE");
        assert.equal(shouldRetry, false, "caller path: cooperative user cancellation must remain terminal and never retried");
      } finally {
        env.SCRAPER_ENGINE_PATH = originalPath;
        lifecycle.__testing.reset();
      }
    });
  });
});
