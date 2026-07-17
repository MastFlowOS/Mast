-- Fixes discovery_location_stats never actually accumulating history.
--
-- ROOT CAUSE: recordTaskOutcome() (discoveryPlanJob.ts) previously wrote
-- searches/discovered_count/accepted_count via a plain `.upsert()`. An
-- upsert's ON CONFLICT DO UPDATE SET column = <value> REPLACES the column,
-- it does not add to it — so every call overwrote the row with just that
-- one run's numbers instead of growing them. The planner's "historical
-- yield" ranking (accepted_count / searches, in planner.ts) was therefore
-- always reading a value that reset on every search instead of learning
-- over time, making the "intelligent rotation" feature effectively inert.
--
-- A plain read-then-write fix in application code isn't enough either:
-- discovery_tasks for the SAME (niche, country_code, city, source) can
-- belong to different, concurrently-running discovery_plans (two users
-- searching the same niche/city at once), so two recordTaskOutcome() calls
-- can race on the same discovery_location_stats row. This function does
-- the increment atomically inside Postgres, the same way
-- claim_discovery_delivery()/release_discovery_delivery() (migration 015)
-- already do for discovery_plans.delivered_count.
create or replace function record_discovery_location_outcome(
  p_niche text,
  p_country_code text,
  p_city text,
  p_source text,
  p_discovered_delta integer,
  p_accepted_delta integer,
  p_exhausted boolean,
  p_errored boolean
)
returns void
language plpgsql
security definer
as $$
begin
  insert into discovery_location_stats (
    niche, country_code, city, source,
    searches, discovered_count, accepted_count,
    last_searched_at, last_exhausted_at, last_error_at, updated_at
  )
  values (
    p_niche, p_country_code, p_city, p_source,
    1, greatest(p_discovered_delta, 0), greatest(p_accepted_delta, 0),
    now(), case when p_exhausted then now() else null end, case when p_errored then now() else null end, now()
  )
  on conflict (niche, country_code, city, source) do update set
    -- Every call represents one real execution attempt of a discovery_task
    -- against this location (success or error), so `searches` always grows
    -- by exactly 1 per call — accumulated against the EXISTING row value,
    -- not overwritten.
    searches = discovery_location_stats.searches + 1,
    discovered_count = discovery_location_stats.discovered_count + greatest(p_discovered_delta, 0),
    accepted_count = discovery_location_stats.accepted_count + greatest(p_accepted_delta, 0),
    last_searched_at = now(),
    last_exhausted_at = case when p_exhausted then now() else discovery_location_stats.last_exhausted_at end,
    last_error_at = case when p_errored then now() else discovery_location_stats.last_error_at end,
    updated_at = now();
end;
$$;

grant execute on function public.record_discovery_location_outcome(text, text, text, text, integer, integer, boolean, boolean) to service_role;
