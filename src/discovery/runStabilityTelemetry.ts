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

/**
 * PHASE 11.1 — area-yield telemetry honesty.
 *
 * Distinguishes WHY an area's `AreaTelemetryRecord` looks the way it does:
 *
 *   fresh_area_run     — a child area worker actually launched and
 *                         performed discovery work; the engine reported
 *                         real `area_sla` Maps-funnel counters this pass.
 *   partial_area_run   — the child started but was stopped (watchdog,
 *                         cancellation, or an outright failure) before it
 *                         could report a normal completion. Whatever was
 *                         genuinely observed before the stop is preserved
 *                         and reported as-is — never zeroed out, never
 *                         upgraded to look like a full run.
 *   parent_pool_cache   — the child's engine invocation completed
 *                         NORMALLY (its own target was reached / it
 *                         exhausted / its consumer stopped it on purpose)
 *                         but never reported a fresh Maps funnel for this
 *                         pass. Whatever got delivered did not come from
 *                         fresh raw/yielded discovery counted THIS
 *                         invocation — see computeAreaYieldReport()'s
 *                         `n/a` handling below.
 *   unknown             — insufficient evidence to say which of the above
 *                         applies (e.g. this area's engine invocation
 *                         never reported ANY completion info at all, or
 *                         an old caller never wired the new evidence
 *                         through) — never guessed, always the safe
 *                         (all-n/a) default in the report.
 *
 * See `determineAreaWorkSource()` below for the pure decision function,
 * and pythonBridge.ts's `EngineDoneInfo.terminationReason` for the
 * authoritative per-invocation signal this is built from.
 */
export type AreaWorkSource = "fresh_area_run" | "partial_area_run" | "parent_pool_cache" | "unknown";

/**
 * Mirrors `EngineDoneInfo["terminationReason"]` (pythonBridge.ts) without
 * importing it — this module stays engine/bridge-import-free (see the
 * module doc comment above), and the two are kept in sync structurally
 * (string literal union) rather than by a hard type dependency.
 *
 * PHASE 12D adds two Node-side-only reasons that never come from the
 * bridge: `area_productivity_timeout_before_first_qualified` and
 * `area_productivity_idle_timeout` (see areaProductivity.ts). When one of
 * these fires, poolExpandJob.ts's `runArea()` reports it here INSTEAD OF
 * whatever generic bridge-level reason (typically `CANCELLED`, since the
 * area's own engine subprocess was asked to stop via SIGTERM) the aborted
 * engine call itself produced — this is Node's own, more specific account
 * of WHY that area stopped, and is strictly more informative than the
 * bridge's generic classification for a caller-initiated abort.
 */
export type AreaTerminationReason =
  | "SUCCESS_TARGET_REACHED"
  | "SUCCESS_EXHAUSTED"
  | "SUCCESS_CONSUMER_STOPPED"
  | "WATCHDOG_TIMEOUT"
  | "CANCELLED"
  | "FAILURE"
  | "area_productivity_timeout_before_first_qualified"
  | "area_productivity_idle_timeout";

export type AreaWorkEvidence = {
  /** True when the engine reported a real numeric `maps_candidates_seen` for this pass (see extractAreaSlaCounters). */
  hasFreshMapsTelemetry: boolean;
  /** This area's own engine invocation's termination classification — undefined only for a call site that doesn't thread it through. */
  terminationReason?: AreaTerminationReason;
  /** False only when this area's engine invocation never produced ANY onDone/perf info at all (e.g. threw before completion could be observed). */
  perfReceived: boolean;
};

/**
 * Pure classification — see the `AreaWorkSource` doc comment above for what
 * each value means. Deliberately does NOT look at `delivered`/`qualified`
 * counts: a cached delivery can be >0, and the PHASE 11.1 prompt is
 * explicit that freshness must never be inferred from delivery counts.
 */
export function determineAreaWorkSource(evidence: AreaWorkEvidence): AreaWorkSource {
  if (!evidence.perfReceived) return "unknown";

  const stoppedEarly =
    evidence.terminationReason === "WATCHDOG_TIMEOUT" ||
    evidence.terminationReason === "CANCELLED" ||
    evidence.terminationReason === "FAILURE" ||
    // PHASE 12D: an adaptive area-productivity stop is, from a telemetry-
    // honesty standpoint, the exact same shape as any other early stop —
    // whatever the engine had genuinely reported before it was asked to
    // stop is preserved as a partial run, never upgraded to look complete.
    evidence.terminationReason === "area_productivity_timeout_before_first_qualified" ||
    evidence.terminationReason === "area_productivity_idle_timeout";
  if (stoppedEarly) return "partial_area_run";

  if (evidence.hasFreshMapsTelemetry) return "fresh_area_run";

  // No fresh Maps funnel reported. If we also don't know how this run
  // ended (old call site, terminationReason never threaded through),
  // that's insufficient evidence either way — don't guess "cache".
  if (evidence.terminationReason === undefined) return "unknown";

  return "parent_pool_cache";
}

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
  /** PHASE 11.1: true only when `area_sla.maps_candidates_seen` was a real number reported by the engine this pass (see extractAreaSlaCounters). */
  hasFreshMapsTelemetry: boolean;
  /** PHASE 11.1: why this record looks the way it does — see the `AreaWorkSource` doc comment above. */
  source: AreaWorkSource;
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

  /**
   * `evidence` is PHASE 11.1's addition: how this area's engine invocation
   * actually ended, used to classify `source` below — see
   * `determineAreaWorkSource()`. Optional, and defaults to "we don't know
   * how it ended but we did get SOME completion callback" (perfReceived:
   * true, terminationReason: undefined) for callers that predate this
   * phase, which resolves to `fresh_area_run` when real area_sla telemetry
   * is present (unchanged behavior) or `unknown` when it isn't (safer than
   * the old silent fallback — see computeAreaYieldReport()).
   */
  finish(
    areaSla: AreaSlaCounters = {},
    evidence: { terminationReason?: AreaTerminationReason; perfReceived?: boolean } = {},
  ): AreaTelemetryRecord {
    const hasFreshMapsTelemetry = areaSla.mapsCandidatesSeen !== undefined;
    const perfReceived = evidence.perfReceived ?? true;
    const source = determineAreaWorkSource({
      hasFreshMapsTelemetry,
      terminationReason: evidence.terminationReason,
      perfReceived,
    });
    return {
      area: this.area,
      workerNumber: this.workerNumber,
      childRequested: this.childRequested,
      // PHASE 11.1: these two fields are UNCHANGED — still fall back to the
      // local candidate count when the engine reported no fresh area_sla,
      // preserving every existing consumer of AreaTelemetryRecord (wave
      // comparison, job summaries, etc. — see this file's module doc
      // comment and the PHASE 11.1 prompt's "preserve all existing
      // telemetry" step). What changed is that computeAreaYieldReport()
      // below no longer presents this fallback value AS IF it were a real
      // raw/yielded Maps count when `source` says otherwise.
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
      hasFreshMapsTelemetry,
      source,
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

/**
 * PHASE 11.1: `raw`/`yielded`/`qualified` are now honesty-gated by
 * `source` — "n/a" whenever this area didn't demonstrably do fresh
 * discovery/qualification work THIS invocation, instead of silently
 * substituting a fallback/cached number as if it were a real funnel count
 * (the bug this phase fixes — see the module doc comment above).
 *
 * `maps_candidates_seen`/`maps_candidates_yielded` are the PRESERVED,
 * UNCHANGED full counters from `AreaTelemetryRecord` (real engine value,
 * or the pre-existing local-count fallback) — kept for anyone doing
 * deeper diagnostic analysis; only the `raw`/`yielded`/`qualified`
 * headline fields are gated. `delivered` and `runtime_ms` are always real
 * Node-local observations regardless of source and are never hidden.
 */
export type AreaYieldReportRow = {
  area: string;
  source: AreaWorkSource;
  raw: number | "n/a";
  yielded: number | "n/a";
  qualified: number | "n/a";
  delivered: number;
  runtime_ms: number;
  maps_candidates_seen: number;
  maps_candidates_yielded: number;
  yield_rate: number;
  qualification_rate: number;
};

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/** One row per completed area, in completion order — never aggregated or reordered, so it stays directly comparable to the raw per-area log lines. */
export function computeAreaYieldReport(records: readonly AreaTelemetryRecord[]): AreaYieldReportRow[] {
  return records.map((r) => {
    // Backward compat (PHASE 11.1 test 7): a record built before this
    // phase (or by a caller that never wired the new fields through) has
    // no `source`/`hasFreshMapsTelemetry` — default to the SAFE reading
    // ("unknown" → every headline field n/a) rather than crashing or
    // guessing "fresh".
    const source: AreaWorkSource = r.source ?? "unknown";
    const isFreshOrPartial = source === "fresh_area_run" || source === "partial_area_run";
    // Even for a partial run, raw/yielded are only real if the engine
    // actually reported a fresh area_sla before it was stopped — an area
    // aborted before any area_sla ever came back has no genuine raw/yielded
    // evidence, only whatever Node observed locally (candidates seen over
    // the stream), which is exactly the number this phase says must never
    // be presented as "raw"/"yielded".
    const rawReportable = isFreshOrPartial && r.hasFreshMapsTelemetry;

    return {
      area: r.area,
      source,
      raw: rawReportable ? r.mapsCandidatesSeen : "n/a",
      yielded: rawReportable ? r.mapsCandidatesYielded : "n/a",
      // `qualified` is a genuine Node-local observation (recordQualified()
      // firing on a real per-lead pipeline event) independent of area_sla,
      // so it's reportable for fresh/partial runs even without fresh Maps
      // telemetry — but NEVER for parent_pool_cache/unknown, where this
      // phase's prompt is explicit that a cache-sourced delivery must not
      // be presented as a freshly-qualified count (see Step 6's examples).
      qualified: isFreshOrPartial ? r.qualified : "n/a",
      delivered: r.delivered,
      runtime_ms: r.runtimeMs,
      maps_candidates_seen: r.mapsCandidatesSeen,
      maps_candidates_yielded: r.mapsCandidatesYielded,
      yield_rate: safeRate(r.mapsCandidatesYielded, r.mapsCandidatesSeen),
      qualification_rate: safeRate(r.qualified, r.mapsCandidatesYielded),
    };
  });
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
