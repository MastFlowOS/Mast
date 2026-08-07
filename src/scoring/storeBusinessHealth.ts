import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { runEngineScore } from "../scraperBridge/pythonBridge.js";

/**
 * Computes the Business Health Score for one business via Engine 2.0
 * (`service.py score`) and upserts it into `business_health_scores`.
 *
 * Engine 2.0 is the single canonical owner of health scoring logic.
 * The `health_score` field maps to `engineResult.health_score` which
 * ScoringWorker._business_health_component computes in Python.
 * Node's only role here is: fetch → delegate to Python → persist.
 */
export async function computeAndStoreBusinessHealth(businessId: string): Promise<void> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, website, instagram, facebook, linkedin, has_photos, reviews_count, reviews_rating, confidence, website_is_weak, ssl_valid, load_time_ms, seo, blog, signals",
    )
    .eq("id", businessId)
    .single();
  if (error) throw error;

  // Engine 2.0 computes both the universal breakdown and the health score.
  const engineResult = await runEngineScore({
    ...business,
    id: businessId,
    // Flatten signals for the engine's flat-dict intake format
    ...(business.signals != null && typeof business.signals === "object" ? business.signals : {}),
  });

  const { error: upsertError } = await supabaseAdmin.from("business_health_scores").upsert(
    {
      business_id: businessId,
      health_score: engineResult.health_score,
      breakdown: engineResult.universal_breakdown ?? {},
      computed_at: new Date().toISOString(),
    },
    { onConflict: "business_id" },
  );
  if (upsertError) throw upsertError;
}
