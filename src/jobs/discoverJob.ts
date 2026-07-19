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
 *
 * ROOT CAUSE FIX (this pass): the ARCHITECTURE FIX above only got the
 * region→country expansion right; it still handed `country.name` (e.g.
 * "United States", "Canada", "Mexico") to the engine as `city`, so every
 * search was really "<niche> in United States" — a query Google Maps has
 * no normal per-listing results feed for. Instead of the usual bounded
 * results panel, Maps tries to cluster/render a nationwide result set with
 * no natural cap, and with no resource blocking in the scraper, that grew
 * the Playwright page's memory until Chromium's renderer OOM-crashed
 * ("Target crashed"), surfacing on whatever Playwright call happened to
 * run next (`page.query_selector_all`, per the reported traceback) —
 * nothing to do with that selector itself. Fix:
 *   - `CountryInfo` (src/lib/geo/countries.ts) now carries `majorCities`,
 *     each country's 3 largest real, Maps-searchable cities.
 *   - `CountryRotation.round()` now yields `{ country, city }` pairs using
 *     the country's CURRENT city, instead of the bare `CountryInfo`.
 *   - `country.name` is never sent to the engine again — only real city
 *     names are.
 *   - `markExhausted()` → `markCurrentSearchExhausted()`: a city's own
 *     exhaustion now advances the rotation to that country's NEXT city;
 *     the whole country is only dropped once every one of its cities has
 *     been exhausted, so a single small city no longer prematurely drops
 *     an entire country from the rotation the way one crash used to end
 *     the whole run.
 */
// CONSUMER-POLICY FIX: a spawned discovery subprocess is a long-lived
// streaming producer, not a disposable one-shot worker — killing it the
// instant CountryRotation.chunkSize()'s *fairness* share (often just 1) is
// reached was thrashing Playwright restarts on every single lead. This
// floor decouples "how many leads is this city fairly owed this round"
// (still `chunk`, used for diversity accounting) from "how many leads must
// actually drain from this one process before we're allowed to rotate away"
// (`Math.max(chunk, STREAM_BATCH_FLOOR)`, capped by what's still remaining
// overall). Legitimate stop conditions — quantity/shortfall satisfied,
// cancellation, plan limit, engine-reported exhaustion — are untouched and
// still take effect immediately.
const STREAM_BATCH_FLOOR = 5;

export async function handleDiscoverJob(payload: DiscoverJobPayload): Promise<void> {
  const niches = splitNicheQuery(payload.niche);
  const countries = resolveCountriesForSelection(payload.region, { currencies: payload.currencies });
  const jobStartedAt = Date.now();

  if (countries.length === 0) {
    console.error(`[discoverJob] no countries resolved for region=${JSON.stringify(payload.region)} — nothing to search`);
    await supabaseAdmin.from("scrape_jobs").update({
      status: "completed_partial",
      completed_at: new Date().toISOString(),
      job_summary: { requested: payload.quantity, delivered: 0, shortfall: payload.quantity, completion_reason: "no_countries", runtime_ms: 0 },
    }).eq("id", payload.scrapeJobId);
    return;
  }

  let delivered = 0; // channel-passing, validated, requested-worth deliveries
  let newForUser = 0;
  let sawLimitReached = false;

  // ── Instrumentation: every engine-yielded lead is counted exactly once
  // here, plus a tally of exactly why it didn't make it to delivery, so a
  // "N discovered, 0 delivered" report can be traced to a precise stage
  // instead of just "filtered." ──────────────────────────────────────────
  let engineYielded = 0;
  const rejectionCounts: Record<string, number> = {};
  let alreadyOwnedByUser = 0;
  let insertedCount = 0;

  const recordRejection = (reason: string) => {
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
  };

  const abortController = new AbortController();

  outer: for (const singleNiche of niches) {
    if (delivered >= payload.quantity) break;

    const rotation = new CountryRotation(countries);
    // Safety valve so a pathological "every country reports not-exhausted
    // but yields nothing" case can't loop forever — normal completion is
    // always via quantity reached or rotation.isFullyExhausted.
    let roundsLeft = countries.length * 6 + 20;

    while (delivered < payload.quantity && !rotation.isFullyExhausted && roundsLeft-- > 0) {
      for (const { country, city } of rotation.round()) {
        if (delivered >= payload.quantity) break;

        const remaining = payload.quantity - delivered;
        const chunk = rotation.chunkSize(remaining); // fairness share — diversity accounting only
        // Streaming target for THIS spawned process: at least the fairness
        // share, but never so small that we pay a full browser startup for
        // a single lead — and never more than what's still actually needed.
        const streamTarget = Math.min(remaining, Math.max(chunk, STREAM_BATCH_FLOOR));
        // Same over-ask rationale as before: channel filtering/validation
        // below discards a fraction of what streams back.
        const askFor = Math.max(streamTarget * 4, streamTarget);

        let citySearchExhausted = false;
        let deliveredThisChunk = 0;

        for await (const lead of runEngineQuery(
          {
            query: singleNiche,
            city, // ROOT CAUSE FIX: a real city (e.g. "Toronto"), never country.name
            country: country.code,
            niche: singleNiche,
            region: payload.region,
            max_results: askFor,
            db_path: `data/leads-${payload.userId}.db`,
          },
          abortController.signal,
          (info) => {
            citySearchExhausted = info.exhausted;
            console.log(
              `[discoverJob] [trace] engine onDone for ${city}/${country.code} — ` +
                `delivered=${info.delivered} requested=${info.requested} exhausted=${info.exhausted}`,
            );
          },
        )) {
          engineYielded += 1;
          const leadName = JSON.stringify(lead.name);
          console.log(`[discoverJob] [trace] ${leadName} \u2193 received from engine (city=${city})`);

          if (!channelsSatisfied(lead, payload.channels)) {
            recordRejection(`failed channel requirement (needed ${JSON.stringify(payload.channels)})`);
            console.log(
              `[discoverJob] [trace] ${leadName} \u2193 REJECTED — failed channel filter ` +
                `(requested=${JSON.stringify(payload.channels)} ` +
                `has={email:${!!lead.email},phone:${!!lead.phone},instagram:${!!lead.instagram},website:${!!lead.website}})`,
            );
            continue; // doesn't satisfy every requested channel — not counted, keep streaming
          }
          console.log(`[discoverJob] [trace] ${leadName} \u2193 PASSED channel filter`);

          const validation = validateLead(lead);
          if (!validation.valid) {
            recordRejection(`validation failed: ${validation.reason}`);
            console.log(`[discoverJob] [trace] ${leadName} \u2193 REJECTED — validation failed reason=${validation.reason}`);
            continue;
          }
          console.log(`[discoverJob] [trace] ${leadName} \u2193 PASSED validation`);

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

          if (result.limitReached) {
            recordRejection("daily/monthly plan limit reached");
            console.log(
              `[discoverJob] [trace] ${leadName} \u2193 REJECTED — plan limit reached ` +
                `(dailyLimit=${payload.dailyLimit} monthlyLimit=${payload.monthlyLimit})`,
            );
          } else if (!result.wasNewForUser) {
            alreadyOwnedByUser += 1;
            recordRejection("duplicate (already delivered to this user)");
            console.log(`[discoverJob] [trace] ${leadName} \u2193 REJECTED — duplicate, user already has businessId=${result.businessId}`);
          } else {
            insertedCount += 1;
            console.log(`[discoverJob] [trace] ${leadName} \u2193 PASSED delivery — inserted businessId=${result.businessId}`);
          }

          if (result.wasNewForUser) {
            delivered += 1;
            newForUser += 1;
            deliveredThisChunk += 1;
          }

          // ── Per-lead cancellation check ────────────────────────────────────
          // The user may have cancelled mid-run; abort cleanly without marking
          // the job failed — it simply stops delivering and closes as cancelled.
          const { data: jobRow } = await supabaseAdmin.from("scrape_jobs")
            .select("status").eq("id", payload.scrapeJobId).maybeSingle();
          if (jobRow?.status === "cancelled") {
            console.log(`[discoverJob] user=${payload.userId} cancelled mid-run — aborting`);
            abortController.abort();
            break outer;
          }

          await supabaseAdmin.from("scrape_jobs")
            .update({ results_count: newForUser, status: "streaming" })
            .eq("id", payload.scrapeJobId)
            .not("status", "eq", "cancelled");

          if (result.limitReached) {
            console.log(`[discoverJob] user=${payload.userId} hit their plan limit mid-run — stopping early`);
            sawLimitReached = true;
            abortController.abort();
            break outer;
          }

          if (delivered >= payload.quantity || deliveredThisChunk >= streamTarget) {
            break; // this process has delivered its streaming batch (or the whole request is done) — move on
          }
        }

        if (citySearchExhausted) {
          // Advances to this country's next city; only drops the whole
          // country once every one of its cities has been exhausted.
          rotation.markCurrentSearchExhausted(country);
        }
      }
    }

    if (delivered >= payload.quantity) {
      abortController.abort();
      break;
    }
  }

  // ── Determine completion reason and final status ─────────────────────────
  const { data: finalJobRow } = await supabaseAdmin.from("scrape_jobs")
    .select("status").eq("id", payload.scrapeJobId).maybeSingle();
  const wasCancelled = finalJobRow?.status === "cancelled";

  const completionReason = wasCancelled
    ? "cancelled"
    : sawLimitReached
      ? "limit_reached"
      : delivered >= payload.quantity
        ? "quantity_reached"
        : "exhausted";

  const finalStatus = wasCancelled
    ? "cancelled"
    : delivered >= payload.quantity
      ? "completed"
      : "completed_partial";

  const jobSummary = {
    requested: payload.quantity,
    delivered,
    shortfall: Math.max(0, payload.quantity - delivered),
    duplicates: alreadyOwnedByUser,
    completion_reason: completionReason,
    runtime_ms: Date.now() - jobStartedAt,
  };

  // runJob() in workers/index.ts will set status='completed' after this
  // function returns (it only knows about scrapeJobId for the legacy
  // discover.live queue). We write the real terminal status here first;
  // workers/index.ts is patched to not overwrite a non-streaming status.
  await supabaseAdmin.from("scrape_jobs").update({
    status: finalStatus,
    results_count: newForUser,
    completed_at: new Date().toISOString(),
    job_summary: jobSummary,
  }).eq("id", payload.scrapeJobId);

  const exhaustedEverySearchVariation = delivered < payload.quantity && !sawLimitReached;
  console.log(
    `[discoverJob] live user=${payload.userId} region=${payload.region} niches=${JSON.stringify(niches)} ` +
      `countries=${JSON.stringify(countries.map((c: CountryInfo) => c.code))} ` +
      `requested=${payload.quantity} delivered=${delivered} newForUser=${newForUser} ` +
      `exhaustedEverySearchVariation=${exhaustedEverySearchVariation}`,
  );

  // ── Final rejection summary — in the requested shape:
  //      N discovered
  //      X rejected because <reason>
  //      1 duplicate
  //      1 inserted
  const summaryLines = [`${engineYielded} discovered (received from engine)`];
  for (const [reason, count] of Object.entries(rejectionCounts).sort((a, b) => b[1] - a[1])) {
    summaryLines.push(`${count} rejected because ${reason}`);
  }
  summaryLines.push(`${insertedCount} inserted`);
  const accountedFor = Object.values(rejectionCounts).reduce((a, b) => a + b, 0) + insertedCount;
  if (accountedFor !== engineYielded) {
    summaryLines.push(
      `⚠️  UNACCOUNTED: ${engineYielded} received from engine but only ${accountedFor} ` +
        `accounted for — ${engineYielded - accountedFor} lead(s) vanished from the ` +
        `discoverJob loop without hitting a logged exit point (check for an ` +
        `unlogged \`continue\`/\`break\` or a thrown exception mid-loop).`,
    );
  }
  console.log(`[discoverJob] rejection summary:\n${summaryLines.join("\n")}`);
  if (alreadyOwnedByUser > 0) {
    console.log(
      `[discoverJob] note: ${alreadyOwnedByUser} lead(s) were rejected as "duplicate" because this exact ` +
        `business was already in this user's CRM (leads table) from a previous run — this is expected on ` +
        `repeat runs against the same user/region/niche, not a bug by itself.`,
    );
  }
}
