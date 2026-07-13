-- MAST — fix missing grants on lead_followups / lead_messages
--
-- ROOT CAUSE: same restored-via-pg_dump issue documented in migration 011
-- (profiles/leads predate the migration history and came in with zero
-- role grants), but 011's table list omitted lead_followups and
-- lead_messages. Confirmed live on 2026-07-13 via information_schema:
-- both tables had only REFERENCES/TRIGGER/TRUNCATE for service_role and
-- authenticated — no SELECT/INSERT/UPDATE/DELETE. RLS policies
-- (followups_owner, messages_owner) exist and are correctly scoped, but
-- are never reached: Postgres returns "permission denied for table
-- lead_followups/lead_messages" (42501) before RLS is evaluated.
--
-- Impact: the Follow-ups page (dashboard.follow-ups.tsx) and the lead
-- message thread (src/lib/api.ts getMessages/sendMessage/getFollowUps/
-- createFollowUp/updateFollowUp/deleteAccount's cleanup step) fail for
-- every user, on both the frontend's direct Supabase calls (authenticated
-- role) and any backend/worker access (service_role).
--
-- APPLIED DIRECTLY TO PRODUCTION (jsbxonmlhkrtuiivehwx) on 2026-07-13.
-- This file records that change in the migration history; re-running it
-- is idempotent and safe.

grant all privileges on table public.lead_followups, public.lead_messages to service_role;
grant select, insert, update, delete on table public.lead_followups, public.lead_messages to authenticated;
grant usage, select on all sequences in schema public to service_role, authenticated;
