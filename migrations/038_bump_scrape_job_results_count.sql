-- Monotonic results_count writer used by src/jobs/poolExpandJob.ts.
--
-- AUDIT NOTE: commit 10dfa5f added code (bumpResultsCount) and a test that
-- reference "migrations/033_bump_scrape_job_results_count.sql", but that file
-- was never committed (the 033 slots are taken by 033_atomic_street_claim_
-- concurrency.sql and 033_discovery_live_events.sql). This migration supplies
-- the function. It is idempotent (CREATE OR REPLACE), so it is safe to run
-- even if the function was already created by hand in an environment.
--
-- Semantics: results_count can only move UP (GREATEST), so concurrent or
-- out-of-order writers can never regress the counter the UI is watching.
-- It only ever touches results_count; status/terminal fields are untouched.
create or replace function bump_scrape_job_results_count(
  p_job_id uuid,
  p_count int
)
returns void
language sql
as $$
  update scrape_jobs
     set results_count = greatest(coalesce(results_count, 0), coalesce(p_count, 0))
   where id = p_job_id;
$$;

comment on function bump_scrape_job_results_count is
  'Atomic, order-independent monotonic update of scrape_jobs.results_count (GREATEST). Used by poolExpandJob.';
