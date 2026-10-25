/**
 * Deterministic unit tests for discovery startup watchdog and street-inventory initialization lifecycle:
 *
 * 1. Inventory initialization lasting longer than 45 seconds does not cause a false startup timeout while making progress.
 * 2. A genuinely stalled initialization still times out safely (inactivity and hard ceiling).
 * 3. A scout that never starts after initialization still triggers the startup timeout.
 * 4. Explicit cancellation during initialization stops the run promptly.
 * 5. Successful initialization is followed by scout startup and correct street/area mode selection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStartupWatchdog,
  STARTUP_WATCHDOG_TIMEOUT_MS,
  MAX_INITIALIZATION_CEILING_MS,
} from "../startupWatchdog.js";
import {
  createInitialLiveDiscoveryState,
  reduceLiveDiscoveryEvent,
} from "../liveDiscoveryState.js";
import {
  initializationProgressEvent,
  scoutStartedEvent,
  leadDeliveredEvent,
} from "../liveDiscoveryEvent.js";
import {
  ensureStreetInventory,
  discoveryModeForStreetInventory,
} from "../streetDiscovery.js";

describe("Discovery Startup Watchdog Lifecycle", () => {
  test("1. Inventory initialization lasting longer than 45 seconds does not cause a false startup timeout while making progress", () => {
    const planId = "plan-long-init";
    let state = createInitialLiveDiscoveryState(10);
    const searchStartedAt = 1_000_000;

    // Discovery plan starts inventory build at t=1s
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, "Initializing street network for Chicago...", "initializing"),
        timestamp: searchStartedAt + 1_000,
      },
    );

    assert.equal(state.initialization?.active, true);
    assert.equal(state.initialization?.message, "Initializing street network for Chicago...");
    // Scout 1 sentence displays progress while remaining idle
    assert.equal(state.scouts[1].status, "idle");
    assert.match(state.scouts[1].sentence, /Initializing street network/);

    // Watchdog check at t=46s (longer than 45s from start), but with heartbeat at t=40s
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, "Querying OpenStreetMap for Chicago boundaries...", "initializing"),
        timestamp: searchStartedAt + 40_000,
      },
    );

    const checkAt46s = evaluateStartupWatchdog({
      now: searchStartedAt + 46_000,
      searchStartedAt,
      state,
      seenLeadsCount: 0,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkAt46s.status, "active_progress");
    if (checkAt46s.status === "active_progress") {
      assert.equal(checkAt46s.phase, "initialization");
    }

    // Additional heartbeats up to 168.7s (the real duration observed in production)
    for (let sec = 50; sec <= 160; sec += 10) {
      state = reduceLiveDiscoveryEvent(
        state,
        {
          ...initializationProgressEvent(planId, `Processing street relations (${sec}s)...`, "initializing"),
          timestamp: searchStartedAt + sec * 1000,
        },
      );
    }

    // Watchdog check at t=165s (almost 3 minutes into initialization)
    const checkAt165s = evaluateStartupWatchdog({
      now: searchStartedAt + 165_000,
      searchStartedAt,
      state,
      seenLeadsCount: 0,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkAt165s.status, "active_progress");
    if (checkAt165s.status === "active_progress") {
      assert.equal(checkAt165s.phase, "initialization");
    }
  });

  test("2. A genuinely stalled initialization still times out safely (inactivity and ceiling)", () => {
    const planId = "plan-stalled-init";
    let state = createInitialLiveDiscoveryState(10);
    const searchStartedAt = 1_000_000;

    // Initialization started at t=1s
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, "Initializing street network...", "initializing"),
        timestamp: searchStartedAt + 1_000,
      },
    );

    // Heartbeat at t=10s, then silence
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, "Querying Overpass...", "initializing"),
        timestamp: searchStartedAt + 10_000,
      },
    );

    // At t=56s: 46s since last heartbeat (exceeds 45s threshold)
    const checkInactivityTimeout = evaluateStartupWatchdog({
      now: searchStartedAt + 56_000,
      searchStartedAt,
      state,
      seenLeadsCount: 0,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkInactivityTimeout.status, "timed_out");
    if (checkInactivityTimeout.status === "timed_out") {
      assert.equal(checkInactivityTimeout.reason, "initialization_stalled");
      assert.match(checkInactivityTimeout.description, /stalled/i);
    }

    // Test hard ceiling: even if heartbeats keep arriving, exceeding max ceiling (180s) times out
    let stateCeiling = createInitialLiveDiscoveryState(10);
    stateCeiling = reduceLiveDiscoveryEvent(
      stateCeiling,
      {
        ...initializationProgressEvent(planId, "Starting...", "initializing"),
        timestamp: searchStartedAt,
      },
    );

    // Heartbeat right at t=181s
    stateCeiling = reduceLiveDiscoveryEvent(
      stateCeiling,
      {
        ...initializationProgressEvent(planId, "Still querying Overpass...", "initializing"),
        timestamp: searchStartedAt + 181_000,
      },
    );

    const checkCeilingTimeout = evaluateStartupWatchdog({
      now: searchStartedAt + 181_001,
      searchStartedAt,
      state: stateCeiling,
      seenLeadsCount: 0,
      hasActiveJob: true,
      maxInitializationCeilingMs: 180_000,
    });

    assert.equal(checkCeilingTimeout.status, "timed_out");
    if (checkCeilingTimeout.status === "timed_out") {
      assert.equal(checkCeilingTimeout.reason, "initialization_ceiling");
      assert.match(checkCeilingTimeout.description, /exceeded maximum limit/i);
    }
  });

  test("3. A scout that never starts after initialization still triggers the startup timeout", () => {
    const planId = "plan-scout-hang";
    let state = createInitialLiveDiscoveryState(10);
    const searchStartedAt = 1_000_000;

    // Initialization runs and completes successfully at t=168s
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, "Initializing...", "initializing"),
        timestamp: searchStartedAt + 1_000,
      },
    );

    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, "Street inventory ready (450 streets)", "completed"),
        timestamp: searchStartedAt + 168_000,
      },
    );

    assert.equal(state.initialization?.active, false);
    assert.equal(state.initializationCompletedAt, searchStartedAt + 168_000);
    // Scouts are still idle waiting to start
    assert.equal(state.scouts[1].status, "idle");

    // At t=188s (20s after initialization completion): scouts still have 25s left in their 45s window
    const checkAt20sAfterInit = evaluateStartupWatchdog({
      now: searchStartedAt + 188_000,
      searchStartedAt,
      state,
      seenLeadsCount: 0,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkAt20sAfterInit.status, "active_progress");
    if (checkAt20sAfterInit.status === "active_progress") {
      assert.equal(checkAt20sAfterInit.phase, "startup");
      assert.equal(checkAt20sAfterInit.nextCheckDelayMs, 25_000);
    }

    // At t=214s (46s after initialization completion): scouts NEVER started! Watchdog MUST fire!
    const checkAt46sAfterInit = evaluateStartupWatchdog({
      now: searchStartedAt + 214_000,
      searchStartedAt,
      state,
      seenLeadsCount: 0,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkAt46sAfterInit.status, "timed_out");
    if (checkAt46sAfterInit.status === "timed_out") {
      assert.equal(checkAt46sAfterInit.reason, "no_scouts_started");
      assert.equal(checkAt46sAfterInit.description, "No scouts started within 45 seconds. Terminating discovery run.");
    }
  });

  test("4. Explicit cancellation during initialization stops the run promptly", async () => {
    let buildFnCalled = false;
    let buildAborted = false;
    const abortController = new AbortController();

    const mockBuildFn = async (params: any, signal?: AbortSignal) => {
      buildFnCalled = true;
      return new Promise<any>((resolve, reject) => {
        signal?.addEventListener("abort", () => {
          buildAborted = true;
          reject(new Error("aborted"));
        });
      });
    };

    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                then: (resolve: any) => resolve({ count: 0, error: null }),
              }),
              then: (resolve: any) => resolve({ count: 0, error: null }),
            }),
          }),
        }),
      }),
    };

    // Start inventory build with caller's abort signal
    const buildPromise = ensureStreetInventory(
      mockDb as any,
      "US",
      "Chicago",
      { countryName: "United States", region: "IL", signal: abortController.signal },
      mockBuildFn as any,
    );

    // Allow streetInventoryFreshCount microtask to settle and invoke buildFn
    await new Promise((r) => setImmediate(r));

    assert.equal(buildFnCalled, true);
    assert.equal(buildAborted, false);

    // User cancels during inventory initialization
    abortController.abort();

    const outcome = await buildPromise;
    assert.equal(buildAborted, true);
    assert.equal(outcome.mode, "area");
    assert.equal(outcome.count, 0);
    if ("fallbackReason" in outcome) {
      assert.equal(outcome.fallbackReason, "cancelled");
    }
  });

  test("5. Successful initialization is followed by scout startup and correct street/area mode selection", async () => {
    const planId = "plan-successful-flow";
    let state = createInitialLiveDiscoveryState(10);
    const searchStartedAt = 1_000_000;

    let buildFnCalled = false;
    const mockBuildFn = async () => {
      buildFnCalled = true;
      count = 520;
      return { status: "ok" as const, fetched: 520, upserted: 520, batches: 5 };
    };

    let count = 0;
    const mockDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                then: (resolve: any) => resolve({ count, error: null }),
              }),
              then: (resolve: any) => resolve({ count, error: null }),
            }),
          }),
        }),
      }),
    };

    // 1. Initial fresh street inventory is 0
    assert.equal(count, 0);

    // 2. ensureStreetInventory successfully runs
    const outcome = await ensureStreetInventory(
      mockDb as any,
      "US",
      "Chicago",
      { countryName: "United States", region: "IL", osmRelationId: 122604 },
      mockBuildFn as any,
    );

    assert.equal(buildFnCalled, true);
    assert.equal(outcome.mode, "street");
    assert.equal(outcome.count, 520);

    // 3. Mode decision uses refreshed count and selects street mode
    const mode = discoveryModeForStreetInventory("google_maps", outcome.count);
    assert.equal(mode, "street");

    // 4. State records initialization complete
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...initializationProgressEvent(planId, `Street inventory ready (${outcome.count} streets)`, "completed"),
        timestamp: searchStartedAt + 50_000,
      },
    );

    // 5. Scouts start searching
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...scoutStartedEvent(planId, 1, "Michigan Ave"),
        timestamp: searchStartedAt + 52_000,
      },
    );

    assert.equal(state.status, "discovering");
    assert.equal(state.scouts[1].status, "active");
    assert.match(state.scouts[1].sentence, /Michigan Ave/);

    // 6. Watchdog evaluates to satisfied
    const checkAfterScoutStarts = evaluateStartupWatchdog({
      now: searchStartedAt + 53_000,
      searchStartedAt,
      state,
      seenLeadsCount: 0,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkAfterScoutStarts.status, "satisfied");

    // 7. Lead delivered also satisfies watchdog
    state = reduceLiveDiscoveryEvent(
      state,
      {
        ...leadDeliveredEvent(planId, 1, "#1", "Chicago Deep Dish Co", "Michigan Ave"),
        timestamp: searchStartedAt + 60_000,
      },
    );

    assert.equal(state.delivered, 1);
    const checkAfterLead = evaluateStartupWatchdog({
      now: searchStartedAt + 60_000,
      searchStartedAt,
      state,
      seenLeadsCount: 1,
      hasActiveJob: true,
      watchdogTimeoutMs: 45_000,
    });

    assert.equal(checkAfterLead.status, "satisfied");
  });
});
