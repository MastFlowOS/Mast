import { supabaseAdmin } from "../lib/supabase.js";
import { computeOpportunityScores, type ScorableBusiness } from "./opportunityScore.js";
import { PROFESSION_SLUGS } from "./professionWeights.js";

/**
 * Computes the Opportunity Score for all 12 professions for one business
 * and upserts them into `business_opportunity_scores` — the table
 * `pool_lookup()` (migrations/003_pool_lookup.sql) already joins against
 * for `instant_pool_ranked`. No SQL changes were needed for ranking to
 * start working; it was always reading this table, which Phase 6 is the
 * first phase to actually populate.
 *
 * Scored once per (business, profession) pair, NOT per user — the same
 * cached score is reused by every freelancer sharing a profession, per the
 * doc's Global Lead Pool design.
 */
export async function computeAndStoreOpportunityScores(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select("website, instagram, facebook, has_photos, reviews_count, reviews_rating, is_disqualified, signals")
    .eq("id", businessId)
    .single();
  if (error) throw error;

  const scores = computeOpportunityScores(business as ScorableBusiness);

  const rows = PROFESSION_SLUGS.map((slug) => ({
    business_id: businessId,
    profession_slug: slug,
    opportunity_score: scores[slug].score,
    score_breakdown: scores[slug].breakdown,
    computed_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabaseAdmin
    .from("business_opportunity_scores")
    .upsert(rows, { onConflict: "business_id,profession_slug" });
  if (upsertError) throw upsertError;
}
