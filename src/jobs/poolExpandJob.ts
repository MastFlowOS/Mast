import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineQuery } from "../scraperBridge/pythonBridge.js";
import { deliverLead } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { validateLead } from "../lib/leadValidation.js";
import { resolveCountriesForSelection, CountryRotation } from "../lib/geo/regions.js";
import type { CountryInfo } from "../lib/geo/countries.js";

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
  /** Target currencies, if any — see src/lib/geo/regions.ts. */
  currencies?: string[];
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
 *  3. The engine is asked for generous headroom per niche/country and the
 *     loop keeps going until `shortfall` is actually met or every
 *     niche/country combination genuinely exhausts (engine
 *     `onDone.exhausted`), instead of stopping after one under-sized
 *     engine call.
 *
 * ARCHITECTURE FIX (this pass): same as discoverJob.ts — `region` is
 * expanded into real countries via resolveCountriesForSelection() (never
 * searched literally), distributed across those countries with
 * CountryRotation so one country can't dominate the pool, and — if
 * `currencies` was provided — narrowed to countries where a discovered
 * business can realistically pay in that currency. `payload.region` is
 * still passed through to deliverLead/pool storage unchanged.
 */
// CONSUMER-POLICY FIX: see matching comment in discoverJob.ts. Same thrash —
// killing the subprocess the instant the raw fairness `chunk` was reached
// (often 1) — happens here via the identical chunk-consumption pattern, so
// it gets the identical fix: a streaming batch floor decoupled from the
// per-round fairness accounting.
const STREAM_BATCH_FLOOR = 5;

export async function handlePoolExpandJob(payload: PoolExpandJobPayload): Promise<void> {
  const { followUp } = payload;
  const niches = splitNicheQuery(payload.niche);
  const countries = resolveCountriesForSelection(payload.region, { currencies: payload.currencies });
  const jobStartedAt = Date.now();

  let delivered = 0; // total businesses newly added to the pool (all niches)
  let newForUser = 0; // of those, how many were credited/delivered to followUp.userId

  if (followUp) {
    await supabaseAdmin.from("scrape_jobs")
      .update({ status: "streaming" })
      .eq("id", followUp.scrapeJobId)
      .not("status", "eq", "cancelled");
  }

  if (countries.length === 0) {
    console.error(`[poolExpandJob] no countries resolved for region=${JSON.stringify(payload.region)} — nothing to search`);
    if (followUp) {
      await supabaseAdmin.from("scrape_jobs").update({
        status: "completed_partial",
        completed_at: new Date().toISOString(),
        job_summary: { requested: payload.shortfall, delivered: 0, shortfall: payload.shortfall, completion_reason: "no_countries", runtime_ms: 0 },
      }).eq("id", followUp.scrapeJobId);
    }
    return;
  }

  const abortController = new AbortController();
  // The target this run is actually trying to satisfy: for a followUp,
  // that's "give this user `shortfall` more NEW deliveries"; for a bare
  // pool-growth run (no followUp), it's "add `shortfall` more businesses
  // to the pool" — there's no per-user channel filter to apply in that
  // case, so every delivered (deduped) business counts.
  const target = payload.shortfall;

  try {
    const stillNeededNow = () => (followUp ? payload.shortfall - newForUser : payload.shortfall - delivered);

    outer: for (const singleNiche of niches) {
      if (stillNeededNow() <= 0) break;

      const rotation = new CountryRotation(countries);
      let roundsLeft = countries.length * 6 + 20;

      while (stillNeededNow() > 0 && !rotation.isFullyExhausted && roundsLeft-- > 0) {
        for (const { country, city } of rotation.round()) {
          const remaining = stillNeededNow();
          if (remaining <= 0) break;

          const chunk = rotation.chunkSize(remaining); // fairness share — diversity accounting only
          // Streaming target for THIS spawned process — see discoverJob.ts.
          const streamTarget = Math.min(remaining, Math.max(chunk, STREAM_BATCH_FLOOR));
          const askFor = Math.max(streamTarget * 4, target);

          let citySearchExhausted = false;
          let deliveredThisChunk = 0;

          for await (const lead of runEngineQuery(
            {
              query: singleNiche,
              city, // ROOT CAUSE FIX: a real city (e.g. "Lagos"), never country.name
              country: country.code,
              niche: singleNiche,
              region: payload.region,
              max_results: askFor,
              db_path: `data/leads-pool-expand.db`,
            },
            abortController.signal,
            (info) => {
              citySearchExhausted = info.exhausted;
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
            deliveredThisChunk += 1;
            if (result.wasNewForUser) newForUser += 1;

            if (followUp) {
              // Guard: if the job was cancelled while we were running, stop.
              const { data: jobStatus } = await supabaseAdmin.from("scrape_jobs")
                .select("status").eq("id", followUp.scrapeJobId).maybeSingle();
              if (jobStatus?.status === "cancelled") {
                abortController.abort();
                break outer;
              }

              await supabaseAdmin.from("scrape_jobs")
                .update({ results_count: newForUser })
                .eq("id", followUp.scrapeJobId)
                .not("status", "eq", "cancelled");

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

            if (deliveredThisChunk >= streamTarget) {
              break; // this process has delivered its streaming batch for this round — move on
            }
          }

          if (citySearchExhausted) {
            // Advances to this country's next city; only drops the whole
            // country once every one of its cities is exhausted.
            rotation.markCurrentSearchExhausted(country);
          }
        }
      }
    }

    // Determine final status and write summary metrics.
    if (followUp) {
      const { data: finalRow } = await supabaseAdmin.from("scrape_jobs")
        .select("status").eq("id", followUp.scrapeJobId).maybeSingle();
      const wasCancelled = finalRow?.status === "cancelled";

      const completionReason = wasCancelled
        ? "cancelled"
        : newForUser >= payload.shortfall
          ? "quantity_reached"
          : "exhausted";

      const finalStatus = wasCancelled
        ? "cancelled"
        : newForUser >= payload.shortfall
          ? "completed"
          : "completed_partial";

      await supabaseAdmin.from("scrape_jobs").update({
        status: finalStatus,
        completed_at: new Date().toISOString(),
        job_summary: {
          requested: payload.shortfall,
          delivered: newForUser,
          shortfall: Math.max(0, payload.shortfall - newForUser),
          completion_reason: completionReason,
          runtime_ms: Date.now() - jobStartedAt,
        },
      }).eq("id", followUp.scrapeJobId);
    }

  } catch (err) {
    if (followUp) {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err), completed_at: new Date().toISOString() })
        .eq("id", followUp.scrapeJobId)
        .not("status", "eq", "cancelled"); // preserve cancellation even on error
    }
    throw err;
  }

  console.log(
    `[poolExpandJob] region=${payload.region} niches=${JSON.stringify(niches)} ` +
      `countries=${JSON.stringify(countries.map((c: CountryInfo) => c.code))} shortfall=${payload.shortfall} ` +
      `delivered=${delivered}${followUp ? ` newForUser=${newForUser} (followUp for user=${followUp.userId})` : ""}`,
  );
}
