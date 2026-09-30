-- Daily-goals SQL invariants. Runs the REAL migrations 008, 014 and 035
-- against a minimal Supabase stub. Run with: scripts/sql-tests/run-daily-goals-sql.sh
\set ON_ERROR_STOP on
\set QUIET on

-- ── Supabase stub ──────────────────────────────────────────────────────────
drop schema if exists auth cascade; create schema auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
drop table if exists daily_goals, goal_completions, progression_events, profiles cascade;
create table profiles (id uuid primary key, xp integer not null default 0);
grant select on profiles to authenticated;

\i migrations/008_progression.sql
\i migrations/014_fix_award_goal_xp_ambiguous_column.sql
\i migrations/035_daily_goals.sql
-- Re-running must be safe.
\i migrations/035_daily_goals.sql

-- ── helpers ────────────────────────────────────────────────────────────────
create or replace function t_assert(cond boolean, msg text) returns void language plpgsql as
$$ begin if not coalesce(cond,false) then raise exception 'ASSERT FAILED: %', msg; end if; end $$;

insert into profiles(id) values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
create temp table ctx(d date);
insert into ctx values (current_date);
grant select on ctx to authenticated;

create or replace function t_goals(n int) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'slot', i, 'definitionId', 'def.'||i, 'family', 'fam'||i, 'title', 'T'||i,
    'description', '', 'target', 2, 'xp', case when i=1 then 50 else 25 end,
    'plan', 'free', 'metadata', jsonb_build_object('windowStart', now())))
  from generate_series(1, n) i $$;

grant all on all tables in schema public to authenticated;
grant usage on schema auth to authenticated;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 1. exactly 4 goals persisted for a new day
select count(*) as n into temp got from ensure_daily_goals((select d from ctx), t_goals(4));
select t_assert((select n from got)=4, 'ensure creates exactly 4');

-- 2. refresh / second tab: same 4 rows, not 8, and a DIFFERENT proposal is ignored
create temp table again as select * from ensure_daily_goals((select d from ctx), t_goals(4));
select t_assert((select count(*) from again)=4, 'second ensure returns 4');
create temp table other as
  select * from ensure_daily_goals((select d from ctx),
    (select jsonb_agg(jsonb_set(g, '{definitionId}', to_jsonb('other.'||(g->>'slot')))) from jsonb_array_elements(t_goals(4)) g));
select t_assert((select count(*) from daily_goals where goal_date=(select d from ctx))=4, 'still 4 rows after re-ensure');
select t_assert((select bool_and(goal_definition_id like 'def.%') from other), 'loser adopts winner set (no other.* ids)');

-- 3. cannot exceed 4 / cannot insert directly
do $$ begin
  begin perform * from ensure_daily_goals((current_date+1), t_goals(5)); raise exception 'should have failed';
  exception when others then if sqlerrm not like '%at most 4%' then raise; end if; end;
end $$;
do $$ begin
  begin insert into daily_goals(user_id,goal_date,slot,goal_definition_id,family,title,target,xp,plan)
        values (auth.uid(), current_date, 1, 'x','f','t',1,1,'free'); raise exception 'direct insert allowed';
  exception when insufficient_privilege then null; end;
end $$;

-- 4. unique(user, date, slot) / unique(user,date,definition) backstops exist
reset role;
do $$ begin
  begin insert into daily_goals(user_id,goal_date,slot,goal_definition_id,family,title,target,xp,plan)
        values ('11111111-1111-1111-1111-111111111111', current_date, 1, 'zzz','f','t',1,1,'free'); raise exception 'slot dup allowed';
  exception when unique_violation then null; end;
  begin insert into daily_goals(user_id,goal_date,slot,goal_definition_id,family,title,target,xp,plan)
        values ('11111111-1111-1111-1111-111111111111', current_date, 4, 'def.1','f','t',1,1,'free'); raise exception 'definition dup allowed';
  exception when unique_violation then null; end;
end $$;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 5. progress is monotonic, capped, completes exactly once
create temp table g1 as select id from daily_goals where goal_definition_id='def.1' and user_id=auth.uid();
select t_assert((select progress from set_daily_goal_progress((select id from g1), 1))=1, 'progress 1');
select t_assert((select progress from set_daily_goal_progress((select id from g1), 0))=1, 'cannot go down');
select t_assert((select status from daily_goals where id=(select id from g1))='active', 'still active below target');
create temp table done1 as select * from set_daily_goal_progress((select id from g1), 99);
select t_assert((select progress from done1)=2 and (select status from done1)='completed', 'capped at target, completed');
create temp table ts1 as select completed_at from done1;
select pg_sleep(0.05);
select t_assert((select completed_at from set_daily_goal_progress((select id from g1), 99))=(select completed_at from ts1), 'completed_at stable (idempotent)');

-- 6. completing one does NOT create a 5th goal
select t_assert((select count(*) from daily_goals where user_id=auth.uid() and goal_date=(select d from ctx))=4, 'no 5th goal after completion');

-- 7. claim: refused before completion, XP from the ROW, exactly once
create temp table g2 as select id from daily_goals where goal_definition_id='def.2' and user_id=auth.uid();
do $$ begin
  begin perform * from claim_daily_goal((select id from g2)); raise exception 'claimed incomplete goal';
  exception when others then if sqlerrm not like '%not completed%' then raise; end if; end;
end $$;
create temp table c1 as select * from claim_daily_goal((select id from g1));
select t_assert((select xp from c1)=50 and (select awarded from c1), 'first claim awards stored 50 XP');
create temp table c2 as select * from claim_daily_goal((select id from g1));
select t_assert(not (select awarded from c2) and (select xp from c2)=50, 'second claim awards nothing');
select t_assert((select xp from profiles where id=auth.uid())=50, 'profiles.xp increased exactly once');
select t_assert((select claimed_at is not null from daily_goals where id=(select id from g1)), 'claimed_at set');
select t_assert((select count(*) from goal_completions where user_id=auth.uid())=1, 'one ledger row');

-- 8. ownership isolation
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  begin perform * from claim_daily_goal((select id from g1)); raise exception 'other user claimed';
  exception when others then if sqlerrm not like '%not found%' then raise; end if; end;
  begin perform * from set_daily_goal_progress((select id from g1), 2); raise exception 'other user progressed';
  exception when others then if sqlerrm not like '%not found%' then raise; end if; end;
end $$;
select t_assert((select count(*) from daily_goals)=0, 'RLS hides other users goals');

-- 9. next local day → a fresh, independent set; back-dating rejected
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
create temp table nextday as select * from ensure_daily_goals((current_date+1), t_goals(4));
select t_assert((select count(*) from nextday)=4, 'next day gets its own 4');
select t_assert((select count(*) from daily_goals where goal_date=(select d from ctx))=4, 'today untouched');
do $$ begin
  begin perform * from ensure_daily_goals(current_date-30, t_goals(4)); raise exception 'backdated';
  exception when others then if sqlerrm not like '%plausible%' then raise; end if; end;
end $$;

-- 10. legacy award_goal_xp still works and shares the same profiles.xp (milestones unaffected)
create temp table legacy as select * from award_goal_xp('discover:10', current_date, 25);
select t_assert((select awarded from legacy) and (select xp from legacy)=75, 'legacy XP path composes with daily XP');

reset role;
\echo ALL DAILY-GOALS SQL TESTS PASSED
