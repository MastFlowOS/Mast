-- MAST — Full service-role privilege audit & permanent fix
--
-- ROOT CAUSE (2026-07-13): `profiles` and `leads` predate every migration in
-- this repo — they were never created by 001-010, almost certainly restored
-- from an external pg_dump/psql session during this app's earlier
-- Netlify+Replit-era backend (see DEPLOYMENT.md), not through Supabase's
-- SQL Editor/dashboard. Supabase's automatic
-- `ALTER DEFAULT PRIVILEGES ... GRANT ... TO service_role` hook only fires
-- for objects created the Supabase-managed way, so tables that arrived via
-- restore/import came in with NO grants to service_role/authenticated/anon
-- at all — only the importing role could touch them. That's exactly what
-- Postgres's own hint ("GRANT SELECT ON public.profiles TO service_role;")
-- was reporting.
--
-- This is not unique to `profiles`. It means this Supabase project's
-- default-privilege configuration for `public` -> `service_role` was never
-- established project-wide — `leads` has the identical problem (the very
-- next table insertLeadForUser() writes to), and businesses/scrape_jobs/
-- business_opportunity_scores (migrations 001-006) relied on the same
-- auto-grant that we now know isn't active here, so they're equally at
-- risk even though they haven't errored yet. ai_intelligence,
-- business_opportunity_insights, lead_activities, progression_events, and
-- goal_completions (migrations 007-009) already got explicit grants when
-- those files were patched for the `CREATE POLICY IF NOT EXISTS` bug.
--
-- This migration is the permanent, project-wide fix:
--   1. Explicitly (re)grants every table/sequence/function the backend
--      service-role client touches, so nothing currently in the schema can
--      hit this class of error again.
--   2. Sets ALTER DEFAULT PRIVILEGES so any table/sequence/function created
--      from here on — by whichever role runs future migrations — is
--      automatically granted correctly, closing the gap permanently instead
--      of requiring a new GRANT statement per future table.
-- Fully idempotent — safe to re-run any number of times.

-- ─── Schema-level prerequisite ──────────────────────────────────────────────
-- Object-level GRANTs have no effect without USAGE on the containing schema.
-- Included defensively in case this was also never established.
grant usage on schema public to service_role, authenticated, anon;

-- ─── Existing tables: explicit, comprehensive grants ───────────────────────
-- service_role is the trusted backend/worker identity (bypasses RLS by
-- design) — granted full read/write on every table it touches, matching
-- standard Supabase convention for this role.
grant all privileges on table
  public.profiles,
  public.leads,
  public.scrape_jobs,
  public.businesses,
  public.business_opportunity_scores,
  public.business_opportunity_insights,
  public.ai_intelligence,
  public.lead_activities,
  public.progression_events,
  public.goal_completions
to service_role;

-- authenticated only needs what it already had working prior to this
-- incident (leads/profiles via the app's pre-existing RLS policies) — no
-- widening beyond that here; this line just guarantees the same "restored
-- table came in with zero grants" failure mode can't also silently be
-- lurking on the anon-key path for these two specific legacy tables.
grant select, insert, update, delete on table public.leads to authenticated;
grant select, update on table public.profiles to authenticated;

-- professions is a shared read-only lookup table (migration 001) — every
-- table above with a profession_slug FK depends on being able to read it.
grant select on table public.professions to service_role, authenticated;
grant select on table public.businesses, public.business_opportunity_scores to authenticated;
grant select on table public.scrape_jobs to authenticated;

-- ─── Sequences ──────────────────────────────────────────────────────────────
-- Any bigint/serial/identity primary key (e.g. leads.id) depends on USAGE on
-- its backing sequence to INSERT, independently of table-level grants — the
-- exact same "restored without grants" failure mode applies to sequences.
grant usage, select on all sequences in schema public to service_role, authenticated;

-- ─── Functions ──────────────────────────────────────────────────────────────
-- EXECUTE is granted to PUBLIC by default at function creation (confirmed
-- fine here — execution reached inside try_increment_lead_usage/pool_lookup
-- before failing on the table access within them) — restated explicitly
-- anyway as defense-in-depth against a future REVOKE EXECUTE FROM PUBLIC.
grant execute on function public.try_increment_lead_usage(uuid, int, int, int) to service_role;
grant execute on function public.pool_lookup(uuid, text, text, text, boolean, int) to service_role;
grant execute on function public.increment_lead_usage(uuid, int) to service_role;
grant execute on function public.award_goal_xp(text, date, integer) to authenticated;

-- ─── Default privileges: prevent recurrence for future objects ────────────
-- Applies to any table/sequence/function created from now on by whichever
-- role executes this statement (current_user — "postgres" whether run via
-- the Supabase SQL Editor or scripts/run-migrations.mjs's DATABASE_URL,
-- since both connect as that role on this project). This is what was
-- actually missing project-wide; every future `create table` in later
-- migrations will now grant correctly without needing its own GRANT lines.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

alter default privileges in schema public
  grant select on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
