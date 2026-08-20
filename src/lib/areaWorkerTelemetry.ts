/**
 * PHASE 6B — real per-area-worker PID/memory footprint measurement.
 *
 * resourceCapacity.ts (Phase 6) measures the container's overall cgroup
 * budget once at worker startup and derives a safe area-worker ceiling
 * from it — but `PIDS_PER_AREA_WORKER` (the per-worker footprint that
 * ceiling divides by) is still a documented ESTIMATE (220), not a real
 * measurement. This module records the actual cgroup `pids.current` /
 * `memory.current` counters at three points in a single area worker's
 * lifecycle:
 *
 *   before_start  — immediately before the Python subprocess is spawned
 *   after_start    — once the browser is up and the first real result has
 *                     come back over the stdout protocol (the earliest
 *                     point this codebase can observe "browser fully
 *                     initialized" without adding a new Python-side IPC
 *                     event — see pythonBridge.ts's existing
 *                     firstLineMs/firstLeadMs probes, which this reuses)
 *   after_cleanup  — once the child process has actually exited (browser
 *                     torn down, no longer holding any PIDs)
 *
 * and turns the before/after_start delta into `peak_pid_delta_per_area` /
 * `peak_memory_delta_per_area` — the real number PIDS_PER_AREA_WORKER
 * should eventually be set from, plus a safety margin, once someone reads
 * these numbers off a real Railway deployment. This module only RECORDS;
 * it never writes back into env.PIDS_PER_AREA_WORKER itself — changing
 * that default requires a human decision informed by this data, not an
 * automatic feedback loop (see the phase prompt: "DO NOT increase
 * production concurrency yet").
 *
 * IMPORTANT — measurement validity: a peak_pid_delta_per_area figure is
 * only a clean single-worker measurement when exactly one area worker is
 * active for its whole lifecycle. If a second area worker starts while the
 * first is still running, the delta observed by either of them also
 * includes the other's footprint and is no longer a clean per-worker
 * number. This module does not prevent concurrent area workers (that's a
 * pool-sizing decision made elsewhere — see resourceCapacity.ts /
 * googleAreaPool.ts) — it only detects the overlap and flags every sample
 * recorded during it as `concurrent: true` so a human reading the log (or
 * `getAreaWorkerTelemetrySummary()`) can discard contaminated samples
 * instead of silently averaging them in.
 */
import { snapshotResourceUsage, type ResourceUsageSnapshot } from "./resourceCapacity.js";

export type AreaLifecyclePhase = "before_start" | "after_start" | "after_cleanup";

export type AreaLifecycleSample = {
  runId: string;
  area: string | undefined;
  phase: AreaLifecyclePhase;
  snapshot: ResourceUsageSnapshot;
  /** True if >1 area worker's lifecycle was in flight when this sample was taken — see module doc comment. */
  concurrent: boolean;
};

export type AreaWorkerDelta = {
  runId: string;
  area: string | undefined;
  /** pids.current(after_start) - pids.current(before_start); null if either snapshot is unreadable. */
  pidDelta: number | null;
  /** memory.current MB(after_start) - memory.current MB(before_start); null if either snapshot is unreadable. */
  memoryDeltaMb: number | null;
  /** True if this delta was measured while >1 area worker was concurrently active — NOT a clean single-worker measurement. */
  concurrent: boolean;
};

// Process-wide bookkeeping. `activeRuns` tracks lifecycles currently
// between before_start and after_cleanup, purely to detect overlap for the
// `concurrent` flag above — it is not used for any scheduling decision.
const activeRuns = new Set<string>();
const startedSnapshots = new Map<string, ResourceUsageSnapshot>();
const samples: AreaLifecycleSample[] = [];
const deltas: AreaWorkerDelta[] = [];

let runCounter = 0;
export function newAreaRunId(): string {
  runCounter += 1;
  return `area-run-${process.pid}-${runCounter}-${Date.now()}`;
}

function record(runId: string, area: string | undefined, phase: AreaLifecyclePhase): ResourceUsageSnapshot {
  const snapshot = snapshotResourceUsage();
  const concurrent = phase === "before_start" ? activeRuns.size > 0 : activeRuns.size > 1;
  samples.push({ runId, area, phase, snapshot, concurrent });
  console.log(
    `[areaWorkerTelemetry] runId=${runId} area=${area ?? "n/a"} phase=${phase} ` +
      `pidsCurrent=${snapshot.pidsCurrent ?? "unknown"} memoryCurrentMb=${snapshot.memoryCurrentMb?.toFixed(1) ?? "unknown"} ` +
      `concurrentAreaWorkers=${activeRuns.size}${concurrent ? " (MEASUREMENT CONTAMINATED — not a clean single-worker sample)" : ""}`,
  );
  return snapshot;
}

/** Call immediately before spawning the area worker's subprocess. */
export function recordBeforeAreaStart(runId: string, area: string | undefined): void {
  activeRuns.add(runId);
  const snapshot = record(runId, area, "before_start");
  startedSnapshots.set(runId, snapshot);
}

/**
 * Call once the browser is fully initialized — in practice, the first
 * genuine lead/result line received over stdout (see module doc comment).
 * Safe to call more than once per run; only the FIRST call is recorded, so
 * callers that don't independently guard against duplicate first-lead
 * events don't need to.
 */
const afterStartRecorded = new Set<string>();
export function recordAfterAreaStart(runId: string, area: string | undefined): void {
  if (afterStartRecorded.has(runId)) return;
  afterStartRecorded.add(runId);
  const before = startedSnapshots.get(runId);
  const after = record(runId, area, "after_start");

  if (!before) return; // recordBeforeAreaStart() was never called for this runId — nothing to diff against
  const pidDelta = before.pidsCurrent !== null && after.pidsCurrent !== null ? after.pidsCurrent - before.pidsCurrent : null;
  const memoryDeltaMb =
    before.memoryCurrentMb !== null && after.memoryCurrentMb !== null ? after.memoryCurrentMb - before.memoryCurrentMb : null;
  const concurrent = activeRuns.size > 1;
  deltas.push({ runId, area, pidDelta, memoryDeltaMb, concurrent });
  console.log(
    `[areaWorkerTelemetry] runId=${runId} area=${area ?? "n/a"} peak_pid_delta_per_area=${pidDelta ?? "unknown"} ` +
      `peak_memory_delta_per_area_mb=${memoryDeltaMb?.toFixed(1) ?? "unknown"}${concurrent ? " (MEASUREMENT CONTAMINATED)" : ""}`,
  );
}

/** Call once the area worker's subprocess has actually exited (post-cleanup). */
export function recordAfterAreaCleanup(runId: string, area: string | undefined): void {
  record(runId, area, "after_cleanup");
  activeRuns.delete(runId);
  startedSnapshots.delete(runId);
  afterStartRecorded.delete(runId);
}

export type AreaWorkerTelemetrySummary = {
  sampleCount: number;
  /** Only deltas measured with exactly one active area worker (concurrent === false). */
  cleanDeltas: AreaWorkerDelta[];
  contaminatedDeltaCount: number;
  peakPidDeltaPerArea: number | null;
  peakMemoryDeltaPerAreaMb: number | null;
};

/**
 * Summarizes every before_start→after_start delta recorded so far,
 * restricted to CLEAN (single-worker) samples — see module doc comment.
 * `peakPidDeltaPerArea` / `peakMemoryDeltaPerAreaMb` are the max observed
 * clean delta, which is the conservative figure to feed into
 * PIDS_PER_AREA_WORKER (plus additional safety margin on top).
 */
export function getAreaWorkerTelemetrySummary(): AreaWorkerTelemetrySummary {
  const cleanDeltas = deltas.filter((d) => !d.concurrent);
  const contaminatedDeltaCount = deltas.length - cleanDeltas.length;
  const pidValues = cleanDeltas.map((d) => d.pidDelta).filter((v): v is number => v !== null);
  const memValues = cleanDeltas.map((d) => d.memoryDeltaMb).filter((v): v is number => v !== null);
  return {
    sampleCount: samples.length,
    cleanDeltas,
    contaminatedDeltaCount,
    peakPidDeltaPerArea: pidValues.length > 0 ? Math.max(...pidValues) : null,
    peakMemoryDeltaPerAreaMb: memValues.length > 0 ? Math.max(...memValues) : null,
  };
}

export const __testing_areaWorkerTelemetry = {
  reset: () => {
    activeRuns.clear();
    startedSnapshots.clear();
    afterStartRecorded.clear();
    samples.length = 0;
    deltas.length = 0;
    runCounter = 0;
  },
};
