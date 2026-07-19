-- Phase 7 — Supplementary atomic increment functions for Lead Engine Observability
-- These are called fire-and-forget from src/lib/observability.ts
-- They use atomic UPDATE so concurrent worker processes can increment safely.

-- ─── record_time_to_first_lead ──────────────────────────────────────────────
-- Idempotent: COALESCE ensures we only record the FIRST value (never overwrite).
CREATE OR REPLACE FUNCTION public.record_time_to_first_lead(
  p_plan_id UUID,
  p_elapsed_ms INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lead_engine_job_metrics
  SET time_to_first_lead_ms = COALESCE(time_to_first_lead_ms, p_elapsed_ms)
  WHERE id = p_plan_id;
EXCEPTION WHEN OTHERS THEN
  -- Silently absorb — this is best-effort observability.
  NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_time_to_first_lead(UUID, INTEGER) TO service_role;


-- ─── increment_job_discovery_metrics ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_job_discovery_metrics(
  p_plan_id UUID,
  p_businesses_discovered INTEGER DEFAULT 0,
  p_maps_scroll_rounds INTEGER DEFAULT 0,
  p_duplicate_count INTEGER DEFAULT 0,
  p_search_exhaustion_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lead_engine_job_metrics
  SET
    businesses_discovered = businesses_discovered + p_businesses_discovered,
    maps_scroll_rounds    = maps_scroll_rounds    + p_maps_scroll_rounds,
    duplicate_count       = duplicate_count       + p_duplicate_count,
    search_exhaustion_reason = COALESCE(p_search_exhaustion_reason, search_exhaustion_reason)
  WHERE id = p_plan_id;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_job_discovery_metrics(UUID, INTEGER, INTEGER, INTEGER, TEXT) TO service_role;


-- ─── increment_job_enrichment_metrics ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_job_enrichment_metrics(
  p_plan_id UUID,
  p_website_success INTEGER DEFAULT 0,
  p_website_failure INTEGER DEFAULT 0,
  p_crawl_time_ms BIGINT DEFAULT 0,
  p_email_success INTEGER DEFAULT 0,
  p_phone_success INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lead_engine_job_metrics
  SET
    website_success_count           = website_success_count           + p_website_success,
    website_failure_count           = website_failure_count           + p_website_failure,
    website_crawl_time_total_ms     = website_crawl_time_total_ms     + p_crawl_time_ms,
    website_crawl_count             = website_crawl_count             + CASE WHEN p_crawl_time_ms > 0 THEN 1 ELSE 0 END,
    email_extraction_success_count  = email_extraction_success_count  + p_email_success,
    phone_extraction_success_count  = phone_extraction_success_count  + p_phone_success
  WHERE id = p_plan_id;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_job_enrichment_metrics(UUID, INTEGER, INTEGER, BIGINT, INTEGER, INTEGER) TO service_role;


-- ─── increment_job_intelligence_metrics ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_job_intelligence_metrics(
  p_plan_id UUID,
  p_instagram_success INTEGER DEFAULT 0,
  p_instagram_failure INTEGER DEFAULT 0,
  p_instagram_lookup_time_ms BIGINT DEFAULT 0,
  p_ai_insight_time_ms BIGINT DEFAULT 0,
  p_ai_insight_generated INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lead_engine_job_metrics
  SET
    instagram_success_count              = instagram_success_count              + p_instagram_success,
    instagram_failure_count              = instagram_failure_count              + p_instagram_failure,
    instagram_lookup_time_total_ms       = instagram_lookup_time_total_ms       + p_instagram_lookup_time_ms,
    instagram_lookup_count               = instagram_lookup_count               + CASE WHEN p_instagram_lookup_time_ms > 0 THEN 1 ELSE 0 END,
    ai_insight_generation_time_total_ms  = ai_insight_generation_time_total_ms  + p_ai_insight_time_ms,
    ai_insight_generation_count          = ai_insight_generation_count          + p_ai_insight_generated
  WHERE id = p_plan_id;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_job_intelligence_metrics(UUID, INTEGER, INTEGER, BIGINT, BIGINT, INTEGER) TO service_role;


-- ─── increment_job_failure_metrics ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_job_failure_metrics(
  p_plan_id UUID,
  p_browser_crashes INTEGER DEFAULT 0,
  p_navigation_timeouts INTEGER DEFAULT 0,
  p_unreachable_websites INTEGER DEFAULT 0,
  p_instagram_unavailables INTEGER DEFAULT 0,
  p_validation_failures INTEGER DEFAULT 0,
  p_user_cancellations INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lead_engine_job_metrics
  SET
    browser_crashes        = browser_crashes        + p_browser_crashes,
    navigation_timeouts    = navigation_timeouts    + p_navigation_timeouts,
    unreachable_websites   = unreachable_websites   + p_unreachable_websites,
    instagram_unavailables = instagram_unavailables + p_instagram_unavailables,
    validation_failures    = validation_failures    + p_validation_failures,
    user_cancellations     = user_cancellations     + p_user_cancellations
  WHERE id = p_plan_id;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_job_failure_metrics(UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;
