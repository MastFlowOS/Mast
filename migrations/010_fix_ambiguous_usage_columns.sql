-- MAST — Fix for "column reference is ambiguous" (Postgres 42702) in
-- try_increment_lead_usage(), first surfaced by POST /v1/discover.
--
-- Root cause: try_increment_lead_usage's RETURNS TABLE declares OUT
-- parameters named `subscription_plan`, `daily_leads_used`, and
-- `monthly_leads_used` — PL/pgSQL treats these as variables in scope for
-- the entire function body, with the exact same names as columns on
-- `profiles`. The original function's initial `select ... from profiles`
-- referenced those column names unqualified, so Postgres couldn't tell
-- whether `daily_leads_used` meant the OUT parameter or the table column
-- (42702). Every other statement in the function was already unambiguous
-- (UPDATE...SET targets and WHERE id = p_user_id don't have this problem),
-- so only the SELECT...INTO needs a table alias.
--
-- Safe to run standalone — this only replaces the function definition from
-- migrations/005_usage_hardening.sql, nothing else.
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
  -- `p.` alias qualifies every column so none of them can be confused with
  -- this function's same-named OUT parameters (subscription_plan,
  -- daily_leads_used, monthly_leads_used) — that ambiguity was the bug.
  select p.daily_leads_used, p.monthly_leads_used, p.next_daily_reset, p.next_monthly_reset,
         p.subscription_plan, p.pending_plan_change
    into v_daily, v_monthly, v_next_daily, v_next_monthly, v_plan, v_pending
  from profiles p
  where p.id = p_user_id
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
  'live callers might still reference is riskier than an unused leftover. '
  'FIXED 2026-07-13: the initial SELECT...INTO now qualifies every column '
  'with the `profiles p` alias — this function''s own OUT parameters '
  '(subscription_plan, daily_leads_used, monthly_leads_used) share names '
  'with profiles columns, which caused Postgres error 42702 (ambiguous '
  'column reference) on every call.';
