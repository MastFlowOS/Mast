-- MAST — Daily Goals (persistent, per local calendar day)
--
-- Replaces the "computed live, replaced on completion" goal model with
-- persisted goal INSTANCES: one agenda of up to 4 goals per user per local
-- day. Completing a goal never creates a replacement; the row stays, marked
-- completed, until the day ends. The next local day gets a new set.
--
-- Architecture (same pattern as migration 008): the browser talks to Supabase
-- directly under RLS. Reads are plain selects; every WRITE goes through a
-- SECURITY DEFINER function so the client cannot insert arbitrary rows,
-- rewind progress, or choose its own XP at claim time.
--
-- XP: claiming reuses the existing ledger (goal_completions, unique per
-- user + goal_id + day) and profiles.xp, so milestones are untouched. The XP
-- amount is read from the goal row, never from the client at claim time.
--
-- Local day: goal_date is the USER'S local calendar date, computed by the
-- client. The functions only sanity-check it is within one day of the server
-- date (covers every timezone) to stop back-dating.
--
-- Safe to re-run.

create table if not exists daily_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  goal_date date not null,
  slot smallint not null check (slot between 1 and 4),
  goal_definition_id text not null,
  family text not null,
  title text not null,
  description text not null default '',
  target integer not null check (target >= 1),
  progress integer not null default 0 check (progress >= 0),
  status text not null default 'active' check (status in ('active', 'completed')),
  xp integer not null check (xp between 0 and 250),
  plan text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  claimed_at timestamptz,
  -- The invariants: at most 4 slots per user per day, and a definition can
  -- only occupy one slot per day.
  unique (user_id, goal_date, slot),
  unique (user_id, goal_date, goal_definition_id),
  check (progress <= target)
);

create index if not exists idx_daily_goals_user_date on daily_goals (user_id, goal_date);

alter table daily_goals enable row level security;

drop policy if exists daily_goals_owner_select on daily_goals;
create policy daily_goals_owner_select
  on daily_goals for select
  to authenticated
  using (auth.uid() = user_id);

-- No client insert/update/delete policies: writes only via the functions below.
grant select on daily_goals to authenticated;
grant select, insert, update, delete on daily_goals to service_role;

-- ─── ensure_daily_goals ─────────────────────────────────────────────────────
-- Idempotent "create today's set if none exists". A per-(user, day) advisory
-- lock serialises concurrent tabs/devices so two clients can never persist two
-- different sets; the loser simply reads the winner's rows.
create or replace function ensure_daily_goals(p_goal_date date, p_goals jsonb)
returns setof daily_goals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'ensure_daily_goals requires an authenticated user';
  end if;
  if p_goal_date < (current_date - 1) or p_goal_date > (current_date + 1) then
    raise exception 'goal_date % is not a plausible local date', p_goal_date;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_goal_date::text, 0));

  select count(*) into v_count from daily_goals
   where daily_goals.user_id = v_user_id and daily_goals.goal_date = p_goal_date;

  if v_count = 0 then
    if p_goals is null or jsonb_typeof(p_goals) <> 'array' or jsonb_array_length(p_goals) <> 4 then
      raise exception 'p_goals must be an array of exactly 4 goals';
    end if;

    for v_item in select * from jsonb_array_elements(p_goals) loop
      insert into daily_goals (
        user_id, goal_date, slot, goal_definition_id, family, title, description,
        target, xp, plan, metadata
      ) values (
        v_user_id,
        p_goal_date,
        (v_item->>'slot')::smallint,
        v_item->>'definitionId',
        v_item->>'family',
        v_item->>'title',
        coalesce(v_item->>'description', ''),
        (v_item->>'target')::integer,
        (v_item->>'xp')::integer,
        v_item->>'plan',
        coalesce(v_item->'metadata', '{}'::jsonb)
      );
    end loop;
  end if;

  return query
    select * from daily_goals
     where daily_goals.user_id = v_user_id and daily_goals.goal_date = p_goal_date
     order by daily_goals.slot;
end;
$$;

-- ─── set_daily_goal_progress ────────────────────────────────────────────────
-- MONOTONIC: progress only ever moves up, capped at target. Reaching target
-- flips status to completed exactly once. Calling it again is a no-op.
create or replace function set_daily_goal_progress(p_id uuid, p_progress integer)
returns daily_goals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row daily_goals;
begin
  if v_user_id is null then
    raise exception 'set_daily_goal_progress requires an authenticated user';
  end if;

  update daily_goals
     set progress = least(daily_goals.target, greatest(daily_goals.progress, coalesce(p_progress, 0))),
         status = case
           when least(daily_goals.target, greatest(daily_goals.progress, coalesce(p_progress, 0))) >= daily_goals.target
             then 'completed' else daily_goals.status end,
         completed_at = case
           when daily_goals.completed_at is null
            and least(daily_goals.target, greatest(daily_goals.progress, coalesce(p_progress, 0))) >= daily_goals.target
             then now() else daily_goals.completed_at end
   where daily_goals.id = p_id and daily_goals.user_id = v_user_id
   returning * into v_row;

  if not found then
    raise exception 'daily goal not found';
  end if;
  return v_row;
end;
$$;

-- ─── claim_daily_goal ───────────────────────────────────────────────────────
-- Awards the goal's stored XP exactly once. Same ledger and unique constraint
-- as award_goal_xp(), but: the goal must be completed, and the amount comes
-- from the row, not from the caller.
create or replace function claim_daily_goal(p_id uuid)
returns table (xp integer, awarded boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal daily_goals;
  v_inserted boolean := false;
  v_xp integer;
begin
  if v_user_id is null then
    raise exception 'claim_daily_goal requires an authenticated user';
  end if;

  select * into v_goal from daily_goals
   where daily_goals.id = p_id and daily_goals.user_id = v_user_id;
  if not found then
    raise exception 'daily goal not found';
  end if;
  if v_goal.status <> 'completed' then
    raise exception 'daily goal is not completed';
  end if;

  insert into goal_completions (user_id, goal_id, completed_on, xp_awarded)
  values (v_user_id, 'daily:' || v_goal.id::text, v_goal.goal_date, v_goal.xp)
  on conflict (user_id, goal_id, completed_on) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted then
    update profiles set xp = coalesce(profiles.xp, 0) + v_goal.xp
     where profiles.id = v_user_id
     returning profiles.xp into v_xp;
    update daily_goals set claimed_at = now() where daily_goals.id = v_goal.id;
  else
    select profiles.xp into v_xp from profiles where profiles.id = v_user_id;
  end if;

  return query select coalesce(v_xp, 0), v_inserted;
end;
$$;

grant execute on function ensure_daily_goals(date, jsonb) to authenticated;
grant execute on function set_daily_goal_progress(uuid, integer) to authenticated;
grant execute on function claim_daily_goal(uuid) to authenticated;
