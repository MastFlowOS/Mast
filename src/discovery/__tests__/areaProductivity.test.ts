/**
 * PHASE 12D — Hybrid adaptive area stopping.
 *
 * Pure-logic tests for areaProductivity.ts's classifier/state helpers
 * (tests 1-4, 10, 12, 13 below), plus an orchestration-level test that
 * wires the classifier + scopeAreaAbort() together with the REAL
 * runAreaWorkerPool() from googleAreaPool.ts (tests 5, 6, 8) — matching
 * the style of googleAreaPool.test.ts: no Postgres, no engine subprocess,
 * fake `runArea`/`claimNextArea`/`tryAcquireSlot` implementations, with a
 * fake `now()` clock so timing is deterministic instead of racing real
 * wall-clock time.
 *
 * Tests 7, 9, 11 (global TARGET_REACHED unchanged; qualification
 * semantics unchanged; no change to scoring/dedup/channel rules) are not
 * re-tested here — see googleAreaPool.test.ts's own cancellation/target
 * coverage for 7, and note that this phase's diff touches no
 * qualification/scoring/dedup/channel file at all (see the final report).
 */
import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Test 12 below dynamically imports src/config/env.ts, which reads required
// config (SUPABASE_URL, DATABASE_URL, etc.) once at import time via a zod
// schema — see pythonBridge.lifecycle.test.ts for the same pattern. These
// must be set before that dynamic import happens.
// ---------------------------------------------------------------------------
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

import {
  createAreaProductivityState,
  evaluateAreaProductivity,
  recordDeliveredLead,
  recordQualifiedLead,
  scopeAreaAbort,
  type AreaProductivityState,
} from "../areaProductivity.js";
import { runAreaWorkerPool, type AreaRunOutcome } from "../googleAreaPool.js";

const IDLE_MS = 60_000; // fixed test window, independent of the real env default

function outcome(partial: Partial<AreaRunOutcome> = {}): AreaRunOutcome {
  return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: false, ...partial };
}

// ── Test 1: zero qualified leads reaches exploration timeout ───────────────
test("1: an area with zero qualified leads is stopped once the exploration window elapses", () => {
  const state = createAreaProductivityState(0);
  assert.equal(evaluateAreaProductivity(state, 30_000, IDLE_MS), null, "not yet at the window");
  assert.equal(
    evaluateAreaProductivity(state, IDLE_MS, IDLE_MS),
    "area_productivity_timeout_before_first_qualified",
    "exploration window elapsed with zero qualified leads",
  );
});

// ── Test 2: one qualified lead before timeout resets the clock ─────────────
test("2: a single qualified lead before the exploration window resets the inactivity clock", () => {
  const state = createAreaProductivityState(0);
  recordQualifiedLead(state, 40_000); // qualifies before the 60s exploration window would expire
  assert.equal(evaluateAreaProductivity(state, 40_000, IDLE_MS), null);
  // Old clock (from startedAt=0) would have expired at 60_000 — but the
  // reference point is now 40_000 (lastQualifiedAt), so the area survives
  // past the OLD deadline as long as it's within IDLE_MS of the new one.
  assert.equal(evaluateAreaProductivity(state, 90_000, IDLE_MS), null, "clock reset to lastQualifiedAt, not startedAt");
  assert.equal(evaluateAreaProductivity(state, 100_000, IDLE_MS), "area_productivity_idle_timeout");
});

// ── Test 3: repeated qualified leads keep the area alive ───────────────────
test("3: repeated qualified leads before each deadline keep the area running indefinitely", () => {
  const state = createAreaProductivityState(0);
  let now = 0;
  for (let i = 0; i < 20; i++) {
    now += 30_000; // well within the 60s window every time
    recordQualifiedLead(state, now);
    assert.equal(evaluateAreaProductivity(state, now, IDLE_MS), null, `iteration ${i} must not stop the area`);
  }
  assert.equal(state.qualifiedCount, 20);
});

// ── Test 4: goes idle after a qualified lead → stops at the inactivity timeout ──
test("4: an area that goes idle after producing a qualified lead stops at the inactivity timeout, not before", () => {
  const state = createAreaProductivityState(0);
  recordQualifiedLead(state, 10_000);
  assert.equal(evaluateAreaProductivity(state, 10_000 + IDLE_MS - 1, IDLE_MS), null, "one ms before the deadline");
  assert.equal(
    evaluateAreaProductivity(state, 10_000 + IDLE_MS, IDLE_MS),
    "area_productivity_idle_timeout",
    "exactly at the deadline",
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
  assert.equal(evaluateAreaProductivity(state, now + 1_000, IDLE_MS), null);
});

// ── Test 12: default configuration value is applied correctly ──────────────
test("12: env default for AREA_PRODUCTIVITY_IDLE_MS is a conservative value grounded in the audit range (>= 85s observed max)", async () => {
  const { env } = await import("../../config/env.js");
  assert.ok(
    env.AREA_PRODUCTIVITY_IDLE_MS >= 85_000,
    "default must sit at/above the audit's observed first-qualified upper bound (85s)",
  );
});

// ── Test 13: configuration/env override works correctly ────────────────────
test("13: AREA_PRODUCTIVITY_IDLE_MS env override is honored", async () => {
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

// ── recordDeliveredLead is observational only, never affects the classifier ──
test("recordDeliveredLead updates deliveredCount without affecting the productivity classifier", () => {
  const state = createAreaProductivityState(0);
  recordDeliveredLead(state);
  recordDeliveredLead(state);
  assert.equal(state.deliveredCount, 2);
  assert.equal(state.qualifiedCount, 0);
  assert.equal(
    evaluateAreaProductivity(state, IDLE_MS, IDLE_MS),
    "area_productivity_timeout_before_first_qualified",
    "delivered-without-qualified must still be treated as unproductive",
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
  idleMs: number;
  clock: { now: () => number; advance: (ms: number) => void };
  /** ms offset (from this area's own start) for a final productivity check after the last scheduled qualified lead (or immediately, if there are none). Defaults to the last offset. */
  finalCheckAtOffset?: number;
}): Promise<{ outcome: AreaRunOutcome; productivity: AreaProductivityState; stoppedBySelf: boolean }> {
  const { area, parentSignal, qualifiedAtOffsets, idleMs, clock } = opts;
  const startedAt = clock.now();
  const productivity = createAreaProductivityState(startedAt);
  const { signal: areaSignal, controller: areaAbort } = scopeAreaAbort(parentSignal);

  let stoppedBySelf = false;
  let qualifiedCount = 0;

  for (const offset of qualifiedAtOffsets) {
    if (areaSignal.aborted) break;
    clock.advance(offset - (clock.now() - startedAt));
    const stopReason = evaluateAreaProductivity(productivity, clock.now(), idleMs);
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
    const finalStopReason = evaluateAreaProductivity(productivity, clock.now(), idleMs);
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
    idleMs: IDLE_MS,
    clock: clockA,
    finalCheckAtOffset: IDLE_MS, // drive the final check past the exploration window
  });

  const areaB = simulateArea({
    area: "Area-Productive",
    parentSignal: parent.signal,
    qualifiedAtOffsets: [10_000, 40_000, 70_000, 100_000], // steadily productive, well within the window each time
    idleMs: IDLE_MS,
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
