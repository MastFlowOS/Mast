/**
 * Worker Pools B — Google Maps area worker pool.
 *
 * Scope reminder (see the phase prompt this implements): Google Maps ONLY.
 * One discovery task, for a city with curated areas, may fan out into
 * multiple concurrent area workers, each claiming a distinct area via the
 * EXISTING `claim_discovery_area()` (migrations/026, wrapped by
 * areaRotation.ts's `claimAreaForCity`) and running one complete Google
 * Maps discovery pass for that area.
 *
 * This module is deliberately split into:
 *   • pure, DB-free, engine-free arithmetic and orchestration
 *     (`computeAreaPoolSize`, `runAreaWorkerPool`) — fully unit-testable
 *     with fake claim/run/capacity functions, no Postgres, no Playwright.
 *   • the actual wiring to Postgres (claim_discovery_area,
 *     record_discovery_area_outcome), the browser slot pool, and
 *     runEngineQuery() lives in discoveryPlanJob.ts, which supplies this
 *     module with small injected functions instead.
 *
 * This mirrors the split cityScheduling.ts/areaRotation.ts already
 * established in this codebase between pure policy and DB-backed
 * atomicity — see areaRotation.ts's own doc comment for the same
 * reasoning applied one layer up.
 */

/** One area worker's outcome, in the same shape recordAreaOutcome() persists. */
export type AreaRunOutcome = {
  discovered: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  exhausted: boolean;
  /** True if this run threw / failed before producing a usable result. */
  failed: boolean;
  error?: string;
};

export type PoolStopReason = "cancelled" | "target_reached" | "areas_exhausted" | "pool_size_zero";

export type AreaWorkerLogEvent =
  | { type: "pool_start"; configured: number; availableAreas: number; capacity: number; poolSize: number }
  | { type: "worker_started"; area: string; slot: number }
  | { type: "worker_finished"; area: string; outcome: AreaRunOutcome }
  | { type: "worker_skipped_no_slot"; slot: number }
  | { type: "worker_skipped_no_area" }
  | { type: "pool_stopped"; reason: PoolStopReason };

export type AreaWorkerPoolResult = {
  configured: number;
  poolSize: number;
  startedWorkers: number;
  areasProcessed: string[];
  totals: {
    discovered: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  };
  /** One entry per area actually run, in completion order. */
  perArea: { area: string; outcome: AreaRunOutcome }[];
  /** True if every area worker that ran failed (used to decide task-level retry). */
  allFailed: boolean;
};

/**
 * Worker Pools B Step 2's sizing formula, as a pure function:
 *
 *   N = min(configured Google area worker count,
 *           number of available curated areas,
 *           safe capacity available to this worker)
 *
 * Never negative; a saturated worker (capacitySlots <= 0) correctly
 * degrades to a pool size of 0 rather than throwing — the caller decides
 * what "zero workers" means (googleAreaPool's own runAreaWorkerPool treats
 * it as "nothing started this pass", not an error).
 */
/**
 * Worker Pools B Step 2's sizing formula, as a pure function:
 *
 *   N = min(configured Google area worker count,
 *           number of available curated areas,
 *           safe capacity available to this worker)
 *
 * Never negative; a saturated worker (capacitySlots <= 0) correctly
 * degrades to a pool size of 0 rather than throwing — the caller decides
 * what "zero workers" means (googleAreaPool's own runAreaWorkerPool treats
 * it as "nothing started this pass", not an error).
 */
export function computeAreaPoolSize(configured: number, availableAreas: number, capacitySlots: number): number {
  return Math.max(0, Math.min(configured, availableAreas, capacitySlots));
}

/**
 * Dynamic discovery capacity model (Phase 6 SLA requirement: 5-10 min for 10-100 leads):
 * Scales safe concurrency with requested lead quantity:
 *   • <= 10 leads: low concurrency (up to 2 workers)
 *   • <= 25 leads: moderate concurrency (up to 3 workers)
 *   • <= 50 leads: higher concurrency (up to 4 workers)
 *   • > 50 leads : maximum safe concurrency (up to 6-8 workers or configured ceiling)
 *
 * Never exceeds available curated areas, measured browser slot capacity, or maxConfigured.
 */
export function computeDynamicDiscoveryCapacity(
  requestedQuantity: number,
  availableAreas: number,
  capacitySlots: number,
  maxConfigured: number = 8,
): number {
  if (requestedQuantity <= 0 || availableAreas <= 0 || capacitySlots <= 0 || maxConfigured <= 0) {
    return 0;
  }

  let desired: number;
  if (requestedQuantity <= 10) {
    desired = Math.min(2, maxConfigured);
  } else if (requestedQuantity <= 25) {
    desired = Math.min(3, maxConfigured);
  } else if (requestedQuantity <= 50) {
    desired = Math.min(4, maxConfigured);
  } else {
    desired = Math.min(8, maxConfigured);
  }

  return Math.max(0, Math.min(desired, availableAreas, capacitySlots));
}

export type RunAreaWorkerPoolParams = {
  configuredWorkers: number;
  /** Total curated areas for this city (used only for the pool-size formula and logging). */
  totalCuratedAreas: number;
  /** Non-blocking: current browser-slot capacity snapshot for sizing decisions. */
  availableCapacity: number;
  /** Optional requested quantity from the parent plan to dynamically size the pool. */
  requestedQuantity?: number;
  /**
   * Attempts to claim one area not yet used by THIS task instance.
   * Returns `undefined` when no distinct new area remains — i.e. every
   * curated area has already been claimed once by this task's pool this
   * run (Step 9: never re-claim the same area in a tight loop within one
   * task). `usedAreas` is supplied so the injected claim function can
   * apply this rule itself (it owns the actual DB call and knows the
   * fallback/cooldown behavior of claim_discovery_area()).
   */
  claimNextArea: (usedAreas: ReadonlySet<string>) => Promise<string | undefined>;
  /** Runs one complete area search. Must not throw for area-local failures — catch and return { failed: true } instead so siblings are unaffected (Step 8). */
  runArea: (area: string) => Promise<AreaRunOutcome>;
  /** Non-blocking: attempts to reserve one browser slot. Returns a release fn, or undefined if none free right now. */
  tryAcquireSlot: () => (() => void) | undefined;
  /** Polled before starting each new area claim; true once the plan is cancelled/target-reached. */
  isTerminal: () => Promise<boolean> | boolean;
  onEvent?: (event: AreaWorkerLogEvent) => void;
};

/**
 * Runs up to `computeAreaPoolSize(...)` or `computeDynamicDiscoveryCapacity(...)`
 * concurrent area workers, each looping: claim a distinct area → run it →
 * record its own outcome (via the caller's `runArea`) → claim the next
 * distinct area, until:
 *   • no new distinct area remains (`claimNextArea` returns undefined), or
 *   • `isTerminal()` reports the plan is cancelled or target-reached, or
 *   • no browser slot is available to start the NEXT area (the worker
 *     simply stops — it does not queue; another already-running worker
 *     picking up more areas covers the remaining capacity).
 *
 * One worker's `runArea` failure never stops its siblings (Step 8) — the
 * pool only reports `allFailed: true` if literally every area that ran
 * failed, which discoveryPlanJob.ts uses to decide whether the task itself
 * should still get its existing bounded pg-boss retry.
 */
export async function runAreaWorkerPool(params: RunAreaWorkerPoolParams): Promise<AreaWorkerPoolResult> {
  const {
    configuredWorkers,
    totalCuratedAreas,
    availableCapacity,
    requestedQuantity,
    claimNextArea,
    runArea,
    tryAcquireSlot,
    isTerminal,
    onEvent,
  } = params;

  const computedWorkers = requestedQuantity !== undefined
    ? (requestedQuantity <= 10 ? 2 : requestedQuantity <= 25 ? 3 : requestedQuantity <= 50 ? 4 : 8)
    : configuredWorkers;
  const poolSize = requestedQuantity !== undefined
    ? computeDynamicDiscoveryCapacity(requestedQuantity, totalCuratedAreas, availableCapacity, configuredWorkers)
    : computeAreaPoolSize(configuredWorkers, totalCuratedAreas, availableCapacity);

  console.info(
    `[discovery-capacity] requested=${requestedQuantity ?? "n/a"} computedWorkers=${computedWorkers} ` +
      `areas=${totalCuratedAreas} browserSlots=${availableCapacity} finalWorkers=${poolSize}`,
  );
  onEvent?.({ type: "pool_start", configured: configuredWorkers, availableAreas: totalCuratedAreas, capacity: availableCapacity, poolSize });

  const usedAreas = new Set<string>();
  const perArea: { area: string; outcome: AreaRunOutcome }[] = [];
  let stoppedReason: PoolStopReason = "areas_exhausted";

  if (poolSize <= 0) {
    onEvent?.({ type: "pool_stopped", reason: "pool_size_zero" });
    return {
      configured: configuredWorkers,
      poolSize: 0,
      startedWorkers: 0,
      areasProcessed: [],
      totals: { discovered: 0, accepted: 0, rejected: 0, duplicates: 0 },
      perArea: [],
      allFailed: false,
    };
  }

  let startedWorkers = 0;

  // One "worker" is a loop that keeps claiming + running distinct areas
  // until it has a reason to stop. Each loop iteration holds exactly one
  // browser slot for the duration of its one area run, then releases it
  // before claiming the next — so slots are shared fairly across workers
  // and across other tasks in this process, not held for the pool's whole
  // lifetime (Step 5/Step 11 — one engine process per area, never reused).
  async function workerLoop(slotIndex: number): Promise<void> {
    for (;;) {
      if (await isTerminal()) {
        stoppedReason = usedAreas.size >= totalCuratedAreas ? "areas_exhausted" : "cancelled";
        return;
      }

      const release = tryAcquireSlot();
      if (!release) {
        onEvent?.({ type: "worker_skipped_no_slot", slot: slotIndex });
        return; // no capacity right now — do not queue; another worker's release() will let a fresh claim happen next loop tick elsewhere
      }

      let area: string | undefined;
      try {
        area = await claimNextArea(usedAreas);
      } catch (err) {
        release();
        throw err; // a claim-mechanism error (e.g. DB unreachable) is not area-local — propagate
      }

      if (!area || usedAreas.has(area)) {
        release();
        onEvent?.({ type: "worker_skipped_no_area" });
        return; // no distinct new area left for this task's pool this run
      }

      usedAreas.add(area);
      startedWorkers += 1;
      console.info(`[area-worker-start] worker=${slotIndex + 1} area=${area}`);
      onEvent?.({ type: "worker_started", area, slot: slotIndex });

      let outcome: AreaRunOutcome;
      try {
        outcome = await runArea(area);
      } catch (err) {
        // Defensive only — runArea's own contract is to never throw for
        // area-local failures (Step 8). If it does anyway, isolate it here
        // too rather than taking down sibling workers.
        outcome = { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: true, error: err instanceof Error ? err.message : String(err) };
      } finally {
        release();
      }

      perArea.push({ area, outcome });
      onEvent?.({ type: "worker_finished", area, outcome });
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) workers.push(workerLoop(i));
  await Promise.all(workers);

  if (await isTerminal()) stoppedReason = usedAreas.size >= totalCuratedAreas ? "areas_exhausted" : (stoppedReason === "areas_exhausted" ? "target_reached" : stoppedReason);
  onEvent?.({ type: "pool_stopped", reason: stoppedReason });

  const totals = perArea.reduce(
    (acc, { outcome }) => ({
      discovered: acc.discovered + outcome.discovered,
      accepted: acc.accepted + outcome.accepted,
      rejected: acc.rejected + outcome.rejected,
      duplicates: acc.duplicates + outcome.duplicates,
    }),
    { discovered: 0, accepted: 0, rejected: 0, duplicates: 0 },
  );

  return {
    configured: configuredWorkers,
    poolSize,
    startedWorkers,
    areasProcessed: perArea.map((p) => p.area),
    totals,
    perArea,
    allFailed: perArea.length > 0 && perArea.every((p) => p.outcome.failed),
  };
}
