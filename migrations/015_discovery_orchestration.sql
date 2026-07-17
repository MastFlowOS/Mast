-- MAST Lead Discovery Engine — production orchestration
--
-- A request is a durable plan, not one long-running worker invocation.  The
-- planner fans a plan out into independently claimable location tasks.  This
-- lets pg-boss distribute countries/cities across any number of worker
-- instances and gives us an auditable record of saturation and failures.

create table if not exists discovery_plans (
  id uuid primary key default gen_random_uuid(),
  scrape_job_id uuid not null unique references scrape_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  niche text not null,
  region text not null,
  channels jsonb not null default '[]'::jsonb,
  currencies jsonb not null default '[]'::jsonb,
  profession_slug text references professions(slug),
  requested_count integer not null check (requested_count > 0),
  delivered_count integer not null default 0 check (delivered_count >= 0),
  status text not null default 'queued' check (status in ('queued','planning','running','completed','partial','failed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_discovery_plans_status on discovery_plans (status, created_at);

create table if not exists discovery_tasks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references discovery_plans(id) on delete cascade,
  niche text not null,
  country_code text not null,
  country_name text not null,
  city text not null,
  source text not null default 'google_maps',
  candidate_budget integer not null check (candidate_budget > 0),
  priority integer not null default 0,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','rate_limited')),
  attempts integer not null default 0,
  discovered_count integer not null default 0,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (plan_id, niche, country_code, city, source)
);

create index if not exists idx_discovery_tasks_claim on discovery_tasks (status, priority desc, created_at);
create index if not exists idx_discovery_tasks_plan on discovery_tasks (plan_id, status);

-- Learns where a niche is becoming saturated.  The planner uses this data to
-- rotate away from low-yield cities on future plans; it never needs a global
-- lock or a hard-coded city order.
create table if not exists discovery_location_stats (
  niche text not null,
  country_code text not null,
  city text not null,
  source text not null default 'google_maps',
  searches integer not null default 0,
  discovered_count integer not null default 0,
  accepted_count integer not null default 0,
  last_searched_at timestamptz,
  last_exhausted_at timestamptz,
  last_error_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (niche, country_code, city, source)
);

-- Durable processing outbox.  A queue message is only a wake-up signal; the
-- row is the source of truth, so a Railway restart between persistence and
-- pg-boss delivery cannot lose enrichment/scoring work.
create table if not exists business_processing_tasks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  kind text not null check (kind in ('enrich','score')),
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (business_id, kind)
);

create index if not exists idx_business_processing_claim on business_processing_tasks (status, kind, created_at);

-- The plan cap is independent from billing.  This atomic reservation prevents
-- concurrent city workers from collectively delivering more than the user
-- requested.  Callers release it if the subsequent credit/CRM insert fails.
create or replace function claim_discovery_delivery(p_plan_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_job_id uuid;
  v_delivered integer;
begin
  update discovery_plans
  set delivered_count = delivered_count + 1,
      status = 'running',
      started_at = coalesce(started_at, now())
  where id = p_plan_id
    and delivered_count < requested_count
    and status in ('queued', 'planning', 'running')
  returning scrape_job_id, delivered_count into v_job_id, v_delivered;

  if not found then
    return false;
  end if;

  update scrape_jobs set results_count = v_delivered, status = 'streaming' where id = v_job_id;
  return true;
end;
$$;

create or replace function release_discovery_delivery(p_plan_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_job_id uuid;
  v_delivered integer;
begin
  update discovery_plans
  set delivered_count = greatest(delivered_count - 1, 0)
  where id = p_plan_id
  returning scrape_job_id, delivered_count into v_job_id, v_delivered;

  if found then
    update scrape_jobs set results_count = v_delivered where id = v_job_id;
  end if;
end;
$$;

alter table discovery_plans enable row level security;
alter table discovery_tasks enable row level security;
alter table discovery_location_stats enable row level security;
alter table business_processing_tasks enable row level security;

create policy "users see own discovery plans" on discovery_plans
  for select to authenticated using (auth.uid() = user_id);

-- Users receive lead INSERTs immediately; this publication addition delivers
-- subsequent enrichment/score updates without a page refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'businesses'
  ) then
    alter publication supabase_realtime add table businesses;
  end if;
end $$;
