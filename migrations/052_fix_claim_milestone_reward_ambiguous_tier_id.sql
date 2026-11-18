-- =============================================================================
-- Migration 052: Fix ambiguous "tier_id" column reference in claim_milestone_reward()
-- =============================================================================
-- Root cause:
--   claim_milestone_reward() returns `TABLE (tier_id text, ...)`, which creates
--   an implicit PL/pgSQL OUT variable named `tier_id`. Inside the function body:
--     ON CONFLICT (user_id, tier_id) DO NOTHING
--   cannot be table-qualified in PostgreSQL ON CONFLICT syntax, so PL/pgSQL
--   raises ERROR 42702: column reference "tier_id" is ambiguous.
--
-- Fix:
--   Add `#variable_conflict use_column` so SQL column references inside the
--   function resolve unambiguously to table columns while all local variables
--   continue to use explicit `v_` prefixes.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_milestone_reward(p_tier_id text)
RETURNS TABLE (
  tier_id text,
  awarded boolean,
  bonus_credits integer,
  daily_limit_bonus integer,
  total_bonus_credits integer,
  effective_daily_limit_bonus integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_user_id uuid := auth.uid();
  v_tier_id text := lower(btrim(coalesce(p_tier_id, '')));
  v_xp_req integer;
  v_bonus_credits integer;
  v_daily_bonus integer;
  v_user_xp integer;
  v_curr_bonus_credits integer;
  v_curr_daily_bonus integer;
  v_inserted boolean := false;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'claim_milestone_reward requires an authenticated user' USING ERRCODE = '42501';
  END IF;

  -- Authoritative tier table matching src/lib/focus.ts MILESTONE_TIERS
  CASE v_tier_id
    WHEN 'explorer'          THEN v_xp_req := 0;    v_bonus_credits := 15;   v_daily_bonus := 0;
    WHEN 'prospector'        THEN v_xp_req := 100;  v_bonus_credits := 50;   v_daily_bonus := 10;
    WHEN 'closer'            THEN v_xp_req := 250;  v_bonus_credits := 100;  v_daily_bonus := 20;
    WHEN 'rainmaker'         THEN v_xp_req := 500;  v_bonus_credits := 250;  v_daily_bonus := 35;
    WHEN 'operator'          THEN v_xp_req := 800;  v_bonus_credits := 400;  v_daily_bonus := 50;
    WHEN 'growth_master'     THEN v_xp_req := 1200; v_bonus_credits := 750;  v_daily_bonus := 75;
    WHEN 'revenue_architect' THEN v_xp_req := 1800; v_bonus_credits := 1500; v_daily_bonus := 100;
    ELSE
      RAISE EXCEPTION 'Unknown milestone tier: %', p_tier_id USING ERRCODE = '22023';
  END CASE;

  SELECT coalesce(p.xp, 0), coalesce(p.bonus_credits, 0), coalesce(p.daily_limit_bonus, 0)
    INTO v_user_xp, v_curr_bonus_credits, v_curr_daily_bonus
  FROM public.profiles p
  WHERE p.id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_user_xp < v_xp_req THEN
    RAISE EXCEPTION 'Insufficient XP to claim % reward (requires % XP, current % XP)',
      v_tier_id, v_xp_req, v_user_xp USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.milestone_reward_claims (user_id, tier_id, bonus_credits, daily_limit_bonus)
  VALUES (v_user_id, v_tier_id, v_bonus_credits, v_daily_bonus)
  ON CONFLICT (user_id, tier_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted THEN
    UPDATE public.profiles
       SET bonus_credits = v_curr_bonus_credits + v_bonus_credits,
           daily_limit_bonus = greatest(v_curr_daily_bonus, v_daily_bonus)
     WHERE public.profiles.id = v_user_id
     RETURNING public.profiles.bonus_credits, public.profiles.daily_limit_bonus
       INTO v_curr_bonus_credits, v_curr_daily_bonus;
  END IF;

  RETURN QUERY SELECT
    v_tier_id,
    v_inserted,
    v_bonus_credits,
    v_daily_bonus,
    v_curr_bonus_credits,
    v_curr_daily_bonus;
END;
$$;

ALTER FUNCTION public.claim_milestone_reward(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_milestone_reward(text) FROM public;
REVOKE ALL ON FUNCTION public.claim_milestone_reward(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_milestone_reward(text) TO authenticated, service_role, postgres;
