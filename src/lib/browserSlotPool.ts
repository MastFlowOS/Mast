/**
 * Worker Pools B (Google Maps area workers) — nested-concurrency capacity.
 *
 * Deliberately split out from workerCapacity.ts (which pulls in
 * supabaseAdmin.ts / env.ts for `worker_instances` registration/heartbeat)
 * so this pure counting semaphore has ZERO external dependencies — no
 * Supabase, no env parsing, no OS calls. That mirrors this codebase's
 * existing pure/DB-split convention (cityScheduling.ts vs areaRotation.ts,
 * computeDispatchSlots() vs its DB-backed dispatch caller) and, concretely,
 * is what lets googleAreaPool.test.ts unit-test this semaphore without a
 * live Supabase project configured.
 *
 * `effectiveConcurrency` (workerCapacity.ts) answers "how many
 * discovery_tasks can this worker process pull concurrently" under the
 * B-0-era assumption that one discovery task spawns exactly one Google
 * browser. That assumption breaks once a single Google Maps task can
 * itself fan out into multiple area workers (src/discovery/googleAreaPool.ts),
 * each spawning its OWN service.py/Playwright/Chromium process — so the
 * true ceiling this worker process must respect is on concurrently
 * RUNNING BROWSERS, not on concurrently running tasks.
 *
 * `browserSlots` (measured in workerCapacity.ts from real OS free memory)
 * is exactly that browser-level ceiling. This module exposes it as a
 * single process-wide counting semaphore that BOTH of the following now
 * acquire a slot from before spawning a browser:
 *   • the legacy single-search path (no curated areas, or a non-Google
 *     provider is left untouched and does not use this semaphore at all —
 *     see discoveryPlanJob.ts's sourceId === "google_maps" gate)
 *   • each Google area worker inside a curated-area task
 *
 * This keeps the invariant "total concurrent browsers in this process ≤
 * measured memory-safe slots" true regardless of whether the concurrency
 * came from many tasks, one task with many areas, or a mix of both — which
 * is the specific gap the B-0 audit flagged (task-level batchSize alone no
 * longer bounds real Google browser fan-out).
 */
export type BrowserSlotPool = {
  /** Total slots this pool was configured with. */
  readonly capacity: number;
  /** Slots currently free (best-effort snapshot — see tryAcquire()'s own note). */
  available(): number;
  /** Slots currently held. */
  inUse(): number;
  /**
   * Attempts to take one slot immediately, without waiting. Returns a
   * release function on success, or `undefined` if no slot is free right
   * now. Non-blocking by design — callers (googleAreaPool.ts) use this to
   * decide "can I start another area worker right now" rather than
   * queueing indefinitely, so a saturated pool degrades to "start fewer
   * workers than configured" (Worker Pools B Step 2/Test C) instead of
   * piling up waiters.
   */
  tryAcquire(): (() => void) | undefined;
};

/**
 * Creates a process-local counting semaphore sized to `capacity` slots.
 * `capacity` should come from a real measurement (browserSlots from
 * measureBrowserCapacity), never a guessed constant — see this module's own
 * doc comment and the Worker Pools B phase prompt's "Do not invent a fixed
 * MB number without evidence" requirement.
 *
 * Clamped to a minimum of 1 so a worker that measured zero free memory
 * still processes work rather than deadlocking — matches
 * measureBrowserCapacity()'s own `Math.max(1, ...)` clamp for
 * effectiveConcurrency.
 */
export function createBrowserSlotPool(capacity: number): BrowserSlotPool {
  const total = Math.max(1, Math.floor(capacity));
  let held = 0;
  return {
    capacity: total,
    available: () => total - held,
    inUse: () => held,
    tryAcquire: () => {
      if (held >= total) return undefined;
      held += 1;
      let released = false;
      return () => {
        if (released) return; // idempotent — a double-release must never under-count `held`
        released = true;
        held -= 1;
      };
    },
  };
}

/**
 * The process-wide browser slot pool. `undefined` until
 * `initBrowserSlotPool()` runs (workers/index.ts, right after
 * `measureBrowserCapacity()`), so any code path that races startup fails
 * loudly instead of silently allowing unbounded browsers.
 */
let processBrowserSlotPool: BrowserSlotPool | undefined;

export function initBrowserSlotPool(capacity: number): BrowserSlotPool {
  processBrowserSlotPool = createBrowserSlotPool(capacity);
  console.log(`[workerCapacity] browserSlotPool initialized capacity=${processBrowserSlotPool.capacity}`);
  return processBrowserSlotPool;
}

/**
 * Returns the process-wide browser slot pool, initializing a single-slot
 * fallback pool (today's "1 task = 1 browser" behavior) if
 * `initBrowserSlotPool()` was never called — e.g. in tests, or a code path
 * that runs before worker startup completes. Never throws, because a
 * missing pool must fail SAFE (serialize to one browser at a time), not
 * fail open (unbounded browsers).
 */
export function getBrowserSlotPool(): BrowserSlotPool {
  if (!processBrowserSlotPool) {
    console.warn("[workerCapacity] getBrowserSlotPool() called before initBrowserSlotPool() — falling back to a single-slot pool");
    processBrowserSlotPool = createBrowserSlotPool(1);
  }
  return processBrowserSlotPool;
}

export const __testing_browserSlotPool = {
  reset: () => { processBrowserSlotPool = undefined; },
};

/**
 * Blocking (polling) slot acquisition — used by the legacy single-browser
 * Google Maps path (discoveryPlanJob.ts), which must still guarantee it
 * eventually gets to run (today's behavior: a discovery task always gets
 * its one browser) rather than degrading to "skip this task" the way the
 * area POOL's non-blocking `tryAcquireSlot()` is allowed to (Worker Pools
 * B Step 2 / Test C — "no fake work" when saturated).
 *
 * This is the piece that closes the real nested-concurrency gap the B-0
 * audit flagged: without it, only Google area-POOL workers would ever
 * decrement this semaphore, so N other concurrently-running ordinary
 * (non-pooled) Google Maps tasks in the same worker process — each
 * legitimately holding one browser under the OLD "1 task = 1 browser"
 * assumption — would be invisible to it, and a pooled task could then
 * still fan out up to `browserSlots` MORE browsers on top of those N,
 * exceeding the measured memory-safe ceiling. Gating the legacy path
 * through the SAME semaphore is what keeps "total concurrent Google
 * browsers in this process ≤ browserSlots" true even when ordinary tasks
 * and a pooled task are running side by side.
 *
 * Polls rather than queues/exits on a signal — background job runtime, not
 * a user-facing synchronous request, so a brief wait for a slot to free up
 * is an acceptable, deliberately simple choice over a fuller wait-queue.
 */
export async function acquireBrowserSlotBlocking(
  pool: BrowserSlotPool,
  opts: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<(() => void) | undefined> {
  const pollMs = opts.pollMs ?? 250;
  for (;;) {
    if (opts.signal?.aborted) return undefined;
    const release = pool.tryAcquire();
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
