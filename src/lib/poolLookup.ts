import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { insertLeadForUser, type PoolBusiness } from "../scraperBridge/deliverLead.js";
import { splitNicheQuery } from "../lib/niches.js";
import { channelsSatisfied } from "../lib/channelFilter.js";
import { COUNTRIES, REGION_NAMES } from "./geo/countries.js";
import { parseGeoScope } from "./geo/scope.js";

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

/** One `pool_lookup()` call's geographic arguments. */
export type PoolScope = {
  /** Legacy free-text label match against businesses.region ('' = no label match). */
  region: string;
  /** ISO codes matched against businesses.country_code (null = none). */
  countryCodes: string[] | null;
  /** true → match ONLY on country_code (an explicit country selection). */
  countryStrict: boolean;
};

/**
 * Turns the request's scope tokens into pool_lookup() calls:
 *
 *  - COUNTRY token(s) → ONE strict call on businesses.country_code. Never
 *    matched by label, never widened to the continent: "Canada" cannot return
 *    a US business and vice-versa.
 *  - CONTINENT token → the legacy label match (businesses.region ilike) OR
 *    any business whose country_code is on that continent, so rows stored
 *    before country_code existed keep matching exactly as before, and rows
 *    discovered under a country selection are still visible to continent
 *    searches (a strict superset of the old behavior).
 *  - Global → same, over every country.
 *
 * A region with no recognizable token falls back to the raw legacy label so
 * behavior for unexpected input is unchanged.
 */
export function poolScopesFor(regionField: string): PoolScope[] {
  const scope = parseGeoScope(regionField);
  const scopes: PoolScope[] = [];

  if (scope.global) {
    scopes.push({ region: "Global", countryCodes: COUNTRIES.map((c) => c.code), countryStrict: false });
  } else {
    for (const continent of scope.continents) {
      if (!REGION_NAMES.includes(continent)) continue;
      scopes.push({
        region: continent,
        countryCodes: COUNTRIES.filter((c) => c.region === continent).map((c) => c.code),
        countryStrict: false,
      });
    }
    if (scope.countries.length > 0) {
      scopes.push({ region: "", countryCodes: scope.countries.map((c) => c.code), countryStrict: true });
    }
  }

  return scopes.length > 0 ? scopes : [{ region: regionField, countryCodes: null, countryStrict: false }];
}

/**
 * How faithfully the delivered set honors Opportunity Score ordering.
 *
 * FALLBACK POLICY ("unscored_last"): a candidate with no Opportunity Score for
 * this user's profession is still ELIGIBLE (ranking never changes eligibility)
 * but is ordered after every scored candidate, keeping pool_lookup's own
 * recency order among the unscored. The result is only called fully ranked
 * when every delivered lead has a score.
 */
export type PoolRanking = {
  requested: boolean;
  /**
   *  not_requested — plain Instant Pool, no ordering promised
   *  full          — every delivered lead has a score; order is by score desc
   *  partial       — some delivered leads have no score (placed last)
   *  unavailable   — ranking could not be computed (no profession focus set)
   */
  status: "not_requested" | "full" | "partial" | "unavailable";
  scored: number;
  unscored: number;
  policy: "unscored_last";
  reason: "no_profession_focus" | null;
};

export type PoolLookupResult = {
  delivered: Array<{ businessId: string; opportunityScore: number | null }>;
  shortfall: number;
  /** true if the stop was actually the plan limit, not just an empty pool */
  limitReached: boolean;
  /** distinct eligible candidates retrieved (bounded by the query limit) */
  candidates: number;
  skipped: { missingBusiness: number; channelMismatch: number; alreadyOwned: number };
  ranking: PoolRanking;
  /**
   * Set when delivery stopped on an unexpected error AFTER some leads may
   * already have been saved and charged. `delivered` still lists exactly what
   * was saved, so the caller can report and reconcile it truthfully.
   */
  interrupted: { message: string } | null;
};

type PoolCandidate = { business_id: string; opportunity_score: number | null; discoveryNiche: string };

/**
 * Global Opportunity Score ordering across ALL niche/scope result sets.
 * pool_lookup() ranks within one call only, so concatenating per-niche results
 * used to leave the final order dependent on niche order. Stable sort:
 * score desc, unscored last, ties keep retrieval order (niche order, then
 * pool_lookup's recency order).
 */
export function rankPoolCandidates<T extends { opportunity_score: number | null }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = a.row.opportunity_score;
      const sb = b.row.opportunity_score;
      if (sa === null && sb === null) return a.index - b.index;
      if (sa === null) return 1;
      if (sb === null) return -1;
      if (sa !== sb) return sb - sa;
      return a.index - b.index;
    })
    .map((x) => x.row);
}

export function summarizePoolRanking(
  rank: boolean,
  professionSlug: string | null,
  delivered: Array<{ opportunityScore: number | null }>,
): PoolRanking {
  const scored = delivered.filter((d) => d.opportunityScore !== null).length;
  const unscored = delivered.length - scored;
  const base = { requested: rank, scored, unscored, policy: "unscored_last" as const };
  if (!rank) return { ...base, status: "not_requested", reason: null };
  if (!professionSlug) return { ...base, status: "unavailable", reason: "no_profession_focus" };
  return { ...base, status: unscored === 0 ? "full" : "partial", reason: null };
}

/**
 * Instant Discovery's "pool only" step. One SQL round trip per niche/scope
 * (see migrations/003 + 034 + 037) finds matching businesses this user doesn't
 * already have, then each match is delivered into `leads` via the same
 * insertLeadForUser() the live path uses — so credit charging and CRM-row
 * shape are identical regardless of where a result came from.
 *
 * This function NEVER starts live scraping and never queues background work;
 * a shortfall is returned to the caller as a shortfall.
 *
 *  - Multiple niches: `pool_lookup()` is called once per niche/scope and the
 *    matches are unioned (OR semantics). Each business is attributed to the
 *    FIRST niche (request order) that matched it.
 *  - Channel filters: AND semantics, applied inside SQL before ORDER/LIMIT
 *    (migration 037); `channelsSatisfied()` is a final safeguard.
 *  - Ranking (rank=true): the union is re-ordered GLOBALLY by Opportunity
 *    Score (rankPoolCandidates). Ranking only affects order, never eligibility.
 *  - Plan limit hit mid-delivery: remaining matches are not delivered and
 *    `limitReached` is set.
 *  - Unexpected error mid-delivery: leads already saved (and charged) are
 *    returned in `delivered` with `interrupted` set, instead of being lost.
 */
export async function lookupAndDeliverFromPool(params: PoolLookupParams): Promise<PoolLookupResult> {
  const niches = splitNicheQuery(params.niche);
  const scopes = poolScopesFor(params.region);
  // Over-fetch only when several niche/scope result sets are unioned, to leave
  // room for the same business appearing in more than one before de-duping.
  const perNicheLimit = niches.length > 1 || scopes.length > 1 ? params.quantity * 5 : params.quantity;

  const matchesByBusinessId = new Map<string, PoolCandidate>();

  for (const singleNiche of niches) {
    for (const scope of scopes) {
      const { data: matches, error } = await supabaseAdmin.rpc("pool_lookup", {
        p_user_id: params.userId,
        p_region: scope.region,
        p_niche: singleNiche,
        p_profession_slug: params.professionSlug,
        p_rank: params.rank,
        p_limit: perNicheLimit,
        p_country_codes: scope.countryCodes,
        p_country_strict: scope.countryStrict,
        // Apply the AND channel requirements in SQL before its LIMIT, so
        // incomplete recent rows cannot hide older eligible businesses.
        p_channels: params.channels,
      });
      if (error) throw error;

      for (const row of (matches ?? []) as Array<{ business_id: string; opportunity_score: number | null }>) {
        if (!matchesByBusinessId.has(row.business_id)) {
          matchesByBusinessId.set(row.business_id, { ...row, discoveryNiche: singleNiche });
        }
      }
    }
  }

  const retrieved = Array.from(matchesByBusinessId.values());
  const rows = params.rank ? rankPoolCandidates(retrieved) : retrieved;
  const skipped = { missingBusiness: 0, channelMismatch: 0, alreadyOwned: 0 };
  const delivered: PoolLookupResult["delivered"] = [];
  let limitReached = false;
  let interrupted: PoolLookupResult["interrupted"] = null;

  if (rows.length > 0) {
    const { data: businesses, error: bizError } = await supabaseAdmin
      .from("businesses")
      .select("id, name, niche, address, website, email, phone, instagram")
      .in(
        "id",
        rows.map((r) => r.business_id),
      );
    if (bizError) throw bizError;

    const businessById = new Map<string, PoolBusiness>((businesses ?? []).map((b) => [b.id, b as PoolBusiness]));

    try {
      for (const row of rows) {
        if (delivered.length >= params.quantity) break;

        const business = businessById.get(row.business_id);
        if (!business) {
          skipped.missingBusiness += 1;
          continue;
        }

        if (!channelsSatisfied(business, params.channels)) {
          skipped.channelMismatch += 1;
          continue;
        }

        const result = await insertLeadForUser(
          business,
          {
            userId: params.userId,
            professionSlug: params.professionSlug,
            discoveryMode: params.rank ? "instant_pool_ranked" : "instant_pool",
            scrapeJobId: params.scrapeJobId,
            opportunityScore: row.opportunity_score,
            dailyLimit: params.dailyLimit,
            monthlyLimit: params.monthlyLimit,
          },
          // The requested niche that matched this business — NOT business.niche.
          { discoveryNiche: row.discoveryNiche },
        );

        if (result.limitReached) {
          limitReached = true;
          break; // the same plan limit applies to every remaining match
        }

        if (result.wasNewForUser) {
          delivered.push({ businessId: row.business_id, opportunityScore: row.opportunity_score });
        } else {
          // Race with a concurrent request for the same user; the credit
          // reservation was already refunded by insertLeadForUser.
          skipped.alreadyOwned += 1;
        }
      }
    } catch (err) {
      interrupted = { message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    delivered,
    shortfall: Math.max(0, params.quantity - delivered.length),
    limitReached,
    candidates: rows.length,
    skipped,
    ranking: summarizePoolRanking(params.rank, params.professionSlug, delivered),
    interrupted,
  };
}
