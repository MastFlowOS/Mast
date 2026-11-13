-- =============================================================================
-- Migration 050: Cross-User Lead Cooldown Protection (15-Day Anti-Spam Shield)
-- =============================================================================
-- Prevents local businesses from becoming a "spam grave" by enforcing a
-- cross-user cooldown window (default 15 days) whenever a business is
-- delivered to any user:
--   1. Adds `cooldown_until timestamptz` to `public.businesses` + partial indexes
--      so active cooldown lookups execute in 0ms.
--   2. Updates `public.pool_lookup` (9-arg and 11-arg overloads) to exclude
--      businesses currently in cooldown (`b.cooldown_until <= now()`).
--   3. Updates `public.deliver_lead_for_user` to atomically guard against
--      concurrent cross-user race conditions (`FOR UPDATE` on `businesses`)
--      and stamp `cooldown_until = now() + N days` upon new lead delivery.
-- =============================================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_businesses_cooldown_until
  ON public.businesses (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_cooldown_country
  ON public.businesses (country_code, cooldown_until)
  WHERE cooldown_until IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 1. Update 9-argument pool_lookup overload (kept for rollout compatibility)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pool_lookup(
  p_user_id uuid,
  p_region text,
  p_niche text,
  p_profession_slug text,
  p_rank boolean,
  p_limit integer,
  p_country_codes text[],
  p_country_strict boolean,
  p_channels text[]
)
RETURNS TABLE (
  business_id uuid,
  opportunity_score numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT b.id AS business_id,
         s.opportunity_score
  FROM public.businesses b
  LEFT JOIN public.business_opportunity_scores s
    ON s.business_id = b.id AND s.profession_slug = p_profession_slug
  WHERE b.is_disqualified = false
    AND b.archived_at IS NULL
    AND (b.cooldown_until IS NULL OR b.cooldown_until <= now())
    AND (
      CASE
        WHEN p_country_strict THEN coalesce(b.country_code = ANY(p_country_codes), false)
        ELSE (
          p_region = ''
          OR b.region ILIKE '%' || p_region || '%'
          OR coalesce(b.country_code = ANY(p_country_codes), false)
        )
      END
    )
    AND (p_niche = '' OR b.niche ILIKE '%' || p_niche || '%')
    AND NOT EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.user_id = p_user_id AND l.business_id = b.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(coalesce(p_channels, ARRAY[]::text[])) AS requested(channel)
      WHERE NOT coalesce(
        CASE requested.channel
          WHEN 'email' THEN nullif(btrim(b.email), '') IS NOT NULL
          WHEN 'phone' THEN nullif(btrim(b.phone), '') IS NOT NULL
          WHEN 'instagram' THEN nullif(btrim(b.instagram), '') IS NOT NULL
          WHEN 'website' THEN nullif(btrim(b.website), '') IS NOT NULL
          ELSE false
        END,
        false
      )
    )
  ORDER BY
    (CASE WHEN p_rank THEN coalesce(s.opportunity_score, -1) ELSE 0 END) DESC,
    b.first_discovered_at DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[]) TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Update 11-argument pool_lookup (active production signature)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pool_lookup(
  p_user_id uuid,
  p_region text,
  p_niche text,
  p_profession_slug text,
  p_rank boolean,
  p_limit integer,
  p_country_codes text[],
  p_country_strict boolean,
  p_channels text[],
  p_min_rating numeric DEFAULT NULL,
  p_min_reviews integer DEFAULT NULL
)
RETURNS TABLE (
  business_id uuid,
  opportunity_score numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT b.id AS business_id,
         s.opportunity_score
  FROM public.businesses b
  LEFT JOIN public.business_opportunity_scores s
    ON s.business_id = b.id AND s.profession_slug = p_profession_slug
  WHERE b.is_disqualified = false
    AND b.archived_at IS NULL
    AND (b.cooldown_until IS NULL OR b.cooldown_until <= now())
    AND (
      CASE
        WHEN p_country_strict THEN coalesce(b.country_code = ANY(p_country_codes), false)
        ELSE (
          p_region = ''
          OR b.region ILIKE '%' || p_region || '%'
          OR coalesce(b.country_code = ANY(p_country_codes), false)
        )
      END
    )
    AND (p_niche = '' OR b.niche ILIKE '%' || p_niche || '%')
    AND NOT EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.user_id = p_user_id AND l.business_id = b.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(coalesce(p_channels, ARRAY[]::text[])) AS requested(channel)
      WHERE NOT coalesce(
        CASE requested.channel
          WHEN 'email' THEN nullif(btrim(b.email), '') IS NOT NULL
          WHEN 'phone' THEN nullif(btrim(b.phone), '') IS NOT NULL
          WHEN 'instagram' THEN nullif(btrim(b.instagram), '') IS NOT NULL
          WHEN 'website' THEN nullif(btrim(b.website), '') IS NOT NULL
          ELSE false
        END,
        false
      )
    )
    AND (
      p_min_rating IS NULL
      OR b.reviews_rating IS NULL
      OR b.reviews_rating <= 0
      OR b.reviews_rating > 5
      OR b.reviews_rating >= p_min_rating
    )
    AND (
      p_min_reviews IS NULL
      OR b.reviews_count IS NULL
      OR b.reviews_count <= 0
      OR b.reviews_count >= p_min_reviews
    )
  ORDER BY
    (CASE WHEN p_rank THEN coalesce(s.opportunity_score, -1) ELSE 0 END) DESC,
    b.first_discovered_at DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[], numeric, integer) TO service_role;

COMMENT ON FUNCTION public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[], numeric, integer) IS
  'Shared pool lookup. Enforces cross-user cooldown, requested channels, and positive rating/review quality floors before ORDER BY/LIMIT.';

-- -----------------------------------------------------------------------------
-- 3. Update deliver_lead_for_user to enforce and stamp cross-user cooldown
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.deliver_lead_for_user(
  uuid, uuid, jsonb, integer, integer, uuid
);

CREATE OR REPLACE FUNCTION public.deliver_lead_for_user(
  p_user_id uuid,
  p_business_id uuid,
  p_lead_row jsonb,
  p_daily_limit integer DEFAULT NULL,
  p_monthly_limit integer DEFAULT NULL,
  p_discovery_plan_id uuid DEFAULT NULL
)
RETURNS TABLE (
  status text,
  lead_id bigint,
  was_new_for_user boolean,
  credit_charged boolean,
  limit_reached boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_lead_id bigint;
  v_inserted_lead_id bigint;
  v_plan_claimed boolean := FALSE;
  v_credit_allowed boolean := FALSE;
  v_source_label text;
  v_discovery_mode text;
  v_cooldown_until timestamptz;
  v_cooldown_days integer;
BEGIN
  -- 1. Serialize concurrent delivery attempts for the same (user, business) pair
  PERFORM pg_catalog.pg_advisory_xact_lock(
    424243,
    pg_catalog.hashtext(p_user_id::text || ':' || p_business_id::text)
  );

  -- 2. Check if user already owns this business
  SELECT l.id INTO v_existing_lead_id
  FROM public.leads l
  WHERE l.user_id = p_user_id
    AND l.business_id = p_business_id
  LIMIT 1;

  IF v_existing_lead_id IS NOT NULL THEN
    RETURN QUERY SELECT 'duplicate'::text, v_existing_lead_id, FALSE, FALSE, FALSE;
    RETURN;
  END IF;

  -- 3. Serialize and check cross-user cooldown on the business row before
  --    claiming any plan slot or charging user credits.
  SELECT b.cooldown_until INTO v_cooldown_until
  FROM public.businesses b
  WHERE b.id = p_business_id
  FOR UPDATE;

  IF v_cooldown_until IS NOT NULL AND v_cooldown_until > pg_catalog.now() THEN
    RETURN QUERY SELECT 'duplicate'::text, NULL::bigint, FALSE, FALSE, FALSE;
    RETURN;
  END IF;

  -- 4. If attached to a discovery plan, claim a delivery slot atomically
  IF p_discovery_plan_id IS NOT NULL THEN
    SELECT public.claim_discovery_delivery(p_discovery_plan_id) INTO v_plan_claimed;
    IF NOT COALESCE(v_plan_claimed, FALSE) THEN
      RETURN QUERY SELECT 'plan_limit_reached'::text, NULL::bigint, FALSE, FALSE, TRUE;
      RETURN;
    END IF;
  END IF;

  -- 5. Reserve 1 lead credit atomically
  SELECT u.allowed INTO v_credit_allowed
  FROM public.try_increment_lead_usage(p_user_id, p_daily_limit, p_monthly_limit, 1) u;

  IF NOT COALESCE(v_credit_allowed, FALSE) THEN
    IF v_plan_claimed AND p_discovery_plan_id IS NOT NULL THEN
      PERFORM public.release_discovery_delivery(p_discovery_plan_id);
    END IF;
    RETURN QUERY SELECT 'credit_limit_reached'::text, NULL::bigint, FALSE, FALSE, TRUE;
    RETURN;
  END IF;

  -- 6. Insert the lead row (ON CONFLICT DO NOTHING as safety belt)
  INSERT INTO public.leads (
    user_id,
    business_id,
    profession_slug,
    opportunity_score,
    discovery_mode,
    scrape_job_id,
    credit_charged,
    business_name,
    instagram_handle,
    linkedin_handle,
    email,
    website,
    phone,
    niche,
    location,
    status,
    ig_followers,
    ig_bio,
    ig_last_post,
    source
  ) VALUES (
    p_user_id,
    p_business_id,
    p_lead_row->>'profession_slug',
    CASE WHEN p_lead_row->>'opportunity_score' IS NOT NULL
         THEN (p_lead_row->>'opportunity_score')::numeric
         ELSE NULL
    END,
    p_lead_row->>'discovery_mode',
    CASE WHEN NULLIF(p_lead_row->>'scrape_job_id', '') IS NOT NULL
         THEN (p_lead_row->>'scrape_job_id')::uuid
         ELSE NULL
    END,
    TRUE,
    COALESCE(p_lead_row->>'business_name', 'Unnamed Business'),
    p_lead_row->>'instagram_handle',
    p_lead_row->>'linkedin_handle',
    p_lead_row->>'email',
    p_lead_row->>'website',
    p_lead_row->>'phone',
    p_lead_row->>'niche',
    p_lead_row->>'location',
    COALESCE(p_lead_row->>'status', 'new'),
    p_lead_row->>'ig_followers',
    p_lead_row->>'ig_bio',
    p_lead_row->>'ig_last_post',
    COALESCE(p_lead_row->>'source', 'discover_live')
  )
  ON CONFLICT (user_id, business_id) WHERE business_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_inserted_lead_id;

  IF v_inserted_lead_id IS NULL THEN
    PERFORM public.try_increment_lead_usage(p_user_id, p_daily_limit, p_monthly_limit, -1);
    IF v_plan_claimed AND p_discovery_plan_id IS NOT NULL THEN
      PERFORM public.release_discovery_delivery(p_discovery_plan_id);
    END IF;

    SELECT l.id INTO v_existing_lead_id
    FROM public.leads l
    WHERE l.user_id = p_user_id
      AND l.business_id = p_business_id
    LIMIT 1;

    RETURN QUERY SELECT 'duplicate'::text, v_existing_lead_id, FALSE, FALSE, FALSE;
    RETURN;
  END IF;

  -- 7. Stamp cross-user cooldown on the business so no other user receives
  --    this lead during the cooldown window (default 15 days).
  v_cooldown_days := GREATEST(
    1,
    COALESCE(NULLIF(p_lead_row->>'cooldown_days', '')::integer, 15)
  );

  UPDATE public.businesses
  SET cooldown_until = pg_catalog.now() + pg_catalog.make_interval(days => v_cooldown_days)
  WHERE id = p_business_id;

  -- 8. Seed initial timeline activity (non-fatal)
  v_discovery_mode := COALESCE(p_lead_row->>'discovery_mode', 'live');
  v_source_label := CASE v_discovery_mode
    WHEN 'live' THEN 'Live Discovery'
    WHEN 'instant_pool_ranked' THEN 'Instant Discovery (Opportunity-ranked)'
    ELSE 'Instant Discovery'
  END;

  BEGIN
    INSERT INTO public.lead_activities (
      lead_id,
      user_id,
      type,
      timestamp,
      content
    ) VALUES (
      v_inserted_lead_id,
      p_user_id,
      'opportunity_discovered',
      pg_catalog.now(),
      'Opportunity discovered via ' || v_source_label || '.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN QUERY SELECT 'delivered'::text, v_inserted_lead_id, TRUE, TRUE, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.deliver_lead_for_user(
  uuid, uuid, jsonb, integer, integer, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.deliver_lead_for_user(
  uuid, uuid, jsonb, integer, integer, uuid
) TO service_role;
