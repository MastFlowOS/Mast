-- MAST — Fix award_goal_xp() 400 / "column reference xp is ambiguous"
--
-- ── ROOT CAUSE ───────────────────────────────────────────────────────────
-- award_goal_xp() is declared `returns table (xp integer, awarded boolean)`.
-- In PL/pgSQL, every column of a RETURNS TABLE clause is turned into an
-- implicitly-declared variable scoped to the whole function body — so this
-- function has a variable named `xp` in addition to the `profiles.xp`
-- column. Inside:
--
--     update profiles set xp = coalesce(xp, 0) + p_xp
--     where id = v_user_id
--     returning profiles.xp into v_xp;
--
-- the SET target `xp` is fine (SET targets are always resolved against the
-- table being updated), but the *expression* `coalesce(xp, 0)` is genuinely
-- ambiguous: Postgres cannot tell whether that bare `xp` means the table
-- column or the out-parameter variable, and raises:
--
--     ERROR 42702: column reference "xp" is ambiguous
--
-- every time the function runs. PostgREST converts that server-side SQL
-- error into the 400 Bad Request the browser sees on
-- `POST /rest/v1/rpc/award_goal_xp` — this was never a frontend payload
-- problem, a parameter name/order mismatch, an RLS policy, or a grants
-- issue. src/lib/api.ts's awardGoalXp() already sent the exact right
-- p_goal_id / p_completed_on / p_xp payload for this exact signature; the
-- function itself was broken and failed on every single invocation,
-- authenticated or not.
--
-- ── FIX ──────────────────────────────────────────────────────────────────
-- Qualify every reference to the xp column with `profiles.xp` so it can
-- never be resolved against the out-parameter variable of the same name.
-- Confirmed fixed by executing the function directly against production as
-- an authenticated role: first call now returns (xp: <new total>,
-- awarded: true), a repeat call for the same (user, goal, day) correctly
-- returns (xp: <same total>, awarded: false) with no double-award.
--
-- Safe to re-run any number of times (CREATE OR REPLACE FUNCTION).

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
  '2026-07-16).';

grant execute on function award_goal_xp(text, date, integer) to authenticated;
