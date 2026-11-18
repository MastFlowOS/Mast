-- =============================================================================
-- Migration 051: Milestone Tier Rewards (Authoritative Bonus Credits & Daily Cap)
-- =============================================================================
-- Turns MILESTONE_TIERS rewards into real, server-enforced perks:
--   1. Adds `bonus_credits` (persistent bonus lead allowance that carries across
--      monthly resets) and `daily_limit_bonus` (permanent daily lead cap boost)
--      to `public.profiles` (never client-writable under migration 042 grants).
--   2. Creates `public.milestone_reward_claims` ledger with UNIQUE(user_id, tier_id)
--      so each tier reward can be claimed at most once per user.
--   3. Provides `public.claim_milestone_reward(p_tier_id text)` SECURITY DEFINER
--      RPC that validates auth.uid(), verifies profiles.xp >= tier threshold,
--      and atomically grants the tier's bonus credits and daily cap boost.
--   4. Updates `public.try_increment_lead_usage` so daily_limit_bonus increases
--      the daily ceiling and bonus_credits cover usage once monthly plan quota
--      is exhausted.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bonus_credits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_limit_bonus integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.milestone_reward_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tier_id text NOT NULL,
  bonus_credits integer NOT NULL DEFAULT 0,
  daily_limit_bonus integer NOT NULL DEFAULT 0,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tier_id)
);

CREATE INDEX IF NOT EXISTS idx_milestone_reward_claims_user
  ON public.milestone_reward_claims (user_id, claimed_at DESC);

ALTER TABLE public.milestone_reward_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS milestone_reward_claims_owner_select ON public.milestone_reward_claims;
CREATE POLICY milestone_reward_claims_owner_select
  ON public.milestone_reward_claims FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No client INSERT/UPDATE/DELETE policies: claims go exclusively through claim_milestone_reward().
GRANT SELECT ON public.milestone_reward_claims TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.milestone_reward_claims TO service_role;

-- ─── claim_milestone_reward(p_tier_id) ────────────────────────────────────────
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
     WHERE id = v_user_id
     RETURNING profiles.bonus_credits, profiles.daily_limit_bonus
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

-- ─── Update try_increment_lead_usage to honor bonus_credits & daily_limit_bonus ──
CREATE OR REPLACE FUNCTION public.try_increment_lead_usage(
  p_user_id uuid,
  p_daily_limit integer DEFAULT NULL,
  p_monthly_limit integer DEFAULT NULL,
  p_count integer DEFAULT 1
)
RETURNS TABLE (
  allowed boolean,
  subscription_plan text,
  daily_leads_used integer,
  monthly_leads_used integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_daily integer;
  v_monthly integer;
  v_next_daily timestamptz;
  v_next_monthly timestamptz;
  v_plan text;
  v_pending text;
  v_bonus_credits integer;
  v_daily_bonus integer;
  v_effective_daily_limit integer;
  v_plan_monthly_avail integer;
  v_total_monthly_avail integer;
  v_from_plan integer;
  v_from_bonus integer;
  v_now timestamptz := now();
BEGIN
  SELECT p.daily_leads_used, p.monthly_leads_used, p.next_daily_reset, p.next_monthly_reset,
         p.subscription_plan, p.pending_plan_change,
         coalesce(p.bonus_credits, 0), coalesce(p.daily_limit_bonus, 0)
    INTO v_daily, v_monthly, v_next_daily, v_next_monthly, v_plan, v_pending,
         v_bonus_credits, v_daily_bonus
  FROM public.profiles p
  WHERE p.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile % not found', p_user_id;
  END IF;

  -- Rolling 24h window
  IF v_next_daily IS NULL OR v_next_daily <= v_now THEN
    v_daily := 0;
    v_next_daily := v_now + interval '24 hours';
  END IF;

  -- Rolling monthly window + apply pending downgrade at boundary
  IF v_next_monthly IS NULL OR v_next_monthly <= v_now THEN
    v_monthly := 0;
    v_next_monthly := v_now + interval '1 month';
    IF v_pending IS NOT NULL THEN
      v_plan := v_pending;
      v_pending := NULL;
    END IF;
  END IF;

  IF p_daily_limit IS NULL OR p_monthly_limit IS NULL THEN
    SELECT l.daily_limit, l.monthly_limit
      INTO p_daily_limit, p_monthly_limit
    FROM public.get_plan_limits(v_plan) l;
  END IF;

  v_effective_daily_limit := p_daily_limit + v_daily_bonus;
  v_plan_monthly_avail := greatest(0, p_monthly_limit - v_monthly);
  v_total_monthly_avail := v_plan_monthly_avail + v_bonus_credits;

  IF p_count > 0 AND (v_daily + p_count > v_effective_daily_limit OR p_count > v_total_monthly_avail) THEN
    UPDATE public.profiles SET
      daily_leads_used = v_daily,
      monthly_leads_used = v_monthly,
      next_daily_reset = v_next_daily,
      next_monthly_reset = v_next_monthly,
      subscription_plan = v_plan,
      pending_plan_change = v_pending
    WHERE id = p_user_id;

    RETURN QUERY SELECT false, v_plan, v_daily, v_monthly;
    RETURN;
  END IF;

  IF p_count > 0 THEN
    v_from_plan := least(p_count, v_plan_monthly_avail);
    v_from_bonus := p_count - v_from_plan;

    UPDATE public.profiles SET
      daily_leads_used = v_daily + p_count,
      monthly_leads_used = v_monthly + v_from_plan,
      bonus_credits = v_bonus_credits - v_from_bonus,
      next_daily_reset = v_next_daily,
      next_monthly_reset = v_next_monthly,
      subscription_plan = v_plan,
      pending_plan_change = v_pending
    WHERE id = p_user_id;

    RETURN QUERY SELECT true, v_plan, v_daily + p_count, v_monthly + v_from_plan;
    RETURN;
  END IF;

  -- p_count = 0 (state resolve) or p_count < 0 (duplicate/failure refund)
  UPDATE public.profiles SET
    daily_leads_used = greatest(0, v_daily + p_count),
    monthly_leads_used = greatest(0, v_monthly + p_count),
    next_daily_reset = v_next_daily,
    next_monthly_reset = v_next_monthly,
    subscription_plan = v_plan,
    pending_plan_change = v_pending
  WHERE id = p_user_id;

  RETURN QUERY SELECT true, v_plan, greatest(0, v_daily + p_count), greatest(0, v_monthly + p_count);
END;
$$;

ALTER FUNCTION public.try_increment_lead_usage(uuid, integer, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.try_increment_lead_usage(uuid, integer, integer, integer) FROM public;
REVOKE ALL ON FUNCTION public.try_increment_lead_usage(uuid, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.try_increment_lead_usage(uuid, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.try_increment_lead_usage(uuid, integer, integer, integer) TO postgres, service_role;
