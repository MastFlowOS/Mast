/**
 * PHASE 5 BENCHMARK: Bounded Candidate Concurrency (Phase 4B) vs Serial Baseline
 *
 * Deterministically measures the latency and throughput profile of:
 *   - Baseline: Serial ingestion (1 candidate at a time, blocking on enrichment)
 *   - Phase 4B: Bounded candidate concurrency (MAX_CANDIDATE_CONCURRENCY = 3)
 *
 * Runs 4 repeatable scenarios with fixed synthetic workloads:
 *   Scenario 1: Enrichment-dominated latency (10 candidates, slow website crawls)
 *   Scenario 2: Mixed fast and slow candidates (instant, medium, and slow crawls)
 *   Scenario 3: Candidate errors and failure isolation (handled crashes)
 *   Scenario 4: Duplicate candidates and plan target cap race
 */

import assert from "node:assert/strict";

const MAX_CANDIDATE_CONCURRENCY = 3;

export type BenchmarkCandidate = {
  id: string;
  name: string;
  enrichmentDurationMs: number;
  shouldFail?: boolean;
  businessId?: string;
};

export type BenchmarkRunResult = {
  mode: "serial" | "bounded_concurrency_3";
  totalDurationMs: number;
  timeToFirstCompletedMs: number;
  timeToTenCompletedMs: number;
  completedCount: number;
  failedCount: number;
  duplicateCount: number;
  limitReachedCount: number;
  peakInFlight: number;
  backpressurePauseCount: number;
};

// ---------------------------------------------------------------------------
// 1. Serial Runner (exact model of pre-Phase 4B execution)
// ---------------------------------------------------------------------------
export async function runSerialBaseline(
  candidates: BenchmarkCandidate[],
  cardExtractionMs: number = 10,
  planTargetLimit: number = Infinity,
): Promise<BenchmarkRunResult> {
  const startedAt = Date.now();
  let timeToFirstCompletedMs = 0;
  let timeToTenCompletedMs = 0;
  let completedCount = 0;
  let failedCount = 0;
  let duplicateCount = 0;
  let limitReachedCount = 0;
  const deliveredBusinessIds = new Set<string>();

  for (const cand of candidates) {
    // 1. Upstream card extraction delay (Playwright sequential step)
    await new Promise((r) => setTimeout(r, cardExtractionMs));

    // 2. Synchronous candidate processing:
    // If target limit reached, stop
    if (completedCount >= planTargetLimit) {
      limitReachedCount++;
      break;
    }

    // 3. Upsert / enrichment (blocking serial wait)
    let failed = false;
    try {
      if (cand.shouldFail) {
        throw new Error(`Simulated crawl error for ${cand.id}`);
      }
      await new Promise((r) => setTimeout(r, cand.enrichmentDurationMs));
    } catch {
      failed = true;
      failedCount++;
    }

    if (!failed) {
      // 4. Delivery & dedup check
      const bId = cand.businessId ?? cand.id;
      if (deliveredBusinessIds.has(bId)) {
        duplicateCount++;
      } else {
        deliveredBusinessIds.add(bId);
        completedCount++;
        const now = Date.now() - startedAt;
        if (completedCount === 1) timeToFirstCompletedMs = now;
        if (completedCount === 10) timeToTenCompletedMs = now;
      }
    }
  }

  const totalDurationMs = Date.now() - startedAt;
  return {
    mode: "serial",
    totalDurationMs,
    timeToFirstCompletedMs,
    timeToTenCompletedMs,
    completedCount,
    failedCount,
    duplicateCount,
    limitReachedCount,
    peakInFlight: 1,
    backpressurePauseCount: 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Bounded Concurrency Runner (exact Phase 4B runOneAreaAttempt model)
// ---------------------------------------------------------------------------
export async function runBoundedConcurrency(
  candidates: BenchmarkCandidate[],
  cardExtractionMs: number = 10,
  planTargetLimit: number = Infinity,
): Promise<BenchmarkRunResult> {
  const startedAt = Date.now();
  let timeToFirstCompletedMs = 0;
  let timeToTenCompletedMs = 0;
  let completedCount = 0;
  let failedCount = 0;
  let duplicateCount = 0;
  let limitReachedCount = 0;
  let peakInFlight = 0;
  let backpressurePauseCount = 0;

  const deliveredBusinessIds = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  // Stream generator
  async function* candidateGenerator() {
    for (const c of candidates) {
      await new Promise((r) => setTimeout(r, cardExtractionMs));
      yield c;
    }
  }

  const iterator = candidateGenerator()[Symbol.asyncIterator]();

  while (true) {
    if (completedCount >= planTargetLimit) break;

    // Backpressure: pause before next iterator pull if at capacity
    if (inFlight.size >= MAX_CANDIDATE_CONCURRENCY) {
      backpressurePauseCount++;
      await Promise.race(inFlight);
    }

    if (completedCount >= planTargetLimit) break;

    const next = await iterator.next();
    if (next.done) break;

    const cand = next.value;

    const candidateTask = (async () => {
      try {
        if (completedCount >= planTargetLimit) {
          limitReachedCount++;
          return;
        }

        // Enrichment wait
        if (cand.shouldFail) {
          throw new Error(`Simulated crawl error for ${cand.id}`);
        }
        await new Promise((r) => setTimeout(r, cand.enrichmentDurationMs));

        if (completedCount >= planTargetLimit) {
          limitReachedCount++;
          return;
        }

        // Delivery
        const bId = cand.businessId ?? cand.id;
        if (deliveredBusinessIds.has(bId)) {
          duplicateCount++;
        } else {
          deliveredBusinessIds.add(bId);
          completedCount++;
          const now = Date.now() - startedAt;
          if (completedCount === 1) timeToFirstCompletedMs = now;
          if (completedCount === 10) timeToTenCompletedMs = now;
        }
      } catch {
        failedCount++;
      }
    })();

    const wrapped = candidateTask.finally(() => inFlight.delete(wrapped));
    inFlight.add(wrapped);
    if (inFlight.size > peakInFlight) {
      peakInFlight = inFlight.size;
    }
  }

  // Drain remaining in-flight tasks
  await Promise.all(inFlight);

  const totalDurationMs = Date.now() - startedAt;
  return {
    mode: "bounded_concurrency_3",
    totalDurationMs,
    timeToFirstCompletedMs,
    timeToTenCompletedMs,
    completedCount,
    failedCount,
    duplicateCount,
    limitReachedCount,
    peakInFlight,
    backpressurePauseCount,
  };
}

// ---------------------------------------------------------------------------
// 3. Benchmark Execution Driver
// ---------------------------------------------------------------------------
async function runBenchmarks() {
  console.log("================================================================================");
  console.log("MAST Discovery Engine — Phase 5 Concurrency Benchmark Report");
  console.log("================================================================================\n");

  // --- Scenario 1: Enrichment-Dominated Latency (10 slow candidates) ---
  console.log("▶ Scenario 1: Enrichment-Dominated Latency (10 candidates, slow website crawls 80ms)");
  const s1Candidates: BenchmarkCandidate[] = Array.from({ length: 10 }, (_, i) => ({
    id: `s1-cand-${i}`,
    name: `S1 Business ${i}`,
    enrichmentDurationMs: 80,
  }));

  const s1Serial = await runSerialBaseline(s1Candidates, 10);
  const s1Concurrent = await runBoundedConcurrency(s1Candidates, 10);
  printComparison("Scenario 1", s1Serial, s1Concurrent);

  // --- Scenario 2: Mixed Fast & Slow Candidates (12 candidates) ---
  console.log("▶ Scenario 2: Mixed Fast & Slow Candidates (4 fast 10ms, 4 medium 40ms, 4 slow 100ms)");
  const s2Candidates: BenchmarkCandidate[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `s2-fast-${i}`, name: `Fast ${i}`, enrichmentDurationMs: 10 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `s2-med-${i}`, name: `Med ${i}`, enrichmentDurationMs: 40 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `s2-slow-${i}`, name: `Slow ${i}`, enrichmentDurationMs: 100 })),
  ];

  const s2Serial = await runSerialBaseline(s2Candidates, 10);
  const s2Concurrent = await runBoundedConcurrency(s2Candidates, 10);
  printComparison("Scenario 2", s2Serial, s2Concurrent);

  // --- Scenario 3: Candidate Errors & Isolation (10 candidates, 2 failures) ---
  console.log("▶ Scenario 3: Candidate Errors & Isolation (10 candidates, 2 simulated crawl errors)");
  const s3Candidates: BenchmarkCandidate[] = Array.from({ length: 10 }, (_, i) => ({
    id: `s3-cand-${i}`,
    name: `S3 Business ${i}`,
    enrichmentDurationMs: 60,
    shouldFail: i === 2 || i === 7,
  }));

  const s3Serial = await runSerialBaseline(s3Candidates, 10);
  const s3Concurrent = await runBoundedConcurrency(s3Candidates, 10);
  printComparison("Scenario 3", s3Serial, s3Concurrent);

  // --- Scenario 4: Duplicate Candidates & Plan Target Limit (Target = 5) ---
  console.log("▶ Scenario 4: Duplicate Candidates & Target Limit (12 candidates, 3 duplicates, target cap = 5)");
  const s4Candidates: BenchmarkCandidate[] = [
    { id: "s4-1", name: "Biz 1", enrichmentDurationMs: 50, businessId: "biz-1" },
    { id: "s4-2", name: "Biz 1 Dup", enrichmentDurationMs: 30, businessId: "biz-1" }, // Duplicate
    { id: "s4-3", name: "Biz 2", enrichmentDurationMs: 40, businessId: "biz-2" },
    { id: "s4-4", name: "Biz 3", enrichmentDurationMs: 60, businessId: "biz-3" },
    { id: "s4-5", name: "Biz 2 Dup", enrichmentDurationMs: 20, businessId: "biz-2" }, // Duplicate
    { id: "s4-6", name: "Biz 4", enrichmentDurationMs: 50, businessId: "biz-4" },
    { id: "s4-7", name: "Biz 5", enrichmentDurationMs: 70, businessId: "biz-5" },
    { id: "s4-8", name: "Biz 6", enrichmentDurationMs: 40, businessId: "biz-6" },
    { id: "s4-9", name: "Biz 7", enrichmentDurationMs: 50, businessId: "biz-7" },
  ];

  const s4Serial = await runSerialBaseline(s4Candidates, 10, 5);
  const s4Concurrent = await runBoundedConcurrency(s4Candidates, 10, 5);
  printComparison("Scenario 4", s4Serial, s4Concurrent);

  // Assert critical invariants
  assert.equal(s1Concurrent.peakInFlight, 3, "Peak concurrency must not exceed 3");
  assert.ok(s1Concurrent.backpressurePauseCount > 0, "Backpressure must trigger when pool is full");
  assert.equal(s3Concurrent.completedCount, 8, "S3 should have 8 successful completions");
  assert.equal(s3Concurrent.failedCount, 2, "S3 should isolate the 2 failures");
  assert.equal(s4Concurrent.completedCount, 5, "S4 must respect plan target cap of 5");
  assert.equal(s4Concurrent.duplicateCount, 2, "S4 must identify duplicates");
}

function printComparison(title: string, serial: BenchmarkRunResult, concurrent: BenchmarkRunResult) {
  const speedup = (serial.totalDurationMs / concurrent.totalDurationMs).toFixed(2);
  const timeSaved = serial.totalDurationMs - concurrent.totalDurationMs;
  const pctSaved = ((timeSaved / serial.totalDurationMs) * 100).toFixed(1);

  console.log(`  ------------------------------------------------------------------------------`);
  console.log(`  Metric                          Serial Baseline     Bounded Concurrency (3)`);
  console.log(`  ------------------------------------------------------------------------------`);
  console.log(`  Total Processing Time:          ${serial.totalDurationMs} ms              ${concurrent.totalDurationMs} ms (${speedup}x speedup, -${pctSaved}%)`);
  console.log(`  Time to 1st Lead:               ${serial.timeToFirstCompletedMs} ms               ${concurrent.timeToFirstCompletedMs} ms`);
  if (serial.timeToTenCompletedMs > 0 || concurrent.timeToTenCompletedMs > 0) {
    console.log(`  Time to 10th Lead:              ${serial.timeToTenCompletedMs} ms             ${concurrent.timeToTenCompletedMs} ms`);
  }
  console.log(`  Peak In-Flight Tasks:           ${serial.peakInFlight}                   ${concurrent.peakInFlight}`);
  console.log(`  Backpressure Pauses:            ${serial.backpressurePauseCount}                   ${concurrent.backpressurePauseCount}`);
  console.log(`  Successful Deliveries:          ${serial.completedCount}                   ${concurrent.completedCount}`);
  console.log(`  Failed / Isolated Tasks:        ${serial.failedCount}                   ${concurrent.failedCount}`);
  console.log(`  Duplicate Identifications:      ${serial.duplicateCount}                   ${concurrent.duplicateCount}`);
  console.log(`  ------------------------------------------------------------------------------\n`);
}

runBenchmarks().catch((err) => {
  console.error("Benchmark run failed:", err);
  process.exit(1);
});
