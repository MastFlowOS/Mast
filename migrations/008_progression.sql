-- MAST — Progression system (Focus dashboard XP + daily goals)
--
-- Root cause of the "403 / permission denied for table progression_events"
-- bug: src/lib/api.ts and src/hooks/use-focus-progress.ts have queried
-- `progression_events` and `goal_completions`, and called an `award_goal_xp`
-- RPC, since the Focus dashboard shipped — but no migration ever created
-- these objects. Supabase returns "permission denied" (not "relation does
-- not exist") for a table that exists with RLS enabled and no matching
-- policy; here the table was never created at all, so every request against
-- it is rejected by Postgres before RLS is even evaluated. This migration
-- creates the missing schema so the existing frontend code (already written
-- against this exact shape) starts working — no frontend changes needed.
--
-- Architecture note: consistent with every other per-user table in this
-- app (`leads`, `lead_followups`, ...), the frontend talks to these tables
-- directly via the anon-key Supabase client, scoped entirely by RLS
-- (`auth.uid() = user_id`). This is not routed through the backend gateway
-- because it isn't part of the Opportunity Engine / Discover surface that
-- mast-backend owns — it's ordinary per-user app data, same category as
-- leads and settings.
--
-- ── PRODUCTION FIX (2026-07-13) ─────────────────────────────────────────
-- This file originally used `create policy if not exists`, which is not
-- valid PostgreSQL syntax (IF NOT EXISTS is not supported on CREATE POLICY).
-- That statement raised a syntax error the first time this file ran, which
-- aborted the entire script inside its transaction — so `progression_events`,
-- `goal_completions`, `profiles.xp`, and `award_goal_xp()` were never
-- reliably created at all, which is the actual root cause of the reported
-- "permission denied for table progression_events" errors. Fixed below by
-- using `drop policy if exists` + `create policy` (idempotent and valid).
-- Explicit GRANTs are also added as defense-in-depth. This file is safe to
-- re-run any number of times.

-- ─── profiles.xp ────────────────────────────────────────────────────────────
-- Persistent XP total read by getXp() / awarded by award_goal_xp(). Additive
-- only — never reset. `add column if not exists` is safe to run whether or
-- not this already exists on the base `profiles` table.
alter table profiles add column if not exists xp integer not null default 0;

-- ─── progression_events ─────────────────────────────────────────────────────
-- Append-only log of metric-increment events (e.g. "businesses_contacted"
-- +1) written by recordProgressionEvent() and read back via
-- getProgressionEventTotals() to drive the Focus dashboard's daily-goal
-- progress bars.
create table if not exists progression_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  event_type text not null,
  quantity integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_progression_events_user_type
  on progression_events (user_id, event_type);

alter table progression_events enable row level security;

drop policy if exists progression_events_owner_select on progression_events;
create policy progression_events_owner_select
  on progression_events for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists progression_events_owner_insert on progression_events;
create policy progression_events_owner_insert
  on progression_events for insert
  to authenticated
  with check (auth.uid() = user_id);

grant select, insert on progression_events to authenticated;
grant select, insert, update, delete on progression_events to service_role;

-- ─── goal_completions ───────────────────────────────────────────────────────
-- One row per (user, goal, calendar day) the instant XP is awarded for that
-- goal. The unique constraint is what makes award_goal_xp() idempotent —
-- a duplicate insert attempt for the same goal/day is caught and reported
-- back as `awarded: false` instead of double-granting XP.
create table if not exists goal_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  goal_id text not null,
  completed_on date not null,
  xp_awarded integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, goal_id, completed_on)
);

create index if not exists idx_goal_completions_user_day
  on goal_completions (user_id, completed_on);

alter table goal_completions enable row level security;

drop policy if exists goal_completions_owner_select on goal_completions;
create policy goal_completions_owner_select
  on goal_completions for select
  to authenticated
  using (auth.uid() = user_id);

-- No client-side insert/update policy: all writes to goal_completions go
-- through award_goal_xp() (security definer), which enforces the
-- exactly-once-per-goal-per-day rule atomically. Letting the client insert
-- directly would let it self-award XP by bypassing that function.

grant select on goal_completions to authenticated;
grant select, insert, update, delete on goal_completions to service_role;

-- ─── award_goal_xp() ────────────────────────────────────────────────────────
-- Atomically: (1) tries to insert a goal_completions row for
-- (auth.uid(), p_goal_id, p_completed_on); (2) if that succeeds (first time
-- today), increments profiles.xp by p_xp and reports awarded = true;
-- (3) if it's already claimed, changes nothing and reports awarded = false.
-- Runs as security definer so it can write profiles.xp on the caller's
-- behalf without needing an UPDATE policy that would otherwise let the
-- client set XP to any arbitrary value directly.
create or replace function award_goal_xp(
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
    raise exception 'award_goal_xp requires an authenticated user';
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

comment on function award_goal_xp is
  'Awards XP for completing a goal on a given day, exactly once per '
  '(user, goal, day) no matter how many times it is called — refreshes, '
  'duplicate tabs, and other devices can never double-award. Security '
  'definer so it can update profiles.xp without a client-writable UPDATE '
  'policy on that column. All references to the xp column are qualified '
  'with profiles. to avoid ambiguity with the RETURNS TABLE(xp, ...) '
  'out-parameter of the same name (root cause of a 400/42702 bug fixed '
  '2026-07-16 — see migrations/014_fix_award_goal_xp_ambiguous_column.sql).';

grant execute on function award_goal_xp(text, date, integer) to authenticated;
