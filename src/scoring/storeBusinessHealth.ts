import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { computeBusinessHealth, type HealthScorableBusiness } from "./businessHealth.js";

/**
 * Computes the Business Health Score for one business and upserts it into
 * `business_health_scores` — a table deliberately separate from
 * `business_opportunity_scores` (Priority 7: "Do NOT merge it with
 * Opportunity Score"). Called alongside `computeAndStoreOpportunityScores`
 * on every discovery, rediscovery, and verification, so the two scores
 * never drift out of sync with each other even though they're stored
 * independently.
 */
export async function computeAndStoreBusinessHealth(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "website, instagram, facebook, linkedin, has_photos, reviews_count, reviews_rating, confidence, " +
        "website_is_weak, ssl_valid, load_time_ms, seo, blog, signals",
    )
    .eq("id", businessId)
    .single();
  if (error) throw error;

  const result = computeBusinessHealth(business as HealthScorableBusiness);

  const { error: upsertError } = await supabaseAdmin.from("business_health_scores").upsert(
    {
      business_id: businessId,
      health_score: result.score,
      breakdown: result.breakdown,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "business_id" },
  );
  if (upsertError) throw upsertError;
}
