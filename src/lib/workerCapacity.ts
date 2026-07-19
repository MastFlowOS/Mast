/**
 * Worker capacity measurement and advertisement (Phase 5 Refinement 4).
 *
 * Measures how many browser-backed tasks this worker process can safely run
 * concurrently based on available memory, then advertises that capacity to
 * the `worker_instances` Postgres table so the ops dashboard has a live view
 * of actual \u2014 not just configured \u2014 capacity across the worker fleet.
 *
 * Key design decisions:
 *  \u2022 Capacity is measured ONCE at startup, used as the batchSize ceiling,
 *    and re-measured only on worker restart.  Mid-run dynamic adjustment
 *    (reducing batchSize on memory pressure) is explicitly deferred:
 *    FUTURE OPTIMIZATION \u2014 add a memory-pressure monitor that periodically
 *    checks os.freemem() and reduces the effective concurrency of the running
 *    worker if free memory drops below WORKER_MEMORY_RESERVE_MB + one
 *    browser slot, so a slow-growing leak or co-located process can\u2019t push
 *    the container into OOM mid-run.  Trigger: a measured OOM incident at
 *    production volumes.
 *
 *  \u2022 The `worker_instances` table is for observability, NOT routing.
 *    pg-boss\u2019s SKIP LOCKED already distributes work across workers naturally;
 *    the table gives ops a live "how much capacity is actually available"
 *    view.  Central routing (dispatcher choosing which worker gets which job)
 *    is a future change that requires evidence SKIP LOCKED is under-performing.
 */

import os from "node:os";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { env } from "../config/env.js";

export type WorkerPoolType = "browser" | "light_compute" | "ai";

export type WorkerCapacity = {
  /** Unique id for this worker process: "<hostname>:<pid>" */
  workerId: string;
  /** Estimated browser slots based on free memory at startup */
  browserSlots: number;
  /** Free memory in MB at startup */
  freeMemoryMb: number;
  /** Logical CPUs available to this process */
  cpuCount: number;
  /** Env-var ceiling (DISCOVERY_TASK_CONCURRENCY or equivalent) */
  configuredConcurrency: number;
  /**
   * The value actually used for batchSize: min(configuredConcurrency, browserSlots).
   * Always \u2265 1 so the worker starts even on a very small container.
   */
  effectiveConcurrency: number;
};

/**
 * Measures available browser capacity at startup.
 *
 * Algorithm:
 *   effectiveConcurrency = min(configuredConcurrency,
 *     floor((freeMem - WORKER_MEMORY_RESERVE_MB) / BROWSER_MEMORY_ESTIMATE_MB))
 *   clamped to [1, configuredConcurrency]
 *
 * Tune BROWSER_MEMORY_ESTIMATE_MB and WORKER_MEMORY_RESERVE_MB via env vars
 * when deploying to a different container size \u2014 don\u2019t change this code.
 */
export function measureBrowserCapacity(configuredConcurrency: number): WorkerCapacity {
  const totalMb = os.totalmem() / 1024 / 1024;
  const freeMb = os.freemem() / 1024 / 1024;

  const perBrowserMb = env.BROWSER_MEMORY_ESTIMATE_MB;
  const reserveMb = env.WORKER_MEMORY_RESERVE_MB;
  const availableForBrowsers = Math.max(0, freeMb - reserveMb);
  const measuredSlots = Math.floor(availableForBrowsers / perBrowserMb);
  const effectiveConcurrency = Math.max(1, Math.min(configuredConcurrency, measuredSlots));

  const workerId = `${os.hostname()}:${process.pid}`;

  console.log(
    `[workerCapacity] id=${workerId} ` +
      `totalMb=${totalMb.toFixed(0)} freeMb=${freeMb.toFixed(0)} ` +
      `reserveMb=${reserveMb} perBrowserMb=${perBrowserMb} ` +
      `measuredSlots=${measuredSlots} configured=${configuredConcurrency} ` +
      `effective=${effectiveConcurrency}`,
  );

  return {
    workerId,
    browserSlots: measuredSlots,
    freeMemoryMb: Math.round(freeMb),
    cpuCount: os.cpus().length,
    configuredConcurrency,
    effectiveConcurrency,
  };
}

/**
 * Upserts this worker\u2019s capacity into the `worker_instances` table.
 * Fire-and-forget on errors \u2014 a failed registration must not prevent the
 * worker from starting and processing jobs.
 */
export async function registerWorkerInstance(
  capacity: WorkerCapacity,
  poolType: WorkerPoolType,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("worker_instances" as any).upsert(
      {
        id: capacity.workerId,
        pool_type: poolType,
        effective_concurrency: capacity.effectiveConcurrency,
        configured_concurrency: capacity.configuredConcurrency,
        free_memory_mb: capacity.freeMemoryMb,
        cpu_count: capacity.cpuCount,
        last_heartbeat_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      console.warn("[workerCapacity] Failed to register worker instance:", error.message);
    } else {
      console.log(`[workerCapacity] Registered worker instance: ${capacity.workerId} pool=${poolType}`);
    }
  } catch (err) {
    // Registration failure must never crash the worker.
    console.warn("[workerCapacity] registerWorkerInstance threw unexpectedly:", err);
  }
}

/**
 * Updates the heartbeat timestamp and current free memory for this worker.
 * Called every 30 seconds by workers/index.ts so the ops dashboard has a live
 * view of actual capacity (not just what was measured at startup).
 *
 * FUTURE OPTIMIZATION: use this heartbeat to also check current freemem and
 * signal to the job handler that concurrency should be reduced if memory is
 * now below the safe threshold (mid-run dynamic adjustment).
 */
export async function heartbeatWorkerInstance(workerId: string): Promise<void> {
  try {
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    await supabaseAdmin.from("worker_instances" as any).update({
      last_heartbeat_at: new Date().toISOString(),
      free_memory_mb: freeMb,
    }).eq("id", workerId);
  } catch {
    // Heartbeat failures are silent \u2014 a single missed heartbeat is harmless.
  }
}
