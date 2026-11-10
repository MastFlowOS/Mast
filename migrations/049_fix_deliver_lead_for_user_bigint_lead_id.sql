-- MAST — Forward Migration 049: Fix deliver_lead_for_user return type to bigint
--
-- Background:
-- In migration 047, public.deliver_lead_for_user was initially defined returning
-- TABLE (..., lead_id uuid, ...). However, public.leads.id is a bigint sequence,
-- and public.lead_activities.lead_id is a bigint foreign key referencing leads(id).
--
-- PostgreSQL does not allow CREATE OR REPLACE FUNCTION to change the output
-- signature (RETURNS TABLE) of an existing function. In environments where
-- migration 047 has already been applied, running CREATE OR REPLACE FUNCTION
-- raises: "ERROR: cannot change return type of existing function".
-- Furthermore, the migration runner (scripts/run-migrations.mjs) records applied
-- files in schema_migrations and skips previously applied migration files, meaning
-- edits to historical migration files are never executed.
--
-- This forward migration safely drops the existing function by parameter signature
-- without CASCADE (verified: deliver_lead_for_user has zero dependent views, triggers,
-- or functions) and recreates it with the authoritative lead_id bigint return type.
--
-- Complete transactional guarantees, advisory locking (namespace 424243), user-scoped
-- ownership checks, discovery-plan reservations, credit checks, and atomic conflict
-- handling are fully preserved.

DROP FUNCTION IF EXISTS public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid);

CREATE OR REPLACE FUNCTION public.deliver_lead_for_user(
  p_user_id uuid,
  p_business_id uuid,
  p_lead_row jsonb,
  p_daily_limit integer default null,
  p_monthly_limit integer default null,
  p_discovery_plan_id uuid default null
)
RETURNS TABLE (
  status text,              -- 'delivered' | 'duplicate' | 'plan_limit_reached' | 'credit_limit_reached'
  lead_id bigint,
  was_new_for_user boolean,
  credit_charged boolean,
  limit_reached boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing_lead_id bigint;
  v_inserted_lead_id bigint;
  v_plan_claimed boolean := false;
  v_credit_allowed boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'p_business_id is required';
  END IF;

  -- 1. Advisory transaction lock on (user_id, business_id) to serialize concurrent deliveries
  -- Namespace: 424243 (mast_lead_delivery)
  PERFORM pg_advisory_xact_lock(424243, hashtext(p_user_id::text || ':' || p_business_id::text));

  -- 2. Fast check: is this business already owned by this user?
  SELECT id INTO v_existing_lead_id
  FROM public.leads
  WHERE user_id = p_user_id AND business_id = p_business_id
  LIMIT 1;

  IF v_existing_lead_id IS NOT NULL THEN
    RETURN QUERY SELECT 'duplicate'::text, v_existing_lead_id, false, false, false;
    RETURN;
  END IF;

  -- 3. Plan reservation (if discovery plan is specified)
  IF p_discovery_plan_id IS NOT NULL THEN
    v_plan_claimed := public.claim_discovery_delivery(p_discovery_plan_id);
    IF NOT v_plan_claimed THEN
      RETURN QUERY SELECT 'plan_limit_reached'::text, NULL::bigint, false, false, true;
      RETURN;
    END IF;
  END IF;

  -- 4. Credit reservation via authoritative try_increment_lead_usage
  SELECT u.allowed
    INTO v_credit_allowed
  FROM public.try_increment_lead_usage(p_user_id, p_daily_limit, p_monthly_limit, 1) u;

  IF NOT coalesce(v_credit_allowed, false) THEN
    -- If plan reservation was claimed, rollback the reservation
    IF v_plan_claimed THEN
      PERFORM public.release_discovery_delivery(p_discovery_plan_id);
    END IF;
    RETURN QUERY SELECT 'credit_limit_reached'::text, NULL::bigint, false, false, true;
    RETURN;
  END IF;

  -- 5. Insert lead row with ON CONFLICT (user_id, business_id) DO NOTHING guard
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
    nullif(p_lead_row->>'opportunity_score', '')::numeric,
    coalesce(p_lead_row->>'discovery_mode', 'live'),
    nullif(p_lead_row->>'scrape_job_id', '')::uuid,
    true,
    coalesce(p_lead_row->>'business_name', 'Unnamed Business'),
    p_lead_row->>'instagram_handle',
    p_lead_row->>'linkedin_handle',
    p_lead_row->>'email',
    p_lead_row->>'website',
    p_lead_row->>'phone',
    p_lead_row->>'niche',
    p_lead_row->>'location',
    coalesce(p_lead_row->>'status', 'new'),
    p_lead_row->>'ig_followers',
    p_lead_row->>'ig_bio',
    p_lead_row->>'ig_last_post',
    coalesce(p_lead_row->>'source', 'discover_live')
  )
  ON CONFLICT (user_id, business_id) WHERE business_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_inserted_lead_id;

  -- 6. Check for conflict race
  IF v_inserted_lead_id IS NULL THEN
    -- Rollback credit
    PERFORM public.try_increment_lead_usage(p_user_id, p_daily_limit, p_monthly_limit, -1);
    -- Rollback plan slot
    IF v_plan_claimed THEN
      PERFORM public.release_discovery_delivery(p_discovery_plan_id);
    END IF;
    -- Find existing ID
    SELECT id INTO v_existing_lead_id
    FROM public.leads
    WHERE user_id = p_user_id AND business_id = p_business_id
    LIMIT 1;

    RETURN QUERY SELECT 'duplicate'::text, v_existing_lead_id, false, false, false;
    RETURN;
  END IF;

  -- 7. Success
  RETURN QUERY SELECT 'delivered'::text, v_inserted_lead_id, true, true, false;
  RETURN;
END;
$$;

ALTER FUNCTION public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid) TO service_role, postgres;

COMMENT ON FUNCTION public.deliver_lead_for_user IS
  'Atomic, transaction-safe lead delivery and credit accounting. '
  'Coordinates ownership check, plan delivery count increment, credit charging, and '
  'lead insertion into a single atomic transaction. Guarantees exactly one credit charged '
  'and exactly one lead created under concurrent delivery attempts. Returns lead_id as bigint.';

-- ─── 3. PostgREST Schema Cache Invalidation ───────────────────────────────────
-- PostgREST maintains an in-memory cache of database RPC signatures and table types.
-- Signal PostgREST via PostgreSQL LISTEN/NOTIFY to reload its schema cache upon COMMIT
-- so that RPC callers immediately resolve the corrected lead_id bigint return type.
NOTIFY pgrst, 'reload schema';
