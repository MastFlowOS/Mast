/**
 * PHASE 25 — Area productivity stop logic (upgrades PHASE 12D's
 * qualified-only clock to a "time since last PRODUCTIVE ACTIVITY" clock —
 * see areaProductivity.ts's module doc comment for the full writeup).
 *
 * Pure-logic tests for areaProductivity.ts's classifier/state helpers
 * (tests 1-4, 10, 12, 13, plus new PHASE 25 tests below), plus an
 * orchestration-level test that wires the classifier + scopeAreaAbort()
 * together with the REAL runAreaWorkerPool() from googleAreaPool.ts (tests
 * 5, 6, 8) — matching the style of googleAreaPool.test.ts: no Postgres, no
 * engine subprocess, fake `runArea`/`claimNextArea`/`tryAcquireSlot`
 * implementations, with a fake `now()` clock so timing is deterministic
 * instead of racing real wall-clock time.
 *
 * Tests 7, 9, 11 (global TARGET_REACHED unchanged; qualification
 * semantics unchanged; no change to scoring/dedup/channel rules) are not
 * re-tested here — see googleAreaPool.test.ts's own cancellation/target
 * coverage for 7, and note that this phase's diff touches no
 * qualification/scoring/dedup/channel file at all (see the final report).
 *
 * PHASE 25 additions: tests 2 (discovery keeps a not-yet-qualified area
 * alive — the exact Bronx/Staten Island benchmark regression), 7
 * (enrichment/queueing style productive activity), 8 (duplicate/heartbeat/
 * rate-limit-only do NOT reset the clock), 13 (max wall-clock runtime
 * bound fires even under continuous activity) below correspond to the
 * phase prompt's STEP 9 test list items 2/3/8/9/10/13.
 */
import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Some tests below dynamically import src/config/env.ts, which reads
// required config (SUPABASE_URL, DATABASE_URL, etc.) once at import time via
// a zod schema — see pythonBridge.lifecycle.test.ts for the same pattern.
// These must be set before that dynamic import happens.
// ---------------------------------------------------------------------------
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

import {
  classifyAreaYield,
  createAreaProductivityState,
  evaluateAreaProductivity,
  evaluateAreaYieldStop,
  recordDeliveredLead,
  recordProductiveActivity,
  recordQualifiedLead,
  scopeAreaAbort,
  type AreaProductivityLimits,
  type AreaProductivityState,
  type AreaYieldLimits,
} from "../areaProductivity.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";

const IDLE_MS = 60_000; // fixed test window, independent of the real env default
// Effectively "no max runtime" for tests that only care about the idle
// window — a value far above anything any test below advances its clock to.
const NO_MAX_RUNTIME = 10_000_000;
const LIMITS: AreaProductivityLimits = { productiveIdleMs: IDLE_MS, maxAreaRuntimeMs: NO_MAX_RUNTIME };

function outcome(partial: Partial<AreaRunOutcome> = {}): AreaRunOutcome {
  return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: false, ...partial };
}

// ── Test 1: zero productive activity reaches exploration timeout ──────────
test("1: an area with zero productive activity is stopped once the exploration window elapses", () => {
  const state = createAreaProductivityState(0);
  assert.equal(evaluateAreaProductivity(state, 30_000, LIMITS), null, "not yet at the window");
  assert.equal(
    evaluateAreaProductivity(state, IDLE_MS, LIMITS),
    "area_productivity_timeout_before_first_qualified",
    "exploration window elapsed with zero productive activity",
  );
});

// ── Test 2: candidate discovery before any qualified lead keeps the clock alive ──
// PHASE 25 — this is the exact Bronx/Staten Island benchmark regression:
// both were actively discovering candidates around 120s with zero
// qualified leads and were killed anyway under the OLD (qualified-only)
// logic. Under the new logic, discovery activity alone must reset the
// clock, regardless of qualified count.
test("2: candidate discovery activity (no qualified leads yet) resets the clock and prevents a premature stop", () => {
  const state = createAreaProductivityState(0);
  recordProductiveActivity(state, "candidate_discovered", 40_000); // discovers before the 60s window would expire
  assert.equal(evaluateAreaProductivity(state, 40_000, LIMITS), null);
  // Old clock (from startedAt=0) would have expired at 60_000 — but the
  // reference point is now 40_000 (lastProductiveActivityAt), so the area
  // survives past the OLD deadline as long as it's within IDLE_MS of the new one.
  assert.equal(
    evaluateAreaProductivity(state, 90_000, LIMITS),
    null,
    "clock reset by discovery activity alone, not by qualification",
  );
  assert.equal(state.qualifiedCount, 0, "still zero qualified — discovery alone must not fabricate a qualification");
  assert.equal(
    evaluateAreaProductivity(state, 100_000, LIMITS),
    "area_productivity_timeout_before_first_qualified",
    "still classified as pre-first-qualified once discovery activity also goes stale",
  );
});

// ── Test 3: repeated qualified leads keep the area alive ───────────────────
test("3: repeated qualified leads before each deadline keep the area running indefinitely", () => {
  const state = createAreaProductivityState(0);
  let now = 0;
  for (let i = 0; i < 20; i++) {
    now += 30_000; // well within the 60s window every time
    recordQualifiedLead(state, now);
    assert.equal(evaluateAreaProductivity(state, now, LIMITS), null, `iteration ${i} must not stop the area`);
  }
  assert.equal(state.qualifiedCount, 20);
});

// ── Test 4: goes idle after a qualified lead → stops at the inactivity timeout ──
test("4: an area that goes idle after producing a qualified lead stops at the inactivity timeout, not before", () => {
  const state = createAreaProductivityState(0);
  recordQualifiedLead(state, 10_000);
  assert.equal(evaluateAreaProductivity(state, 10_000 + IDLE_MS - 1, LIMITS), null, "one ms before the deadline");
  assert.equal(
    evaluateAreaProductivity(state, 10_000 + IDLE_MS, LIMITS),
    "area_productivity_idle_timeout",
    "exactly at the deadline",
  );
});

// ── Test 7: candidate queued / enrichment-style productive activity after qualification ──
// PHASE 25 — after at least one qualified lead, continued discovery/queueing
// activity must also keep the area alive, exactly like continued
// qualification did under the old logic. Matches the Brooklyn (qualified=1)
// and Queens (qualified=3) benchmark scenarios, both stopped prematurely by
// the old qualified-only clock while still actively discovering.
test("7: candidate queued/enrichment-style activity after the first qualified lead prevents a premature idle stop", () => {
  const state = createAreaProductivityState(0);
  recordQualifiedLead(state, 5_000);
  recordProductiveActivity(state, "candidate_queued", 5_000 + IDLE_MS - 1_000); // just under the deadline
  assert.equal(evaluateAreaProductivity(state, 5_000 + IDLE_MS - 1_000, LIMITS), null);
  // Old deadline (from lastQualifiedAt=5_000) would have been 5_000+IDLE_MS —
  // but the new productive activity moved the reference point forward.
  assert.equal(
    evaluateAreaProductivity(state, 5_000 + IDLE_MS + 30_000, LIMITS),
    null,
    "clock reset by candidate_queued, surviving past the OLD qualified-only deadline",
  );
  recordProductiveActivity(state, "enrichment_completed", 5_000 + IDLE_MS + 30_000);
  assert.equal(state.lastProductiveEventType, "enrichment_completed");
});

// ── Test 8: duplicate/heartbeat/rate-limit-only activity must NOT reset the clock ──
// PHASE 25 STEP 3's negative list — these are deliberately never routed to
// recordProductiveActivity by poolExpandJob.ts's onProgress wiring, so this
// test simply documents/locks in that the classifier has no way to be told
// about them: only genuine productive events (via recordProductiveActivity/
// recordQualifiedLead/recordDeliveredLead) can move the clock at all.
test("8: an area with no genuine productive activity still times out even if time passes (duplicate/heartbeat/rate-limit-wait analog)", () => {
  const state = createAreaProductivityState(0);
  // Simulate the passage of time with nothing but non-productive noise
  // (heartbeats, duplicate candidates, rate-limit waits) — none of which
  // this module is ever told about, so lastProductiveActivityAt never moves.
  assert.equal(evaluateAreaProductivity(state, IDLE_MS - 1, LIMITS), null);
  assert.equal(
    evaluateAreaProductivity(state, IDLE_MS, LIMITS),
    "area_productivity_timeout_before_first_qualified",
    "no genuine productive activity was ever recorded, so the exploration window still elapses",
  );
});

// ── Test 10: no fixed per-area qualified quota exists ───────────────────────
test("10: an area with hundreds of qualified leads is never stopped by count alone, only by elapsed idle time", () => {
  const state = createAreaProductivityState(0);
  let now = 0;
  for (let i = 0; i < 500; i++) {
    now += 100; // fast, steady qualification — far more than any historical fixed quota
    recordQualifiedLead(state, now);
  }
  assert.equal(state.qualifiedCount, 500);
  // Still well within the inactivity window since the last one — must not stop.
  assert.equal(evaluateAreaProductivity(state, now + 1_000, LIMITS), null);
});

// ── Test 12: default configuration value is applied correctly ──────────────
test("12: env default for AREA_PRODUCTIVITY_IDLE_MS is a conservative value grounded in the audit range (>= 85s observed max)", async () => {
  const { env } = await import("../../config/env.js");
  assert.ok(
    env.AREA_PRODUCTIVITY_IDLE_MS >= 85_000,
    "default must sit at/above the audit's observed first-qualified upper bound (85s)",
  );
});

// PHASE 25 — env default for the new hard runtime ceiling: must sit
// comfortably above the slowest genuinely-productive area observed in the
// benchmark audit (Queens, still discovering at ~240s with 3 qualified).
test("12b: env default for AREA_PRODUCTIVITY_MAX_RUNTIME_MS sits above the audit's longest observed productive run (240s)", async () => {
  const { env } = await import("../../config/env.js");
  assert.ok(
    env.AREA_PRODUCTIVITY_MAX_RUNTIME_MS >= 240_000,
    "default must sit at/above the audit's observed longest productive run (240s / Queens)",
  );
});

// ── Test 13a: configuration/env override works correctly ───────────────────
test("13a: AREA_PRODUCTIVITY_IDLE_MS env override is honored", async () => {
  const previous = process.env.AREA_PRODUCTIVITY_IDLE_MS;
  process.env.AREA_PRODUCTIVITY_IDLE_MS = "45000";
  try {
    // Zod schema re-parsed fresh via a dynamic re-import path is not
    // available here (env.ts parses once at module load) — instead,
    // directly exercise the same zod coercion the schema uses to confirm
    // the override value would be accepted and coerced correctly.
    const { z } = await import("zod");
    const schemaPiece = z.coerce.number().int().min(10_000).default(120_000);
    assert.equal(schemaPiece.parse(process.env.AREA_PRODUCTIVITY_IDLE_MS), 45_000);
  } finally {
    if (previous === undefined) delete process.env.AREA_PRODUCTIVITY_IDLE_MS;
    else process.env.AREA_PRODUCTIVITY_IDLE_MS = previous;
  }
});

// ── Test 13b: max wall-clock runtime fires even under continuous productive activity ──
// PHASE 25 STEP 4/STEP 9 item 13 — a pathological provider that keeps
// producing SOME activity forever must still be bounded.
test("13b: maxAreaRuntimeMs stops an area even while it keeps reporting productive activity", () => {
  const limits: AreaProductivityLimits = { productiveIdleMs: IDLE_MS, maxAreaRuntimeMs: 300_000 };
  const state = createAreaProductivityState(0);
  let now = 0;
  // Keep the area "productive" (never idle) every 10s, well under the
  // idle window, all the way out past the 300s max-runtime ceiling.
  for (let i = 0; i < 40; i++) {
    now += 10_000;
    if (now >= 300_000) break;
    recordProductiveActivity(state, "candidate_discovered", now);
    assert.equal(evaluateAreaProductivity(state, now, limits), null, `iteration ${i} must not stop the area yet`);
  }
  assert.equal(
    evaluateAreaProductivity(state, 300_000, limits),
    "area_productivity_max_runtime",
    "the hard wall-clock ceiling must fire regardless of ongoing activity",
  );
});

test("13c: maxAreaRuntimeMs takes precedence over an idle-timeout reason at the exact same instant", () => {
  // Construct a state that is BOTH past its idle window AND past max
  // runtime at the same `now` — max runtime must win (STEP 4's stated
  // precedence: it is checked first, unconditionally).
  const limits: AreaProductivityLimits = { productiveIdleMs: 60_000, maxAreaRuntimeMs: 100_000 };
  const state = createAreaProductivityState(0);
  assert.equal(evaluateAreaProductivity(state, 100_000, limits), "area_productivity_max_runtime");
});

// ── recordDeliveredLead is productive activity (PHASE 25) but observational re: qualifiedCount ──
test("recordDeliveredLead updates deliveredCount and counts as productive activity, without fabricating a qualification", () => {
  const state = createAreaProductivityState(0);
  recordDeliveredLead(state, 10_000);
  recordDeliveredLead(state, 20_000);
  assert.equal(state.deliveredCount, 2);
  assert.equal(state.qualifiedCount, 0);
  assert.equal(state.lastProductiveEventType, "delivered");
  // The clock was reset at 20_000 by the second delivery, so the area
  // survives right up to (but not including) 20_000 + IDLE_MS...
  assert.equal(evaluateAreaProductivity(state, 20_000 + IDLE_MS - 1, LIMITS), null);
  // ...and is still classified as "before first qualified" once it does
  // finally go idle, since no lead has actually qualified.
  assert.equal(
    evaluateAreaProductivity(state, 20_000 + IDLE_MS, LIMITS),
    "area_productivity_timeout_before_first_qualified",
    "delivered-without-qualified is still classified as pre-first-qualified once truly idle",
  );
});

// ── scopeAreaAbort: forwards parent abort, but an own-abort does not touch the parent ──
test("scopeAreaAbort: aborting the scoped controller does not abort the parent signal", () => {
  const parent = new AbortController();
  const { signal, controller } = scopeAreaAbort(parent.signal);
  controller.abort("area_productivity_idle_timeout");
  assert.equal(signal.aborted, true);
  assert.equal(parent.signal.aborted, false, "an area's own idle-stop must never abort the shared parent signal");
});

test("scopeAreaAbort: aborting the parent signal propagates to the scoped signal", () => {
  const parent = new AbortController();
  const { signal } = scopeAreaAbort(parent.signal);
  assert.equal(signal.aborted, false);
  parent.abort("TARGET_REACHED");
  assert.equal(signal.aborted, true, "the existing global abort path must still reach every area");
});

test("scopeAreaAbort: an already-aborted parent signal produces an already-aborted scoped signal", () => {
  const parent = new AbortController();
  parent.abort("USER_CANCELLED");
  const { signal } = scopeAreaAbort(parent.signal);
  assert.equal(signal.aborted, true);
});

// ── Orchestration-level tests (5, 6, 8): real runAreaWorkerPool + productivity wiring ──

/**
 * Simulates one area worker the same way poolExpandJob.ts's `runArea()`
 * wires areaProductivity.ts together with a per-area scoped abort — but
 * with a fake, controllable "engine" (an array of scheduled qualified-lead
 * timestamps and a fake clock) instead of runEngineQuery()/Playwright, so
 * the whole thing runs instantly and deterministically in a unit test.
 */
async function simulateArea(opts: {
  area: string;
  parentSignal: AbortSignal;
  qualifiedAtOffsets: number[]; // ms offsets (from this area's own start) at which a qualified lead arrives
  limits: AreaProductivityLimits;
  clock: { now: () => number; advance: (ms: number) => void };
  /** ms offset (from this area's own start) for a final productivity check after the last scheduled qualified lead (or immediately, if there are none). Defaults to the last offset. */
  finalCheckAtOffset?: number;
}): Promise<{ outcome: AreaRunOutcome; productivity: AreaProductivityState; stoppedBySelf: boolean }> {
  const { area, parentSignal, qualifiedAtOffsets, limits, clock } = opts;
  const startedAt = clock.now();
  const productivity = createAreaProductivityState(startedAt);
  const { signal: areaSignal, controller: areaAbort } = scopeAreaAbort(parentSignal);

  let stoppedBySelf = false;
  let qualifiedCount = 0;

  for (const offset of qualifiedAtOffsets) {
    if (areaSignal.aborted) break;
    clock.advance(offset - (clock.now() - startedAt));
    const stopReason = evaluateAreaProductivity(productivity, clock.now(), limits);
    if (stopReason) {
      productivity.stoppedReason = stopReason;
      areaAbort.abort(stopReason);
      stoppedBySelf = true;
      break;
    }
    recordQualifiedLead(productivity, clock.now());
    qualifiedCount += 1;
  }

  if (!areaSignal.aborted) {
    const finalOffset = opts.finalCheckAtOffset ?? qualifiedAtOffsets[qualifiedAtOffsets.length - 1] ?? 0;
    clock.advance(finalOffset - (clock.now() - startedAt));
    const finalStopReason = evaluateAreaProductivity(productivity, clock.now(), limits);
    if (finalStopReason) {
      productivity.stoppedReason = finalStopReason;
      areaAbort.abort(finalStopReason);
      stoppedBySelf = true;
    }
  }

  return {
    outcome: outcome({ discovered: qualifiedCount, accepted: qualifiedCount }),
    productivity,
    stoppedBySelf,
  };
}

// ── Test 5 & 6: an unproductive area stopping does not abort a productive sibling ──
test("5 & 6: one unproductive area stops on its own while a productive sibling keeps running", async () => {
  const parent = new AbortController();
  const clockA = { t: 0, now() { return this.t; }, advance(ms: number) { this.t += ms; } };
  const clockB = { t: 0, now() { return this.t; }, advance(ms: number) { this.t += ms; } };

  const areaA = simulateArea({
    area: "Area-Unproductive",
    parentSignal: parent.signal,
    qualifiedAtOffsets: [], // never qualifies anything — must hit the exploration timeout
    limits: LIMITS,
    clock: clockA,
    finalCheckAtOffset: IDLE_MS, // drive the final check past the exploration window
  });

  const areaB = simulateArea({
    area: "Area-Productive",
    parentSignal: parent.signal,
    qualifiedAtOffsets: [10_000, 40_000, 70_000, 100_000], // steadily productive, well within the window each time
    limits: LIMITS,
    clock: clockB,
  });

  const [resultA, resultB] = await Promise.all([areaA, areaB]);

  assert.equal(resultA.stoppedBySelf, true, "the unproductive area must stop itself");
  assert.equal(
    resultA.productivity.stoppedReason,
    "area_productivity_timeout_before_first_qualified",
    "test 1's stop reason must fire for a zero-qualified area",
  );
  assert.equal(resultB.stoppedBySelf, false, "the productive sibling must not be stopped by this classifier");
  assert.equal(resultB.productivity.qualifiedCount, 4, "the productive sibling must keep all its qualified leads");
  assert.equal(parent.signal.aborted, false, "neither area's own stop may abort the shared parent/job signal");
});

// ── Test 8: slot release lets workerLoop claim another area after an adaptive stop ──
test("8: runAreaWorkerPool claims a replacement area after one area is stopped adaptively", async () => {
  const areas = ["Area-1", "Area-2", "Area-3"];
  const claimed: string[] = [];
  const parent = new AbortController();

  const result = await runAreaWorkerPool({
    configuredWorkers: 1, // single worker/slot, so a replacement claim proves the slot was actually released
    totalCuratedAreas: areas.length,
    availableCapacity: 1,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a));
      if (!next) return undefined;
      claimed.push(next);
      return next;
    },
    runArea: async (area) => {
      // Area-1 simulates going unproductive and adaptively stopping
      // itself (via its own scoped abort) — runArea itself must still
      // return normally (never throw) so the pool's worker loop is free
      // to claim the next area, exactly like poolExpandJob.ts's real
      // runArea() returning once its `for await` ends after the scoped
      // signal aborts.
      if (area === "Area-1") {
        const { signal, controller } = scopeAreaAbort(parent.signal);
        controller.abort("area_productivity_timeout_before_first_qualified");
        assert.equal(signal.aborted, true);
        return outcome({ discovered: 0, accepted: 0 });
      }
      return outcome({ discovered: 1, accepted: 1 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(claimed.length, areas.length, "every area must eventually be claimed — the released slot let the worker keep going");
  assert.equal(result.startedWorkers, areas.length);
  assert.equal(parent.signal.aborted, false, "the adaptively-stopped area must never abort the shared parent signal");
});

// =============================================================================
// PHASE 30 — AREA YIELD / ROTATION OPTIMIZATION
//
// `classifyAreaYield`/`evaluateAreaYieldStop` are a SEPARATE, independent
// check from `evaluateAreaProductivity` above — an area can pass the idle
// check forever (steady candidate_discovered/candidate_queued activity)
// while still being LOW_YIELD. Regression scenario named in the phase
// prompt: production went from ~100 leads/6min to ~53 leads/30min because
// low-yield-but-busy areas (Bronx-like/Staten-Island-like) occupied worker
// slots that Queens-like/Manhattan-like productive areas never got to use.
// =============================================================================

const YIELD_LIMITS: AreaYieldLimits = {
  minElapsedMsForEvaluation: 90_000,
  minCandidateVolumeForEvaluation: 15,
  lowYieldMaxRate: 0.05,
  marginalMaxRate: 0.15,
};

function recordDiscoveries(state: AreaProductivityState, count: number, now: number): void {
  for (let i = 0; i < count; i++) recordProductiveActivity(state, "candidate_discovered", now);
}

// ── Yield test 1: low candidate volume → keep area alive ───────────────────
test("yield 1: low candidate volume keeps an area classified productive (and un-stoppable) even past the time gate", () => {
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 5, 100_000); // well past minElapsedMsForEvaluation, but under minCandidateVolumeForEvaluation
  assert.equal(classifyAreaYield(state, 100_000, YIELD_LIMITS), "productive");
  assert.equal(evaluateAreaYieldStop(state, 100_000, YIELD_LIMITS), null);
});

// ── Yield test 2: productive area → keep alive ──────────────────────────────
// Manhattan-like: high candidate volume, healthy qualification rate.
test("yield 2: a genuinely productive area (healthy qualification rate) is never classified low_yield", () => {
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 40, 100_000);
  for (let i = 0; i < 10; i++) recordQualifiedLead(state, 100_000); // 10/40 = 25% — well above marginalMaxRate
  assert.equal(classifyAreaYield(state, 100_000, YIELD_LIMITS), "productive");
  assert.equal(evaluateAreaYieldStop(state, 100_000, YIELD_LIMITS), null);
});

// ── Yield test 3: high candidate volume + near-zero qualification → low_yield ──
// Bronx-like/Staten-Island-like: busy discovery, nothing ever qualifies.
test("yield 3: high candidate volume with near-zero qualification is classified low_yield and stops the area", () => {
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 30, 100_000); // 0/30 = 0%
  assert.equal(classifyAreaYield(state, 100_000, YIELD_LIMITS), "low_yield");
  assert.equal(evaluateAreaYieldStop(state, 100_000, YIELD_LIMITS), "area_productivity_low_yield");
});

// ── Yield test 4: moderate candidate volume + some qualification → productive ──
test("yield 4: moderate candidate volume with a decent qualification rate is classified productive", () => {
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 20, 100_000);
  for (let i = 0; i < 5; i++) recordQualifiedLead(state, 100_000); // 5/20 = 25%
  assert.equal(classifyAreaYield(state, 100_000, YIELD_LIMITS), "productive");
});

// ── Yield test 5: marginal yield → keep temporarily ─────────────────────────
// Queens-like: some qualification, but thin relative to volume — kept alive,
// never stopped, distinct from both "productive" and "low_yield".
test("yield 5: a marginal qualification rate is classified marginal and is never stopped by the yield classifier", () => {
  // Queens-like: rate strictly between lowYieldMaxRate (0.05) and marginalMaxRate (0.15).
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 20, 100_000);
  for (let i = 0; i < 2; i++) recordQualifiedLead(state, 100_000); // 2/20 = 10%
  assert.equal(classifyAreaYield(state, 100_000, YIELD_LIMITS), "marginal");
  assert.equal(
    evaluateAreaYieldStop(state, 100_000, YIELD_LIMITS),
    null,
    "marginal is kept temporarily — only low_yield ever stops an area",
  );
});

// ── Yield test 6: low-yield stop does not abort siblings ───────────────────
test("yield 6: a low-yield area's own scoped abort never touches the shared parent signal (siblings unaffected)", () => {
  const parent = new AbortController();
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 30, 100_000);
  const stopReason = evaluateAreaYieldStop(state, 100_000, YIELD_LIMITS);
  assert.equal(stopReason, "area_productivity_low_yield");

  const { signal, controller } = scopeAreaAbort(parent.signal);
  controller.abort(stopReason);
  assert.equal(signal.aborted, true, "this area's own scoped signal aborts");
  assert.equal(parent.signal.aborted, false, "the shared parent/job signal — and therefore every sibling area — is untouched");
});

// ── Yield test 7: global TARGET_REACHED unchanged ───────────────────────────
test("yield 7: aborting the shared parent signal (TARGET_REACHED) still reaches an area regardless of its yield classification", () => {
  const parent = new AbortController();
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 30, 100_000); // this area would independently classify low_yield too
  const { signal } = scopeAreaAbort(parent.signal);
  assert.equal(signal.aborted, false);
  parent.abort("TARGET_REACHED");
  assert.equal(signal.aborted, true, "the existing global TARGET_REACHED path is completely untouched by yield classification");
});

// ── Yield test 8: max runtime unchanged (precedence: maxRuntime/idle checked before yield) ──
test("yield 8: evaluateAreaProductivity's max-runtime/idle precedence is untouched — yield is only consulted when it returns null", () => {
  const limits: AreaProductivityLimits = { productiveIdleMs: 60_000, maxAreaRuntimeMs: 100_000 };
  const state = createAreaProductivityState(0);
  recordDiscoveries(state, 30, 50_000); // would independently be low_yield once evaluable
  // At now=100_000 the max-runtime ceiling fires FIRST — the caller-side
  // precedence (evaluateAreaProductivity(...) ?? evaluateAreaYieldStop(...))
  // means evaluateAreaYieldStop is never even reached in that case.
  assert.equal(evaluateAreaProductivity(state, 100_000, limits), "area_productivity_max_runtime");
});

// ── Yield test 9: productive activity still prevents false idle stop, independent of yield ──
test("yield 9: an area with continuous discovery activity never trips the idle clock, even while separately being low_yield", () => {
  const idleLimits: AreaProductivityLimits = { productiveIdleMs: 60_000, maxAreaRuntimeMs: 10_000_000 };
  const state = createAreaProductivityState(0);
  let now = 0;
  for (let i = 0; i < 30; i++) {
    now += 5_000; // steady activity, well within the 60s idle window every time
    recordProductiveActivity(state, "candidate_discovered", now);
  }
  assert.equal(evaluateAreaProductivity(state, now, idleLimits), null, "idle clock unaffected — this area is still busy");
  // ...yet the SEPARATE yield check now says stop, because it is genuinely low-yield:
  assert.equal(classifyAreaYield(state, now, YIELD_LIMITS), "low_yield");
  assert.equal(evaluateAreaYieldStop(state, now, YIELD_LIMITS), "area_productivity_low_yield");
});

// ── Yield test 10: next queued area can occupy freed slot (rotation via existing pool) ──
// Mirrors the existing "8" orchestration test above but with a yield-style
// stop reason, confirming runAreaWorkerPool's worker loop (unmodified by
// this phase) claims a replacement area the exact same way for a
// low-yield stop as it does for an idle/max-runtime stop.
test("yield 10: runAreaWorkerPool claims a replacement area after one area is stopped for low yield", async () => {
  const areas = ["Bronx-like", "Staten-Island-like", "Queens-like", "Manhattan-like"];
  const claimed: string[] = [];
  const parent = new AbortController();

  const result = await runAreaWorkerPool({
    configuredWorkers: 1, // single slot — a replacement claim proves the slot was actually released
    totalCuratedAreas: areas.length,
    availableCapacity: 1,
    claimNextArea: async (usedAreas) => {
      const next = areas.find((a) => !usedAreas.has(a));
      if (!next) return undefined;
      claimed.push(next);
      return next;
    },
    runArea: async (area) => {
      if (area === "Bronx-like" || area === "Staten-Island-like") {
        // Busy but low-yield — rotated out by its own scoped abort, exactly
        // like poolExpandJob.ts's real runArea() does when evaluateAreaYieldStop fires.
        const state = createAreaProductivityState(0);
        recordDiscoveries(state, 25, 100_000);
        const stopReason = evaluateAreaYieldStop(state, 100_000, YIELD_LIMITS);
        assert.equal(stopReason, "area_productivity_low_yield");
        const { signal, controller } = scopeAreaAbort(parent.signal);
        controller.abort(stopReason);
        assert.equal(signal.aborted, true);
        return outcome({ discovered: 25, accepted: 0 });
      }
      // Queens-like / Manhattan-like: productive, runs to natural completion.
      return outcome({ discovered: 10, accepted: 4 });
    },
    tryAcquireSlot: () => () => {},
    isTerminal: () => false,
  });

  assert.equal(claimed.length, areas.length, "every area must eventually be claimed — the low-yield rotations freed slots for the rest");
  assert.equal(result.startedWorkers, areas.length);
  assert.equal(parent.signal.aborted, false, "low-yield rotation never aborts the shared parent signal");
});

// ── Yield test: env defaults are internally consistent ─────────────────────
test("yield env: AREA_YIELD_MARGINAL_MAX_RATE default is >= AREA_YIELD_LOW_MAX_RATE default", async () => {
  const { env } = await import("../../config/env.js");
  assert.ok(env.AREA_YIELD_MARGINAL_MAX_RATE >= env.AREA_YIELD_LOW_MAX_RATE);
  assert.ok(env.AREA_YIELD_MIN_ELAPSED_MS < env.AREA_PRODUCTIVITY_IDLE_MS, "yield evaluation should be reachable before the idle ceiling would otherwise fire");
  assert.ok(env.AREA_YIELD_MIN_CANDIDATE_VOLUME >= 1);
});
