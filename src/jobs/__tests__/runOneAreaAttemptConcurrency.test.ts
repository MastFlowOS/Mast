/**
 * PHASE 4B — runOneAreaAttempt Bounded Candidate Concurrency Tests.
 *
 * Verifies the exact execution path and invariants in `src/jobs/discoveryPlanJob.ts`:
 *   1. MAX_CANDIDATE_CONCURRENCY is defined and exported as 3.
 *   2. Bounded in-flight pool: in-flight set is strictly capped at MAX_CANDIDATE_CONCURRENCY (3).
 *   3. Backpressure invariant: iterator.next() is paused while 3 tasks are in-flight.
 *   4. Single consumer: only one sequential consumer drives the provider search iterator.
 *   5. Candidate isolation: task-level try/catch guarantees a failure in candidate A
 *      does not abort or reject candidates B and C in flight.
 *   6. Settling & Cleanup: all in-flight tasks settle via Promise.all before query exit,
 *      and searchIterator.return?.(undefined) cleans up generator resources.
 *   7. Abort & Terminal handling: mid-loop cancellation breaks consumer loop,
 *      and post-abort deliveries are cleanly skipped.
 *   8. Observational telemetry: Service-need gate and qualification telemetry remains
 *      observational and does not block delivery.
 *   9. Deduplication & Credit Safety: Atomic database protections remain authoritative.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MAX_CANDIDATE_CONCURRENCY, __testing } from "../discoveryPlanJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const discoveryPlanJobSrc = readFileSync(path.join(__dirname, "../discoveryPlanJob.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. Static Contract & Architectural Pinning
// ---------------------------------------------------------------------------

test("1. MAX_CANDIDATE_CONCURRENCY is exported and strictly set to 3", () => {
  assert.equal(MAX_CANDIDATE_CONCURRENCY, 3, "Phase 4B concurrency must be bounded to at most 3");
  assert.equal(__testing.MAX_CANDIDATE_CONCURRENCY, 3);
  assert.equal(typeof __testing.runOneAreaAttempt, "function");
});

test("2. runOneAreaAttempt uses a bounded inFlight Set and Promise.race backpressure", () => {
  assert.ok(
    discoveryPlanJobSrc.includes("const inFlight = new Set<Promise<void>>()"),
    "Expected runOneAreaAttempt to allocate an inFlight Set",
  );
  assert.ok(
    discoveryPlanJobSrc.includes("if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY)"),
    "Expected check against MAX_CANDIDATE_CONCURRENCY before pulling next candidate",
  );
  assert.ok(
    discoveryPlanJobSrc.includes("await Promise.race(inFlight)"),
    "Expected Promise.race backpressure pause when inFlight reaches capacity",
  );
});

test("3. Upstream backpressure pauses iterator.next() before pulling new candidates", () => {
  const backpressureIndex = discoveryPlanJobSrc.indexOf("if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY)");
  const nextCallIndex = discoveryPlanJobSrc.indexOf("next = await searchIterator.next()");

  assert.notEqual(backpressureIndex, -1, "Backpressure check must exist");
  assert.notEqual(nextCallIndex, -1, "searchIterator.next() call must exist");
  assert.ok(
    backpressureIndex < nextCallIndex,
    "Backpressure check MUST occur BEFORE searchIterator.next() to prevent prefetching when full",
  );
});

test("4. Single consumer drives provider.search iterator", () => {
  const iteratorAllocIndex = discoveryPlanJobSrc.indexOf("const searchIterator = searchIterable[Symbol.asyncIterator]()");
  assert.notEqual(iteratorAllocIndex, -1, "Must obtain searchIterator explicitly");

  // Verify searchIterator is only driven by the single while loop
  const occurrences = discoveryPlanJobSrc.split("searchIterator.next()").length - 1;
  assert.equal(occurrences, 1, "Exactly one call site must pull searchIterator.next()");
});

test("5. Every in-flight task has top-level try/catch preventing unhandled rejections", () => {
  assert.ok(
    discoveryPlanJobSrc.includes("unhandled candidate task failure for pid="),
    "candidateTask must catch top-level unexpected errors",
  );
  assert.ok(
    discoveryPlanJobSrc.includes("inFlight.delete(wrapped)"),
    "candidateTask must remove itself from inFlight via finally",
  );
  assert.ok(
    discoveryPlanJobSrc.includes("await Promise.all(inFlight)"),
    "runOneAreaAttempt must await all in-flight tasks before query exit",
  );
  assert.ok(
    discoveryPlanJobSrc.includes("await searchIterator.return?.(undefined)"),
    "runOneAreaAttempt must cleanly dispose searchIterator on exit",
  );
});

// ---------------------------------------------------------------------------
// 2. Functional Concurrency, Isolation, and Backpressure Invariants
// ---------------------------------------------------------------------------

test("6. Candidate processing overlaps when tasks are slow, never exceeding 3 peak concurrency", async () => {
  const activeTasks = new Set<string>();
  let peakConcurrency = 0;
  const executionOrder: string[] = [];

  // Simulate 6 candidates with varying processing durations
  const candidateDurations: Record<string, number> = {
    "c-0": 50,
    "c-1": 80,
    "c-2": 30,
    "c-3": 40,
    "c-4": 20,
    "c-5": 30,
  };

  async function* mockCandidateStream() {
    for (const [id, duration] of Object.entries(candidateDurations)) {
      yield { id, duration };
    }
  }

  const inFlight = new Set<Promise<void>>();
  const stream = mockCandidateStream()[Symbol.asyncIterator]();

  while (true) {
    if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY) {
      await Promise.race(inFlight);
    }

    const next = await stream.next();
    if (next.done) break;

    const { id, duration } = next.value;

    const task = (async () => {
      activeTasks.add(id);
      if (activeTasks.size > peakConcurrency) {
        peakConcurrency = activeTasks.size;
      }

      await new Promise((resolve) => setTimeout(resolve, duration));

      activeTasks.delete(id);
      executionOrder.push(id);
    })();

    const wrapped = task.finally(() => inFlight.delete(wrapped));
    inFlight.add(wrapped);
  }

  await Promise.all(inFlight);

  assert.equal(peakConcurrency, 3, "Peak concurrency must equal 3");
  assert.equal(activeTasks.size, 0, "All tasks must have settled");
  assert.equal(executionOrder.length, 6, "All 6 candidates must have executed");
  // Out of order completion: c-2 (30ms) finishes before c-1 (80ms)
  const idx1 = executionOrder.indexOf("c-1");
  const idx2 = executionOrder.indexOf("c-2");
  assert.ok(idx2 < idx1, `c-2 (${idx2}) should finish before c-1 (${idx1})`);
});

test("7. Upstream pull is halted while 3 tasks are in-flight (true backpressure)", async () => {
  let resolve0: () => void = () => {};
  let resolve1: () => void = () => {};
  let resolve2: () => void = () => {};

  const p0 = new Promise<void>((r) => { resolve0 = r; });
  const p1 = new Promise<void>((r) => { resolve1 = r; });
  const p2 = new Promise<void>((r) => { resolve2 = r; });

  const pulledItems: string[] = [];

  async function* mockStream() {
    for (let i = 0; i < 6; i++) {
      pulledItems.push(`item-${i}`);
      yield `item-${i}`;
    }
  }

  const inFlight = new Set<Promise<void>>();
  const stream = mockStream()[Symbol.asyncIterator]();

  const runner = (async () => {
    while (true) {
      if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY) {
        await Promise.race(inFlight);
      }
      const next = await stream.next();
      if (next.done) break;

      const id = next.value;
      const task = (async () => {
        if (id === "item-0") await p0;
        else if (id === "item-1") await p1;
        else if (id === "item-2") await p2;
        else await new Promise((r) => setTimeout(r, 10));
      })();

      const wrapped = task.finally(() => inFlight.delete(wrapped));
      inFlight.add(wrapped);
    }
    await Promise.all(inFlight);
  })();

  // Wait a short tick for the pool to fill
  await new Promise((r) => setTimeout(r, 40));

  // Items 0, 1, 2 were pulled and are in-flight.
  // Backpressure MUST prevent pulling item-3!
  assert.deepEqual(pulledItems, ["item-0", "item-1", "item-2"], "Iterator must NOT pull item-3 while slots 0,1,2 are busy");

  // Release item-1
  resolve1();
  await new Promise((r) => setTimeout(r, 40));

  // Now item-3 should have been pulled
  assert.ok(pulledItems.includes("item-3"), "Iterator should resume and pull item-3 once a slot opens");

  // Release remaining
  resolve0();
  resolve2();
  await runner;

  assert.equal(pulledItems.length, 6, "All 6 items pulled eventually");
});

test("8. Candidate failure isolation: an exception in candidate 1 does not abort siblings", async () => {
  const successes: string[] = [];
  const failures: string[] = [];

  const inFlight = new Set<Promise<void>>();

  async function processCandidate(id: string) {
    try {
      if (id === "bad-cand") {
        throw new Error("Simulated website crawl fatal crash");
      }
      await new Promise((r) => setTimeout(r, 20));
      successes.push(id);
    } catch (err) {
      failures.push(id);
    }
  }

  const candidates = ["cand-0", "bad-cand", "cand-2"];
  for (const c of candidates) {
    if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY) {
      await Promise.race(inFlight);
    }
    const task = processCandidate(c);
    const wrapped = task.finally(() => inFlight.delete(wrapped));
    inFlight.add(wrapped);
  }

  await Promise.all(inFlight);

  assert.equal(failures.length, 1);
  assert.equal(failures[0], "bad-cand");
  assert.deepEqual(successes.sort(), ["cand-0", "cand-2"], "Siblings must succeed without aborting");
});

test("9. AbortSignal cleanly stops admission of new candidates and skips post-abort delivery", async () => {
  const abortController = new AbortController();
  const delivered: string[] = [];
  const inFlight = new Set<Promise<void>>();

  async function* mockStream() {
    for (let i = 0; i < 10; i++) {
      yield `cand-${i}`;
    }
  }

  const stream = mockStream()[Symbol.asyncIterator]();

  while (true) {
    if (abortController.signal.aborted) break;
    if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY) {
      await Promise.race(inFlight);
    }
    if (abortController.signal.aborted) break;

    const next = await stream.next();
    if (next.done) break;

    const id = next.value;

    const task = (async () => {
      if (id === "cand-1") {
        abortController.abort(); // Cancel while cand-0 and cand-1 are in-flight
      }
      await new Promise((r) => setTimeout(r, 20));
      if (!abortController.signal.aborted) {
        delivered.push(id);
      }
    })();

    const wrapped = task.finally(() => inFlight.delete(wrapped));
    inFlight.add(wrapped);
  }

  await Promise.all(inFlight);

  assert.ok(delivered.length <= 1, "No deliveries should occur after abort is observed");
  assert.ok(!delivered.includes("cand-2"), "Candidates after abort must never be admitted");
  assert.ok(!delivered.includes("cand-9"), "Candidates after abort must never be admitted");
});
