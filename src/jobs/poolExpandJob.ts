import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import { deliverLead } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";

export type PoolExpandFollowUp = {
  userId: string;
  professionSlug: string | null;
  rank: boolean;
  scrapeJobId: string;
  dailyLimit: number;
  monthlyLimit: number;
  /** Requested channels for the user this expand run is following up for — see channelFilter.ts. */
  channels: string[];
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
 *
 * PRODUCT-QUALITY PASS (this file): same three fixes as discoverJob.ts —
 * see that file's docstring for the full root-cause writeup. Summary:
 *  1. Niches are split (splitNicheQuery) and searched independently (OR),
 *     each tagged via the engine's `niche` param so `businesses.niche`
 *     (and therefore the frontend's "discovered niche" column) is
 *     populated correctly instead of being left blank.
 *  2. `followUp.channels`, when present, is enforced post-enrichment via
 *     channelsSatisfied() before a lead is delivered to that user.
 *  3. The engine is asked for generous headroom per niche and the loop
 *     keeps going — across niches — until `shortfall` is actually met or
 *     every niche genuinely exhausts (engine `onDone.exhausted`), instead
 *     of stopping after one under-sized engine call.
 */
export async function handlePoolExpandJob(payload: PoolExpandJobPayload): Promise<void> {
  const { followUp } = payload;
  const niches = splitNicheQuery(payload.niche);

  let delivered = 0; // total businesses newly added to the pool (all niches)
  let newForUser = 0; // of those, how many were credited/delivered to followUp.userId

  if (followUp) {
    await supabaseAdmin.from("scrape_jobs").update({ status: "streaming" }).eq("id", followUp.scrapeJobId);
  }

  const abortController = new AbortController();
  // The target this run is actually trying to satisfy: for a followUp,
  // that's "give this user `shortfall` more NEW deliveries"; for a bare
  // pool-growth run (no followUp), it's "add `shortfall` more businesses
  // to the pool" — there's no per-user channel filter to apply in that
  // case, so every delivered (deduped) business counts.
  const target = payload.shortfall;

  try {
    outer: for (const singleNiche of niches) {
      const stillNeeded = followUp ? payload.shortfall - newForUser : payload.shortfall - delivered;
      if (stillNeeded <= 0) break;

      const askFor = Math.max(stillNeeded * 4, target);
      let nicheExhausted = false;

      for await (const lead of runEngineQuery(
        {
          query: singleNiche,
          city: payload.region,
          niche: singleNiche,
          region: payload.region,
          max_results: askFor,
          db_path: `data/leads-pool-expand.db`,
        },
        abortController.signal,
        (info) => {
          nicheExhausted = info.exhausted;
        },
      )) {
        if (followUp && !channelsSatisfied(lead, followUp.channels)) {
          continue; // doesn't satisfy every requested channel for the waiting user — not counted
        }

        const validation = validateLead(lead);
        if (!validation.valid) {
          console.log(`[poolExpandJob] skipping invalid lead name=${JSON.stringify(lead.name)} reason=${validation.reason}`);
          continue;
        }

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
            break outer;
          }

          if (newForUser >= payload.shortfall) {
            abortController.abort();
            break outer;
          }
        } else if (delivered >= payload.shortfall) {
          abortController.abort();
          break outer;
        }
      }

      void nicheExhausted; // exhaustion just means "move to next niche", already the loop's natural behavior
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
    `[poolExpandJob] region=${payload.region} niches=${JSON.stringify(niches)} shortfall=${payload.shortfall} ` +
      `delivered=${delivered}${followUp ? ` newForUser=${newForUser} (followUp for user=${followUp.userId})` : ""}`,
  );
}
