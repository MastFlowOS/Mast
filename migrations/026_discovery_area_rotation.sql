-- Phase 3C-4C-B — geographic search rotation.
--
-- Adds a SEPARATE area-state table rather than widening
-- discovery_location_stats's primary key (migration 015). The Phase
-- 3C-4C-A audit flagged altering that table's PK as a real trade-off
-- (existing FKs/RLS policies reference the current PK) that deserved its
-- own decision rather than being folded silently into this migration —
-- this table is that decision, resolved conservatively. Every column here
-- mirrors discovery_location_stats's own naming/typing convention exactly
-- so the two tables read the same way; the only new column is `area`.
create table if not exists discovery_area_stats (
  id uuid primary key default gen_random_uuid(),
  niche text not null,
  country_code text not null,
  city text not null,
  area text not null,
  source text not null default 'google_maps',
  searches integer not null default 0,
  discovered_count integer not null default 0,
  accepted_count integer not null default 0,
  last_searched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (niche, country_code, city, area, source)
);

-- Services claim_discovery_area()'s selection query: scoped to one
-- (niche, country_code, city, source) location, ordered by recency.
create index if not exists idx_discovery_area_stats_location
  on discovery_area_stats (niche, country_code, city, source, last_searched_at);

alter table discovery_area_stats enable row level security;
-- No policies added, deliberately — matching discovery_location_stats
-- (migration 015): this table is planner/worker-internal bookkeeping, not
-- user-facing data, so only service_role (which bypasses RLS) touches it.

-- Atomically claims one eligible curated area for a (niche, country_code,
-- city, source) location and stamps its last_searched_at, mirroring
-- claim_discovery_delivery()'s (migration 015) "single atomic
-- UPDATE ... WHERE ... RETURNING, no explicit locks beyond the touched
-- row(s)" pattern — the UPDATE's own WHERE clause is the mutual-exclusion
-- mechanism, exactly like that function's doc comment describes.
--
-- Selection policy (mirrors areaRotation.ts's selectAreaFromStats(), kept
-- in sync deliberately so the pure JS policy tests and this SQL function
-- agree on behavior):
--   1. Prefer an area never searched before (last_searched_at is null).
--   2. Otherwise prefer the least-recently-searched area OUTSIDE the
--      cooldown window (last_searched_at < now() - cooldown).
--   3. If every curated area is still inside the cooldown window, fall
--      back to the single globally least-recently-searched area rather
--      than returning nothing / stalling forever.
--
-- `for update skip locked` scopes the lock to the one candidate row this
-- statement is about to claim — never the whole city, never the whole
-- table — so two concurrent workers targeting the same city each land on
-- a different eligible row when alternatives exist (requirement §9),
-- without serializing the wider discovery system (requirement §5/§9).
create or replace function claim_discovery_area(
  p_niche text,
  p_country_code text,
  p_city text,
  p_source text,
  p_areas text[],
  p_cooldown_seconds integer default 21600 -- 6 hours, mirrors areaRotation.ts's DEFAULT_AREA_COOLDOWN_MS
)
returns text
language plpgsql
security definer
as $$
declare
  v_area text;
  v_cutoff timestamptz := now() - make_interval(secs => greatest(p_cooldown_seconds, 0));
begin
  if p_areas is null or array_length(p_areas, 1) is null then
    return null;
  end if;

  -- Ensure every curated area for this location has a row to select from.
  -- ON CONFLICT DO NOTHING keeps this idempotent and race-safe if two
  -- workers reach it for the same brand-new location at once.
  insert into discovery_area_stats (niche, country_code, city, area, source)
  select p_niche, p_country_code, p_city, a, p_source
  from unnest(p_areas) as a
  on conflict (niche, country_code, city, area, source) do nothing;

  -- Primary pass: never-searched first, then least-recently-searched,
  -- restricted to areas outside the cooldown window.
  with candidate as (
    select id
    from discovery_area_stats
    where niche = p_niche
      and country_code = p_country_code
      and city = p_city
      and source = p_source
      and area = any(p_areas)
      and (last_searched_at is null or last_searched_at < v_cutoff)
    order by last_searched_at asc nulls first
    for update skip locked
    limit 1
  )
  update discovery_area_stats das
  set last_searched_at = now(),
      updated_at = now()
  from candidate
  where das.id = candidate.id
  returning das.area into v_area;

  if v_area is not null then
    return v_area;
  end if;

  -- Fallback pass: every curated area for this location is currently
  -- inside the cooldown window. Reuse the globally least-recently-searched
  -- one instead of stalling (requirement §4.4) — still atomic, still
  -- scoped to this one location only.
  with candidate as (
    select id
    from discovery_area_stats
    where niche = p_niche
      and country_code = p_country_code
      and city = p_city
      and source = p_source
      and area = any(p_areas)
    order by last_searched_at asc nulls first
    for update skip locked
    limit 1
  )
  update discovery_area_stats das
  set last_searched_at = now(),
      updated_at = now()
  from candidate
  where das.id = candidate.id
  returning das.area into v_area;

  return v_area;
end;
$$;

-- Accumulates one claimed area's search outcome atomically, mirroring
-- record_discovery_location_outcome() (migration 016) exactly — same
-- "increment against the existing row value inside Postgres" reasoning
-- (two concurrent tasks can finish against the same area's row). `searches`
-- is incremented HERE, not at claim time, matching the city-level
-- function's own convention of counting a "search" as a completed
-- execution attempt, not a scheduling event.
create or replace function record_discovery_area_outcome(
  p_niche text,
  p_country_code text,
  p_city text,
  p_area text,
  p_source text,
  p_discovered_delta integer,
  p_accepted_delta integer
)
returns void
language plpgsql
security definer
as $$
begin
  insert into discovery_area_stats (
    niche, country_code, city, area, source,
    searches, discovered_count, accepted_count, last_searched_at, updated_at
  )
  values (
    p_niche, p_country_code, p_city, p_area, p_source,
    1, greatest(p_discovered_delta, 0), greatest(p_accepted_delta, 0), now(), now()
  )
  on conflict (niche, country_code, city, area, source) do update set
    searches = discovery_area_stats.searches + 1,
    discovered_count = discovery_area_stats.discovered_count + greatest(p_discovered_delta, 0),
    accepted_count = discovery_area_stats.accepted_count + greatest(p_accepted_delta, 0),
    updated_at = now();
end;
$$;

grant execute on function public.claim_discovery_area(text, text, text, text, text[], integer) to service_role;
grant execute on function public.record_discovery_area_outcome(text, text, text, text, text, integer, integer) to service_role;
