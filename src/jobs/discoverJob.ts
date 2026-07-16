import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import { deliverLead } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { resolveCountriesForSelection, CountryRotation } from "../lib/geo/regions.js";
import type { CountryInfo } from "../lib/geo/countries.js";

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
  /** Target currencies, if any — narrows which countries are searched per
   * region to ones where discovered businesses can realistically pay in
   * that currency. See src/lib/geo/regions.ts. */
  currencies?: string[];
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
 *     pulling from the engine — across niches AND countries — until either
 *     `quantity` opportunities have actually been delivered, or every
 *     niche/country combination reports genuine exhaustion (via the
 *     `onDone` callback).
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
 *
 * ARCHITECTURE FIX (this pass): `region` was being handed to the engine as
 * the literal `city` search term — i.e. the Maps query was genuinely
 * "Bakery in North America", which is not a place Maps can search. Region
 * is a UI/analytics grouping, not a search location. Now:
 *   - `resolveCountriesForSelection()` (src/lib/geo/regions.ts) expands the
 *     selected region(s) — and, if a target currency was chosen, filters to
 *     countries where a discovered business can realistically pay in it —
 *     into the real list of countries to search.
 *   - `CountryRotation` distributes `quantity` evenly across those
 *     countries per round, moving on the moment a country's search space is
 *     genuinely exhausted (per its own `onDone.exhausted`), instead of one
 *     country ever dominating the results.
 *   - The engine itself is untouched: it still just receives one real
 *     country (`city` + `country`) per call and performs a normal search —
 *     all the expansion/distribution logic lives here in orchestration.
 *   - `payload.region` is still passed through to `deliverLead`/pool
 *     storage unchanged — that's the free-text label `businesses.region`
 *     and `pool_lookup()` already match against, untouched by this fix.
 */
export async function handleDiscoverJob(payload: DiscoverJobPayload): Promise<void> {
  const niches = splitNicheQuery(payload.niche);
  const countries = resolveCountriesForSelection(payload.region, { currencies: payload.currencies });

  if (countries.length === 0) {
    console.error(`[discoverJob] no countries resolved for region=${JSON.stringify(payload.region)} — nothing to search`);
    return;
  }

  let delivered = 0; // channel-passing, validated, requested-worth deliveries
  let newForUser = 0;
  let sawLimitReached = false;

  const abortController = new AbortController();

  outer: for (const singleNiche of niches) {
    if (delivered >= payload.quantity) break;

    const rotation = new CountryRotation(countries);
    // Safety valve so a pathological "every country reports not-exhausted
    // but yields nothing" case can't loop forever — normal completion is
    // always via quantity reached or rotation.isFullyExhausted.
    let roundsLeft = countries.length * 6 + 20;

    while (delivered < payload.quantity && !rotation.isFullyExhausted && roundsLeft-- > 0) {
      for (const country of rotation.round()) {
        if (delivered >= payload.quantity) break;

        const remaining = payload.quantity - delivered;
        const chunk = rotation.chunkSize(remaining);
        // Same over-ask rationale as before: channel filtering/validation
        // below discards a fraction of what streams back.
        const askFor = Math.max(chunk * 4, chunk);

        let countryExhausted = false;
        let deliveredThisChunk = 0;

        for await (const lead of runEngineQuery(
          {
            query: singleNiche,
            city: country.name,
            country: country.code,
            niche: singleNiche,
            region: payload.region,
            max_results: askFor,
            db_path: `data/leads-${payload.userId}.db`,
          },
          abortController.signal,
          (info) => {
            countryExhausted = info.exhausted;
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
            deliveredThisChunk += 1;
          }

          await supabaseAdmin.from("scrape_jobs").update({ results_count: newForUser, status: "streaming" }).eq("id", payload.scrapeJobId);

          if (result.limitReached) {
            console.log(`[discoverJob] user=${payload.userId} hit their plan limit mid-run — stopping early`);
            sawLimitReached = true;
            abortController.abort();
            break outer;
          }

          if (delivered >= payload.quantity || deliveredThisChunk >= chunk) {
            break; // this country's chunk (or the whole request) is satisfied — move on
          }
        }

        if (countryExhausted) {
          rotation.markExhausted(country);
        }
      }
    }

    if (delivered >= payload.quantity) {
      abortController.abort();
      break;
    }
  }

  const exhaustedEverySearchVariation = delivered < payload.quantity && !sawLimitReached;
  console.log(
    `[discoverJob] live user=${payload.userId} region=${payload.region} niches=${JSON.stringify(niches)} ` +
      `countries=${JSON.stringify(countries.map((c: CountryInfo) => c.code))} ` +
      `requested=${payload.quantity} delivered=${delivered} newForUser=${newForUser} ` +
      `exhaustedEverySearchVariation=${exhaustedEverySearchVariation}`,
  );
}
