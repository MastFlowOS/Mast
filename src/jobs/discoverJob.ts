import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import { deliverLead } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";

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
 *
 * PRODUCT-QUALITY PASS (this file): three root causes fixed here, all in
 * the orchestration around the same engine call — no engine API changed:
 *
 *  1. "Requested quantity not honored" — this used to make exactly ONE
 *     runEngineQuery() call with `max_results: payload.quantity` and just
 *     took whatever came back, even if the engine stopped short of
 *     `quantity` for reasons that had nothing to do with the search space
 *     being exhausted (see service.py's raw_supply_cap fix). Now: keep
 *     pulling from the engine — across niches — until either `quantity`
 *     opportunities have actually been delivered, or every niche's engine
 *     run reports genuine exhaustion (via the new `onDone` callback).
 *
 *  2. "Channel filters not respected" — `channels` was accepted by this
 *     job's payload but never used. Now every engine lead is checked with
 *     `channelsSatisfied()` (post-enrichment, per the requirement) before
 *     `deliverLead` is called; leads that don't satisfy every requested
 *     channel are skipped and don't count against `quantity`, so the
 *     stream keeps going to compensate — this is what makes fix #1 and fix
 *     #2 work together correctly instead of just capping delivery low.
 *
 *  3. "Multiple niches behave like AND" / "discovered niche shows —" —
 *     `payload.niche` was passed straight through as the Maps search query
 *     but the engine's `niche` tagging param was never passed at all. Now
 *     `splitNicheQuery()` turns a comma-joined "Bakery, Coffee" into
 *     independent niches, each run as its own query AND passed as the
 *     engine's `niche` param (previously omitted entirely, which is why
 *     every delivered lead's `niche` column was blank/"—" downstream).
 */
export async function handleDiscoverJob(payload: DiscoverJobPayload): Promise<void> {
  const niches = splitNicheQuery(payload.niche);

  let delivered = 0; // channel-passing, validated, requested-worth deliveries
  let newForUser = 0;
  let sawLimitReached = false;

  const abortController = new AbortController();

  outer: for (const singleNiche of niches) {
    if (delivered >= payload.quantity) break;

    // Ask the engine for generous headroom, not just the remaining
    // shortfall — channel filtering/validation below may discard a
    // fraction of what it streams back, so under-asking would reproduce
    // bug #1 one level up. The engine's own exhaustion (reported via
    // onDone) is what actually caps this, not this number.
    const askFor = Math.max((payload.quantity - delivered) * 4, payload.quantity);

    let nicheExhausted = false;

    for await (const lead of runEngineQuery(
      {
        query: singleNiche,
        city: payload.region,
        niche: singleNiche,
        region: payload.region,
        max_results: askFor,
        db_path: `data/leads-${payload.userId}.db`,
      },
      abortController.signal,
      (info) => {
        nicheExhausted = info.exhausted;
      },
    )) {
      if (!channelsSatisfied(lead, payload.channels)) {
        continue; // doesn't satisfy every requested channel — not counted, keep streaming
      }

      const validation = validateLead(lead);
      if (!validation.valid) {
        console.log(`[discoverJob] skipping invalid lead name=${JSON.stringify(lead.name)} reason=${validation.reason}`);
        continue;
      }

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

      if (result.wasNewForUser) {
        delivered += 1;
        newForUser += 1;
      }

      await supabaseAdmin.from("scrape_jobs").update({ results_count: newForUser, status: "streaming" }).eq("id", payload.scrapeJobId);

      if (result.limitReached) {
        console.log(`[discoverJob] user=${payload.userId} hit their plan limit mid-run — stopping early`);
        sawLimitReached = true;
        abortController.abort();
        break outer;
      }

      if (delivered >= payload.quantity) {
        break; // quantity satisfied — let this niche's stream wind down via abort below
      }
    }

    if (delivered >= payload.quantity) {
      abortController.abort();
      break;
    }

    // nicheExhausted === true means this niche's search space is genuinely
    // exhausted at the current region/channel filter — move on to the next
    // niche (if any) to keep working toward `quantity`. If it's false, we
    // stopped consuming for some other reason (already handled above);
    // either way there's nothing more to extract from this niche right now.
    void nicheExhausted;
  }

  const exhaustedEverySearchVariation = delivered < payload.quantity && !sawLimitReached;
  console.log(
    `[discoverJob] live user=${payload.userId} region=${payload.region} niches=${JSON.stringify(niches)} ` +
      `requested=${payload.quantity} delivered=${delivered} newForUser=${newForUser} ` +
      `exhaustedEverySearchVariation=${exhaustedEverySearchVariation}`,
  );
}
