/**
 * Phase 3B — Discovery Concurrency Audit + Implementation.
 *
 * ROOT CAUSE (see planner.ts's dispatchQueuedDiscoveryTasks docstring for
 * the full writeup): dispatchQueuedDiscoveryTasks used to `.limit(1)`
 * unconditionally, so a plan never had more than one discovery_tasks row
 * dispatched at once, regardless of the worker pool's batch capacity or
 * the per-plan-tier `workerConcurrency` cap that already existed in
 * config/plans.ts and was already enforced (but never fed any real
 * concurrent work) by handleDiscoveryTask's pre-claim check.
 *
 * These tests exercise `computeDispatchSlots` — the pure arithmetic that
 * now decides how many additional discovery_tasks rows may be dispatched
 * on a given call — in isolation from Postgres/pg-boss, matching the style
 * of requestLifecycle.test.ts elsewhere in this directory (pure-logic unit
 * tests; DB-touching behavior is covered separately by a
 * DATABASE_URL-gated integration test, mirroring
 * poolExpandDeliveryReservation.test.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeDispatchSlots } from "../cityScheduling.js";
import { getPlanConcurrency } from "../../config/plans.js";

test("dispatches up to the full concurrency cap when nothing is running yet and enough work is queued", () => {
  // e.g. a pro-tier plan (cap 8) with 20 queued cities should get 8
  // dispatched at once — genuine overlapping city/provider work, not one
  // city finishing before the next starts.
  assert.equal(computeDispatchSlots(8, 0, 20), 8);
});

test("never exceeds the concurrency cap even when far more work is queued", () => {
  assert.equal(computeDispatchSlots(2, 0, 1000), 2);
  assert.equal(computeDispatchSlots(16, 0, 1000), 16);
});

test("only dispatches remaining headroom when some tasks are already running", () => {
  // 8-cap plan, 5 already running -> only 3 more may be dispatched (this is
  // the "top-up" call made after each task completion).
  assert.equal(computeDispatchSlots(8, 5, 20), 3);
});

test("dispatches zero, never negative, once the user is already at their concurrency cap", () => {
  assert.equal(computeDispatchSlots(4, 4, 20), 0);
  assert.equal(computeDispatchSlots(4, 9, 20), 0); // stale/racy overcount must not go negative
});

test("never dispatches more than what is actually queued, even with headroom to spare", () => {
  // 16-cap (premium) plan but only 2 cities left queued -> dispatch 2, not 16.
  assert.equal(computeDispatchSlots(16, 0, 2), 2);
  assert.equal(computeDispatchSlots(16, 10, 0), 0);
});

test("dispatches nothing once requested==accepted has already stopped queueing further work", () => {
  // dispatchQueuedDiscoveryTasks itself returns before calling
  // computeDispatchSlots once delivered_count >= requested_count, but the
  // arithmetic must also degrade safely to zero if ever called with no
  // queued work left (e.g. every city already attempted).
  assert.equal(computeDispatchSlots(8, 0, 0), 0);
});

test("per-tier concurrency caps feed directly into the dispatch bound (free=2, starter=4, pro=8, premium=16)", () => {
  assert.equal(computeDispatchSlots(getPlanConcurrency("free"), 0, 20), 2);
  assert.equal(computeDispatchSlots(getPlanConcurrency("starter"), 0, 20), 4);
  assert.equal(computeDispatchSlots(getPlanConcurrency("pro"), 0, 20), 8);
  assert.equal(computeDispatchSlots(getPlanConcurrency("premium"), 0, 20), 16);
});

test("runtime PLAN_CONCURRENCY_OVERRIDES changes the dispatch bound without a deploy", () => {
  assert.equal(computeDispatchSlots(getPlanConcurrency("pro", { pro: 3 }), 0, 20), 3);
});

test("sustained concurrency: repeated top-up calls converge on the cap as tasks complete one at a time", () => {
  // Models what actually happens in production: materializeDiscoveryPlan's
  // initial dispatch, then one top-up dispatchQueuedDiscoveryTasks call per
  // completed task (discoveryPlanJob.ts). With a cap of 3 and 10 queued
  // cities, the plan should sustain exactly 3 concurrent workers the whole
  // way through, never more, never dropping to 1.
  const cap = 3;
  let queued = 10;
  let running = 0;
  const dispatchedOverTime: number[] = [];

  // Initial fan-out.
  let slots = computeDispatchSlots(cap, running, queued);
  running += slots;
  queued -= slots;
  dispatchedOverTime.push(running);
  assert.equal(running, 3);

  // Each subsequent "task finished -> top up" cycle.
  while (queued > 0) {
    running -= 1; // one worker finished
    slots = computeDispatchSlots(cap, running, queued);
    running += slots;
    queued -= slots;
    dispatchedOverTime.push(running);
  }

  // The pool never exceeded the cap and stayed saturated (at the cap)
  // until the queue ran out, rather than draining to 1 the way the
  // pre-fix `.limit(1)` dispatch did.
  assert.ok(dispatchedOverTime.every((n) => n <= cap));
  assert.ok(dispatchedOverTime.slice(0, -1).every((n) => n === cap));
});
