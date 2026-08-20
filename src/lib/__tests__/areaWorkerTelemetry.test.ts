/**
 * Phase 6B — unit tests for areaWorkerTelemetry.ts's lifecycle bookkeeping
 * and delta computation. Uses the real `snapshotResourceUsage()` (backed
 * by whatever cgroup this test process happens to run under — possibly
 * "unavailable" on a dev machine), so these tests only assert on
 * structure/bookkeeping, never on specific numeric values.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  newAreaRunId,
  recordBeforeAreaStart,
  recordAfterAreaStart,
  recordAfterAreaCleanup,
  getAreaWorkerTelemetrySummary,
  __testing_areaWorkerTelemetry,
} from "../areaWorkerTelemetry.js";

test("single clean area-worker lifecycle produces exactly one delta, marked not concurrent", () => {
  __testing_areaWorkerTelemetry.reset();
  const runId = newAreaRunId();
  recordBeforeAreaStart(runId, "downtown");
  recordAfterAreaStart(runId, "downtown");
  recordAfterAreaCleanup(runId, "downtown");

  const summary = getAreaWorkerTelemetrySummary();
  assert.equal(summary.contaminatedDeltaCount, 0);
  assert.equal(summary.cleanDeltas.length, 1);
  assert.equal(summary.cleanDeltas[0]?.area, "downtown");
  assert.equal(summary.cleanDeltas[0]?.concurrent, false);
});

test("recordAfterAreaStart is idempotent — a duplicate call for the same runId does not add a second delta", () => {
  __testing_areaWorkerTelemetry.reset();
  const runId = newAreaRunId();
  recordBeforeAreaStart(runId, "midtown");
  recordAfterAreaStart(runId, "midtown");
  recordAfterAreaStart(runId, "midtown"); // duplicate — e.g. a second lead line
  recordAfterAreaCleanup(runId, "midtown");

  const summary = getAreaWorkerTelemetrySummary();
  assert.equal(summary.cleanDeltas.length, 1);
});

test("overlapping lifecycles are flagged as concurrent and excluded from clean deltas", () => {
  __testing_areaWorkerTelemetry.reset();
  const runA = newAreaRunId();
  const runB = newAreaRunId();

  recordBeforeAreaStart(runA, "area-a");
  recordBeforeAreaStart(runB, "area-b"); // runA still active -> runB's before_start sample is itself concurrent
  recordAfterAreaStart(runA, "area-a"); // runB also active here -> runA's delta is contaminated
  recordAfterAreaStart(runB, "area-b"); // runA still active -> runB's delta is contaminated too
  recordAfterAreaCleanup(runA, "area-a");
  recordAfterAreaCleanup(runB, "area-b");

  const summary = getAreaWorkerTelemetrySummary();
  assert.equal(summary.cleanDeltas.length, 0);
  assert.equal(summary.contaminatedDeltaCount, 2);
});

test("a run that never reaches after_start (e.g. early crash) does not leak bookkeeping or produce a delta", () => {
  __testing_areaWorkerTelemetry.reset();
  const runId = newAreaRunId();
  recordBeforeAreaStart(runId, "crashed-area");
  recordAfterAreaCleanup(runId, "crashed-area"); // no recordAfterAreaStart in between

  const summary = getAreaWorkerTelemetrySummary();
  assert.equal(summary.cleanDeltas.length, 0);
  assert.equal(summary.contaminatedDeltaCount, 0);

  // A subsequent, independent clean run must not itself be misflagged as
  // concurrent because of the crashed run's bookkeeping.
  const runId2 = newAreaRunId();
  recordBeforeAreaStart(runId2, "next-area");
  recordAfterAreaStart(runId2, "next-area");
  recordAfterAreaCleanup(runId2, "next-area");

  const summary2 = getAreaWorkerTelemetrySummary();
  assert.equal(summary2.cleanDeltas.length, 1);
  assert.equal(summary2.cleanDeltas[0]?.concurrent, false);
});

test("peakPidDeltaPerArea / peakMemoryDeltaPerAreaMb are null when no clean numeric deltas exist", () => {
  __testing_areaWorkerTelemetry.reset();
  const summary = getAreaWorkerTelemetrySummary();
  assert.equal(summary.peakPidDeltaPerArea, null);
  assert.equal(summary.peakMemoryDeltaPerAreaMb, null);
});
