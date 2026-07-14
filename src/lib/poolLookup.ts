import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { insertLeadForUser, type PoolBusiness } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";

export type PoolLookupParams = {
  userId: string;
  region: string;
  niche: string;
  professionSlug: string | null;
  rank: boolean;
  quantity: number;
  scrapeJobId: string;
  dailyLimit: number;
  monthlyLimit: number;
  /** Channels the user requested — see channelFilter.ts. Empty = no filter. */
  channels: string[];
};

export type PoolLookupResult = {
  delivered: Array<{ businessId: string; opportunityScore: number | null }>;
  shortfall: number;
  /** true if the stop was actually the plan limit, not just an empty pool */
  limitReached: boolean;
};

/**
 * Instant Discovery's actual "check the pool first" step. One SQL round
 * trip per niche (see migrations/003_pool_lookup.sql) finds matching
 * businesses this user doesn't already have, then each match is delivered
 * into `leads` via the same insertLeadForUser() the scrape path uses — so
 * credit charging and CRM-row shape are identical regardless of whether a
 * result came from the pool or a fresh scrape.
 *
 * PHASE 5: if insertLeadForUser reports the plan limit was hit partway
 * through delivering matches, the remaining matches are simply not
 * delivered — same treatment as a pool shortfall, so the response shape
 * doesn't need a third state. The route decides what "shortfall" should
 * trigger (background expand) regardless of which reason produced it.
 *
 * PRODUCT-QUALITY PASS (this file):
 *
 *  - Multiple niches: `pool_lookup()`'s `p_niche` filter is a plain
 *    `ilike '%p_niche%'` against `businesses.niche`, which holds a SINGLE
 *    niche per row (e.g. "Bakery"). Passing it the frontend's comma-joined
 *    "Bakery, Coffee" as one string matched almost nothing, because no
 *    business's niche column literally contains that whole substring. Per
 *    scope, the SQL function itself isn't touched (migrations are
 *    off-limits) — instead this now calls `pool_lookup` ONCE PER niche
 *    (splitNicheQuery) and unions the matches (OR semantics), exactly the
 *    same fix pattern as the live-discovery jobs.
 *
 *  - Channel filters: `channels` was previously not even a parameter here,
 *    so Instant Discovery ignored them entirely. `pool_lookup()` can't
 *    filter by channel either (same migrations restriction), so this
 *    over-fetches from the pool (a generous multiple of `quantity`) and
 *    applies `channelsSatisfied()` client-side before capping at
 *    `quantity` — so a channel-filtered request that depletes the pool's
 *    first batch of matches still gets everything the pool actually has to
 *    offer, not just the first `quantity` rows regardless of fit.
 */
export async function lookupAndDeliverFromPool(params: PoolLookupParams): Promise<PoolLookupResult> {
  const niches = splitNicheQuery(params.niche);
  const hasChannelFilter = params.channels.length > 0;
  // Over-fetch to leave room for channel-filter attrition — pool_lookup
  // can't apply that filter itself, so we ask for more candidates than we
  // need and prune locally. 5x is a conservative buffer; genuinely thin
  // pools still correctly fall through to `shortfall` below.
  const perNicheLimit = hasChannelFilter ? params.quantity * 5 : params.quantity;

  const matchesByBusinessId = new Map<string, { business_id: string; opportunity_score: number | null }>();

  for (const singleNiche of niches) {
    const { data: matches, error } = await supabaseAdmin.rpc("pool_lookup", {
      p_user_id: params.userId,
      p_region: params.region,
      p_niche: singleNiche,
      p_profession_slug: params.professionSlug,
      p_rank: params.rank,
      p_limit: perNicheLimit,
    });
    if (error) throw error;

    for (const row of (matches ?? []) as Array<{ business_id: string; opportunity_score: number | null }>) {
      if (!matchesByBusinessId.has(row.business_id)) {
        matchesByBusinessId.set(row.business_id, row);
      }
    }
  }

  const rows = Array.from(matchesByBusinessId.values());
  if (rows.length === 0) {
    return { delivered: [], shortfall: params.quantity, limitReached: false };
  }

  const { data: businesses, error: bizError } = await supabaseAdmin
    .from("businesses")
    .select("id, name, niche, address, website, email, phone, instagram")
    .in(
      "id",
      rows.map((r) => r.business_id),
    );
  if (bizError) throw bizError;

  const businessById = new Map<string, PoolBusiness>((businesses ?? []).map((b) => [b.id, b as PoolBusiness]));

  const delivered: PoolLookupResult["delivered"] = [];
  let limitReached = false;

  for (const row of rows) {
    if (delivered.length >= params.quantity) break;

    const business = businessById.get(row.business_id);
    if (!business) continue; // shouldn't happen, but don't let one bad row fail the whole batch

    if (!channelsSatisfied(business, params.channels)) {
      continue; // doesn't satisfy every requested channel — skip without counting
    }

    const result = await insertLeadForUser(business, {
      userId: params.userId,
      professionSlug: params.professionSlug,
      discoveryMode: params.rank ? "instant_pool_ranked" : "instant_pool",
      scrapeJobId: params.scrapeJobId,
      opportunityScore: row.opportunity_score,
      dailyLimit: params.dailyLimit,
      monthlyLimit: params.monthlyLimit,
    });

    if (result.limitReached) {
      limitReached = true;
      break; // no point checking further matches — the same limit still applies
    }

    // wasNewForUser should always be true here — pool_lookup already
    // excludes businesses this user has. A false would mean a race with
    // another concurrent request for the same user; harmless, just don't
    // count it twice.
    if (result.wasNewForUser) {
      delivered.push({ businessId: row.business_id, opportunityScore: row.opportunity_score });
    }
  }

  return { delivered, shortfall: Math.max(0, params.quantity - delivered.length), limitReached };
}
