/**
 * P0 — SHARED LIVE PID ADMISSION regression tests.
 *
 * ROOT CAUSE under test (see resourceCapacity.ts's own doc comment on
 * `trySharedPidAdmission` for the full writeup): area-worker capacity
 * (`resourceWorkerSlotPool`) and enrichment/score concurrency
 * (`businessEnrichConcurrency`/`businessScoreConcurrency`) were each sized
 * from a single point-in-time `pids.max`/`pids.current` snapshot taken once
 * at process startup, and neither re-checked LIVE `pids.current` before
 * admitting a new subprocess-spawning unit of work — while both draw from
 * the SAME cgroup `pids.max` budget. `trySharedPidAdmission` is the shared,
 * race-safe, live-checked admission gate that closes that gap for both
 * systems at once.
 *
 * `readPidCapacity()` reads this container's real `/sys/fs/cgroup` files,
 * which this test suite must not depend on (mirrors the P0 prompt's own
 * "mock/inject pids.current rather than relying on the real host") — every
 * test below injects a fabricated snapshot via
 * `__testing_sharedPidAdmission.setPidCapacity()`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  trySharedPidAdmission,
  acquireSharedPidAdmissionBlocking,
  __testing_sharedPidAdmission,
} from "../resourceCapacity.js";

test.beforeEach(() => {
  __testing_sharedPidAdmission.reset();
});

test.after(() => {
  __testing_sharedPidAdmission.reset();
});

// ── 1. Enough live PID capacity → admission granted ─────────────────────────
test("1. enough live PID capacity grants admission", () => {
  // pidsMax=1000, reservePids=300 (default), pidsCurrent=300 -> headroom=400, comfortably >= 220.
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 300 });
  const outcome = trySharedPidAdmission(220, "area_worker");
  assert.equal(outcome.granted, true);
  if (outcome.granted) outcome.release();
});

// ── 2. Insufficient live PID capacity → admission denied ────────────────────
test("2. insufficient live PID capacity denies admission", () => {
  // pidsMax=1000, pidsCurrent=926, reservePids defaults to env.PIDS_RESERVE_BUDGET (300)
  // -> headroom = 1000 - 300 - 926 = -226, well under requested 220.
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 926 });
  const outcome = trySharedPidAdmission(220, "area_worker");
  assert.equal(outcome.granted, false);
  if (!outcome.granted) {
    assert.equal(outcome.pidsCurrent, 926);
    assert.equal(outcome.pidsMax, 1000);
    assert.ok(outcome.reason.includes("insufficient live PID headroom"));
  }
});

// ── 3. Two concurrent admission attempts cannot both consume the same
//        final protected capacity ──────────────────────────────────────────
test("3. two admission attempts against the same live headroom cannot both be granted past the budget", () => {
  // pidsMax=1000, reservePids=300 (default), pidsCurrent=400 -> raw headroom=300.
  // Two area-worker requests of 220 each: first must be granted (220<=300),
  // second must be denied (300-220=80 remaining < 220) — never both granted,
  // which is exactly the race the P0 prompt describes (A reads 600 -> allowed;
  // B reads 600 -> allowed; both spawn).
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 400 });
  const first = trySharedPidAdmission(220, "area_worker");
  const second = trySharedPidAdmission(220, "area_worker");
  assert.equal(first.granted, true);
  assert.equal(second.granted, false);
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 220);
  if (first.granted) first.release();
});

// ── 4. Reservation releases after normal subprocess completion ──────────────
test("4. reservation releases after normal completion, freeing headroom for the next request", async () => {
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 400 });
  const first = trySharedPidAdmission(220, "area_worker");
  assert.equal(first.granted, true);
  if (first.granted) {
    // simulate the subprocess lifecycle completing normally
    await Promise.resolve();
    first.release();
  }
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 0);
  const second = trySharedPidAdmission(220, "area_worker");
  assert.equal(second.granted, true);
  if (second.granted) second.release();
});

// ── 5. Reservation releases after exception ──────────────────────────────────
test("5. reservation releases after the guarded subprocess call throws", async () => {
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 400 });
  const outcome = trySharedPidAdmission(220, "enrichment");
  assert.equal(outcome.granted, true);
  if (outcome.granted) {
    try {
      await (async () => {
        throw new Error("simulated subprocess failure");
      })();
    } catch {
      // expected
    } finally {
      outcome.release();
    }
  }
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 0);
});

// ── 6. Reservation releases after abort/timeout ──────────────────────────────
test("6. reservation releases after an aborted/timed-out subprocess call", async () => {
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 400 });
  const outcome = trySharedPidAdmission(220, "area_worker");
  assert.equal(outcome.granted, true);
  if (outcome.granted) {
    const controller = new AbortController();
    try {
      const pending = new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      controller.abort();
      await pending.catch(() => {});
    } finally {
      outcome.release();
    }
  }
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 0);

  // double-release must never under-count (idempotent release contract)
  if (outcome.granted) outcome.release();
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 0);
});

// ── 7. Area worker and enrichment share the same admission budget ───────────
test("7. area-worker and enrichment admission requests draw from the SAME shared budget", () => {
  // pidsMax=1000, reservePids=300, pidsCurrent=460 -> raw headroom=240.
  // An area worker (220) fits; the shared budget is now down to 20, so an
  // enrichment request (20) still fits exactly, and a second enrichment
  // request must be denied — proving the two callers share ONE budget, not
  // two independent ones.
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 460 });
  const areaWorker = trySharedPidAdmission(220, "area_worker");
  assert.equal(areaWorker.granted, true);
  const enrichmentOne = trySharedPidAdmission(20, "enrichment");
  assert.equal(enrichmentOne.granted, true);
  const enrichmentTwo = trySharedPidAdmission(20, "enrichment");
  assert.equal(enrichmentTwo.granted, false);
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 240);
  if (areaWorker.granted) areaWorker.release();
  if (enrichmentOne.granted) enrichmentOne.release();
});

// ── Fail-safe: unmeasurable pids.max grants (no-op release), never hard-denies ──
test("8. unmeasurable pids.max (cgroup unavailable) grants unconditionally with a no-op release", () => {
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "unavailable", pidsMax: null, pidsCurrent: null });
  const outcome = trySharedPidAdmission(220, "area_worker");
  assert.equal(outcome.granted, true);
  if (outcome.granted) {
    outcome.release();
    outcome.release(); // idempotent no-op, must not throw
  }
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 0);
});

// ── Blocking variant: polls until a denied request is later granted ─────────
test("9. acquireSharedPidAdmissionBlocking polls until headroom frees up", async () => {
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 400 });
  const holder = trySharedPidAdmission(220, "area_worker");
  assert.equal(holder.granted, true);

  // headroom is now 300-220=80, not enough for another 220 request — the
  // blocking acquire must keep polling rather than granting immediately.
  const blockingPromise = acquireSharedPidAdmissionBlocking(220, "area_worker", { pollMs: 10 });

  // free the held reservation shortly after; the blocking acquire should
  // then succeed on its next poll.
  setTimeout(() => {
    if (holder.granted) holder.release();
  }, 30);

  const release = await blockingPromise;
  assert.ok(typeof release === "function");
  release?.();
  assert.equal(__testing_sharedPidAdmission.getReservedPidUnits(), 0);
});

test("9b. acquireSharedPidAdmissionBlocking respects an aborted signal", async () => {
  __testing_sharedPidAdmission.setPidCapacity({ cgroupVersion: "v2", pidsMax: 1000, pidsCurrent: 999 });
  const controller = new AbortController();
  controller.abort();
  const release = await acquireSharedPidAdmissionBlocking(220, "area_worker", { pollMs: 10, signal: controller.signal });
  assert.equal(release, undefined);
});
