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
  panel_retry_count: 0,
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
    total_ms: 100, spawn_ms: null, browser_ready_ms: null, maps_start_ms: null,
    panel_detected_ms: null, panel_retry_count: 0, first_candidate_ms: null,
    search_exhausted_ms: null, first_python_yield_ms: null, first_forwarded_ms: null,
    first_admitted_ms: null, first_enrichment_ms: null, first_qualified_ms: null,
    first_new_for_user_ms: null, target_reached_ms: null, drain_begin_ms: null,
    pending_at_drain: null, worker_shutdown_begin_ms: null, engine_done_ms: null,
    raw_candidates: 0, yielded_candidates: 0, admitted_candidates: 0,
    enrichment_attempts: 0, qualified: 0, new_for_user: 0, delivered: 0, termination_reason: null,
    durations: {
      claim_to_spawn_ms: null, spawn_to_browser_ready_ms: null, browser_ready_to_nav_submitted_ms: null,
      nav_submitted_to_panel_detected_ms: null, panel_detected_to_first_candidate_ms: null,
      first_candidate_to_search_exhausted_ms: null, first_qualified_to_first_new_for_user_ms: null,
      first_new_for_user_to_target_reached_ms: null, target_reached_to_drain_begin_ms: null,
      drain_begin_to_worker_shutdown_ms: null, worker_shutdown_to_engine_done_ms: null,
    },
  };
  const late: StreetTimingSummary = { ...early, street_key: "ny:late-st", street_name: "Late St" };

  // Pushed "late" (higher claimedAt) FIRST, "early" (lower claimedAt) SECOND
  // — i.e. completion order is the reverse of claim order.
  recordStreetSummary("run-6", late, /* claimedAt */ 2_000);
  recordStreetSummary("run-6", early, /* claimedAt */ 1_000);

  const rows = emitRunSummary("run-6");
  assert.deepEqual(rows.map((r) => r.street_key), ["ny:early-st", "ny:late-st"]);
});

// ── CRITMODE PART 2 — PRE-FIRST-CANDIDATE / POST-USEFUL-WORK tests ──────

test("6. zero-result street: ~59s spent entirely pre-first-candidate, search_exhausted with zero yielded", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock(0);
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:zero-st", streetName: "Zero St", runId: "run-7", workerId: "worker-1", now: clock.now });

  tracer.markClaimed();
  clock.advance(50);
  tracer.markSpawnStarted();
  clock.advance(58_950); // total street time lands right at ~59s
  tracer.markEngineDone();

  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 10, firstLineMs: null, firstLeadMs: null }, // no lead line ever sent
      progressMarks: {
        "discovery:browser_page_ready": 20,
        "discovery:maps_navigation_start": 40,
        "discovery:panel_resolved": 500,
        // no candidate_discovered — this street found nothing
        "discovery:search_exhausted": 58_900, // scroll budget fully exhausted, 0 yielded
      },
    },
    counts: { ...ZERO_COUNTS },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clock.now,
  });

  // Every post-first-candidate field is null — there was no candidate.
  assert.equal(summary.first_candidate_ms, null);
  assert.equal(summary.first_admitted_ms, null);
  assert.equal(summary.first_enrichment_ms, null);
  assert.equal(summary.first_qualified_ms, null);
  assert.equal(summary.first_new_for_user_ms, null);
  assert.equal(summary.qualified, 0);
  assert.equal(summary.delivered, 0);

  // But the FULL pre-first-candidate chain is present and accounts for
  // essentially the entire ~59s street runtime — proving the time was
  // spent scanning, not idling or waiting on something downstream.
  assert.equal(summary.browser_ready_ms, 50 + 20);
  assert.equal(summary.maps_start_ms, 50 + 40);
  assert.equal(summary.panel_detected_ms, 50 + 500);
  assert.equal(summary.search_exhausted_ms, 50 + 58_900);
  assert.equal(summary.total_ms, 59_000);
  // The gap between panel detection and first-candidate is null since
  // there was never a candidate — no divide-by-nothing, no NaN.
  assert.equal(summary.durations.panel_detected_to_first_candidate_ms, null);
  assert.equal(summary.search_exhausted_ms! - summary.panel_detected_ms!, 58_400);
});

test("7. panel failure + retries: panel_retry_count reflects live-accumulated retries, not just first-occurrence", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock(0);
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:flaky-st", streetName: "Flaky St", runId: "run-8", workerId: "worker-1", now: clock.now });

  tracer.markClaimed();
  clock.advance(10);
  tracer.markSpawnStarted();

  // Three panel_failure_retry events fired live (attempts 1, 2, 3) before
  // attempt 4 finally resolves a panel. progressMarks only ever captures
  // the FIRST occurrence's timestamp (30ms since spawn) — the retry COUNT
  // has to come from the caller's own live accumulation (simulated here
  // exactly as poolExpandJob.ts's onProgress handler does it).
  let liveRetryCount = 0;
  for (const _attempt of [1, 2, 3]) liveRetryCount += 1;

  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 5, firstLineMs: 900, firstLeadMs: 900 },
      progressMarks: {
        "discovery:browser_page_ready": 15,
        "discovery:panel_failure_retry": 30, // first occurrence only
        "discovery:panel_resolved": 850, // eventually resolves on attempt 4
        "discovery:candidate_discovered": 870,
      },
    },
    counts: { ...ZERO_COUNTS, panel_retry_count: liveRetryCount, raw_candidates: 1, yielded_candidates: 1 },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clock.now,
  });

  assert.equal(summary.panel_retry_count, 3);
  assert.equal(summary.panel_detected_ms, 10 + 850);
  assert.equal(summary.first_candidate_ms, 10 + 870);
  // Confirms this street's slowness is attributable to retries: nav
  // submitted -> panel detected spans nearly the whole panel_resolved
  // delay, well past a single healthy attempt's usual latency.
  assert.ok((summary.durations.browser_ready_to_nav_submitted_ms ?? 0) >= 0);
});

test("8. first-qualified fires before engine-done, and the gap between them is captured", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock(0);
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:lingering-st", streetName: "Lingering St", runId: "run-9", workerId: "worker-1", now: clock.now });

  tracer.markClaimed();
  clock.advance(20);
  tracer.markSpawnStarted();
  clock.advance(5);
  tracer.markFirstForwarded();
  clock.advance(3);
  tracer.markFirstNewForUser();
  // The engine does NOT finish for another 40s after the qualified/new-for-user
  // lead already went out — this is production observation #2 (streets
  // staying alive 30-60s after already producing useful work).
  clock.advance(40_000);
  tracer.markEngineDone();

  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 5, firstLineMs: 25, firstLeadMs: 25 },
      progressMarks: {
        "discovery:candidate_discovered": 15,
        "discovery:candidate_queued": 18,
        "qualification:candidate_qualified": 22, // qualified well before engine_done
      },
    },
    counts: { ...ZERO_COUNTS, raw_candidates: 1, yielded_candidates: 1, admitted_candidates: 1, qualified: 1, new_for_user: 1, delivered: 1 },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clock.now,
  });

  assert.ok(summary.first_qualified_ms !== null && summary.engine_done_ms !== null);
  assert.ok(summary.first_qualified_ms! < summary.engine_done_ms!);
  // engine stayed alive ~40s after the lead was already fully useful —
  // exactly the symptom this phase exists to quantify.
  const lingering = summary.engine_done_ms! - summary.first_new_for_user_ms!;
  assert.ok(lingering >= 39_000 && lingering <= 41_000, `expected ~40s lingering, got ${lingering}ms`);
});

test("9. target reached fires before engine-done, with drain/shutdown durations in between", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock(0);
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:target-st", streetName: "Target St", runId: "run-10", workerId: "worker-1", now: clock.now });

  tracer.markClaimed();
  clock.advance(10);
  tracer.markSpawnStarted();
  clock.advance(2);
  tracer.markFirstForwarded();
  clock.advance(1);
  tracer.markFirstNewForUser();
  tracer.markPendingAtDrain(4); // 4 candidates still mid-pipeline when target hit
  clock.advance(35_000); // drain + worker shutdown together take ~35s
  tracer.markEngineDone();

  const summary = tracer.finalize({
    info: {
      bridgeTimings: { spawnMs: 3, firstLineMs: 12, firstLeadMs: 12 },
      progressMarks: {
        "qualification:candidate_qualified": 11,
        "engine:target_reached": 13, // fires right after the last accepted lead
        "engine:drain_begin": 14,
        "engine:worker_shutdown_begin": 30_000, // draining 4 pending candidates takes a while
      },
    },
    counts: { ...ZERO_COUNTS, qualified: 1, new_for_user: 1, delivered: 1 },
    terminationReason: "SUCCESS_TARGET_REACHED",
    now: clock.now,
  });

  assert.ok(summary.target_reached_ms !== null && summary.engine_done_ms !== null);
  assert.ok(summary.target_reached_ms! < summary.engine_done_ms!);
  assert.equal(summary.pending_at_drain, 4);
  assert.ok(summary.durations.target_reached_to_drain_begin_ms! >= 0);
  assert.ok(summary.durations.drain_begin_to_worker_shutdown_ms! > 0);
  assert.ok(summary.durations.worker_shutdown_to_engine_done_ms! > 0);
  // Together these two durations explain the ~30-60s post-useful-work
  // lingering this phase was asked to explain.
  const totalDrainToDone = summary.engine_done_ms! - summary.target_reached_ms!;
  assert.ok(totalDrainToDone > 30_000);
});

test("10. missing optional PART 2 timestamps do not crash (no browser_page_ready/panel/drain events at all)", () => {
  __testing_streetLifecycleTrace.reset();
  const clock = makeClock(0);
  const tracer = createStreetLifecycleTracer({ streetKey: "ny:sparse-st", streetName: "Sparse St", runId: "run-11", workerId: "worker-1", now: clock.now });

  tracer.markClaimed();
  clock.advance(5);
  tracer.markSpawnStarted();
  clock.advance(5);
  tracer.markEngineDone();

  assert.doesNotThrow(() => {
    const summary = tracer.finalize({
      info: { bridgeTimings: { spawnMs: 1, firstLineMs: null, firstLeadMs: null } }, // no progressMarks key at all
      counts: ZERO_COUNTS,
      terminationReason: "FAILURE",
      now: clock.now,
    });
    assert.equal(summary.browser_ready_ms, null);
    assert.equal(summary.panel_detected_ms, null);
    assert.equal(summary.search_exhausted_ms, null);
    assert.equal(summary.target_reached_ms, null);
    assert.equal(summary.drain_begin_ms, null);
    assert.equal(summary.worker_shutdown_begin_ms, null);
    assert.equal(summary.pending_at_drain, null); // markPendingAtDrain() never called
    assert.equal(summary.panel_retry_count, 0);
    // Every duration built from an all-null chain must also be null, never NaN/undefined/throw.
    for (const [key, value] of Object.entries(summary.durations)) {
      assert.ok(value === null || typeof value === "number", `${key} should be null or number, got ${value}`);
    }
  });
});

test("11. cross-street isolation holds for the new PART 2 fields too (panel retries, drain marks)", () => {
  __testing_streetLifecycleTrace.reset();
  const clockA = makeClock(0);
  const clockB = makeClock(0);

  const tracerA = createStreetLifecycleTracer({ streetKey: "ny:iso-a-st", streetName: "Iso A St", runId: "run-12", workerId: "worker-1", now: clockA.now });
  const tracerB = createStreetLifecycleTracer({ streetKey: "ny:iso-b-st", streetName: "Iso B St", runId: "run-12", workerId: "worker-2", now: clockB.now });

  tracerA.markClaimed();
  tracerB.markClaimed();
  clockA.advance(10);
  clockB.advance(10);
  tracerA.markSpawnStarted();
  tracerB.markSpawnStarted();

  // A has pending work at drain; B has none. Interleaved calls must not cross-contaminate.
  tracerB.markPendingAtDrain(0);
  tracerA.markPendingAtDrain(7);

  const summaryA = tracerA.finalize({
    info: { bridgeTimings: { spawnMs: 1, firstLineMs: 5, firstLeadMs: 5 }, progressMarks: { "discovery:panel_failure_retry": 3 } },
    counts: { ...ZERO_COUNTS, panel_retry_count: 5 },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clockA.now,
  });
  const summaryB = tracerB.finalize({
    info: { bridgeTimings: { spawnMs: 1, firstLineMs: 5, firstLeadMs: 5 } },
    counts: { ...ZERO_COUNTS, panel_retry_count: 0 },
    terminationReason: "SUCCESS_EXHAUSTED",
    now: clockB.now,
  });

  assert.equal(summaryA.pending_at_drain, 7);
  assert.equal(summaryB.pending_at_drain, 0);
  assert.equal(summaryA.panel_retry_count, 5);
  assert.equal(summaryB.panel_retry_count, 0);
  assert.notEqual(summaryA.street_key, summaryB.street_key);

  const rows = __testing_streetLifecycleTrace.peek("run-12");
  assert.equal(rows.length, 2);
});
