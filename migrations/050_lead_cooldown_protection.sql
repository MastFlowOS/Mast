-- =============================================================================
-- Migration 050: Per-Profession Multi-User Lead Cooldown Protection
-- =============================================================================
-- Prevents local businesses from becoming a "spam grave" without draining city
-- inventory for high-volume plans:
--   1. Scopes cooldowns per (business_id, profession_slug) so a Web Designer
--      receiving a lead never blocks a Video Editor, SEO agency, or Accountant.
--   2. Allows up to 5 distinct users within the same profession over a 15-day
--      window before stamping `cooldown_until = now() + 15 days` for that
--      profession.
--   3. Uses a partial index (`WHERE cooldown_until IS NOT NULL`) so `pool_lookup`
--      and Live Discovery pre-click/pre-enrichment skips execute in 0ms and
--      only filter businesses that have actually reached the 5-user cap.
-- =============================================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS cooldown_until timestamptz;

-- Clear any legacy global single-delivery cooldown stamps on businesses
UPDATE public.businesses
SET cooldown_until = NULL
WHERE cooldown_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.business_profession_cooldowns (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  profession_slug text NOT NULL,
  delivery_count integer NOT NULL DEFAULT 1,
  window_started_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  cooldown_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (business_id, profession_slug)
);

ALTER TABLE public.business_profession_cooldowns ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.business_profession_cooldowns FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.business_profession_cooldowns TO service_role;

CREATE INDEX IF NOT EXISTS idx_bpc_active_cooldown
  ON public.business_profession_cooldowns (profession_slug, cooldown_until)
  WHERE cooldown_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bpc_business_profession_active
  ON public.business_profession_cooldowns (business_id, profession_slug, cooldown_until)
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
    AND NOT EXISTS (
      SELECT 1
      FROM public.business_profession_cooldowns bpc
      WHERE bpc.business_id = b.id
        AND bpc.profession_slug = COALESCE(NULLIF(btrim(p_profession_slug), ''), '__global__')
        AND bpc.cooldown_until IS NOT NULL
        AND bpc.cooldown_until > now()
    )
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
    AND NOT EXISTS (
      SELECT 1
      FROM public.business_profession_cooldowns bpc
      WHERE bpc.business_id = b.id
        AND bpc.profession_slug = COALESCE(NULLIF(btrim(p_profession_slug), ''), '__global__')
        AND bpc.cooldown_until IS NOT NULL
        AND bpc.cooldown_until > now()
    )
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
  'Shared pool lookup. Enforces per-profession 5-user cooldown, requested channels, and positive rating/review quality floors before ORDER BY/LIMIT.';

-- -----------------------------------------------------------------------------
-- 3. Update deliver_lead_for_user to enforce and stamp per-profession 5-user cooldown
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
  v_profession_slug text;
  v_cooldown_until timestamptz;
  v_cooldown_days integer;
  v_cooldown_max_users integer;
BEGIN
  v_profession_slug := COALESCE(NULLIF(pg_catalog.btrim(p_lead_row->>'profession_slug'), ''), '__global__');

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

  -- 3. Serialize and check per-profession cooldown before claiming any plan
  --    slot or charging user credits.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    424244,
    pg_catalog.hashtext(p_business_id::text || ':' || v_profession_slug)
  );

  SELECT bpc.cooldown_until INTO v_cooldown_until
  FROM public.business_profession_cooldowns bpc
  WHERE bpc.business_id = p_business_id
    AND bpc.profession_slug = v_profession_slug;

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

  -- 7. Increment per-profession delivery counter and stamp 15-day cooldown
  --    only when the 5th distinct user in this profession receives the lead.
  v_cooldown_days := GREATEST(
    1,
    COALESCE(NULLIF(p_lead_row->>'cooldown_days', '')::integer, 15)
  );
  v_cooldown_max_users := GREATEST(
    1,
    COALESCE(NULLIF(p_lead_row->>'cooldown_max_users', '')::integer, 5)
  );

  INSERT INTO public.business_profession_cooldowns AS bpc (
    business_id,
    profession_slug,
    delivery_count,
    window_started_at,
    cooldown_until,
    updated_at
  ) VALUES (
    p_business_id,
    v_profession_slug,
    1,
    pg_catalog.now(),
    CASE WHEN 1 >= v_cooldown_max_users
         THEN pg_catalog.now() + pg_catalog.make_interval(days => v_cooldown_days)
         ELSE NULL
    END,
    pg_catalog.now()
  )
  ON CONFLICT (business_id, profession_slug) DO UPDATE
  SET
    delivery_count = CASE
      WHEN (bpc.cooldown_until IS NOT NULL AND bpc.cooldown_until <= pg_catalog.now())
        OR bpc.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(days => v_cooldown_days)
      THEN 1
      ELSE bpc.delivery_count + 1
    END,
    window_started_at = CASE
      WHEN (bpc.cooldown_until IS NOT NULL AND bpc.cooldown_until <= pg_catalog.now())
        OR bpc.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(days => v_cooldown_days)
      THEN pg_catalog.now()
      ELSE bpc.window_started_at
    END,
    cooldown_until = CASE
      WHEN (
        CASE
          WHEN (bpc.cooldown_until IS NOT NULL AND bpc.cooldown_until <= pg_catalog.now())
            OR bpc.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(days => v_cooldown_days)
          THEN 1
          ELSE bpc.delivery_count + 1
        END
      ) >= v_cooldown_max_users
      THEN pg_catalog.now() + pg_catalog.make_interval(days => v_cooldown_days)
      ELSE NULL
    END,
    updated_at = pg_catalog.now();

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
