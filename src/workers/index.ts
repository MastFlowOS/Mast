import type { Job } from "pg-boss";
import { getBoss, QUEUES } from "../lib/queue.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { handleDiscoverJob, type DiscoverJobPayload } from "../jobs/discoverJob.js";
import { handlePoolExpandJob, type PoolExpandJobPayload } from "../jobs/poolExpandJob.js";
import { handleVerificationJob, type VerificationJobPayload } from "../jobs/verificationJob.js";
import { handleDiscoveryPlanJob, handleDiscoveryTask, type DiscoveryPlanPayload, type DiscoveryTaskPayload } from "../jobs/discoveryPlanJob.js";
import { handleBusinessProcessingJob, type BusinessProcessingPayload } from "../jobs/businessProcessingJob.js";
import { env } from "../config/env.js";

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

  await boss.work<DiscoveryPlanPayload>(QUEUES.discoveryPlan, async ([job]) => {
    await runJob(job.id, null, () => handleDiscoveryPlanJob(job.data));
  });

  await boss.work<DiscoveryTaskPayload>(QUEUES.discoveryTask, { batchSize: env.DISCOVERY_TASK_CONCURRENCY }, async (jobs) => {
    await processBatchConcurrently(jobs, (job) => runJob(job.id, null, () => handleDiscoveryTask(job.data)));
  });

  await boss.work<BusinessProcessingPayload>(QUEUES.businessEnrich, { batchSize: env.ENRICHMENT_TASK_CONCURRENCY }, async (jobs) => {
    await processBatchConcurrently(jobs, (job) => runJob(job.id, null, () => handleBusinessProcessingJob(job.data)));
  });
  await boss.work<BusinessProcessingPayload>(QUEUES.businessScore, { batchSize: env.ENRICHMENT_TASK_CONCURRENCY }, async (jobs) => {
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

  // Recurring verification, per the doc's "approximately every 14 days"
  // pool-freshness requirement. Schedule expression is UTC cron; pg-boss
  // dedupes by key so re-running `npm run start:worker` doesn't create
  // duplicate schedules.
  await boss.schedule(QUEUES.poolVerify, "0 3 * * *", { batchSize: 200 });

  console.log("[worker] subscribed to all queues, waiting for jobs...");
}

async function runJob(bossJobId: string, scrapeJobId: string | null, fn: () => Promise<void>) {
  if (scrapeJobId) {
    await supabaseAdmin.from("scrape_jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", scrapeJobId);
  }

  try {
    await fn();
    if (scrapeJobId) {
      await supabaseAdmin.from("scrape_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", scrapeJobId);
    }
  } catch (err) {
    console.error(`[worker] job ${bossJobId} failed`, err);
    if (scrapeJobId) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err), completed_at: new Date().toISOString() })
        .eq("id", scrapeJobId);
    }
    throw err; // let pg-boss apply its retry policy
  }
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
