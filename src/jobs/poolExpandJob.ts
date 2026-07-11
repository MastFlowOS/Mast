import { supabaseAdmin } from "../lib/supabase.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import { deliverLead } from "../scraperBridge/deliverLead.js";

export type PoolExpandFollowUp = {
  userId: string;
  professionSlug: string | null;
  rank: boolean;
  scrapeJobId: string;
  dailyLimit: number;
  monthlyLimit: number;
};

export type PoolExpandJobPayload = {
  region: string;
  niche: string;
  shortfall: number;
  /**
   * When present, this expand run is a direct continuation of a specific
   * user's Instant Discovery request that fell short — each newly-
   * discovered business is ALSO delivered to that user (credit-charged,
   * CRM row inserted) under the SAME scrape_job_id the gateway already
   * returned to them.
   *
   * When absent, this only grows the shared pool — used when a shortfall
   * happens but there's no single user to hand results back to fast enough
   * to matter, or for backward compatibility.
   */
  followUp?: PoolExpandFollowUp;
};

/**
 * Grows `businesses` for a region/niche that came up short during an
 * Instant Discovery pool lookup. Runs the same engine as discover.live, via
 * the same bridge.
 *
 * PHASE 5: same per-lead atomic credit check as discoverJob.ts — a
 * followUp run can also be stopped early if the user's limit is reached
 * mid-run (e.g. they started a second search while this one was still
 * backfilling).
 */
export async function handlePoolExpandJob(payload: PoolExpandJobPayload): Promise<void> {
  const { followUp } = payload;
  let delivered = 0;
  let newForUser = 0;

  if (followUp) {
    await supabaseAdmin.from("scrape_jobs").update({ status: "streaming" }).eq("id", followUp.scrapeJobId);
  }

  const abortController = new AbortController();

  try {
    for await (const lead of runEngineQuery(
      {
        query: payload.niche,
        city: payload.region,
        max_results: payload.shortfall,
        db_path: `data/leads-pool-expand.db`,
      },
      abortController.signal,
    )) {
      const result = await deliverLead(
        lead,
        {
          userId: followUp?.userId ?? null,
          professionSlug: followUp?.professionSlug ?? null,
          discoveryMode: followUp?.rank ? "instant_pool_ranked" : "instant_pool",
          scrapeJobId: followUp?.scrapeJobId ?? "",
          dailyLimit: followUp?.dailyLimit,
          monthlyLimit: followUp?.monthlyLimit,
        },
        payload.region,
      );

      delivered += 1;
      if (result.wasNewForUser) newForUser += 1;

      if (followUp) {
        await supabaseAdmin.from("scrape_jobs").update({ results_count: newForUser }).eq("id", followUp.scrapeJobId);

        if (result.limitReached) {
          console.log(`[poolExpandJob] user=${followUp.userId} hit their plan limit mid-run — stopping early`);
          abortController.abort();
          break;
        }
      }
    }

    if (followUp) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", followUp.scrapeJobId);
    }
  } catch (err) {
    if (followUp) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err), completed_at: new Date().toISOString() })
        .eq("id", followUp.scrapeJobId);
    }
    throw err;
  }

  console.log(
    `[poolExpandJob] region=${payload.region} niche=${payload.niche} shortfall=${payload.shortfall} ` +
      `delivered=${delivered}${followUp ? ` newForUser=${newForUser} (followUp for user=${followUp.userId})` : ""}`,
  );
}
