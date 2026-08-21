/**
 * PHASE 10 — run-to-run stability telemetry.
 *
 * Pure-logic tests for runStabilityTelemetry.ts, matching the style of
 * roundSizing.test.ts / googleAreaPool.test.ts elsewhere in this
 * directory: no Postgres, no engine subprocess — a fake `now()` clock is
 * injected so timing-based fields (runtimeMs/firstQualifiedMs/
 * firstDeliveredMs) are deterministic instead of racing real wall-clock
 * time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AreaTelemetryRecorder,
  RunStabilityTracker,
  extractAreaSlaCounters,
  computeJobTelemetrySummary,
  computeAreaYieldReport,
  compareAreaWaves,
  type AreaTelemetryRecord,
} from "../runStabilityTelemetry.js";

function fakeClock(startAt = 0) {
  let t = startAt;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function record(overrides: Partial<AreaTelemetryRecord> = {}): AreaTelemetryRecord {
  return {
    area: "Area1",
    workerNumber: 1,
    childRequested: 10,
    mapsCandidatesSeen: 40,
    mapsCandidatesYielded: 20,
    earlyNew: 15,
    earlyDuplicate: 3,
    earlyPruned: 2,
    contactFailures: 1,
    missingEmail: 0,
    missingInstagram: 0,
    qualified: 10,
    delivered: 10,
    runtimeMs: 5000,
    firstQualifiedMs: 500,
    firstDeliveredMs: 600,
    ...overrides,
  };
}

// ── extractAreaSlaCounters ──────────────────────────────────────────────

test("extractAreaSlaCounters pulls only known numeric fields, never fabricates missing ones", () => {
  const counters = extractAreaSlaCounters({
    maps_candidates_seen: 42,
    maps_candidates_yielded: 21,
    early_new: 10,
    early_duplicates: 5,
    early_pruned: 6,
    contact_failures: 2,
    unrelated_field: "ignored",
  });
  assert.deepEqual(counters, {
    mapsCandidatesSeen: 42,
    mapsCandidatesYielded: 21,
    earlyNew: 10,
    earlyDuplicate: 5,
    earlyPruned: 6,
    contactFailures: 2,
  });
});

test("extractAreaSlaCounters returns {} for undefined/null input, and no defined numeric fields for non-numeric input — never throws", () => {
  assert.deepEqual(extractAreaSlaCounters(undefined), {});
  assert.deepEqual(extractAreaSlaCounters(null), {});
  const nonNumeric = extractAreaSlaCounters({ maps_candidates_seen: "not-a-number" });
  assert.equal(nonNumeric.mapsCandidatesSeen, undefined);
});

// ── AreaTelemetryRecorder ────────────────────────────────────────────────

test("AreaTelemetryRecorder tracks candidatesSeen/missingEmail/missingInstagram purely from recordCandidateSeen calls", () => {
  const clock = fakeClock();
  const rec = new AreaTelemetryRecorder("Area1", 2, 10, clock.now);
  rec.recordCandidateSeen({ hasEmail: true, hasInstagram: true });
  rec.recordCandidateSeen({ hasEmail: false, hasInstagram: true });
  rec.recordCandidateSeen({ hasEmail: true, hasInstagram: false });
  rec.recordCandidateSeen({ hasEmail: false, hasInstagram: false });

  const finished = rec.finish();
  assert.equal(finished.mapsCandidatesSeen, 4);
  assert.equal(finished.mapsCandidatesYielded, 4); // falls back to local count when no engine perf given
  assert.equal(finished.missingEmail, 2);
  assert.equal(finished.missingInstagram, 2);
  assert.equal(finished.area, "Area1");
  assert.equal(finished.workerNumber, 2);
  assert.equal(finished.childRequested, 10);
});

test("AreaTelemetryRecorder.finish() prefers engine-provided area_sla counters over the local candidate count", () => {
  const rec = new AreaTelemetryRecorder("Area1", 1, 10);
  rec.recordCandidateSeen({ hasEmail: true, hasInstagram: true });
  rec.recordCandidateSeen({ hasEmail: true, hasInstagram: true });

  const finished = rec.finish({ mapsCandidatesSeen: 99, mapsCandidatesYielded: 55, earlyNew: 3, earlyDuplicate: 1, earlyPruned: 1, contactFailures: 4 });
  assert.equal(finished.mapsCandidatesSeen, 99);
  assert.equal(finished.mapsCandidatesYielded, 55);
  assert.equal(finished.earlyNew, 3);
  assert.equal(finished.earlyDuplicate, 1);
  assert.equal(finished.earlyPruned, 1);
  assert.equal(finished.contactFailures, 4);
});

test("AreaTelemetryRecorder records first_qualified_ms/first_delivered_ms only on the FIRST occurrence", () => {
  const clock = fakeClock();
  const rec = new AreaTelemetryRecorder("Area1", 1, 10, clock.now);

  clock.advance(100);
  rec.recordQualified(); // first qualified at t=100
  clock.advance(50);
  rec.recordQualified(); // second qualified — must not overwrite firstQualifiedMs
  clock.advance(75);
  rec.recordDelivered(); // first delivered at t=225
  clock.advance(30);
  rec.recordDelivered(); // second delivered — must not overwrite firstDeliveredMs

  const finished = rec.finish();
  assert.equal(finished.qualified, 2);
  assert.equal(finished.delivered, 2);
  assert.equal(finished.firstQualifiedMs, 100);
  assert.equal(finished.firstDeliveredMs, 225);
  assert.equal(finished.runtimeMs, 255);
});

test("AreaTelemetryRecorder reports null first_qualified_ms/first_delivered_ms when neither ever happened", () => {
  const rec = new AreaTelemetryRecorder("Area1", 1, 10);
  const finished = rec.finish();
  assert.equal(finished.firstQualifiedMs, null);
  assert.equal(finished.firstDeliveredMs, null);
  assert.equal(finished.qualified, 0);
  assert.equal(finished.delivered, 0);
});

// ── computeJobTelemetrySummary ───────────────────────────────────────────

test("computeJobTelemetrySummary computes average/median qualified per area correctly", () => {
  const records = [record({ qualified: 2 }), record({ qualified: 4 }), record({ qualified: 9 })];
  const summary = computeJobTelemetrySummary(records, {
    areaWaves: 1,
    areasStarted: 3,
    totalRuntimeMs: 12000,
    globalTargetTimeMs: 9000,
    waveBoundaries: [0],
  });
  assert.equal(summary.areasCompleted, 3);
  assert.equal(summary.averageQualifiedPerArea, 5);
  assert.equal(summary.medianQualifiedPerArea, 4);
  assert.equal(summary.globalTargetTimeMs, 9000);
  assert.equal(summary.totalRuntimeMs, 12000);
});

test("computeJobTelemetrySummary handles zero areas without dividing by zero", () => {
  const summary = computeJobTelemetrySummary([], {
    areaWaves: 0,
    areasStarted: 0,
    totalRuntimeMs: 500,
    globalTargetTimeMs: null,
    waveBoundaries: [],
  });
  assert.equal(summary.areasCompleted, 0);
  assert.equal(summary.averageQualifiedPerArea, 0);
  assert.equal(summary.medianQualifiedPerArea, 0);
  assert.equal(summary.globalTargetTimeMs, null);
});

test("computeJobTelemetrySummary computes per-wave yield by slicing records at waveBoundaries", () => {
  const records = [
    record({ area: "W1-A1", delivered: 3 }),
    record({ area: "W1-A2", delivered: 2 }),
    record({ area: "W2-A1", delivered: 5 }),
  ];
  const summary = computeJobTelemetrySummary(records, {
    areaWaves: 2,
    areasStarted: 3,
    totalRuntimeMs: 1000,
    globalTargetTimeMs: null,
    waveBoundaries: [0, 2], // wave 1: records[0..2), wave 2: records[2..3)
  });
  assert.deepEqual(summary.perWaveYield, [5, 5]); // wave1: 3+2=5, wave2: 5
});

// ── RunStabilityTracker (stateful wiring) ───────────────────────────────

test("RunStabilityTracker.startArea/recordAreaFinished/summary end-to-end wiring matches computeJobTelemetrySummary", () => {
  const clock = fakeClock();
  const tracker = new RunStabilityTracker(clock.now);

  tracker.startWave();
  const rec1 = tracker.startArea("A1", 1, 10);
  clock.advance(10);
  rec1.recordCandidateSeen({ hasEmail: true, hasInstagram: true });
  rec1.recordQualified();
  rec1.recordDelivered();
  tracker.recordAreaFinished(rec1.finish());

  const rec2 = tracker.startArea("A2", 2, 10);
  clock.advance(20);
  rec2.recordCandidateSeen({ hasEmail: false, hasInstagram: true });
  tracker.recordAreaFinished(rec2.finish());

  clock.advance(5);
  const summary = tracker.summary({ areasStarted: 2, targetReachedAtMs: clock.now() });

  assert.equal(summary.areaWaves, 1);
  assert.equal(summary.areasStarted, 2);
  assert.equal(summary.areasCompleted, 2);
  assert.equal(summary.totalRuntimeMs, 35);
  assert.equal(tracker.areaRecords.length, 2);
});

test("RunStabilityTracker.startWave() records a new wave boundary each call — multiple waves reflected in perWaveYield", () => {
  const tracker = new RunStabilityTracker(() => 0);

  tracker.startWave();
  tracker.recordAreaFinished(record({ area: "W1-A1", delivered: 4 }));

  tracker.startWave();
  tracker.recordAreaFinished(record({ area: "W2-A1", delivered: 6 }));
  tracker.recordAreaFinished(record({ area: "W2-A2", delivered: 1 }));

  const summary = tracker.summary({ areasStarted: 3, targetReachedAtMs: null });
  assert.equal(summary.areaWaves, 2);
  assert.deepEqual(summary.perWaveYield, [4, 7]);
});

// ── computeAreaYieldReport (PHASE 10 item 4) ────────────────────────────

test("computeAreaYieldReport computes yield_rate/qualification_rate per area", () => {
  const records = [
    record({ area: "A1", mapsCandidatesSeen: 100, mapsCandidatesYielded: 50, qualified: 10 }),
    record({ area: "A2", mapsCandidatesSeen: 40, mapsCandidatesYielded: 40, qualified: 40 }),
  ];
  const report = computeAreaYieldReport(records);
  assert.deepEqual(report[0], { area: "A1", raw: 100, yielded: 50, qualified: 10, yield_rate: 0.5, qualification_rate: 0.2 });
  assert.deepEqual(report[1], { area: "A2", raw: 40, yielded: 40, qualified: 40, yield_rate: 1, qualification_rate: 1 });
});

test("computeAreaYieldReport never divides by zero — returns 0 rate for a zero-candidate area", () => {
  const report = computeAreaYieldReport([record({ area: "Dead", mapsCandidatesSeen: 0, mapsCandidatesYielded: 0, qualified: 0 })]);
  assert.equal(report[0].yield_rate, 0);
  assert.equal(report[0].qualification_rate, 0);
});

// ── compareAreaWaves (PHASE 10 item 4 — deterministic variance signals) ─

test("compareAreaWaves reports higher coefficient of variation for the metric that actually varies most across waves", () => {
  // Wave 1: fast, low-candidate areas. Wave 2: slow, high-candidate areas.
  // runtime_ms varies a lot between waves; contact_failures stays flat.
  const records = [
    record({ area: "W1-A1", runtimeMs: 1000, contactFailures: 1 }),
    record({ area: "W1-A2", runtimeMs: 1200, contactFailures: 1 }),
    record({ area: "W2-A1", runtimeMs: 9000, contactFailures: 1 }),
    record({ area: "W2-A2", runtimeMs: 9500, contactFailures: 1 }),
  ];
  const comparison = compareAreaWaves(records, [0, 2]);

  assert.equal(comparison.waveCount, 2);
  const runtimeSignal = comparison.signals.find((s) => s.metric === "avg_runtime_ms")!;
  const contactSignal = comparison.signals.find((s) => s.metric === "avg_contact_failures")!;

  assert.ok(runtimeSignal.coefficientOfVariation > contactSignal.coefficientOfVariation, "runtime, which actually differs between waves, must show higher CV than the flat contact-failure metric");
  assert.equal(contactSignal.coefficientOfVariation, 0, "a metric with identical values across every wave has zero variation");
});

test("compareAreaWaves annotates every signal with a hypothesis label from the phase prompt (A-G)", () => {
  const comparison = compareAreaWaves([record()], [0]);
  for (const signal of comparison.signals) {
    assert.ok(signal.hypothesis.length > 0);
  }
  const metrics = comparison.signals.map((s) => s.metric);
  assert.ok(metrics.includes("avg_maps_candidates_seen")); // hypothesis A
  assert.ok(metrics.includes("avg_runtime_ms")); // hypothesis B
  assert.ok(metrics.includes("avg_contact_failures")); // hypothesis C
  assert.ok(metrics.includes("avg_missing_email_rate")); // hypothesis D
  assert.ok(metrics.includes("avg_child_requested")); // hypothesis E
});

test("compareAreaWaves handles a single wave without throwing (CV is 0 across one data point)", () => {
  const comparison = compareAreaWaves([record(), record()], [0]);
  assert.equal(comparison.waveCount, 1);
  for (const signal of comparison.signals) {
    assert.equal(signal.values.length, 1);
  }
});
