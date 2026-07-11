import { supabaseAdmin } from "../lib/supabase.js";
import { insertLeadForUser, type PoolBusiness } from "../scraperBridge/deliverLead.js";

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
};

export type PoolLookupResult = {
  delivered: Array<{ businessId: string; opportunityScore: number | null }>;
  shortfall: number;
  /** true if the stop was actually the plan limit, not just an empty pool */
  limitReached: boolean;
};

/**
 * Instant Discovery's actual "check the pool first" step. One SQL round
 * trip (see migrations/003_pool_lookup.sql) finds matching businesses this
 * user doesn't already have, then each match is delivered into `leads` via
 * the same insertLeadForUser() the scrape path uses — so credit charging
 * and CRM-row shape are identical regardless of whether a result came from
 * the pool or a fresh scrape.
 *
 * PHASE 5: if insertLeadForUser reports the plan limit was hit partway
 * through delivering matches, the remaining matches are simply not
 * delivered — same treatment as a pool shortfall, so the response shape
 * doesn't need a third state. The route decides what "shortfall" should
 * trigger (background expand) regardless of which reason produced it.
 */
export async function lookupAndDeliverFromPool(params: PoolLookupParams): Promise<PoolLookupResult> {
  const { data: matches, error } = await supabaseAdmin.rpc("pool_lookup", {
    p_user_id: params.userId,
    p_region: params.region,
    p_niche: params.niche,
    p_profession_slug: params.professionSlug,
    p_rank: params.rank,
    p_limit: params.quantity,
  });
  if (error) throw error;

  const rows = (matches ?? []) as Array<{ business_id: string; opportunity_score: number | null }>;
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
    const business = businessById.get(row.business_id);
    if (!business) continue; // shouldn't happen, but don't let one bad row fail the whole batch

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
