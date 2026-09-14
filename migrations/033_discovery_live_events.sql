-- MAST — Live Discovery UI (Task 3 of 3)
--
-- Task 1 (liveDiscoveryEvent.ts) built a process-local, in-memory pub/sub
-- for DiscoveryLiveEvents, keyed by discovery_plans.id. That pub/sub only
-- fans out to subscribers in the SAME Node process as the publisher.
--
-- In this deployment the publisher (handleDiscoveryPlanJob, a pg-boss job
-- handler) only ever runs in the WORKER process (railway.worker.json ->
-- `node dist/workers/index.js`) — a separate service from the gateway
-- (railway.json -> `node dist/server.js`) that serves the browser. The
-- worker process has no public HTTP endpoint of its own. So a browser can
-- never reach the in-memory pub/sub directly, and an SSE endpoint hosted on
-- the gateway could not read it either — the two processes share nothing.
--
-- The existing, already-proven answer to exactly this cross-process problem
-- in this codebase is Supabase Realtime: subscribeToDiscoverJob()
-- (src/lib/api.ts) already has the browser connect DIRECTLY to Supabase's
-- hosted realtime service and watch Postgres INSERT/UPDATE via
-- `postgres_changes` — see migrations/004_realtime.sql and
-- migrations/015_discovery_orchestration.sql for the identical pattern on
-- `leads` / `scrape_jobs` / `businesses`. It works regardless of which
-- process performs the write, because Realtime reads the WAL, not
-- process memory.
--
-- This table is that same pattern applied to DiscoveryLiveEvent: the worker
-- inserts one row per event (see liveDiscoveryEvent.ts's publish call,
-- extended in Task 3 to also persist here — the in-memory pub/sub itself is
-- untouched and still fires for any same-process listener), and the browser
-- subscribes to INSERTs filtered by plan_id, the same way it already does
-- for `leads` filtered by scrape_job_id.
create table if not exists discovery_live_events (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references discovery_plans(id) on delete cascade,
  -- The DiscoveryLiveEvent's own `id` (liveDiscoveryEvent.ts's nextId()) —
  -- carried through so the frontend reducer's existing de-dup guard
  -- (DiscoveryLiveState._internal.processedEventIds) and the frontend
  -- subscription's own applied-id set both work unchanged against a
  -- reconciliation fetch that may overlap with rows already seen live.
  event_id text not null,
  event_type text not null,
  scout_id smallint,
  area_label text,
  pipeline_id text,
  business_name text,
  reason text,
  delivered_count integer,
  target integer,
  area_outcome jsonb,
  failure_reason text,
  -- The event's own Date.now() at build time (liveDiscoveryEvent.ts's
  -- baseEvent) — used for ordering on reconciliation fetches; created_at
  -- (this row's insert time) is a separate, purely operational timestamp.
  event_timestamp timestamptz not null,
  created_at timestamptz not null default now(),
  unique (plan_id, event_id)
);

create index if not exists idx_discovery_live_events_plan on discovery_live_events (plan_id, event_timestamp);

alter table discovery_live_events enable row level security;

-- Same ownership check as "users see own discovery plans" (015), just
-- joined through plan_id since this table has no user_id column of its own.
create policy "users see own discovery live events" on discovery_live_events
  for select to authenticated using (
    exists (
      select 1 from discovery_plans p
      where p.id = plan_id and p.user_id = auth.uid()
    )
  );

-- Only the service-role client (supabaseAdmin, worker-side) ever inserts
-- into this table, which bypasses RLS entirely — no insert policy is
-- needed or added for the browser's anon/authenticated roles.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'discovery_live_events'
  ) then
    alter publication supabase_realtime add table discovery_live_events;
  end if;
end $$;
