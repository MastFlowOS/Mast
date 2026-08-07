import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineScore } from "../scraperBridge/pythonBridge.js";
import { PROFESSION_SLUGS } from "./professionWeights.js";

/**
 * Computes the Opportunity Score for all profession slugs for one business
 * via Engine 2.0 (`service.py score`) and upserts them into
 * `business_opportunity_scores`.
 *
 * Engine 2.0 is the single canonical owner of all scoring logic.
 * Node's only role here is: fetch → delegate to Python → persist.
 * The TypeScript `computeOpportunityScores` function is no longer called
 * from this path.
 */
export async function computeAndStoreOpportunityScores(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, website, instagram, facebook, linkedin, has_photos, reviews_count, reviews_rating, is_disqualified, website_is_weak, ssl_valid, load_time_ms, seo, blog, signals",
    )
    .eq("id", businessId)
    .single();
  if (error) throw error;

  // Engine 2.0 computes all profession scores.
  const engineResult = await runEngineScore({
    ...business,
    id: businessId,
    // Flatten signals for the engine's flat-dict intake format
    ...(business.signals != null && typeof business.signals === "object" ? business.signals : {}),
  });

  // Map Engine 2.0's profession_scores map to DB rows for all canonical slugs.
  // Engine 2.0 produces scores for all PROFESSION_SLUGS; any missing slug
  // defaults to 0 so the upsert never leaves gaps.
  const rows = PROFESSION_SLUGS.map((slug) => {
    const ps = engineResult.profession_scores?.[slug];
    return {
      business_id: businessId,
      profession_slug: slug,
      opportunity_score: ps?.score ?? 0,
      score_breakdown: ps?.breakdown ?? engineResult.universal_breakdown ?? {},
      computed_at: new Date().toISOString(),
    };
  });

  const { error: upsertError } = await supabaseAdmin
    .from("business_opportunity_scores")
    .upsert(rows, { onConflict: "business_id,profession_slug" });
  if (upsertError) throw upsertError;
}
