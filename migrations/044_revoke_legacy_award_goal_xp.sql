-- ─── MAST Migration 044: Revoke Legacy award_goal_xp Execution Privileges ────
--
-- Security Audit Finding:
-- Legacy public.award_goal_xp(text, date, integer) was superseded by
-- claim_daily_goal(uuid) in migration 035. claim_daily_goal securely verifies
-- goal completion and reads the authoritative XP value from daily_goals rather
-- than trusting caller-supplied parameters.
--
-- This migration revokes all execute privileges on award_goal_xp() from
-- PUBLIC, anon, and authenticated roles so that authenticated clients cannot
-- invoke this legacy RPC to award arbitrary XP.
--
-- Execution is preserved exclusively for service_role and postgres.

-- 1. Harden the function definition against parameter tampering and NULL XP
create or replace function public.award_goal_xp(
  p_goal_id text,
  p_completed_on date,
  p_xp integer
)
returns table (xp integer, awarded boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_inserted boolean := false;
  v_xp integer;
begin
  if v_user_id is null then
    raise exception 'award_goal_xp requires an authenticated user' using errcode = '42501';
  end if;

  if p_xp is null or p_xp < 0 or p_xp > 250 then
    raise exception 'XP value out of permitted range (0-250)' using errcode = '22023';
  end if;

  if p_goal_id is null or trim(p_goal_id) = '' then
    raise exception 'goal_id is required' using errcode = '22023';
  end if;

  if p_completed_on is null then
    raise exception 'completed_on date is required' using errcode = '22023';
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

-- 2. Ensure postgres ownership
alter function public.award_goal_xp(text, date, integer) owner to postgres;

-- 3. Explicitly revoke all privileges from public, anon, and authenticated
revoke all on function public.award_goal_xp(text, date, integer) from public;
revoke all on function public.award_goal_xp(text, date, integer) from anon;
revoke all on function public.award_goal_xp(text, date, integer) from authenticated;

revoke execute on function public.award_goal_xp(text, date, integer) from public;
revoke execute on function public.award_goal_xp(text, date, integer) from anon;
revoke execute on function public.award_goal_xp(text, date, integer) from authenticated;

-- 4. Grant execution exclusively to service_role and postgres
grant execute on function public.award_goal_xp(text, date, integer) to service_role, postgres;

comment on function public.award_goal_xp(text, date, integer) is
  'Legacy XP award RPC. Deprecated and revoked from authenticated/public callers. Production applications must use claim_daily_goal(uuid).';
