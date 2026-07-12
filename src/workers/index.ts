import { getBoss, QUEUES } from "../lib/queue.js";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { handleDiscoverJob } from "../jobs/discoverJob.js";
import { handlePoolExpandJob } from "../jobs/poolExpandJob.js";
import { handleVerificationJob } from "../jobs/verificationJob.js";

process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException", { message: err?.message, stack: err?.stack, err });
});
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection", { reason });
});

type DiscoverJobPayload = {
  scrapeJobId: string;
  userId: string;
  region: string;
  niche: string;
  channels: string[];
  professionSlug: string | null;
  quantity: number;
  dailyLimit: number;
  monthlyLimit: number;
};

async function main() {
  const boss = await getBoss();

  // discover.live is the only queued discovery path as of Phase 3 — Instant
  // Discovery (Starter/Pro/Premium) is a synchronous pool lookup in the
  // gateway request handler now, not a queue job. See src/lib/poolLookup.ts
  // and src/server/routes/discover.ts.
  await boss.work<DiscoverJobPayload>(QUEUES.discoverLive, async ([job]) => {
    await runJob(job.id, job.data.scrapeJobId, () => handleDiscoverJob(job.data));
  });

  await boss.work(QUEUES.poolExpand, async ([job]) => {
    await runJob(job.id, null, () => handlePoolExpandJob(job.data as Parameters<typeof handlePoolExpandJob>[0]));
  });

  await boss.work(QUEUES.poolVerify, async ([job]) => {
    await runJob(job.id, null, () => handleVerificationJob(job.data as Parameters<typeof handleVerificationJob>[0]));
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
