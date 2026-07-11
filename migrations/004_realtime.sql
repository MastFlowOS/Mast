-- MAST Opportunity Engine — Part 3, Phase 4
-- Enables Supabase Realtime for the Discover page's live/streaming UI.
--
-- Discover subscribes to:
--  - INSERT on `leads`, filtered by scrape_job_id — new opportunities
--    landing in this user's CRM as Live Discovery / pool follow-up runs
--  - UPDATE on `scrape_jobs`, filtered by id — status/results_count moving
--    queued -> streaming -> completed|failed
--
-- Both are added to the `supabase_realtime` publication, which is what the
-- Supabase client's postgres_changes listener actually reads from.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads'
  ) then
    alter publication supabase_realtime add table leads;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scrape_jobs'
  ) then
    alter publication supabase_realtime add table scrape_jobs;
  end if;
end $$;
