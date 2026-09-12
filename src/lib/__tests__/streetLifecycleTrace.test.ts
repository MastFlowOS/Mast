/**
 * CRITMODE — unit tests for the per-street lifecycle correlator
 * (streetLifecycleTrace.ts). Pure-logic tests: no Supabase/pg-boss/Python
 * subprocess required, since this module has no such dependency — every
 * timestamp is either injected directly (`now()`) or supplied via a
 * hand-built `EngineDoneInfo`-shaped object.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreetLifecycleTracer,
  emitRunSummary,
  recordStreetSummary,
  __testing_streetLifecycleTrace,
} from "../streetLifecycleTrace.js";
import type { StreetLifecycleCounts, StreetTimingSummary } from "../streetLifecycleTrace.js";

const ZERO_COUNTS: StreetLifecycleCounts = {
  raw_candidates: 0,
  yielded_candidates: 0,
  admitted_candidates: 0,
  enrichment_attempts: 0,
  qualified: 0,
  new_for_user: 0,
  delivered: 0,
};

/** Simple controllable clock for deterministic tests. */
function makeClock(startAt = 1_000_000) {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    value: () => t,
  };
}

test("1. correlates a full street lifecycle by street key / run id / worker id", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock();

  const tracer = createStreetLifecycleTracer({
    streetKey: "ny:main-st",
    streetName: "Main St",
    runId: "run-1",
    workerId: "worker-1",
    now: clock.now,
  });

  tracer.markClaimed(); // t=1_000_000
  clock.advance(50);
  tracer.markSpawnStarted(); // spawn_started at +50ms

  clock.advance(10);
  tracer.markFirstForwarded(); // +60ms from claim

  clock.advance(5);
  tracer.markFirstNewForUser(); // +65ms from claim

  clock.advance(20);
  tracer.markEngineDone(); // +85ms from claim

  clock.advance(5);
  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 12, firstLineMs: 30, firstLeadMs: 40 },
      progressMarks: {
        "discovery:maps_navigation_start": 15,
        "discovery:candidate_discovered": 25,
        "discovery:candidate_queued": 28,
        "website:stage_completed": 33,
        "qualification:candidate_qualified": 38,
      },
    },
    counts: { ...ZERO_COUNTS, raw_candidates: 4, yielded_candidates: 3, admitted_candidates: 3, qualified: 1, delivered: 1, new_for_user: 1, enrichment_attempts: 2 },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clock.now,
  });

  assert.equal(summary.street_key, "ny:main-st");
  assert.equal(summary.street_name, "Main St");
  assert.equal(summary.run_id, "run-1");
  assert.equal(summary.worker_id, "worker-1");
  assert.equal(summary.termination_reason, "SUCCESS_EXHAUSTED");

  // spawn_started was at +50ms from claim; every progressMarks/bridgeTimings
  // value is ms-since-spawn, so each derived field = 50 + that value.
  assert.equal(summary.spawn_ms, 50 + 12);
  assert.equal(summary.maps_start_ms, 50 + 15);
  assert.equal(summary.first_candidate_ms, 50 + 25);
  assert.equal(summary.first_python_yield_ms, 50 + 40);
  assert.equal(summary.first_admitted_ms, 50 + 28);
  assert.equal(summary.first_enrichment_ms, 50 + 33);
  assert.equal(summary.first_qualified_ms, 50 + 38);

  // Node-side live marks are relative to claim directly.
  assert.equal(summary.first_forwarded_ms, 60);
  assert.equal(summary.first_new_for_user_ms, 65);
  assert.equal(summary.engine_done_ms, 85);
  assert.equal(summary.total_ms, 90); // finalize() called 5ms after engine_done

  assert.equal(summary.raw_candidates, 4);
  assert.equal(summary.yielded_candidates, 3);
  assert.equal(summary.admitted_candidates, 3);
  assert.equal(summary.enrichment_attempts, 2);
  assert.equal(summary.qualified, 1);
  assert.equal(summary.new_for_user, 1);
  assert.equal(summary.delivered, 1);
});

test("2. missing optional timestamps do not crash — every derived field falls back to null", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock();
  const tracer = createStreetLifecycleTracer({
    streetKey: "ny:empty-st",
    streetName: "Empty St",
    runId: "run-2",
    workerId: "worker-1",
    now: clock.now,
  });

  // Only markClaimed() is called — spawn never started, no forward, no
  // new-for-user, no engine-done, and `info` is entirely absent (as if the
  // engine subprocess crashed before ever reporting anything).
  tracer.markClaimed();
  clock.advance(100);

  assert.doesNotThrow(() => {
    const summary = tracer.finalize({
      info: undefined,
      counts: ZERO_COUNTS,
      terminationReason: undefined,
      now: clock.now,
    });

    assert.equal(summary.spawn_ms, null);
    assert.equal(summary.maps_start_ms, null);
    assert.equal(summary.first_candidate_ms, null);
    assert.equal(summary.first_python_yield_ms, null);
    assert.equal(summary.first_forwarded_ms, null);
    assert.equal(summary.first_admitted_ms, null);
    assert.equal(summary.first_enrichment_ms, null);
    assert.equal(summary.first_qualified_ms, null);
    assert.equal(summary.first_new_for_user_ms, null);
    assert.equal(summary.engine_done_ms, null);
    assert.equal(summary.termination_reason, null);
    // total_ms IS derivable — markClaimed() was called, and finalize()
    // always has its own "now" — so this is the one field that stays a
    // real number even when nothing else ever happened.
    assert.equal(summary.total_ms, 100);
  });

  // A tracer that never even had markClaimed() called should also degrade
  // gracefully rather than throwing (e.g. a claim RPC that failed after
  // the tracer was constructed but before markClaimed() fired).
  const neverClaimed = createStreetLifecycleTracer({
    streetKey: "ny:never-claimed-st",
    streetName: "Never Claimed St",
    runId: "run-2",
    workerId: "worker-1",
    now: clock.now,
  });
  assert.doesNotThrow(() => {
    const summary = neverClaimed.finalize({ info: undefined, counts: ZERO_COUNTS, terminationReason: null, now: clock.now });
    assert.equal(summary.total_ms, null);
  });
});

test("3. one street cannot absorb another street's timings, even when interleaved", () => {
  __testing_streetLifecycleTrace.reset();
  const clockA = makeClock(1_000_000);
  const clockB = makeClock(5_000_000); // entirely different epoch

  const tracerA = createStreetLifecycleTracer({ streetKey: "ny:a-st", streetName: "A St", runId: "run-3", workerId: "worker-1", now: clockA.now });
  const tracerB = createStreetLifecycleTracer({ streetKey: "ny:b-st", streetName: "B St", runId: "run-3", workerId: "worker-2", now: clockB.now });

  // Interleave every call — A and B never share a clock or a mutable map.
  tracerA.markClaimed();
  tracerB.markClaimed();
  clockA.advance(10);
  clockB.advance(999); // wildly different pace — must not leak into A
  tracerB.markSpawnStarted();
  tracerA.markSpawnStarted();
  clockA.advance(5);
  clockB.advance(5);
  tracerA.markFirstForwarded();
  tracerB.markFirstForwarded();

  const summaryA = tracerA.finalize({
    info: { bridgeTimings: { spawnMs: 1, firstLineMs: 2, firstLeadMs: 3 } },
    counts: { ...ZERO_COUNTS, delivered: 1 },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clockA.now,
  });
  const summaryB = tracerB.finalize({
    info: { bridgeTimings: { spawnMs: 100, firstLineMs: 200, firstLeadMs: 300 } },
    counts: { ...ZERO_COUNTS, delivered: 2 },
    terminationReason: "WATCHDOG_TIMEOUT",
    now: clockB.now,
  });

  assert.equal(summaryA.street_key, "ny:a-st");
  assert.equal(summaryB.street_key, "ny:b-st");
  assert.equal(summaryA.first_forwarded_ms, 15); // A's own 10+5, unaffected by B's 999+5
  assert.equal(summaryB.first_forwarded_ms, 1004); // B's own 999+5
  assert.equal(summaryA.spawn_ms, 10 + 1);
  assert.equal(summaryB.spawn_ms, 999 + 100);
  assert.equal(summaryA.delivered, 1);
  assert.equal(summaryB.delivered, 2);
  assert.equal(summaryA.termination_reason, "SUCCESS_EXHAUSTED");
  assert.equal(summaryB.termination_reason, "WATCHDOG_TIMEOUT");

  // Both landed in the same run's rollup, as two DISTINCT rows.
  const rows = __testing_streetLifecycleTrace.peek("run-3");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.street_key).sort(), ["ny:a-st", "ny:b-st"]);
});

test("4. summary calculates each duration correctly relative to street_claimed", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock(0);
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:calc-st", streetName: "Calc St", runId: "run-4", workerId: "worker-1", now: clock.now });

  tracer.markClaimed(); // t=0
  clock.advance(1234);
  tracer.markSpawnStarted(); // spawn_started_ms (from claim) = 1234

  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 500, firstLineMs: 600, firstLeadMs: 700 },
      progressMarks: { "discovery:maps_navigation_start": 550 },
    },
    counts: ZERO_COUNTS,
    terminationReason: "SUCCESS_EXHAUSTED",
    now: () => 1234 + 800, // finalize() called 800ms after spawn_started
  });

  // Every *_ms field that's derived "since spawn" must equal
  // spawn_started_offset (1234) + the raw ms-since-spawn value.
  assert.equal(summary.spawn_ms, 1234 + 500);
  assert.equal(summary.maps_start_ms, 1234 + 550);
  assert.equal(summary.first_python_yield_ms, 1234 + 700);
  // total_ms is simply finalize()'s own "now" minus claimedAt (0).
  assert.equal(summary.total_ms, 1234 + 800);

  // Idempotency: calling markSpawnStarted() again after finalize() must
  // not retroactively change an already-emitted summary object.
  tracer.markSpawnStarted();
  assert.equal(summary.spawn_ms, 1234 + 500);
});

test("5. reconciliation still works when a street has zero leads", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock();
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:dead-st", streetName: "Dead St", runId: "run-5", workerId: "worker-1", now: clock.now });

  tracer.markClaimed();
  clock.advance(20);
  tracer.markSpawnStarted();
  // No candidates ever discovered, admitted, enriched, qualified, or
  // delivered — engine simply exhausted its scan budget with nothing to
  // show for it. first_forwarded_ms / first_new_for_user_ms are never
  // marked (no lead ever arrived).
  clock.advance(30_000);
  tracer.markEngineDone();

  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 15, firstLineMs: null, firstLeadMs: null },
      progressMarks: { "discovery:maps_navigation_start": 20 },
    },
    counts: { ...ZERO_COUNTS }, // everything zero
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clock.now,
  });

  assert.equal(summary.raw_candidates, 0);
  assert.equal(summary.yielded_candidates, 0);
  assert.equal(summary.admitted_candidates, 0);
  assert.equal(summary.qualified, 0);
  assert.equal(summary.new_for_user, 0);
  assert.equal(summary.delivered, 0);
  assert.equal(summary.first_forwarded_ms, null); // never marked — no crash
  assert.equal(summary.first_new_for_user_ms, null);
  assert.equal(summary.first_python_yield_ms, null); // firstLeadMs was null
  assert.equal(summary.engine_done_ms, 30_020);
  assert.equal(summary.termination_reason, "SUCCESS_EXHAUSTED");

  // The run-level rollup must still include this zero-lead street exactly
  // once — a street with nothing delivered is not "missing", it's a
  // legitimate, fully-reconciled zero-yield row.
  const rows = emitRunSummary("run-5");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.street_key, "ny:dead-st");
  assert.equal(rows[0]?.delivered, 0);

  // emitRunSummary() clears the run — calling it again returns nothing,
  // rather than re-emitting a stale row or throwing.
  const rowsAgain = emitRunSummary("run-5");
  assert.equal(rowsAgain.length, 0);
});

test("recordStreetSummary + emitRunSummary sort by TRUE claim order, not finalize/completion order", () => {
  __testing_streetLifecycleTrace.reset();

  // Manually construct two summaries and push them out of claim order —
  // exercising recordStreetSummary()/emitRunSummary() directly (as
  // finalize() itself does internally) to prove the sort key is claim
  // time, not push order.
  const early: StreetTimingSummary = {
    street_key: "ny:early-st", street_name: "Early St", run_id: "run-6", worker_id: "w1",
    total_ms: 100, spawn_ms: null, maps_start_ms: null, first_candidate_ms: null,
    first_python_yield_ms: null, first_forwarded_ms: null, first_admitted_ms: null,
    first_enrichment_ms: null, first_qualified_ms: null, first_new_for_user_ms: null,
    engine_done_ms: null, raw_candidates: 0, yielded_candidates: 0, admitted_candidates: 0,
    enrichment_attempts: 0, qualified: 0, new_for_user: 0, delivered: 0, termination_reason: null,
  };
  const late: StreetTimingSummary = { ...early, street_key: "ny:late-st", street_name: "Late St" };

  // Pushed "late" (higher claimedAt) FIRST, "early" (lower claimedAt) SECOND
  // — i.e. completion order is the reverse of claim order.
  recordStreetSummary("run-6", late, /* claimedAt */ 2_000);
  recordStreetSummary("run-6", early, /* claimedAt */ 1_000);

  const rows = emitRunSummary("run-6");
  assert.deepEqual(rows.map((r) => r.street_key), ["ny:early-st", "ny:late-st"]);
});
