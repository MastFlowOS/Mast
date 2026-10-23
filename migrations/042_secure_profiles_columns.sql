-- Migration 042: Secure profiles columns & Authoritative Entitlements
--
-- 1. Restrict client UPDATE permissions on profiles to non-privileged fields only.
-- 2. Provide canonical plan limit resolution matching application configuration.
-- 3. Replace try_increment_lead_usage with a single atomic implementation supporting dynamic plan limits.
-- 4. Provide atomic manual lead creation with quota enforcement and rollback safety.
-- 5. Provide consume_crm_lead_credit RPC for authoritative credit consumption.
-- 6. Harden legacy XP award RPC against parameter tampering.

-- ─── 1. Restrict profiles permissions ─────────────────────────────────────────
revoke all on table public.profiles from anon;
revoke all on table public.profiles from public;

-- Revoke blanket UPDATE from authenticated
revoke update on table public.profiles from authenticated;

-- Grant UPDATE exclusively on user-editable non-privileged profile columns
grant update (full_name, settings) on table public.profiles to authenticated;

-- ─── 2. Canonical Plan Limits Lookup Function ────────────────────────────────
create or replace function public.get_plan_limits(p_plan text)
returns table (daily_limit integer, monthly_limit integer)
language sql
immutable
set search_path = public
as $$
  select
    case lower(coalesce(p_plan, 'free'))
      when 'starter' then 100
      when 'pro' then 400
      when 'premium' then 1000
      when 'scale' then 1000
      else 20 -- 'free'
    end,
    case lower(coalesce(p_plan, 'free'))
      when 'starter' then 1500
      when 'pro' then 6000
      when 'premium' then 25000
      when 'scale' then 25000
      else 300 -- 'free'
    end;
$$;

alter function public.get_plan_limits(text) owner to postgres;
revoke all on function public.get_plan_limits(text) from public;
revoke all on function public.get_plan_limits(text) from anon;
grant execute on function public.get_plan_limits(text) to authenticated, service_role, postgres;

-- ─── 3. Atomic try_increment_lead_usage with Dynamic Plan Limits ─────────────
create or replace function public.try_increment_lead_usage(
  p_user_id uuid,
  p_daily_limit integer default null,
  p_monthly_limit integer default null,
  p_count integer default 1
)
returns table (
  allowed boolean,
  subscription_plan text,
  daily_leads_used integer,
  monthly_leads_used integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_daily integer;
  v_monthly integer;
  v_next_daily timestamptz;
  v_next_monthly timestamptz;
  v_plan text;
  v_pending text;
  v_now timestamptz := now();
begin
  -- Row lock: concurrent calls for the SAME user serialize here.
  -- Column aliases 'p.' avoid ambiguity with OUT parameters.
  select p.daily_leads_used, p.monthly_leads_used, p.next_daily_reset, p.next_monthly_reset,
         p.subscription_plan, p.pending_plan_change
    into v_daily, v_monthly, v_next_daily, v_next_monthly, v_plan, v_pending
  from profiles p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception 'profile % not found', p_user_id;
  end if;

  -- Rolling 24h window
  if v_next_daily is null or v_next_daily <= v_now then
    v_daily := 0;
    v_next_daily := v_now + interval '24 hours';
  end if;

  -- Rolling monthly window + apply pending downgrade at boundary
  if v_next_monthly is null or v_next_monthly <= v_now then
    v_monthly := 0;
    v_next_monthly := v_now + interval '1 month';
    if v_pending is not null then
      v_plan := v_pending;
      v_pending := null;
    end if;
  end if;

  -- If limits were not explicitly supplied, dynamically resolve them
  -- from canonical plan configuration using the post-reset effective plan.
  if p_daily_limit is null or p_monthly_limit is null then
    select l.daily_limit, l.monthly_limit
      into p_daily_limit, p_monthly_limit
    from public.get_plan_limits(v_plan) l;
  end if;

  -- p_count = 0 is a pure "resolve current state" query — always allowed.
  if p_count > 0 and (v_daily + p_count > p_daily_limit or v_monthly + p_count > p_monthly_limit) then
    -- Persist the (re)computed reset window even on rejection
    update profiles set
      daily_leads_used = v_daily,
      monthly_leads_used = v_monthly,
      next_daily_reset = v_next_daily,
      next_monthly_reset = v_next_monthly,
      subscription_plan = v_plan,
      pending_plan_change = v_pending
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

alter function public.try_increment_lead_usage(uuid, integer, integer, integer) owner to postgres;
revoke all on function public.try_increment_lead_usage(uuid, integer, integer, integer) from public;
revoke all on function public.try_increment_lead_usage(uuid, integer, integer, integer) from anon;
revoke all on function public.try_increment_lead_usage(uuid, integer, integer, integer) from authenticated;
grant execute on function public.try_increment_lead_usage(uuid, integer, integer, integer) to postgres, service_role;

-- ─── 4. Authoritative CRM Lead Creation & Quota Enforcement ───────────────────
create or replace function public.create_crm_lead(p_lead jsonb)
returns public.leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_allowed boolean;
  v_plan text;
  v_inserted public.leads;
  v_status text;
  v_priority text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  -- Single atomic pass: acquires row lock, applies rolling resets and pending downgrades,
  -- looks up canonical limits for the effective plan, and reserves credit.
  select allowed, subscription_plan into v_allowed, v_plan
  from public.try_increment_lead_usage(v_user_id, null, null, 1);

  if not coalesce(v_allowed, false) then
    raise exception 'Lead generation quota exceeded' using errcode = '54000';
  end if;

  -- Validate and sanitize client-controlled fields against canonical LeadStatus taxonomy
  v_status := lower(coalesce(p_lead->>'status', 'new'));
  if v_status not in ('new', 'email_sent', 'called', 'instagram_sent', 'replied', 'meeting_booked', 'closed', 'dead') then
    v_status := 'new';
  end if;

  v_priority := lower(coalesce(p_lead->>'priority', 'medium'));
  if v_priority not in ('low', 'medium', 'high') then
    v_priority := 'medium';
  end if;

  v_name := trim(coalesce(p_lead->>'business_name', p_lead->>'businessName', 'New Lead'));
  if length(v_name) = 0 then
    v_name := 'New Lead';
  end if;
  if length(v_name) > 255 then
    v_name := substr(v_name, 1, 255);
  end if;

  -- Insert lead row within the same transaction (Rollback on failure guarantees zero leaked credits)
  insert into public.leads (
    user_id,
    business_name,
    email,
    phone,
    website,
    instagram_handle,
    linkedin_handle,
    niche,
    location,
    status,
    priority,
    credit_charged,
    discovery_mode,
    opportunity_score,
    scrape_job_id
  ) values (
    v_user_id,
    v_name,
    nullif(trim(p_lead->>'email'), ''),
    nullif(trim(p_lead->>'phone'), ''),
    nullif(trim(p_lead->>'website'), ''),
    nullif(trim(coalesce(p_lead->>'instagram_handle', p_lead->>'instagramHandle')), ''),
    nullif(trim(coalesce(p_lead->>'linkedin_handle', p_lead->>'linkedinHandle')), ''),
    nullif(trim(p_lead->>'niche'), ''),
    nullif(trim(p_lead->>'location'), ''),
    v_status,
    v_priority,
    true,        -- Server-controlled: client cannot bypass credit charge
    'manual',    -- Server-controlled: client cannot forge discovery mode
    null,        -- Server-controlled
    null         -- Server-controlled
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

alter function public.create_crm_lead(jsonb) owner to postgres;
revoke all on function public.create_crm_lead(jsonb) from public;
revoke all on function public.create_crm_lead(jsonb) from anon;
grant execute on function public.create_crm_lead(jsonb) to authenticated, service_role, postgres;

-- ─── 5. Authoritative Credit Consumption RPC ──────────────────────────────────
create or replace function public.consume_crm_lead_credit(p_count integer default 1)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_allowed boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_count is null or p_count <= 0 then
    raise exception 'Requested credit count must be a positive integer' using errcode = '22023';
  end if;

  if p_count > 1000 then
    raise exception 'Requested credit count exceeds maximum batch limit (1000)' using errcode = '22023';
  end if;

  select allowed into v_allowed
  from public.try_increment_lead_usage(v_user_id, null, null, p_count);

  return coalesce(v_allowed, false);
end;
$$;

alter function public.consume_crm_lead_credit(integer) owner to postgres;
revoke all on function public.consume_crm_lead_credit(integer) from public;
revoke all on function public.consume_crm_lead_credit(integer) from anon;
grant execute on function public.consume_crm_lead_credit(integer) to authenticated, service_role, postgres;

-- ─── 6. Harden legacy award_goal_xp against arbitrary parameter tampering ────
create or replace function public.award_goal_xp(
  p_goal_id text,
  p_completed_on date,
  p_xp integer
)
returns table (xp integer, awarded boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_inserted boolean := false;
  v_xp integer;
begin
  if v_user_id is null then
    raise exception 'award_goal_xp requires an authenticated user' using errcode = '42501';
  end if;

  if p_xp < 0 or p_xp > 250 then
    raise exception 'XP value out of permitted range (0-250)' using errcode = '22023';
  end if;

  insert into goal_completions (user_id, goal_id, completed_on, xp_awarded)
  values (v_user_id, p_goal_id, p_completed_on, p_xp)
  on conflict (user_id, goal_id, completed_on) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted then
    update profiles set xp = coalesce(profiles.xp, 0) + p_xp
    where profiles.id = v_user_id
    returning profiles.xp into v_xp;
  else
    select profiles.xp into v_xp from profiles where profiles.id = v_user_id;
  end if;

  return query select coalesce(v_xp, 0), v_inserted;
end;
$$;

alter function public.award_goal_xp(text, date, integer) owner to postgres;
revoke all on function public.award_goal_xp(text, date, integer) from public;
revoke all on function public.award_goal_xp(text, date, integer) from anon;
grant execute on function public.award_goal_xp(text, date, integer) to authenticated, service_role, postgres;

-- Ensure claim_daily_goal has explicit public search_path
alter function public.claim_daily_goal(uuid) set search_path = public;
