import type { Job } from "pg-boss";
import { getBoss, QUEUES } from "../lib/queue.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { handleDiscoverJob, type DiscoverJobPayload } from "../jobs/discoverJob.js";
import { handlePoolExpandJob, type PoolExpandJobPayload } from "../jobs/poolExpandJob.js";
import { handleVerificationJob, type VerificationJobPayload } from "../jobs/verificationJob.js";
import { handleDiscoveryPlanJob, handleDiscoveryTask, type DiscoveryPlanPayload, type DiscoveryTaskPayload } from "../jobs/discoveryPlanJob.js";
import { handleBusinessProcessingJob, type BusinessProcessingPayload } from "../jobs/businessProcessingJob.js";
import { env } from "../config/env.js";
import { measureBrowserCapacity, registerWorkerInstance, heartbeatWorkerInstance } from "../lib/workerCapacity.js";
import { captureSystemSnapshot, workerMetrics } from "../lib/observability.js";

// Ensure the provider registry is initialised at startup so any
// getProvider() call in handleDiscoveryTask has the implementations loaded.
import "../discovery/providerRegistry.js";

process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException", { message: err?.message, stack: err?.stack, err });
});
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection", { reason });
});

/**
 * pg-boss v10 removed `teamSize`/`teamConcurrency`/`teamRefill` from
 * `work()` (see https://github.com/timgit/pg-boss/releases/tag/10.0.0) —
 * concurrency is no longer a polling-level option. `batchSize` now only
 * controls how many jobs are fetched per poll; the fetched batch still has
 * to be processed by the handler itself to run concurrently. This helper
 * fetches up to `concurrency` jobs at a time and runs all of them in
 * parallel via `Promise.all`, which is the closest v10-native equivalent to
 * the old `teamSize` behaviour for these queues.
 */
async function processBatchConcurrently<T>(jobs: Job<T>[], handler: (job: Job<T>) => Promise<void>): Promise<void> {
  await Promise.all(jobs.map((job) => handler(job)));
}

async function main() {
  const boss = await getBoss();

  // ── Phase 5 Refinement 4: Capacity measurement ───────────────────────────
  // Measure available browser capacity from OS free memory at startup so the
  // worker never fetches more concurrent jobs than it has RAM for.  The
  // effective concurrency is min(configured, measured) and is used for the
  // batchSize on browser-backed queues.
  const browserCapacity = measureBrowserCapacity(env.DISCOVERY_TASK_CONCURRENCY);
  await registerWorkerInstance(browserCapacity, "browser");

  // Heartbeat the worker_instances row every 30 seconds so the ops dashboard
  // has a live view of actual capacity across the fleet.
  const workerHeartbeatInterval = setInterval(
    () => heartbeatWorkerInstance(browserCapacity.workerId),
    30_000,
  );

  // Clean up the heartbeat interval if the process exits gracefully.
  process.on("SIGTERM", () => clearInterval(workerHeartbeatInterval));
  process.on("SIGINT",  () => clearInterval(workerHeartbeatInterval));

  await boss.work<DiscoveryPlanPayload>(QUEUES.discoveryPlan, async ([job]) => {
    await runJob(job.id, null, () => handleDiscoveryPlanJob(job.data));
  });

  // Use effectiveConcurrency (memory-bounded) instead of the raw configured
  // value so the worker can't be scheduled into OOM by raising the env var
  // on a container that can't support the higher concurrency.
  await boss.work<DiscoveryTaskPayload>(QUEUES.discoveryTask, { batchSize: browserCapacity.effectiveConcurrency }, async (jobs) => {
    await processBatchConcurrently(jobs, (job) => runJob(job.id, null, () => handleDiscoveryTask(job.data)));
  });

  await boss.work<BusinessProcessingPayload>(QUEUES.businessEnrich, { batchSize: env.ENRICHMENT_TASK_CONCURRENCY }, async (jobs) => {
    await processBatchConcurrently(jobs, (job) => runJob(job.id, null, () => handleBusinessProcessingJob(job.data)));
  });
  await boss.work<BusinessProcessingPayload>(QUEUES.businessScore, { batchSize: env.INTELLIGENCE_TASK_CONCURRENCY }, async (jobs) => {
    await processBatchConcurrently(jobs, (job) => runJob(job.id, null, () => handleBusinessProcessingJob(job.data)));
  });

  // discover.live is the only queued discovery path as of Phase 3 — Instant
  // Discovery (Starter/Pro/Premium) is a synchronous pool lookup in the
  // gateway request handler now, not a queue job. See src/lib/poolLookup.ts
  // and src/server/routes/discover.ts.
  await boss.work<DiscoverJobPayload>(QUEUES.discoverLive, async ([job]) => {
    await runJob(job.id, job.data.scrapeJobId, () => handleDiscoverJob(job.data));
  });

  await boss.work<PoolExpandJobPayload>(QUEUES.poolExpand, async ([job]) => {
    await runJob(job.id, null, () => handlePoolExpandJob(job.data));
  });

  await boss.work<VerificationJobPayload>(QUEUES.poolVerify, async ([job]) => {
    await runJob(job.id, null, () => handleVerificationJob(job.data));
  });

  // ── Scheduler initialization (guarded) ──────────────────────────────────
  // Wrap scheduler initialization in its own guarded block so that if it
  // fails, the worker still starts and processes discovery/enrichment jobs.
  try {
    // Recurring verification, per the doc's "approximately every 14 days"
    // pool-freshness requirement. Schedule expression is UTC cron; pg-boss
    // dedupes by key so re-running `npm run start:worker` doesn't create
    // duplicate schedules.
    await boss.schedule(QUEUES.poolVerify, "0 3 * * *", { batchSize: 200 });
  } catch (err) {
    console.error("[worker] Optional scheduler failed to schedule poolVerify (non-fatal):", err);
  }

  try {
    // ── Phase 5 Refinement 2: Priority aging ──────────────────────────────────
    // Raises the priority of discovery tasks that have been waiting longer than
    // 10 minutes toward their tier’s ceiling band, preventing starvation of lower
    // tiers when a higher tier has sustained throughput.  Aging is capped at the
    // tier ceiling so a free-tier task can never reach a pro/premium priority.
    //
    // Each tier’s ceiling is stored in PLANS.priorityBand.ceiling (plans.ts).
    // The UPDATE is intentionally broad: it applies to any queued task older
    // than the threshold regardless of which worker picks it up, so multiple
    // worker replicas don’t double-apply the boost (the LEAST clamp is idempotent).
    //
    // Schedule: every 5 minutes, matching the refinement doc’s recommendation.
    await boss.schedule("priority-aging", "*/5 * * * *", {});
  } catch (err) {
    console.error("[worker] Optional scheduler failed to schedule priority-aging (non-fatal):", err);
  }

  // Work on priority aging queue. Errors are caught inside the handler so they
  // never crash the worker process.
  await boss.work("priority-aging", async () => {
    try {
      await supabaseAdmin.rpc("age_discovery_task_priorities" as any, {
        p_aging_threshold_minutes: 10,
        p_boost_per_interval: 1,
      } as any);
    } catch (err) {
      console.error("[worker] Background priority-aging database call failed (non-fatal):", err);
    }
  });

  // ── Phase 7: Observability snapshot (every 1 minute) ─────────────────────
  // Captures a time-series snapshot of active workers, queue depths, and
  // browser metrics into lead_engine_snapshots for the ops dashboard.
  try {
    await boss.schedule("metrics-snapshot", "*/1 * * * *", {});
  } catch (err) {
    console.error("[worker] Optional scheduler failed to schedule metrics-snapshot (non-fatal):", err);
  }

  await boss.work("metrics-snapshot", async () => {
    // captureSystemSnapshot is itself non-throwing; any error is caught inside.
    await captureSystemSnapshot(workerMetrics);
  });

  console.log(`[worker] subscribed to all queues — effectiveConcurrency=${browserCapacity.effectiveConcurrency} configured=${browserCapacity.configuredConcurrency} freeMb=${browserCapacity.freeMemoryMb}`);
}

async function runJob(bossJobId: string, scrapeJobId: string | null, fn: () => Promise<void>) {
  if (scrapeJobId) {
    // Only transition to 'running' if the job is in an appropriate pre-run
    // state. Do NOT overwrite 'cancelled' (set by the user before we even
    // started) or any terminal state left by a previous crashed attempt.
    await supabaseAdmin.from("scrape_jobs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", scrapeJobId)
      .in("status", ["queued", "running"]);
  }

  try {
    await fn();
    if (scrapeJobId) {
      // The handler (e.g. handleDiscoverJob) writes its own terminal state
      // (completed | completed_partial | cancelled) together with job_summary.
      // runJob only needs to write 'completed' as a safe fallback for jobs
      // where the handler exited cleanly but didn't write a terminal state
      // (e.g. an older handler or discovery_plan flows).
      // We must NOT overwrite completed_partial / cancelled / completed.
      await supabaseAdmin.from("scrape_jobs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", scrapeJobId)
        .in("status", ["running", "streaming"]); // only apply when handler left it non-terminal
    }
  } catch (err) {
    console.error(`[worker] job ${bossJobId} failed`, err);
    if (scrapeJobId) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err), completed_at: new Date().toISOString() })
        .eq("id", scrapeJobId)
        .not("status", "eq", "cancelled"); // never overwrite a user cancellation with 'failed'
    }
    throw err; // let pg-boss apply its retry policy
  }
}


main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
