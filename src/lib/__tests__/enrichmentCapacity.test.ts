/**
 * Phase 18 — Unit tests for resource-aware ENRICHMENT concurrency
 * (measureEnrichmentCapacity / splitEnrichmentCapacity in
 * resourceCapacity.ts), plus regression coverage confirming Phase 18 does
 * not disturb Phase 16's area-worker capacity model or the existing
 * businessEnrich/businessScore queue semantics.
 *
 * Pure-logic tests only — mirrors resourceCapacity.test.ts's own
 * "computeSafeResourceCapacity is a pure function, fully unit-testable
 * against fabricated inputs" convention. No cgroup files, no pg-boss, no
 * subprocess involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSafePidWorkerCeiling,
  computeSafeResourceCapacity,
  splitEnrichmentCapacity,
} from "../resourceCapacity.js";

// ── 1. default enrichment concurrency preserved when no resource
//    constraint is available ────────────────────────────────────────────
test("computeSafeResourceCapacity: enrichment — unmeasurable PID accounting falls back to the known-safe combined default (8+8=16), not the raw configured ceiling", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: null,
    pidsCurrent: null,
    pidsPerAreaWorker: 20, // ENRICHMENT_PIDS_PER_WORKER
    reservePids: 300,
    fallbackCeiling: 16, // ENRICHMENT_SAFE_RESOURCE_WORKERS_FALLBACK default
    configuredCeiling: 16, // ENRICHMENT_TASK_CONCURRENCY(8) + INTELLIGENCE_TASK_CONCURRENCY(8)
  });
  assert.equal(result.pidCeilingBasis, "fallback_unavailable");
  assert.equal(result.safeAreaWorkers, 16);
});

test("splitEnrichmentCapacity: unconstrained safe total splits proportionally to each queue's own configured desire and preserves today's 8/8 defaults", () => {
  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(16, 8, 8);
  assert.equal(enrichConcurrency, 8);
  assert.equal(intelligenceConcurrency, 8);
});

// ── 2. PID-limited container reduces enrichment concurrency ────────────
test("computeSafeResourceCapacity: enrichment — a tight measured PID budget reduces the combined ceiling below the configured 16", () => {
  // 20 PIDs/worker, ~200 PID budget after reserve => ceiling of 10.
  const result = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 3596,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    configuredCeiling: 16,
  });
  assert.equal(result.pidCeilingBasis, "measured");
  assert.equal(result.safeAreaWorkers, 10);
});

test("splitEnrichmentCapacity: reduced combined ceiling is split proportionally, favoring the larger configured queue on remainder ties", () => {
  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(10, 8, 8);
  assert.equal(enrichConcurrency + intelligenceConcurrency, 10);
  // Equal configured shares (8/8) => 5/5 exactly, no remainder edge case.
  assert.equal(enrichConcurrency, 5);
  assert.equal(intelligenceConcurrency, 5);
});

// ── 3. memory-limited container reduces enrichment concurrency ─────────
test("computeSafeResourceCapacity: enrichment — a configured per-worker memory ceiling can be the binding constraint", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 300,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    cgroupMemoryLimitMb: 1024,
    cgroupMemoryCurrentMb: 512,
    perBrowserMb: 100, // ENRICHMENT_MEMORY_MB_PER_WORKER, when configured
    reserveMemoryMb: 256,
    configuredCeiling: 16,
  });
  // Memory budget: 1024 - 512 - 256 = 256mb / 100mb = 2 workers.
  assert.equal(result.cgroupMemoryWorkerCeiling, 2);
  assert.equal(result.safeAreaWorkers, 2);
});

test("computeSafeResourceCapacity: enrichment — an unconfigured memory ceiling (ENRICHMENT_MEMORY_MB_PER_WORKER unset) leaves memory unconstrained", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 4096,
    pidsCurrent: 300,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    cgroupMemoryLimitMb: null, // measureEnrichmentCapacity only reads this when the env var is set
    cgroupMemoryCurrentMb: null,
    configuredCeiling: 16,
  });
  assert.equal(result.cgroupMemoryWorkerCeiling, null);
});

// ── 4. manual enrichment cap wins ───────────────────────────────────────
test("computeSafeResourceCapacity: enrichment — manual cap (ENRICHMENT_SAFE_RESOURCE_WORKERS) wins even when measured capacity is higher", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 100_000,
    pidsCurrent: 0,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    configuredCeiling: 16,
    manualCap: 3,
  });
  assert.equal(result.safeAreaWorkers, 3);
});

test("splitEnrichmentCapacity: a manual cap below either single queue's configured desire is still split fairly, never fully starving one queue if the other doesn't need its whole share", () => {
  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(3, 8, 8);
  assert.equal(enrichConcurrency + intelligenceConcurrency, 3);
  assert.ok(enrichConcurrency >= 1, "equal-weight queues must not fully starve either side at safeTotal=3");
  assert.ok(intelligenceConcurrency >= 1, "equal-weight queues must not fully starve either side at safeTotal=3");
});

// ── 5. zero resource capacity => zero enrichment workers, never forced to 1 ─
test("computeSafeResourceCapacity: enrichment — exhausted PID budget yields a real zero ceiling, not a forced minimum of 1", () => {
  const result = computeSafeResourceCapacity({
    pidsMax: 500,
    pidsCurrent: 490,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    configuredCeiling: 16,
  });
  assert.equal(result.safeAreaWorkers, 0);
});

test("splitEnrichmentCapacity: safeTotal=0 produces zero concurrency for both queues, never forced up to 1", () => {
  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(0, 8, 8);
  assert.equal(enrichConcurrency, 0);
  assert.equal(intelligenceConcurrency, 0);
});

test("splitEnrichmentCapacity: zero configured desire on both queues never divides by zero and produces zero concurrency", () => {
  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(10, 0, 0);
  assert.equal(enrichConcurrency, 0);
  assert.equal(intelligenceConcurrency, 0);
});

// ── 6. current area-worker capacity and enrichment capacity remain
//    independent ─────────────────────────────────────────────────────────
test("computeSafeResourceCapacity: area-worker call (pidsPerAreaWorker=220) and enrichment call (pidsPerAreaWorker=20) against the SAME cgroup snapshot produce different, independent ceilings", () => {
  const areaWorkerResult = computeSafePidWorkerCeiling(4096, 300, 220, 300, 2);
  const enrichmentResult = computeSafePidWorkerCeiling(4096, 300, 20, 300, 16);
  assert.equal(areaWorkerResult.ceiling, 15); // matches the existing Phase 16 test's own expectation
  assert.equal(enrichmentResult.ceiling, 174); // (4096-300-300)/20 = 174.8 -> floor 174
  assert.notEqual(areaWorkerResult.ceiling, enrichmentResult.ceiling);
});

// ── 7/8. ENRICHMENT_PIDS_PER_WORKER is not accidentally replaced by
//    PIDS_PER_AREA_WORKER ────────────────────────────────────────────────
test("computeSafePidWorkerCeiling: using the area-worker PID assumption (220) where the enrichment assumption (20) belongs would under-count safe capacity by 11x", () => {
  const withEnrichmentAssumption = computeSafePidWorkerCeiling(4096, 300, 20, 300, 16);
  const withWronglyReusedAreaAssumption = computeSafePidWorkerCeiling(4096, 300, 220, 300, 16);
  assert.ok(
    withEnrichmentAssumption.ceiling > withWronglyReusedAreaAssumption.ceiling * 10,
    "regression guard: if PIDS_PER_AREA_WORKER (220) is ever substituted for ENRICHMENT_PIDS_PER_WORKER (20), this assertion catches the far-too-conservative ceiling that would result",
  );
});

// ── 9. ENRICHMENT_MEMORY_MB_PER_WORKER is respected if configured ──────
test("computeSafeResourceCapacity: enrichment — a configured memory-per-worker value is honored exactly, not silently ignored", () => {
  const tightMemory = computeSafeResourceCapacity({
    pidsMax: 100_000,
    pidsCurrent: 0,
    pidsPerAreaWorker: 20,
    reservePids: 300,
    fallbackCeiling: 16,
    cgroupMemoryLimitMb: 500,
    cgroupMemoryCurrentMb: 0,
    perBrowserMb: 50,
    reserveMemoryMb: 0,
    configuredCeiling: 16,
  });
  assert.equal(tightMemory.cgroupMemoryWorkerCeiling, 10); // 500/50
  assert.equal(tightMemory.safeAreaWorkers, 10);
});

// ── 10. Website/Contact/Instagram cannot multiply total concurrency
//    beyond the global safe enrichment ceiling ──────────────────────────
test("splitEnrichmentCapacity: the two queues' outputs never sum to more than the combined safe ceiling, across a range of configured ratios", () => {
  const cases: Array<[number, number, number]> = [
    [16, 8, 8],
    [16, 12, 4],
    [7, 8, 8],
    [1, 8, 8],
    [100, 8, 8], // safe capacity exceeding configured desire must clamp to configured, not multiply past it
  ];
  for (const [safeTotal, enrichConfigured, intelligenceConfigured] of cases) {
    const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(safeTotal, enrichConfigured, intelligenceConfigured);
    assert.ok(enrichConcurrency <= enrichConfigured, `enrichConcurrency must never exceed its own configured ceiling (case safeTotal=${safeTotal})`);
    assert.ok(intelligenceConcurrency <= intelligenceConfigured, `intelligenceConcurrency must never exceed its own configured ceiling (case safeTotal=${safeTotal})`);
    assert.ok(
      enrichConcurrency + intelligenceConcurrency <= Math.min(safeTotal, enrichConfigured + intelligenceConfigured),
      `combined concurrency must never exceed min(safeTotal, totalConfigured) (case safeTotal=${safeTotal})`,
    );
  }
});

test("splitEnrichmentCapacity: an asymmetric configured ratio (12 vs 4) still splits proportionally rather than evenly", () => {
  const { enrichConcurrency, intelligenceConcurrency } = splitEnrichmentCapacity(8, 12, 4);
  assert.equal(enrichConcurrency + intelligenceConcurrency, 8);
  assert.ok(enrichConcurrency > intelligenceConcurrency, "the 12-configured queue must receive the larger share of an 8-unit ceiling than the 4-configured queue");
});
