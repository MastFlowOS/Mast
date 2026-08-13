/**
 * Worker Pools B — nested-concurrency capacity safety.
 *
 * Pure tests for the browser slot semaphore (createBrowserSlotPool /
 * initBrowserSlotPool / getBrowserSlotPool) that now bounds TOTAL
 * concurrently running Google browsers in this worker process, regardless
 * of whether the concurrency came from many discovery_tasks, one task's
 * Google area worker pool, or a mix of both — the specific gap the B-0
 * audit flagged in effectiveConcurrency's old "1 task = 1 browser"
 * assumption. No OS memory measurement or Supabase call is exercised here
 * (measureBrowserCapacity's os.freemem()-based arithmetic is unchanged and
 * not re-tested); this file covers only the semaphore itself.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserSlotPool, initBrowserSlotPool, getBrowserSlotPool, acquireBrowserSlotBlocking, __testing_browserSlotPool as __testing_workerCapacity } from "../browserSlotPool.js";

test("createBrowserSlotPool never grants more concurrent slots than its capacity", () => {
  const pool = createBrowserSlotPool(2);
  const a = pool.tryAcquire();
  const b = pool.tryAcquire();
  const c = pool.tryAcquire();

  assert.ok(a, "first slot must be granted");
  assert.ok(b, "second slot must be granted");
  assert.equal(c, undefined, "a third slot must be refused — capacity is 2");
  assert.equal(pool.inUse(), 2);
  assert.equal(pool.available(), 0);
});

test("releasing a slot frees it up for the next tryAcquire()", () => {
  const pool = createBrowserSlotPool(1);
  const release = pool.tryAcquire();
  assert.ok(release);
  assert.equal(pool.tryAcquire(), undefined, "capacity 1 — no second slot while the first is held");

  release!();
  assert.equal(pool.available(), 1);
  const second = pool.tryAcquire();
  assert.ok(second, "slot must be available again after release");
});

test("release() is idempotent — calling it twice never over-counts available slots", () => {
  const pool = createBrowserSlotPool(1);
  const release = pool.tryAcquire();
  release!();
  release!(); // double release must not push availability above capacity
  assert.equal(pool.available(), 1);
  assert.equal(pool.inUse(), 0);
});

test("capacity is clamped to a minimum of 1 (never deadlocks a worker with zero measured memory)", () => {
  const pool = createBrowserSlotPool(0);
  assert.equal(pool.capacity, 1);
  const pool2 = createBrowserSlotPool(-5);
  assert.equal(pool2.capacity, 1);
});

test("initBrowserSlotPool()/getBrowserSlotPool() share one process-wide pool", () => {
  __testing_workerCapacity.reset();
  const initialized = initBrowserSlotPool(3);
  const fetched = getBrowserSlotPool();
  assert.equal(fetched.capacity, 3);
  assert.equal(fetched, initialized, "getBrowserSlotPool() must return the SAME pool instance initBrowserSlotPool() created");
  __testing_workerCapacity.reset();
});

test("getBrowserSlotPool() falls back to a safe single-slot pool if never initialized", () => {
  __testing_workerCapacity.reset();
  const pool = getBrowserSlotPool();
  assert.equal(pool.capacity, 1, "fail SAFE (serialize) rather than fail open (unbounded) when startup never ran");
  __testing_workerCapacity.reset();
});

// ── Nested-concurrency scenario: many tasks × in-task area fan-out never exceeds the real ceiling ──
test("nested concurrency: N tasks each spawning M area workers never exceeds the measured browser ceiling", () => {
  const measuredSlots = 4; // e.g. this worker process measured room for 4 Chromium processes
  const pool = createBrowserSlotPool(measuredSlots);

  // Simulate 4 "tasks" each wanting to run 4 "area workers" concurrently —
  // i.e. the exact scenario the phase prompt calls out: "4 discovery tasks
  // × 4 Google workers must NOT silently become 16 unconstrained browsers".
  const releases: (() => void)[] = [];
  let grantedTotal = 0;
  for (let task = 0; task < 4; task++) {
    for (let areaWorker = 0; areaWorker < 4; areaWorker++) {
      const release = pool.tryAcquire();
      if (release) {
        grantedTotal += 1;
        releases.push(release);
      }
    }
  }

  assert.equal(grantedTotal, measuredSlots, "only as many browsers as the measured ceiling may run at once, regardless of how the demand is shaped");
  assert.equal(pool.inUse(), measuredSlots);
  for (const release of releases) release();
  assert.equal(pool.inUse(), 0);
});

// ── acquireBrowserSlotBlocking: the piece that closes the legacy-path gap ──
test("acquireBrowserSlotBlocking waits for a slot to free up rather than failing when saturated", async () => {
  const pool = createBrowserSlotPool(1);
  const release = pool.tryAcquire();
  assert.ok(release);

  const acquirePromise = acquireBrowserSlotBlocking(pool, { pollMs: 5 });
  let resolved = false;
  acquirePromise.then(() => { resolved = true; });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false, "must still be waiting while the only slot is held");

  release!();
  const secondRelease = await acquirePromise;
  assert.ok(secondRelease, "must eventually acquire once the held slot is released");
  secondRelease!();
});

test("acquireBrowserSlotBlocking returns undefined promptly once its abort signal fires", async () => {
  const pool = createBrowserSlotPool(1);
  const release = pool.tryAcquire();
  assert.ok(release);

  const controller = new AbortController();
  const acquirePromise = acquireBrowserSlotBlocking(pool, { pollMs: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 15);

  const result = await acquirePromise;
  assert.equal(result, undefined);
  release!();
});

test("nested concurrency: a pooled task's area workers never exceed the ceiling alongside OTHER legacy tasks already holding slots", async () => {
  // This is the exact gap acquireBrowserSlotBlocking() closes: without the
  // legacy single-search path also acquiring from this SAME semaphore, a
  // pooled task's tryAcquireSlot() calls would be blind to browsers already
  // held by other concurrently-running (non-pooled) tasks in this process.
  const measuredSlots = 3;
  const pool = createBrowserSlotPool(measuredSlots);

  // Two "legacy" tasks already running, each holding one browser slot.
  const legacyReleaseA = await acquireBrowserSlotBlocking(pool);
  const legacyReleaseB = await acquireBrowserSlotBlocking(pool);
  assert.ok(legacyReleaseA && legacyReleaseB);
  assert.equal(pool.available(), 1, "only 1 of 3 slots should remain free with 2 legacy tasks already running");

  // A pooled task now tries to start area workers — it can only ever start
  // as many as the REMAINING capacity, not the full measured ceiling.
  let granted = 0;
  for (let i = 0; i < 3; i++) {
    if (pool.tryAcquire()) granted += 1;
  }
  assert.equal(granted, 1, "the pool must see the 2 legacy-held slots and only grant the 1 that's actually free");
  assert.equal(pool.inUse(), measuredSlots, "total in-use must never exceed the measured ceiling across legacy + pooled work combined");

  legacyReleaseA!();
  legacyReleaseB!();
});
