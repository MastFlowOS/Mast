-- MAST Opportunity Engine — Part 3, Phase 5
-- Credits & subscription enforcement hardening.
--
-- Problems this closes, found auditing Phases 1-4:
--
-- 1. Daily/monthly usage reset (`next_daily_reset` / `next_monthly_reset`
--    on `profiles`) only ever ran client-side, in generateLeads' call to
--    checkAndResetUsage — triggered lazily, only when a user happened to
--    open Discover. A user who never revisited Discover around a reset
--    boundary would stay stuck at their old counters indefinitely, and any
--    direct API caller (bypassing the frontend entirely) never reset at
--    all.
-- 2. The gateway read daily/monthly usage ONCE at the start of a request,
--    computed how many opportunities it was allowed to deliver, then
--    incremented usage per delivered lead afterward with no re-check.
--    Two concurrent discover requests from the same user could both pass
--    the initial check against stale counts and jointly blow past the
--    plan's limits — worse for Free's Live Discovery, which can stream
--    for many seconds, plenty of time for a second request to race it.
--
-- This migration replaces both with ONE atomic, row-locked function that
-- performs the exact same rolling-window reset semantics as the frontend's
-- checkAndResetUsage (including applying a pending plan downgrade at the
-- monthly boundary) and only commits an increment if it still fits under
-- the caller-supplied limits at the moment of the row lock — so the check
-- and the charge can never be split by a race, no matter how many
-- concurrent requests or how long a single job runs.
--
-- Plan limits are NOT duplicated into SQL — the caller (gateway) passes
-- them in, still sourced from the single Node-side src/config/plans.ts.
-- Only the reset/lock/charge mechanics live here.
create or replace function try_increment_lead_usage(
  p_user_id uuid,
  p_daily_limit int,
  p_monthly_limit int,
  p_count int default 1
)
returns table (
  allowed boolean,
  subscription_plan text,
  daily_leads_used int,
  monthly_leads_used int
)
language plpgsql
as $$
declare
  v_daily int;
  v_monthly int;
  v_next_daily timestamptz;
  v_next_monthly timestamptz;
  v_plan text;
  v_pending text;
  v_now timestamptz := now();
begin
  -- Row lock: concurrent calls for the SAME user serialize here, so two
  -- in-flight requests can never both read the same stale counts.
  select daily_leads_used, monthly_leads_used, next_daily_reset, next_monthly_reset,
         subscription_plan, pending_plan_change
    into v_daily, v_monthly, v_next_daily, v_next_monthly, v_plan, v_pending
  from profiles where id = p_user_id
  for update;

  if not found then
    raise exception 'profile % not found', p_user_id;
  end if;

  -- Rolling 24h window, matching checkAndResetUsage's client-side logic
  -- exactly (next_daily_reset = trigger time + 24h, not a calendar boundary).
  if v_next_daily is null or v_next_daily <= v_now then
    v_daily := 0;
    v_next_daily := v_now + interval '24 hours';
  end if;

  -- Rolling monthly window, same as above, INCLUDING applying a pending
  -- downgrade at the boundary — this is existing product behavior
  -- (checkAndResetUsage) being made atomic, not new behavior.
  if v_next_monthly is null or v_next_monthly <= v_now then
    v_monthly := 0;
    v_next_monthly := v_now + interval '1 month';
    if v_pending is not null then
      v_plan := v_pending;
      v_pending := null;
    end if;
  end if;

  -- p_count = 0 is a pure "resolve current state" call (used at the start
  -- of a request, before limits/quantity are computed) — always allowed,
  -- never itself a reason to reject.
  if p_count > 0 and (v_daily + p_count > p_daily_limit or v_monthly + p_count > p_monthly_limit) then
    -- Persist the (re)computed reset window even on rejection, so a
    -- boundary crossing detected here is never silently lost.
    update profiles set
      daily_leads_used = v_daily, monthly_leads_used = v_monthly,
      next_daily_reset = v_next_daily, next_monthly_reset = v_next_monthly,
      subscription_plan = v_plan, pending_plan_change = v_pending
    where id = p_user_id;

    return query select false, v_plan, v_daily, v_monthly;
    return;
  end if;

  update profiles set
    daily_leads_used = v_daily + p_count,
    monthly_leads_used = v_monthly + p_count,
    next_daily_reset = v_next_daily,
    next_monthly_reset = v_next_monthly,
    subscription_plan = v_plan,
    pending_plan_change = v_pending
  where id = p_user_id;

  return query select true, v_plan, v_daily + p_count, v_monthly + p_count;
end;
$$;

comment on function try_increment_lead_usage is
  'Atomic, race-safe replacement for the client-only lazy reset + the '
  'non-atomic increment_lead_usage() from migration 002. p_count=0 resolves '
  'state without charging; p_count<0 refunds a reservation that turned out '
  'to be a duplicate delivery. increment_lead_usage() is left in place '
  '(superseded, unused) rather than dropped, since dropping a function '
  'live callers might still reference is riskier than an unused leftover.';
