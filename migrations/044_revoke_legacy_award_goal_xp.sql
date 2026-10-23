-- ─── MAST Migration 044: Revoke Legacy award_goal_xp Execution Privileges ────
--
-- Security Audit Finding:
-- Legacy public.award_goal_xp(text, date, integer) was superseded by
-- claim_daily_goal(uuid) in migration 035. claim_daily_goal securely verifies
-- goal completion and reads the authoritative XP value from daily_goals rather
-- than trusting caller-supplied parameters.
--
-- This migration is strictly permission-only: it revokes all execute privileges
-- on public.award_goal_xp(text, date, integer) from PUBLIC, anon, and authenticated
-- roles so that untrusted callers cannot invoke this legacy RPC.
--
-- Execution is preserved exclusively for service_role and postgres.

-- 1. Explicitly revoke all privileges from public, anon, and authenticated
revoke all on function public.award_goal_xp(text, date, integer) from public;
revoke all on function public.award_goal_xp(text, date, integer) from anon;
revoke all on function public.award_goal_xp(text, date, integer) from authenticated;

revoke execute on function public.award_goal_xp(text, date, integer) from public;
revoke execute on function public.award_goal_xp(text, date, integer) from anon;
revoke execute on function public.award_goal_xp(text, date, integer) from authenticated;

-- 2. Grant execution exclusively to service_role and postgres
grant execute on function public.award_goal_xp(text, date, integer) to service_role, postgres;
