/**
 * PHASE 42A — regression tests for the production "RuntimeError: can't
 * start new thread" fix.
 *
 * ROOT CAUSE (see resourceCapacity.ts's own doc comment on
 * initResourceWorkerSlotPool() for the full writeup): `safeAreaWorkers`
 * (the measured cgroup PID/thread ceiling) was a STATIC number, computed
 * once at process startup and then consulted independently, non-atomically,
 * by every concurrently-running `runAreaWorkerPool()` invocation in this
 * process (multiple `discoveryTask` jobs run concurrently via
 * `processBatchConcurrently()`, and/or one or more `poolExpand` jobs
 * running alongside them — two separate pg-boss queues, same process). Each
 * invocation independently computed and enforced its own local cap of up to
 * `safeAreaWorkers` area workers, so N concurrently-running discovery jobs
 * could together spawn up to N x cap area workers (and their underlying
 * Python subprocesses / OS threads) — exactly the production evidence:
 * `effectiveWorkers=3` in the logs while `concurrentAreaWorkers=9/10` (3
 * concurrent invocations x 3 workers each) actually ran, exhausting the
 * container's `pids.max` cgroup budget inside `asyncio.to_thread()`.
 *
 * THE FIX: a real, shared, atomically-decrementing counting semaphore
 * (`createBrowserSlotPool()`, reused verbatim — it is already a pure,
 * domain-agnostic primitive) sized to the SAME measured `safeAreaWorkers`
 * ceiling, initialized ONCE at process startup
 * (`initResourceWorkerSlotPool()`) and shared by every `tryAcquireSlot()`
 * call site across BOTH poolExpandJob.ts and discoveryPlanJob.ts (pooled
 * AND legacy single-search paths) — mirroring how browserSlotPool.ts
 * already correctly bounds concurrent Google browsers regardless of
 * whether the concurrency came from many tasks, one task's area fan-out,
 * or a mix of both (see browserSlotPool.test.ts's own "nested concurrency"
 * tests, which this file follows the same pattern of).
 *
 * These tests exercise the semaphore itself (reusing createBrowserSlotPool,
 * so pool-primitive correctness is already covered by
 * browserSlotPool.test.ts) plus the specific cross-invocation scenario that
 * caused the production incident, and the init/get singleton wiring.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserSlotPool } from "../browserSlotPool.js";
import {
  initResourceWorkerSlotPool,
  getResourceWorkerSlotPool,
  __testing_resourceWorkerSlotPool,
} from "../resourceCapacity.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../../discovery/googleAreaPool.js";

function outcome(partial: Partial<AreaRunOutcome> = {}): AreaRunOutcome {
  return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: false, ...partial };
}

test.beforeEach(() => {
  __testing_resourceWorkerSlotPool.reset();
});

test.after(() => {
  __testing_resourceWorkerSlotPool.reset();
});

// ── Regression 1: the CORE bug — effective worker count cannot exceed the ──
// configured safe cap, EVEN when multiple independent runAreaWorkerPool()
// invocations (simulating concurrent poolExpand/discoveryTask jobs in the
// same process) all try to start area workers at the same time.
test("REGRESSION: N concurrent runAreaWorkerPool() invocations never together exceed the measured safe PID/thread ceiling", async () => {
  const measuredSafeCeiling = 3; // e.g. this container's real cgroup PID budget only supports 3
  initResourceWorkerSlotPool(measuredSafeCeiling);
  const resourcePool = getResourceWorkerSlotPool();

  // Each "invocation" gets its OWN independent (generously large) browser
  // slot pool — isolating this test to the resource/PID semaphore
  // specifically, not the (already correct) memory-based one.
  let maxConcurrentAreaWorkers = 0;
  let currentConcurrentAreaWorkers = 0;

  async function runOneInvocation(tag: string): Promise<void> {
    const areas = [`${tag}-A1`, `${tag}-A2`, `${tag}-A3`, `${tag}-A4`, `${tag}-A5`];
    const localBrowserPool = createBrowserSlotPool(10); // plenty of memory — not the constraint under test
    const claimed = new Set<string>();
    await runAreaWorkerPool({
      configuredWorkers: 3, // "effectiveWorkers=3" in the production logs
      safeResourceWorkers: Number.MAX_SAFE_INTEGER, // sizing formula unconstrained — the semaphore below is what must enforce safety
      totalCuratedAreas: areas.length,
      availableCapacity: localBrowserPool.available(),
      // NOTE: reserves the area SYNCHRONOUSLY inside claimNextArea itself
      // (before returning), exactly like googleAreaPool.test.ts's own
      // "safe resource ceiling bounds dynamic area workers without
      // duplicate claims" fake — mirrors the real claim_discovery_area()
      // atomic DB reservation. Relying on the outer usedAreas Set (which
      // runAreaWorkerPool only updates AFTER this async function's promise
      // resolves) would let concurrent workerLoops race and all "claim"
      // the same area, artificially serializing them — masking the exact
      // concurrency this test exists to exercise.
      claimNextArea: async (usedAreas) => {
        const next = areas.find((a) => !usedAreas.has(a) && !claimed.has(a));
        if (!next) return undefined;
        claimed.add(next);
        return next;
      },
      tryAcquireSlot: () => {
        const releaseBrowser = localBrowserPool.tryAcquire();
        if (!releaseBrowser) return undefined;
        const releaseResource = resourcePool.tryAcquire();
        if (!releaseResource) {
          releaseBrowser();
          return undefined;
        }
        return () => {
          releaseResource();
          releaseBrowser();
        };
      },
      runArea: async (area) => {
        currentConcurrentAreaWorkers += 1;
        maxConcurrentAreaWorkers = Math.max(maxConcurrentAreaWorkers, currentConcurrentAreaWorkers);
        // Simulate real work (a Python subprocess run) taking some time,
        // so overlapping invocations genuinely race for the same slots.
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrentAreaWorkers -= 1;
        return outcome({ discovered: 1, accepted: 1 });
      },
      isTerminal: () => false,
    });
  }

  // Simulate exactly the production scenario: 3 poolExpand/discoveryTask
  // jobs running CONCURRENTLY in the same process, each independently
  // deciding "I can safely run up to 3 area workers".
  await Promise.all([runOneInvocation("job1"), runOneInvocation("job2"), runOneInvocation("job3")]);

  assert.ok(
    maxConcurrentAreaWorkers <= measuredSafeCeiling,
    `observed ${maxConcurrentAreaWorkers} concurrent area workers across concurrent invocations — must never exceed the measured safe ceiling of ${measuredSafeCeiling} (this is the exact production bug: effectiveWorkers=3 but concurrentAreaWorkers reached 9)`,
  );
});

// ── Regression 2: failed discovery still releases its slot ─────────────────
test("REGRESSION: a failed area run still releases its resource slot (no leak on failure)", async () => {
  initResourceWorkerSlotPool(2);
  const resourcePool = getResourceWorkerSlotPool();
  const browserPool = createBrowserSlotPool(10);
  const areas = ["A1", "A2", "A3", "A4"];
  const claimed = new Set<string>();

  await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: browserPool.available(),
    claimNextArea: async (used) => {
      const next = areas.find((a) => !used.has(a) && !claimed.has(a));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    tryAcquireSlot: () => {
      const releaseBrowser = browserPool.tryAcquire();
      if (!releaseBrowser) return undefined;
      const releaseResource = resourcePool.tryAcquire();
      if (!releaseResource) {
        releaseBrowser();
        return undefined;
      }
      return () => {
        releaseResource();
        releaseBrowser();
      };
    },
    runArea: async () => {
      throw new Error("simulated Python subprocess crash");
    },
    isTerminal: () => false,
  });

  assert.equal(resourcePool.inUse(), 0, "the resource slot must be released even when runArea() throws — no orphaned slot after a failed area");
  assert.equal(resourcePool.available(), 2, "full capacity must be available again after every area (successful or failed) has released its slot");
});

// ── Regression 3: no orphan discovery subprocess remains after area ────────
// completion — every acquired slot is eventually released, across a full
// pool run mixing success and failure.
test("REGRESSION: no orphan resource slot remains held after area-pool completion, across mixed success/failure outcomes", async () => {
  initResourceWorkerSlotPool(3);
  const resourcePool = getResourceWorkerSlotPool();
  const browserPool = createBrowserSlotPool(10);
  const areas = ["A1", "A2", "A3", "A4", "A5", "A6"];
  const claimed = new Set<string>();
  let call = 0;

  await runAreaWorkerPool({
    configuredWorkers: 3,
    totalCuratedAreas: areas.length,
    availableCapacity: browserPool.available(),
    claimNextArea: async (used) => {
      const next = areas.find((a) => !used.has(a) && !claimed.has(a));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    tryAcquireSlot: () => {
      const releaseBrowser = browserPool.tryAcquire();
      if (!releaseBrowser) return undefined;
      const releaseResource = resourcePool.tryAcquire();
      if (!releaseResource) {
        releaseBrowser();
        return undefined;
      }
      return () => {
        releaseResource();
        releaseBrowser();
      };
    },
    runArea: async () => {
      call += 1;
      if (call % 2 === 0) throw new Error("simulated failure");
      return outcome({ discovered: 1, accepted: 1 });
    },
    isTerminal: () => false,
  });

  assert.equal(resourcePool.inUse(), 0, "every acquired resource slot must be released by the time the whole pool run resolves — no orphan subprocess slot left held");
});

// ── Regression 4: repeated area starts do not accumulate workers ───────────
test("REGRESSION: repeated sequential pool runs (simulating repeated area starts within one job) never accumulate held slots", async () => {
  initResourceWorkerSlotPool(2);
  const resourcePool = getResourceWorkerSlotPool();
  const browserPool = createBrowserSlotPool(10);
  const areas = ["A1", "A2", "A3"];

  for (let round = 0; round < 5; round++) {
    const claimed = new Set<string>();
    await runAreaWorkerPool({
      configuredWorkers: 2,
      totalCuratedAreas: areas.length,
      availableCapacity: browserPool.available(),
      claimNextArea: async (used) => {
        const next = areas.find((a) => !used.has(a) && !claimed.has(a));
        if (!next) return undefined;
        claimed.add(next);
        return next;
      },
      tryAcquireSlot: () => {
        const releaseBrowser = browserPool.tryAcquire();
        if (!releaseBrowser) return undefined;
        const releaseResource = resourcePool.tryAcquire();
        if (!releaseResource) {
          releaseBrowser();
          return undefined;
        }
        return () => {
          releaseResource();
          releaseBrowser();
        };
      },
      runArea: async () => outcome({ discovered: 1, accepted: 1 }),
      isTerminal: () => false,
    });
    assert.equal(resourcePool.inUse(), 0, `round ${round}: resource slots must be fully released between rounds, never accumulating`);
  }
});

// ── Regression 5: init/get singleton wiring ─────────────────────────────────
test("initResourceWorkerSlotPool()/getResourceWorkerSlotPool() share one process-wide pool sized to the measured safe ceiling", () => {
  const initialized = initResourceWorkerSlotPool(3);
  const fetched = getResourceWorkerSlotPool();
  assert.equal(fetched.capacity, 3);
  assert.equal(fetched, initialized, "getResourceWorkerSlotPool() must return the SAME pool instance initResourceWorkerSlotPool() created");
});

test("getResourceWorkerSlotPool() fails SAFE (single-slot pool) rather than open (unbounded) if never initialized", () => {
  const pool = getResourceWorkerSlotPool();
  assert.equal(pool.capacity, 1, "a missing measurement must serialize to one area worker at a time, never allow unbounded concurrency");
});

// ── Regression 6 (Phase 2B, Test C): a 4th concurrent attempt cannot ───────
// bypass the shared capacity=3 ceiling, even when all 4 attempts race
// tryAcquireSlot() at the exact same moment (not sequentially).
test("REGRESSION: a 4th simultaneous area worker cannot bypass shared capacity=3 — tryAcquireSlot() refuses once all 3 slots are held", async () => {
  initResourceWorkerSlotPool(3);
  const resourcePool = getResourceWorkerSlotPool();
  const browserPool = createBrowserSlotPool(10); // memory is not the constraint under test

  const pairedTryAcquireSlot = () => {
    const releaseBrowser = browserPool.tryAcquire();
    if (!releaseBrowser) return undefined;
    const releaseResource = resourcePool.tryAcquire();
    if (!releaseResource) {
      releaseBrowser();
      return undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseResource();
      releaseBrowser();
    };
  };

  // Fire 4 simultaneous acquisition attempts (no await between them) —
  // exactly the "many callers race the same shared pool at once" shape
  // that matters for this regression, as opposed to sequential acquires.
  const releases = [pairedTryAcquireSlot(), pairedTryAcquireSlot(), pairedTryAcquireSlot(), pairedTryAcquireSlot()];

  const acquiredCount = releases.filter((r) => r !== undefined).length;
  assert.equal(acquiredCount, 3, "exactly 3 of the 4 simultaneous attempts may hold a slot — the 4th must be refused");
  assert.equal(releases[3], undefined, "the 4th attempt must receive no release function at all (refused, not queued)");
  assert.equal(resourcePool.inUse(), 3);
  assert.equal(resourcePool.available(), 0);

  // Releasing one slot frees exactly one more attempt, never more.
  releases[0]?.();
  assert.equal(resourcePool.available(), 1);
  const fifthAttempt = pairedTryAcquireSlot();
  assert.notEqual(fifthAttempt, undefined, "a freed slot must become acquirable again");
  assert.equal(resourcePool.inUse(), 3);

  // Cleanup.
  releases[1]?.();
  releases[2]?.();
  fifthAttempt?.();
  assert.equal(resourcePool.inUse(), 0);
});

// ── Regression 7 (Phase 2B, Test F): cancellation/termination still ───────
// releases the slot, exercised through the ACTUAL caller path — the same
// paired browser+resource tryAcquireSlot()/finally wiring discoveryPlanJob.ts
// and poolExpandJob.ts use, combined with runAreaWorkerPool's own
// isTerminal()-driven cancellation — not a simplified stand-in.
test("REGRESSION: mid-run cancellation (isTerminal) still releases the resource slot through the real paired tryAcquireSlot()/finally caller path", async () => {
  initResourceWorkerSlotPool(2);
  const resourcePool = getResourceWorkerSlotPool();
  const browserPool = createBrowserSlotPool(2);
  const areas = ["Area1", "Area2", "Area3", "Area4", "Area5"];
  const claimed = new Set<string>();
  let cancelAfterFirstCompletion = false;

  const result = await runAreaWorkerPool({
    configuredWorkers: 2,
    totalCuratedAreas: areas.length,
    availableCapacity: browserPool.available(),
    claimNextArea: async (used) => {
      const next = areas.find((a) => !used.has(a) && !claimed.has(a));
      if (!next) return undefined;
      claimed.add(next);
      return next;
    },
    // Exactly the production pairing: acquire browser + resource together,
    // release both together, all-or-nothing — see discoveryPlanJob.ts /
    // poolExpandJob.ts's own tryAcquireSlot() closures.
    tryAcquireSlot: () => {
      const releaseBrowser = browserPool.tryAcquire();
      if (!releaseBrowser) return undefined;
      const releaseResource = resourcePool.tryAcquire();
      if (!releaseResource) {
        releaseBrowser();
        return undefined;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseResource();
        releaseBrowser();
      };
    },
    runArea: async () => {
      cancelAfterFirstCompletion = true; // cancellation "lands" once the first area finishes
      return outcome({ discovered: 1, accepted: 1 });
    },
    // Cancellation/termination signal — mirrors observeTerminalPlan() /
    // stopOuter||stillNeededNow()<=0||abortController.signal.aborted in the
    // real callers.
    isTerminal: () => cancelAfterFirstCompletion,
  });

  assert.ok(result.startedWorkers >= 1, "at least one area should have started before cancellation landed");
  assert.equal(resourcePool.inUse(), 0, "cancellation must not leak a held resource slot — the finally-block release must still run");
  assert.equal(browserPool.inUse(), 0, "cancellation must not leak a held browser slot either");
  assert.equal(resourcePool.available(), 2, "full resource capacity must be available again after a cancelled pool run");
});

// ── Regression 8 (Phase 2B, Test F): the legacy (non-pooled) single-search ─
// path's blocking acquire also releases cleanly when its AbortSignal fires
// before a slot was ever acquired — no phantom release, no leak.
test("REGRESSION: legacy blocking acquire aborted before acquiring a slot never leaks — nothing to release, pool stays fully free", async () => {
  initResourceWorkerSlotPool(1);
  const resourcePool = getResourceWorkerSlotPool();

  // Saturate the only slot first, so the blocking acquire below has
  // nothing to acquire and must wait — then abort it, mirroring
  // requestAbort.signal firing mid-wait in discoveryPlanJob.ts's legacy path.
  const holder = resourcePool.tryAcquire();
  assert.ok(holder, "setup: the single slot must be held for this test to exercise the waiting/abort path");

  const controller = new AbortController();
  const { acquireBrowserSlotBlocking } = await import("../browserSlotPool.js");
  const acquirePromise = acquireBrowserSlotBlocking(resourcePool, { pollMs: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  const release = await acquirePromise;

  assert.equal(release, undefined, "an aborted blocking acquire must resolve to undefined, never a phantom release function");
  assert.equal(resourcePool.inUse(), 1, "the pre-existing holder's slot must be untouched by the aborted waiter");

  holder?.();
  assert.equal(resourcePool.inUse(), 0, "releasing the original holder returns the pool to fully free — the aborted waiter left nothing behind");
});
