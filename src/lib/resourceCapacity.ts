/**
 * Phase 6 — Throughput Scaling / Safe Multi-Area Concurrency.
 *
 * TASK 1/TASK 3 implementation: `browserSlots` (workerCapacity.ts) is a
 * MEMORY-ONLY estimate — free RAM divided by an estimated per-browser MB
 * footprint. It says nothing about PID or OS-thread capacity, and the old
 * production evidence (93 GB free / ~266 browserSlots, yet
 * `safeResourceWorkers` hardcoded to 2, with "can't start new thread" /
 * "pthread_create: Resource temporarily unavailable" observed at
 * concurrency 3 during earlier development) is exactly what you would see
 * if PIDs/threads — not memory — are the real ceiling on this container.
 *
 * TASK 2 (thread exhaustion trace), as found in this codebase's own code,
 * not guessed:
 *   • engine/execution_driver.py: ExecutionDriver.start() spawns one
 *     "mast-execution-driver" thread; _ensure_producers_started() spawns
 *     one additional thread per producer stage (Discovery, today: one).
 *     => >= 2 Python-level threads per area worker's subprocess.
 *   • providers/parallel_composite_provider.py: one
 *     "parallel-discovery-<provider_id>" thread per wrapped provider
 *     streamed concurrently.
 *   • Playwright's Python client launches its own Node.js driver process
 *     per browser context, itself multi-threaded.
 *   • Chromium, launched by that driver, is a full multi-process tree
 *     (browser/main, zygote, GPU, one-or-more renderer, network/utility),
 *     each of which is independently multi-threaded.
 *   • src/scraperBridge/pythonBridge.ts spawn()s exactly one `python3
 *     service.py` OS process per area worker (one runOneAreaAttempt() call
 *     == one fresh subprocess, per googleAreaPool.ts's own doc comment:
 *     "a fresh service.py / MapsScraper / Playwright / Chromium process per
 *     area, never a shared or reused browser").
 *
 * Linux's `pids` cgroup controller (the one that actually produced
 * "pthread_create: Resource temporarily unavailable" once its ceiling was
 * hit) counts EVERY task_struct against pids.max — that includes every one
 * of the OS threads above, not just top-level processes. So the real
 * concurrency ceiling for area workers is:
 *
 *   safePidWorkers = floor((pids.max - pids.current - reserve) / pidsPerAreaWorker)
 *
 * measured from the real cgroup, not assumed from memory headroom alone.
 * This module measures that once at worker startup (mirroring
 * workerCapacity.ts's measureBrowserCapacity()) and exposes it as a
 * process-wide singleton (mirroring browserSlotPool.ts's own
 * init/get pattern) so discoveryPlanJob.ts / poolExpandJob.ts can read a
 * genuinely resource-aware `safeResourceWorkers` instead of the old
 * hardcoded constant.
 */
import fs from "node:fs";
import { env } from "../config/env.js";
import { createBrowserSlotPool, type BrowserSlotPool } from "./browserSlotPool.js";

export type CgroupVersion = "v2" | "v1" | "unavailable";

export type PidCapacitySnapshot = {
  cgroupVersion: CgroupVersion;
  /** null means "max"/unlimited as reported by the cgroup, or unreadable. */
  pidsMax: number | null;
  /** null means unreadable. */
  pidsCurrent: number | null;
};

/**
 * PHASE 6B — a single point-in-time reading of the cgroup counters this
 * phase is auditing, plus a wall-clock timestamp. Used both for the
 * one-time startup snapshot and for the repeated before/after/after-cleanup
 * samples taken around a single area worker's lifecycle (see
 * areaWorkerTelemetry.ts). Deliberately the SAME two counters
 * (pids.current, memory.current) at every call site so before/after deltas
 * are always comparing like with like.
 */
export type ResourceUsageSnapshot = {
  atMs: number;
  pidsCurrent: number | null;
  memoryCurrentMb: number | null;
};

/**
 * PHASE 6B — reads live cgroup PID/memory usage (`pids.current`,
 * `memory.current`) at the moment of the call. Cheap synchronous file
 * reads, safe to call at high frequency (once per area-worker lifecycle
 * point). Never throws; unreadable counters come back as `null` so a
 * caller can distinguish "genuinely zero" from "couldn't measure" — same
 * convention as the rest of this module.
 */
export function snapshotResourceUsage(): ResourceUsageSnapshot {
  return {
    atMs: Date.now(),
    pidsCurrent: readPidCapacity().pidsCurrent,
    memoryCurrentMb: readCgroupMemoryCurrentMb(),
  };
}

function readIntFile(path: string): number | null {
  try {
    const raw = fs.readFileSync(path, "utf8").trim();
    if (raw === "max" || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * TASK 1 — reads the real cgroup PID accounting for this container.
 * Tries cgroup v2's unified hierarchy first, falls back to cgroup v1's
 * `pids` controller, and reports `"unavailable"` (never throws, never
 * fabricates a number) when neither exists — e.g. a non-Linux dev machine,
 * or a host without the pids controller enabled.
 */
export function readPidCapacity(): PidCapacitySnapshot {
  if (fs.existsSync("/sys/fs/cgroup/pids.max")) {
    return {
      cgroupVersion: "v2",
      pidsMax: readIntFile("/sys/fs/cgroup/pids.max"),
      pidsCurrent: readIntFile("/sys/fs/cgroup/pids.current"),
    };
  }
  if (fs.existsSync("/sys/fs/cgroup/pids/pids.max")) {
    return {
      cgroupVersion: "v1",
      pidsMax: readIntFile("/sys/fs/cgroup/pids/pids.max"),
      pidsCurrent: readIntFile("/sys/fs/cgroup/pids/pids.current"),
    };
  }
  return { cgroupVersion: "unavailable", pidsMax: null, pidsCurrent: null };
}

/**
 * TASK 1 — cgroup MEMORY limit, as a cross-check against `os.freemem()` /
 * `os.totalmem()` (workerCapacity.ts). In a container, `os.freemem()`
 * reports HOST free memory, not the cgroup's memory.max — a well-known
 * Node/container gotcha that can make a tightly-limited container look
 * like it has enormous headroom (matching the "free memory ≈ 93 GB" /
 * "browserSlots ≈ 266" production evidence this phase is auditing).
 * Returns null when unreadable or reported as unlimited.
 */
export function readCgroupMemoryLimitMb(): number | null {
  const v2 = readIntFile("/sys/fs/cgroup/memory.max");
  if (v2 !== null) return v2 / 1024 / 1024;
  const v1 = readIntFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  // cgroup v1 reports a huge sentinel (close to LONG_MAX) for "unlimited"
  // rather than a literal "max" string — treat anything over ~1 PB as
  // unlimited/unset rather than a real limit.
  if (v1 !== null && v1 < 1e15) return v1 / 1024 / 1024;
  return null;
}

/**
 * PHASE 6B — cgroup `memory.current` (the LIVE usage counter), as opposed
 * to `readCgroupMemoryLimitMb()` above which reads `memory.max` (the
 * ceiling). Needed for the same reason `pids.current` is read alongside
 * `pids.max`: a limit alone says nothing about how much headroom is
 * actually left, or how much one area worker's lifecycle actually
 * consumed. Same v2-first/v1-fallback/never-throws contract as the rest of
 * this module.
 */
export function readCgroupMemoryCurrentMb(): number | null {
  const v2 = readIntFile("/sys/fs/cgroup/memory.current");
  if (v2 !== null) return v2 / 1024 / 1024;
  const v1 = readIntFile("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1 !== null && v1 < 1e15) return v1 / 1024 / 1024;
  return null;
}

/**
 * PHASE 6B — Node process/thread count, read from `/proc/self/status`'s
 * `Threads:` line. This counts OS-level threads of THIS Node process only
 * (not child processes) — a cross-check alongside pids.current, since a
 * single Node process with libuv's threadpool + GC threads etc. already
 * consumes several of the pids-cgroup's budget before any Python/Chromium
 * subprocess is spawned. Returns null on non-Linux or if unreadable —
 * never throws, never fabricates a number.
 */
export function readNodeThreadCount(): number | null {
  try {
    const raw = fs.readFileSync("/proc/self/status", "utf8");
    const match = raw.match(/^Threads:\s*(\d+)/m);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export type PidCeilingBasis = "measured" | "fallback_unavailable";

/**
 * TASK 3 — pure arithmetic: derives a safe area-worker ceiling from real
 * PID accounting. Exported standalone (no fs/env access) so it is fully
 * unit-testable against fabricated cgroup snapshots, matching this
 * codebase's existing pure/DB-split convention (see browserSlotPool.ts /
 * googleAreaPool.ts's own doc comments for the same split).
 *
 * `pidsMax === null` means PID accounting is genuinely unavailable (not
 * "unlimited") — this NEVER degrades to an unbounded ceiling; it falls
 * back to `fallbackCeiling` (the previously-validated known-safe constant)
 * because "we can't measure it" is not the same claim as "it's safe".
 */
export function computeSafePidWorkerCeiling(
  pidsMax: number | null,
  pidsCurrent: number | null,
  pidsPerAreaWorker: number,
  reservePids: number,
  fallbackCeiling: number,
): { ceiling: number; basis: PidCeilingBasis } {
  if (pidsMax === null) {
    return { ceiling: Math.max(1, Math.floor(fallbackCeiling)), basis: "fallback_unavailable" };
  }
  const baseline = pidsCurrent ?? 0;
  const budget = Math.max(0, pidsMax - baseline - reservePids);
  const ceiling = Math.max(0, Math.floor(budget / Math.max(1, pidsPerAreaWorker)));
  return { ceiling, basis: "measured" };
}

export type ComputeSafeResourceCapacityParams = {
  pidsMax: number | null;
  pidsCurrent: number | null;
  pidsPerAreaWorker: number;
  reservePids: number;
  fallbackCeiling: number;
  cgroupMemoryLimitMb?: number | null;
  cgroupMemoryCurrentMb?: number | null;
  perBrowserMb?: number;
  reserveMemoryMb?: number;
  configuredCeiling?: number;
  manualCap?: number;
};

export type SafeResourceCapacityResult = {
  pidWorkerCeiling: number;
  pidCeilingBasis: PidCeilingBasis;
  cgroupMemoryWorkerCeiling: number | null;
  rawResourceCeiling: number;
  safeAreaWorkers: number;
};

/**
 * Pure arithmetic resource capacity model (Phase 16).
 * Combines measured PID budget and cgroup memory headroom into a single
 * safe, conservative ceiling while respecting configured ceilings and manual caps.
 */
export function computeSafeResourceCapacity(params: ComputeSafeResourceCapacityParams): SafeResourceCapacityResult {
  const {
    pidsMax,
    pidsCurrent,
    pidsPerAreaWorker,
    reservePids,
    fallbackCeiling,
    cgroupMemoryLimitMb = null,
    cgroupMemoryCurrentMb = null,
    perBrowserMb = 350,
    reserveMemoryMb = 256,
    configuredCeiling = Number.MAX_SAFE_INTEGER,
    manualCap,
  } = params;

  const { ceiling: pidWorkerCeiling, basis: pidCeilingBasis } = computeSafePidWorkerCeiling(
    pidsMax,
    pidsCurrent,
    pidsPerAreaWorker,
    reservePids,
    fallbackCeiling,
  );

  let cgroupMemoryWorkerCeiling: number | null = null;
  if (cgroupMemoryLimitMb !== null && cgroupMemoryLimitMb !== undefined) {
    const baselineMem = cgroupMemoryCurrentMb ?? 0;
    const memBudget = Math.max(0, cgroupMemoryLimitMb - baselineMem - reserveMemoryMb);
    cgroupMemoryWorkerCeiling = Math.max(0, Math.floor(memBudget / Math.max(1, perBrowserMb)));
  }

  const rawResourceCeiling =
    cgroupMemoryWorkerCeiling !== null
      ? Math.min(pidWorkerCeiling, cgroupMemoryWorkerCeiling)
      : pidWorkerCeiling;

  const safeAreaWorkers = Math.min(
    configuredCeiling,
    rawResourceCeiling,
    manualCap ?? rawResourceCeiling,
  );

  return {
    pidWorkerCeiling,
    pidCeilingBasis,
    cgroupMemoryWorkerCeiling,
    rawResourceCeiling,
    safeAreaWorkers,
  };
}

export type ResourceCapacity = {
  pidCapacity: PidCapacitySnapshot;
  cgroupMemoryLimitMb: number | null;
  /** PHASE 6B — cgroup memory.current at the moment this was measured (startup). */
  cgroupMemoryCurrentMb: number | null;
  /** PHASE 16 — cgroup memory ceiling in workers (null if unconstrained / non-cgroup). */
  cgroupMemoryWorkerCeiling: number | null;
  /** PHASE 6B — this Node worker process's own PID. */
  nodePid: number;
  /** PHASE 6B — this Node worker process's own OS thread count (null if unreadable / non-Linux). */
  nodeThreadCount: number | null;
  pidsPerAreaWorker: number;
  reservePids: number;
  /** Ceiling derived purely from PID/thread accounting (before folding in memory or configured/env ceiling). */
  pidWorkerCeiling: number;
  pidCeilingBasis: PidCeilingBasis;
  /** Final safe area-worker count: min(configuredCeiling, rawResourceCeiling, manualCap ?? rawResourceCeiling). */
  safeAreaWorkers: number;
};

/**
 * TASK 1 + TASK 3 — measures this worker process's real PID/thread and memory budget
 * once at startup and folds it together with the configured area-worker
 * ceiling into a single deterministic, observable number. Mirrors
 * workerCapacity.ts's `measureBrowserCapacity()` in shape and logging so
 * ops can read both from the same startup log line format.
 *
 * Clamped to a minimum of 1 (same reasoning as browserSlotPool.ts /
 * measureBrowserCapacity's own `Math.max(1, ...)` clamps) so a
 * pathologically constrained container still processes one area at a time
 * instead of deadlocking at a computed ceiling of 0.
 */
export function measureResourceCapacity(configuredCeiling: number): ResourceCapacity {
  const pidCapacity = readPidCapacity();
  const cgroupMemoryLimitMb = readCgroupMemoryLimitMb();
  const cgroupMemoryCurrentMb = readCgroupMemoryCurrentMb();
  const nodePid = process.pid;
  const nodeThreadCount = readNodeThreadCount();

  const computed = computeSafeResourceCapacity({
    pidsMax: pidCapacity.pidsMax,
    pidsCurrent: pidCapacity.pidsCurrent,
    pidsPerAreaWorker: env.PIDS_PER_AREA_WORKER,
    reservePids: env.PIDS_RESERVE_BUDGET,
    fallbackCeiling: env.GOOGLE_MAPS_SAFE_RESOURCE_WORKERS_FALLBACK,
    cgroupMemoryLimitMb,
    cgroupMemoryCurrentMb,
    perBrowserMb: env.BROWSER_MEMORY_ESTIMATE_MB,
    reserveMemoryMb: env.WORKER_MEMORY_RESERVE_MB,
    configuredCeiling,
    manualCap: env.GOOGLE_MAPS_SAFE_RESOURCE_WORKERS,
  });

  console.log(
    `[resourceCapacity] cgroup=${pidCapacity.cgroupVersion} nodePid=${nodePid} nodeThreads=${nodeThreadCount ?? "unknown"} ` +
      `pidsMax=${pidCapacity.pidsMax ?? "unlimited/unknown"} pidsCurrent=${pidCapacity.pidsCurrent ?? "unknown"} ` +
      `cgroupMemLimitMb=${cgroupMemoryLimitMb ?? "unknown"} cgroupMemCurrentMb=${cgroupMemoryCurrentMb?.toFixed(1) ?? "unknown"} ` +
      `cgroupMemWorkerCeiling=${computed.cgroupMemoryWorkerCeiling ?? "unconstrained"} ` +
      `pidsPerAreaWorker=${env.PIDS_PER_AREA_WORKER} reservePids=${env.PIDS_RESERVE_BUDGET} ` +
      `basis=${computed.pidCeilingBasis} pidWorkerCeiling=${computed.pidWorkerCeiling} ` +
      `configuredCeiling=${configuredCeiling} manualCap=${env.GOOGLE_MAPS_SAFE_RESOURCE_WORKERS ?? "unset"} ` +
      `safeAreaWorkers=${computed.safeAreaWorkers}`,
  );

  return {
    pidCapacity,
    cgroupMemoryLimitMb,
    cgroupMemoryCurrentMb,
    cgroupMemoryWorkerCeiling: computed.cgroupMemoryWorkerCeiling,
    nodePid,
    nodeThreadCount,
    pidsPerAreaWorker: env.PIDS_PER_AREA_WORKER,
    reservePids: env.PIDS_RESERVE_BUDGET,
    pidWorkerCeiling: computed.pidWorkerCeiling,
    pidCeilingBasis: computed.pidCeilingBasis,
    safeAreaWorkers: computed.safeAreaWorkers,
  };
}

/**
 * PHASE 6B — one consolidated startup telemetry line covering everything
 * this phase's measurement task asks for in one place: the raw cgroup
 * counters, this Node process's own PID/thread count, the configured
 * area-worker ceiling, the memory-derived browser-slot capacity
 * (workerCapacity.ts's measureBrowserCapacity(), measured separately —
 * kept as a caller-supplied number here rather than importing
 * workerCapacity.ts, to avoid a circular import between the two capacity
 * modules), and the final computed safe resource-worker count. Purely a
 * logging convenience over `ResourceCapacity` — computes nothing new.
 */
export function logStartupResourceTelemetry(capacity: ResourceCapacity, browserSlots: number, configuredAreaWorkers: number): void {
  console.log(
    `[resourceCapacity][startup] nodePid=${capacity.nodePid} nodeThreads=${capacity.nodeThreadCount ?? "unknown"} ` +
      `pidsMax=${capacity.pidCapacity.pidsMax ?? "unlimited/unknown"} pidsCurrent=${capacity.pidCapacity.pidsCurrent ?? "unknown"} ` +
      `memoryMaxMb=${capacity.cgroupMemoryLimitMb?.toFixed(1) ?? "unknown"} memoryCurrentMb=${capacity.cgroupMemoryCurrentMb?.toFixed(1) ?? "unknown"} ` +
      `memoryWorkerCeiling=${capacity.cgroupMemoryWorkerCeiling ?? "unconstrained"} ` +
      `configuredAreaWorkerCeiling=${configuredAreaWorkers} browserSlots=${browserSlots} ` +
      `computedSafeResourceWorkers=${capacity.safeAreaWorkers} (basis=${capacity.pidCeilingBasis})`,
  );
}

/**
 * Process-wide singleton, set once at startup by workers/index.ts right
 * after `measureResourceCapacity()`. `undefined` until then, mirroring
 * browserSlotPool.ts's own init/get pattern — any code path that races
 * startup fails SAFE (see `getResourceCapacity()` below), not open.
 */
let processResourceCapacity: ResourceCapacity | undefined;

export function initResourceCapacity(configuredCeiling: number): ResourceCapacity {
  processResourceCapacity = measureResourceCapacity(configuredCeiling);
  return processResourceCapacity;
}

/**
 * Returns the process-wide measured resource capacity, falling back to the
 * previously-validated known-safe constant (GOOGLE_MAPS_SAFE_RESOURCE_WORKERS_FALLBACK,
 * default 2) if `initResourceCapacity()` was never called — e.g. in tests,
 * or a code path that runs before worker startup completes. Never throws;
 * a missing measurement must fail SAFE (low, known-good concurrency), not
 * fail open (unbounded area workers).
 */
export function getResourceCapacity(): ResourceCapacity {
  if (!processResourceCapacity) {
    console.warn("[resourceCapacity] getResourceCapacity() called before initResourceCapacity() — falling back to the known-safe constant");
    const fallback = env.GOOGLE_MAPS_SAFE_RESOURCE_WORKERS_FALLBACK;
    processResourceCapacity = {
      pidCapacity: { cgroupVersion: "unavailable", pidsMax: null, pidsCurrent: null },
      cgroupMemoryLimitMb: null,
      cgroupMemoryCurrentMb: null,
      cgroupMemoryWorkerCeiling: null,
      nodePid: process.pid,
      nodeThreadCount: readNodeThreadCount(),
      pidsPerAreaWorker: env.PIDS_PER_AREA_WORKER,
      reservePids: env.PIDS_RESERVE_BUDGET,
      pidWorkerCeiling: fallback,
      pidCeilingBasis: "fallback_unavailable",
      safeAreaWorkers: fallback,
    };
  }
  return processResourceCapacity;
}

export const __testing_resourceCapacity = {
  reset: () => { processResourceCapacity = undefined; },
  set: (capacity: ResourceCapacity) => { processResourceCapacity = capacity; },
};

/**
 * PHASE 42A — ROOT-CAUSE FIX for "RuntimeError: can't start new thread" in
 * production (pids.current ~855, concurrentAreaWorkers observed at 9-10
 * despite `effectiveWorkers=3`).
 *
 * `safeAreaWorkers` above (ResourceCapacity) is a STATIC number, measured
 * ONCE at process startup. Until this fix, `poolExpandJob.ts` and
 * `discoveryPlanJob.ts` each read that static number directly
 * (`getResourceCapacity().safeAreaWorkers`) and used it only as one of
 * several `Math.min()` terms in `computeAreaPoolSize()` /
 * `computeDynamicDiscoveryCapacity()` — i.e. as an upper bound each
 * individual `runAreaWorkerPool()` CALL applied to ITSELF. It was never a
 * shared, live-decrementing account of how many PID/thread-consuming area
 * workers are ACTUALLY running right now across every concurrent
 * invocation in this process.
 *
 * That is the exact lifecycle bug: this worker process can have many
 * `runAreaWorkerPool()` calls in flight at once — multiple `discoveryTask`
 * jobs processed concurrently via `processBatchConcurrently()`
 * (workers/index.ts, `batchSize: browserCapacity.effectiveConcurrency`),
 * and/or one or more `poolExpand` jobs running alongside them (a separate
 * queue, same process) — and EACH ONE independently computed its own
 * "safe" pool size using the SAME static `safeAreaWorkers` ceiling (e.g.
 * 3), then started that many area workers. Three concurrently-running
 * discovery jobs each independently deciding "I can safely run 3 area
 * workers" is how `effectiveWorkers=3` in the logs coexists with 9
 * concurrent area workers (and their Python subprocesses/threads) actually
 * running — exactly the `concurrentAreaWorkers=9/10` telemetry from
 * production. `browserSlotPool.ts` already solved this exact class of bug
 * for MEMORY (a real, shared, atomically-decrementing semaphore every
 * browser launch — legacy path and pooled path alike — acquires a slot
 * from before spawning); the PID/thread-derived ceiling never got the same
 * treatment, so it stayed correct in isolation but silently multiplied
 * under real concurrency.
 *
 * `createBrowserSlotPool()` is a pure, domain-agnostic counting semaphore
 * (capacity/tryAcquire/available/inUse — see browserSlotPool.ts's own doc
 * comment), so it is reused here verbatim rather than re-implementing the
 * same primitive a second time. `initResourceWorkerSlotPool()` is called
 * once at worker startup (workers/index.ts, immediately after
 * `initResourceCapacity()`) sized to the SAME measured `safeAreaWorkers`
 * ceiling; `getResourceWorkerSlotPool()` is then combined with the
 * existing browser slot pool at every `tryAcquireSlot()` call site
 * (poolExpandJob.ts, discoveryPlanJob.ts) so an area worker only starts
 * once BOTH a browser-memory slot AND a PID/thread-budget slot are
 * actually free right now, process-wide, across every concurrently-running
 * job — never a per-call static ceiling applied blind to sibling
 * invocations.
 */
let processResourceWorkerSlotPool: BrowserSlotPool | undefined;

export function initResourceWorkerSlotPool(capacity: number): BrowserSlotPool {
  processResourceWorkerSlotPool = createBrowserSlotPool(capacity);
  console.log(`[resourceCapacity] resourceWorkerSlotPool initialized capacity=${processResourceWorkerSlotPool.capacity}`);
  return processResourceWorkerSlotPool;
}

/**
 * Returns the process-wide PID/thread-budget slot pool, initializing a
 * single-slot fallback (serialize to one area worker at a time) if
 * `initResourceWorkerSlotPool()` was never called — e.g. in tests, or a
 * code path racing worker startup. Never throws; a missing pool must fail
 * SAFE (low, known-good concurrency), never fail open (unbounded area
 * workers) — same convention as `getResourceCapacity()` and
 * `getBrowserSlotPool()`.
 */
export function getResourceWorkerSlotPool(): BrowserSlotPool {
  if (!processResourceWorkerSlotPool) {
    console.warn("[resourceCapacity] getResourceWorkerSlotPool() called before initResourceWorkerSlotPool() — falling back to a single-slot pool");
    processResourceWorkerSlotPool = createBrowserSlotPool(1);
  }
  return processResourceWorkerSlotPool;
}

export const __testing_resourceWorkerSlotPool = {
  reset: () => { processResourceWorkerSlotPool = undefined; },
};

/**
 * PHASE 18 — resource-aware ENRICHMENT concurrency.
 *
 * Applies the exact same measured-PID-budget model this module already
 * uses for area workers (see the module docstring above and Phase 6's
 * `computeSafeResourceCapacity`) to the businessEnrich (Website+Contact)
 * and businessScore (Instagram) pg-boss queues in workers/index.ts —
 * NOT a second independent resource model, the same
 * `computeSafeResourceCapacity` pure function, called with an
 * enrichment-specific PID-per-worker assumption
 * (`env.ENRICHMENT_PIDS_PER_WORKER`, deliberately distinct from
 * `env.PIDS_PER_AREA_WORKER` — see that env var's own doc comment for
 * why the two are not interchangeable) instead of the area-worker one.
 *
 * `configuredCeiling` here is the TOTAL desired concurrency across BOTH
 * enrichment queues (`ENRICHMENT_TASK_CONCURRENCY +
 * INTELLIGENCE_TASK_CONCURRENCY`) — they are two independently-configured
 * pg-boss queues today (not one shared queue), but both run inside the
 * same worker process and both spawn the same kind of lightweight
 * `service.py enrich`/`service.py score` subprocess, so they compete for
 * the exact same measured PID budget. `splitEnrichmentCapacity` below is
 * what turns one combined safe ceiling back into two per-queue
 * `batchSize` values without letting either queue starve the other.
 */
export type EnrichmentCapacity = {
  pidCapacity: PidCapacitySnapshot;
  cgroupMemoryLimitMb: number | null;
  cgroupMemoryCurrentMb: number | null;
  cgroupMemoryWorkerCeiling: number | null;
  enrichmentPidsPerWorker: number;
  reservePids: number;
  pidWorkerCeiling: number;
  pidCeilingBasis: PidCeilingBasis;
  /** Combined businessEnrich + businessScore safe ceiling, before the per-queue split. */
  safeEnrichmentWorkers: number;
};

export function measureEnrichmentCapacity(configuredCeiling: number): EnrichmentCapacity {
  const pidCapacity = readPidCapacity();
  // Memory ceiling only participates when a real per-worker estimate has
  // been configured (see ENRICHMENT_MEMORY_MB_PER_WORKER's own doc
  // comment) — an unset value must leave the memory dimension
  // unconstrained, never silently assume some invented footprint.
  const cgroupMemoryLimitMb = env.ENRICHMENT_MEMORY_MB_PER_WORKER !== undefined ? readCgroupMemoryLimitMb() : null;
  const cgroupMemoryCurrentMb = cgroupMemoryLimitMb !== null ? readCgroupMemoryCurrentMb() : null;

  const computed = computeSafeResourceCapacity({
    pidsMax: pidCapacity.pidsMax,
    pidsCurrent: pidCapacity.pidsCurrent,
    pidsPerAreaWorker: env.ENRICHMENT_PIDS_PER_WORKER,
    reservePids: env.PIDS_RESERVE_BUDGET,
    fallbackCeiling: env.ENRICHMENT_SAFE_RESOURCE_WORKERS_FALLBACK,
    cgroupMemoryLimitMb,
    cgroupMemoryCurrentMb,
    perBrowserMb: env.ENRICHMENT_MEMORY_MB_PER_WORKER ?? 1,
    reserveMemoryMb: env.WORKER_MEMORY_RESERVE_MB,
    configuredCeiling,
    manualCap: env.ENRICHMENT_SAFE_RESOURCE_WORKERS,
  });

  console.log(
    `[resourceCapacity][enrichment] cgroup=${pidCapacity.cgroupVersion} ` +
      `pidsMax=${pidCapacity.pidsMax ?? "unlimited/unknown"} pidsCurrent=${pidCapacity.pidsCurrent ?? "unknown"} ` +
      `memoryMaxMb=${cgroupMemoryLimitMb ?? "unconstrained"} memoryCurrentMb=${cgroupMemoryCurrentMb?.toFixed(1) ?? "unconstrained"} ` +
      `memoryWorkerCeiling=${computed.cgroupMemoryWorkerCeiling ?? "unconstrained"} ` +
      `enrichmentPidsPerWorker=${env.ENRICHMENT_PIDS_PER_WORKER} reservePids=${env.PIDS_RESERVE_BUDGET} ` +
      `basis=${computed.pidCeilingBasis} pidWorkerCeiling=${computed.pidWorkerCeiling} ` +
      `enrichment_configured_concurrency=${configuredCeiling} manualCap=${env.ENRICHMENT_SAFE_RESOURCE_WORKERS ?? "unset"} ` +
      `enrichment_safe_resource_concurrency=${computed.safeAreaWorkers}`,
  );

  return {
    pidCapacity,
    cgroupMemoryLimitMb,
    cgroupMemoryCurrentMb,
    cgroupMemoryWorkerCeiling: computed.cgroupMemoryWorkerCeiling,
    enrichmentPidsPerWorker: env.ENRICHMENT_PIDS_PER_WORKER,
    reservePids: env.PIDS_RESERVE_BUDGET,
    pidWorkerCeiling: computed.pidWorkerCeiling,
    pidCeilingBasis: computed.pidCeilingBasis,
    safeEnrichmentWorkers: computed.safeAreaWorkers,
  };
}

/**
 * PHASE 18, STEP 4/5 — turns one combined safe enrichment ceiling back
 * into two independent per-queue `batchSize` values (businessEnrich,
 * businessScore) without merging the two pg-boss queues into one (the
 * smallest change preserving today's queue architecture — see
 * workers/index.ts) and without letting either stage starve the other.
 *
 * Pure arithmetic, unit-testable on its own: allocates the combined
 * `safeTotal` proportionally to each queue's OWN configured desire
 * (`enrichConfigured` covers Website+Contact, `intelligenceConfigured`
 * covers Instagram), floors each share, and hands any leftover unit (from
 * flooring) to whichever queue's exact share was larger — so the two
 * outputs always sum to `min(safeTotal, enrichConfigured +
 * intelligenceConfigured)`, never more, and never less than that sum
 * would allow. Never forces either output above 0 back to 1 — a
 * genuinely zero combined ceiling produces two zero shares (STEP 6).
 */
export function splitEnrichmentCapacity(
  safeTotal: number,
  enrichConfigured: number,
  intelligenceConfigured: number,
): { enrichConcurrency: number; intelligenceConcurrency: number } {
  const totalConfigured = enrichConfigured + intelligenceConfigured;
  if (safeTotal <= 0 || totalConfigured <= 0) {
    return { enrichConcurrency: 0, intelligenceConcurrency: 0 };
  }

  const capped = Math.min(safeTotal, totalConfigured);
  const enrichShareExact = (capped * enrichConfigured) / totalConfigured;
  const intelligenceShareExact = capped - enrichShareExact;

  let enrichConcurrency = Math.min(enrichConfigured, Math.floor(enrichShareExact));
  let intelligenceConcurrency = Math.min(intelligenceConfigured, Math.floor(intelligenceShareExact));

  // Hand any leftover (lost to flooring, or headroom either individual
  // queue cap didn't use) to whichever queue still has room under its own
  // configured ceiling, preferring the larger fractional remainder first
  // — deterministic tie-break, no starvation of the smaller queue.
  let leftover = capped - enrichConcurrency - intelligenceConcurrency;
  const enrichRemainder = enrichShareExact - Math.floor(enrichShareExact);
  const intelligenceRemainder = intelligenceShareExact - Math.floor(intelligenceShareExact);
  const order: Array<"enrich" | "intelligence"> =
    enrichRemainder >= intelligenceRemainder ? ["enrich", "intelligence"] : ["intelligence", "enrich"];

  for (const which of order) {
    if (leftover <= 0) break;
    if (which === "enrich") {
      const room = enrichConfigured - enrichConcurrency;
      const take = Math.min(room, leftover);
      enrichConcurrency += take;
      leftover -= take;
    } else {
      const room = intelligenceConfigured - intelligenceConcurrency;
      const take = Math.min(room, leftover);
      intelligenceConcurrency += take;
      leftover -= take;
    }
  }

  return { enrichConcurrency, intelligenceConcurrency };
}

let processEnrichmentCapacity: EnrichmentCapacity | undefined;

export function initEnrichmentCapacity(configuredCeiling: number): EnrichmentCapacity {
  processEnrichmentCapacity = measureEnrichmentCapacity(configuredCeiling);
  return processEnrichmentCapacity;
}

export function getEnrichmentCapacity(): EnrichmentCapacity {
  if (!processEnrichmentCapacity) {
    console.warn("[resourceCapacity][enrichment] getEnrichmentCapacity() called before initEnrichmentCapacity() — falling back to the known-safe constant");
    const fallback = env.ENRICHMENT_SAFE_RESOURCE_WORKERS_FALLBACK;
    processEnrichmentCapacity = {
      pidCapacity: { cgroupVersion: "unavailable", pidsMax: null, pidsCurrent: null },
      cgroupMemoryLimitMb: null,
      cgroupMemoryCurrentMb: null,
      cgroupMemoryWorkerCeiling: null,
      enrichmentPidsPerWorker: env.ENRICHMENT_PIDS_PER_WORKER,
      reservePids: env.PIDS_RESERVE_BUDGET,
      pidWorkerCeiling: fallback,
      pidCeilingBasis: "fallback_unavailable",
      safeEnrichmentWorkers: fallback,
    };
  }
  return processEnrichmentCapacity;
}

export const __testing_enrichmentCapacity = {
  reset: () => { processEnrichmentCapacity = undefined; },
  set: (capacity: EnrichmentCapacity) => { processEnrichmentCapacity = capacity; },
};
