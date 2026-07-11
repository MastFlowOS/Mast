import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import { deliverLead } from "../scraperBridge/deliverLead.js";

export type DiscoverJobPayload = {
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

/**
 * discover.live only, as of Phase 3 (Free tier — Live Discovery). Runs a
 * real query through the Part 1 engine via scraper-bridge and streams each
 * result into `businesses` + the user's `leads` CRM row as soon as it's
 * delivered, updating scrape_jobs.results_count along the way.
 *
 * PHASE 5: credit is checked atomically per lead (see deliverLead.ts /
 * migrations/005_usage_hardening.sql) instead of only once at job start —
 * a Live Discovery run can last many seconds, plenty of time for the same
 * user's daily/monthly limit to be reached mid-stream (e.g. two searches
 * fired close together). The moment that happens, the subprocess is
 * aborted rather than continuing to scrape for opportunities that will
 * just be discarded.
 */
export async function handleDiscoverJob(payload: DiscoverJobPayload): Promise<void> {
  let delivered = 0;
  let newForUser = 0;

  const abortController = new AbortController();

  for await (const lead of runEngineQuery(
    {
      query: payload.niche,
      city: payload.region,
      max_results: payload.quantity,
      db_path: `data/leads-${payload.userId}.db`,
    },
    abortController.signal,
  )) {
    const result = await deliverLead(
      lead,
      {
        userId: payload.userId,
        professionSlug: payload.professionSlug,
        discoveryMode: "live",
        scrapeJobId: payload.scrapeJobId,
        dailyLimit: payload.dailyLimit,
        monthlyLimit: payload.monthlyLimit,
      },
      payload.region,
    );

    delivered += 1;
    if (result.wasNewForUser) newForUser += 1;

    await supabaseAdmin.from("scrape_jobs").update({ results_count: newForUser, status: "streaming" }).eq("id", payload.scrapeJobId);

    if (result.limitReached) {
      console.log(`[discoverJob] user=${payload.userId} hit their plan limit mid-run — stopping early`);
      abortController.abort();
      break;
    }
  }

  console.log(`[discoverJob] live user=${payload.userId} region=${payload.region} niche=${payload.niche} delivered=${delivered} newForUser=${newForUser}`);
}
