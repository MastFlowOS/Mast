/**
 * PHASE 10 — run-to-run stability telemetry.
 *
 * Scope: this module is pure, DB-free, engine-free recording/aggregation —
 * fully unit-testable — mirroring the existing split in this directory
 * (googleAreaPool.ts, roundSizing.ts, areaRotation.ts) between pure policy
 * and the actual Supabase/pg-boss/engine wiring, which lives in the job
 * files (poolExpandJob.ts / discoveryPlanJob.ts) that import this module.
 *
 * WHY THIS EXISTS: "same request, 5m21s one run / 20m the next" cannot be
 * explained by staring at aggregate before/after numbers — it requires
 * per-area, per-run visibility into exactly where each run's time and
 * yield went. This module gives every area worker a durable telemetry
 * record (see `AreaTelemetryRecord`) and rolls those up into a job-level
 * summary and a deterministic "area yield report" so a real production
 * run can be diagnosed against the specific hypotheses this phase lists:
 *
 *   A. Maps candidate composition      — see mapsCandidatesSeen variance
 *   B. Maps discovery duration         — see runtimeMs variance
 *   C. enrichment failure              — see contactFailures variance
 *   D. email/Instagram false negatives — see missingEmail/missingInstagram
 *   E. child budget                    — see childRequested variance
 *   F. resource contention             — see runtimeMs/firstQualifiedMs
 *                                         variance concentrated in one wave
 *   G. something else                  — none of the above show variance
 *
 * `compareAreaWaves()` deliberately does NOT declare a winner — it reports
 * a coefficient of variation (stdev/mean, unit-independent so metrics are
 * comparable to each other) per metric per wave, annotated with which
 * hypothesis it's evidence for. The prompt's own instruction is "do NOT
 * guess" — the highest-CV row(s) are where a human should look next, not
 * a verdict this module hands down on its own.
 */

/** One area worker's full run-stability record — see the PHASE 10 prompt's field list. */
export type AreaTelemetryRecord = {
  area: string;
  workerNumber: number;
  childRequested: number;
  mapsCandidatesSeen: number;
  mapsCandidatesYielded: number;
  earlyNew: number;
  earlyDuplicate: number;
  earlyPruned: number;
  contactFailures: number;
  missingEmail: number;
  missingInstagram: number;
  qualified: number;
  delivered: number;
  runtimeMs: number;
  firstQualifiedMs: number | null;
  firstDeliveredMs: number | null;
};

/** Raw `area_sla` counters as reported by the Python engine's `__done__` perf blob. */
export type AreaSlaCounters = {
  mapsCandidatesSeen?: number;
  mapsCandidatesYielded?: number;
  earlyNew?: number;
  earlyDuplicate?: number;
  earlyPruned?: number;
  contactFailures?: number;
};

/**
 * Pulls the handful of `area_sla` fields this module cares about out of the
 * raw `Record<string, unknown>` perf blob threaded through from
 * `EngineDoneInfo.perf` — see `service.py`'s `__done__` sentinel and
 * `utils/perf.py:RunProfiler.area_sla_line()` for where these are computed
 * engine-side. Missing/non-numeric fields are simply omitted (never
 * fabricated), so `AreaTelemetryRecorder.finish()` can fall back to its
 * own Node-side candidate count for `mapsCandidatesSeen`/`mapsCandidatesYielded`
 * when an engine build predates one of these fields.
 */
export function extractAreaSlaCounters(areaSla: Record<string, unknown> | undefined | null): AreaSlaCounters {
  if (!areaSla) return {};
  const num = (key: string): number | undefined => (typeof areaSla[key] === "number" ? (areaSla[key] as number) : undefined);
  return {
    mapsCandidatesSeen: num("maps_candidates_seen"),
    mapsCandidatesYielded: num("maps_candidates_yielded"),
    earlyNew: num("early_new"),
    earlyDuplicate: num("early_duplicates"),
    earlyPruned: num("early_pruned"),
    contactFailures: num("contact_failures"),
  };
}

/**
 * Records ONE area worker's telemetry as it runs, then produces a durable
 * `AreaTelemetryRecord` via `finish()`. Instantiated once per claimed area
 * (see poolExpandJob.ts's `runArea()`), discarded once `finish()` is
 * called and its result pushed onto the job-level tracker.
 */
export class AreaTelemetryRecorder {
  private readonly startedAtMs: number;
  private candidatesSeenLocal = 0;
  private missingEmailCount = 0;
  private missingInstagramCount = 0;
  private qualifiedCount = 0;
  private deliveredCount = 0;
  private firstQualifiedMs: number | null = null;
  private firstDeliveredMs: number | null = null;

  constructor(
    private readonly area: string,
    private readonly workerNumber: number,
    private readonly childRequested: number,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.startedAtMs = now();
  }

  private readonly now: () => number;

  /** Call once per raw candidate the engine yields to Node (a "discovered" lead). */
  recordCandidateSeen(fields: { hasEmail: boolean; hasInstagram: boolean }): void {
    this.candidatesSeenLocal += 1;
    if (!fields.hasEmail) this.missingEmailCount += 1;
    if (!fields.hasInstagram) this.missingInstagramCount += 1;
  }

  /** Call once per candidate that passed the engine's own strict qualification gate (website+email+phone+instagram). */
  recordQualified(): void {
    this.qualifiedCount += 1;
    if (this.firstQualifiedMs === null) this.firstQualifiedMs = this.now() - this.startedAtMs;
  }

  /** Call once per lead actually delivered (inserted/credited) to the user/pool. */
  recordDelivered(): void {
    this.deliveredCount += 1;
    if (this.firstDeliveredMs === null) this.firstDeliveredMs = this.now() - this.startedAtMs;
  }

  finish(areaSla: AreaSlaCounters = {}): AreaTelemetryRecord {
    return {
      area: this.area,
      workerNumber: this.workerNumber,
      childRequested: this.childRequested,
      mapsCandidatesSeen: areaSla.mapsCandidatesSeen ?? this.candidatesSeenLocal,
      mapsCandidatesYielded: areaSla.mapsCandidatesYielded ?? this.candidatesSeenLocal,
      earlyNew: areaSla.earlyNew ?? 0,
      earlyDuplicate: areaSla.earlyDuplicate ?? 0,
      earlyPruned: areaSla.earlyPruned ?? 0,
      contactFailures: areaSla.contactFailures ?? 0,
      missingEmail: this.missingEmailCount,
      missingInstagram: this.missingInstagramCount,
      qualified: this.qualifiedCount,
      delivered: this.deliveredCount,
      runtimeMs: this.now() - this.startedAtMs,
      firstQualifiedMs: this.firstQualifiedMs,
      firstDeliveredMs: this.firstDeliveredMs,
    };
  }
}

/** Job-level run-stability summary — see the PHASE 10 prompt's field list. */
export type JobTelemetrySummary = {
  areaWaves: number;
  areasStarted: number;
  areasCompleted: number;
  globalTargetTimeMs: number | null;
  totalRuntimeMs: number;
  perWaveYield: number[];
  averageQualifiedPerArea: number;
  medianQualifiedPerArea: number;
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Pure aggregation: `records` in completion order, `waveBoundaries[i]` is
 * the index into `records` where wave `i` started (so wave `i`'s slice is
 * `records[waveBoundaries[i] .. waveBoundaries[i+1])`, and the last wave
 * runs to `records.length`). See `RunStabilityTracker` below for the
 * stateful wrapper that builds these inputs incrementally during a real
 * job run.
 */
export function computeJobTelemetrySummary(
  records: readonly AreaTelemetryRecord[],
  ctx: {
    areaWaves: number;
    areasStarted: number;
    totalRuntimeMs: number;
    globalTargetTimeMs: number | null;
    waveBoundaries: readonly number[];
  },
): JobTelemetrySummary {
  const qualifiedCounts = records.map((r) => r.qualified);

  const perWaveYield: number[] = ctx.waveBoundaries.map((start, i) => {
    const end = i + 1 < ctx.waveBoundaries.length ? ctx.waveBoundaries[i + 1] : records.length;
    return records.slice(start, end).reduce((sum, r) => sum + r.delivered, 0);
  });

  return {
    areaWaves: ctx.areaWaves,
    areasStarted: ctx.areasStarted,
    areasCompleted: records.length,
    globalTargetTimeMs: ctx.globalTargetTimeMs,
    totalRuntimeMs: ctx.totalRuntimeMs,
    perWaveYield,
    averageQualifiedPerArea: average(qualifiedCounts),
    medianQualifiedPerArea: median(qualifiedCounts),
  };
}

/**
 * Stateful wrapper used by the job files (poolExpandJob.ts) to build up
 * `AreaTelemetryRecord[]` + wave boundaries incrementally as a real run
 * progresses, then produce the pure summary above at job end. One
 * instance per job invocation, discarded when the job returns.
 */
export class RunStabilityTracker {
  private readonly startedAtMs: number;
  private waveCount = 0;
  private readonly waveBoundaries: number[] = [];
  private readonly records: AreaTelemetryRecord[] = [];

  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
  }

  /** Call once per pool creation (== once per `runAreaWorkerPool()` call — see googleAreaPool.ts). */
  startWave(): void {
    this.waveCount += 1;
    this.waveBoundaries.push(this.records.length);
  }

  /** Begins a new area worker's recorder — see `AreaTelemetryRecorder`. */
  startArea(area: string, workerNumber: number, childRequested: number): AreaTelemetryRecorder {
    return new AreaTelemetryRecorder(area, workerNumber, childRequested, this.now);
  }

  /** Call once an area worker's `finish()` has produced its record. */
  recordAreaFinished(record: AreaTelemetryRecord): void {
    this.records.push(record);
  }

  get areaRecords(): readonly AreaTelemetryRecord[] {
    return this.records;
  }

  summary(opts: { areasStarted: number; targetReachedAtMs: number | null }): JobTelemetrySummary {
    return computeJobTelemetrySummary(this.records, {
      areaWaves: this.waveCount,
      areasStarted: opts.areasStarted,
      totalRuntimeMs: this.now() - this.startedAtMs,
      globalTargetTimeMs: opts.targetReachedAtMs !== null ? opts.targetReachedAtMs - this.startedAtMs : null,
      waveBoundaries: this.waveBoundaries,
    });
  }

  yieldReport(): AreaYieldReportRow[] {
    return computeAreaYieldReport(this.records);
  }

  waveComparison(): WaveComparisonReport {
    return compareAreaWaves(this.records, this.waveBoundaries);
  }
}

// ── Deterministic area yield report (PHASE 10 item 4) ──────────────────

export type AreaYieldReportRow = {
  area: string;
  raw: number;
  yielded: number;
  qualified: number;
  yield_rate: number;
  qualification_rate: number;
};

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/** One row per completed area, in completion order — never aggregated or reordered, so it stays directly comparable to the raw per-area log lines. */
export function computeAreaYieldReport(records: readonly AreaTelemetryRecord[]): AreaYieldReportRow[] {
  return records.map((r) => ({
    area: r.area,
    raw: r.mapsCandidatesSeen,
    yielded: r.mapsCandidatesYielded,
    qualified: r.qualified,
    yield_rate: safeRate(r.mapsCandidatesYielded, r.mapsCandidatesSeen),
    qualification_rate: safeRate(r.qualified, r.mapsCandidatesYielded),
  }));
}

// ── Deterministic wave-comparison variance signals (PHASE 10 item 4) ───

export type WaveVarianceSignal = {
  metric: string;
  /** Which of the phase prompt's hypotheses (A-G) this metric is evidence for — not a conclusion, a pointer. */
  hypothesis: string;
  /** This metric's average value within each wave, in wave order. */
  values: number[];
  /** stdev/mean across waves — unit-independent, so metrics are directly comparable to find which one varies most run-to-run. 0 when the metric never varies or every wave averages to 0. */
  coefficientOfVariation: number;
};

export type WaveComparisonReport = {
  waveCount: number;
  signals: WaveVarianceSignal[];
};

function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/**
 * Splits `records` into waves using `waveBoundaries` (same convention as
 * `computeJobTelemetrySummary`) and reports, per candidate metric, the
 * per-wave average and the coefficient of variation across waves. Sort
 * the returned `signals` by `coefficientOfVariation` descending to see
 * which metric — and therefore which hypothesis (A-G) — moved the most
 * between waves in a real run; this function itself makes no claim about
 * which one is "the" cause.
 */
export function compareAreaWaves(records: readonly AreaTelemetryRecord[], waveBoundaries: readonly number[]): WaveComparisonReport {
  const waves: AreaTelemetryRecord[][] = waveBoundaries.map((start, i) => {
    const end = i + 1 < waveBoundaries.length ? waveBoundaries[i + 1] : records.length;
    return records.slice(start, end);
  });

  const metricDefs: { metric: string; hypothesis: string; extract: (r: AreaTelemetryRecord) => number }[] = [
    { metric: "avg_maps_candidates_seen", hypothesis: "A: Maps candidate composition", extract: (r) => r.mapsCandidatesSeen },
    { metric: "avg_runtime_ms", hypothesis: "B: Maps discovery duration", extract: (r) => r.runtimeMs },
    { metric: "avg_contact_failures", hypothesis: "C: enrichment failure", extract: (r) => r.contactFailures },
    {
      metric: "avg_missing_email_rate",
      hypothesis: "D: email false negatives",
      extract: (r) => safeRate(r.missingEmail, r.mapsCandidatesYielded),
    },
    {
      metric: "avg_missing_instagram_rate",
      hypothesis: "D: instagram false negatives",
      extract: (r) => safeRate(r.missingInstagram, r.mapsCandidatesYielded),
    },
    { metric: "avg_child_requested", hypothesis: "E: child budget", extract: (r) => r.childRequested },
    { metric: "avg_first_qualified_ms", hypothesis: "F: resource contention / B: discovery duration", extract: (r) => r.firstQualifiedMs ?? 0 },
  ];

  const signals: WaveVarianceSignal[] = metricDefs.map(({ metric, hypothesis, extract }) => {
    const values = waves.map((wave) => average(wave.map(extract)));
    return { metric, hypothesis, values, coefficientOfVariation: coefficientOfVariation(values) };
  });

  return { waveCount: waves.length, signals };
}
