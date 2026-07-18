/**
 * Mast Lead Engine — TypeScript Performance Profiler (Phase 2)
 *
 * Lightweight job-level timer that mirrors the Python RunProfiler API.
 * Zero dependencies, zero behaviour change — purely additive instrumentation.
 *
 * Usage:
 *   const profiler = new JobProfiler();
 *   const t = profiler.timer("business_upsert"); await upsert(); t.end();
 *   profiler.mark("first_lead_delivered");
 *   profiler.printReport({ query, city, delivered, requested });
 */

interface StageSample {
  totalMs: number;
  count: number;
  sorted: number[]; // kept sorted for O(1) percentile reads
}

interface StageStats {
  count: number;
  totalMs: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  pctOfRuntime: number;
}

function sortedInsert(arr: number[], val: number): void {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < val) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, val);
}

function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.floor((sorted.length * pct) / 100) - 1);
  return sorted[Math.min(idx, sorted.length - 1)] ?? null;
}

export class JobProfiler {
  private readonly startMs: number = Date.now();
  private readonly startHr: bigint = process.hrtime.bigint();
  private stages: Map<string, StageSample> = new Map();
  private marks: Map<string, number> = new Map(); // name -> ms offset from start
  private pythonPerf: Record<string, unknown> = {};

  /** Start timing a stage. Call `.end()` when the stage completes. */
  timer(stage: string): { end: () => void } {
    const t0 = process.hrtime.bigint();
    return {
      end: () => {
        const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
        let entry = this.stages.get(stage);
        if (!entry) {
          entry = { totalMs: 0, count: 0, sorted: [] };
          this.stages.set(stage, entry);
        }
        entry.totalMs += elapsedMs;
        entry.count += 1;
        sortedInsert(entry.sorted, elapsedMs);
      },
    };
  }

  /** Directly record a pre-computed elapsed time for a stage (e.g. queue wait). */
  recordRaw(stage: string, elapsedMs: number): void {
    let entry = this.stages.get(stage);
    if (!entry) {
      entry = { totalMs: 0, count: 0, sorted: [] };
      this.stages.set(stage, entry);
    }
    entry.totalMs += elapsedMs;
    entry.count += 1;
    sortedInsert(entry.sorted, elapsedMs);
  }

  /** Record a single-point timestamp event (no duration). */
  mark(event: string): void {
    this.marks.set(event, Date.now() - this.startMs);
  }

  /** Store the __perf__ payload received from the Python subprocess. */
  attachPythonPerf(perf: Record<string, unknown>): void {
    this.pythonPerf = perf;
  }

  get totalElapsedMs(): number {
    return Number(process.hrtime.bigint() - this.startHr) / 1e6;
  }

  private stageStats(name: string): StageStats {
    const s = this.stages.get(name);
    const totalRuntime = this.totalElapsedMs;
    if (!s || s.count === 0) {
      return {
        count: 0, totalMs: 0, avgMs: null, minMs: null, maxMs: null,
        p50Ms: null, p90Ms: null, p99Ms: null, pctOfRuntime: 0,
      };
    }
    return {
      count: s.count,
      totalMs: s.totalMs,
      avgMs: s.totalMs / s.count,
      minMs: s.sorted[0] ?? null,
      maxMs: s.sorted[s.sorted.length - 1] ?? null,
      p50Ms: percentile(s.sorted, 50),
      p90Ms: percentile(s.sorted, 90),
      p99Ms: percentile(s.sorted, 99),
      pctOfRuntime: totalRuntime > 0 ? (s.totalMs / totalRuntime) * 100 : 0,
    };
  }

  /** Full structured summary — merged with Python perf if available. */
  summary(): Record<string, unknown> {
    const totalMs = this.totalElapsedMs;
    const stages: Record<string, unknown> = {};
    for (const [name] of this.stages) {
      stages[name] = this.stageStats(name);
    }
    return {
      ts_side: {
        run_total_ms: Math.round(totalMs),
        marks: Object.fromEntries(this.marks),
        stages,
      },
      python_side: this.pythonPerf,
    };
  }

  /**
   * Print one concise report to console.
   * Python-side details (stage breakdown, rejection breakdown) come from pythonPerf
   * which was already printed by the Python profiler to stderr — we only print
   * the TS-side timings here to avoid redundancy.
   */
  printReport(opts: {
    query: string;
    city: string;
    delivered: number;
    requested: number;
    queueWaitMs?: number;
    spawnMs?: number;
    firstLineMs?: number;
    firstLeadMs?: number;
  }): void {
    const totalS = (this.totalElapsedMs / 1000).toFixed(1);
    const W = 70;
    const bar = "═".repeat(W);

    const lines: string[] = [
      "",
      bar,
      `  TS WORKER REPORT  |  ${opts.query} / ${opts.city}`.padEnd(W),
      `  Job total: ${totalS}s   Leads delivered: ${opts.delivered}/${opts.requested}`,
    ];

    if (opts.queueWaitMs !== undefined) {
      lines.push(`  Queue wait: ${(opts.queueWaitMs / 1000).toFixed(2)}s   ` +
        `Python spawn: ${opts.spawnMs !== undefined ? (opts.spawnMs / 1000).toFixed(2) + "s" : "n/a"}   ` +
        `First line: ${opts.firstLineMs !== undefined ? (opts.firstLineMs / 1000).toFixed(2) + "s" : "n/a"}   ` +
        `First lead: ${opts.firstLeadMs !== undefined ? (opts.firstLeadMs / 1000).toFixed(2) + "s" : "n/a"}`);
    }

    lines.push("");
    lines.push("  TS STAGE BREAKDOWN  (ranked slowest → fastest)");
    lines.push("");
    lines.push(`  ${"#".padEnd(4)}${"Stage".padEnd(26)}${"Calls".padStart(6)}${"Total".padStart(9)}${"Avg".padStart(9)}${"P50".padStart(9)}${"P90".padStart(9)}${"P99".padStart(9)}${"  %".padStart(6)}`);
    lines.push("  " + "─".repeat(W - 2));

    const ranked = [...this.stages.entries()]
      .map(([name]) => ({ name, stats: this.stageStats(name) }))
      .filter((e) => e.stats.count > 0)
      .sort((a, b) => b.stats.totalMs - a.stats.totalMs);

    const fmt = (ms: number | null) =>
      ms === null ? "   —  " : `${(ms / 1000).toFixed(2)}s`;

    ranked.forEach(({ name, stats }, i) => {
      lines.push(
        `  ${String(i + 1).padEnd(4)}` +
        `${name.substring(0, 25).padEnd(26)}` +
        `${String(stats.count).padStart(6)}` +
        `  ${fmt(stats.totalMs)}` +
        `  ${fmt(stats.avgMs)}` +
        `  ${fmt(stats.p50Ms)}` +
        `  ${fmt(stats.p90Ms)}` +
        `  ${fmt(stats.p99Ms)}` +
        `  ${stats.pctOfRuntime.toFixed(0).padStart(3)}%`,
      );
    });

    lines.push(bar, "");
    console.log(lines.join("\n"));
  }
}
