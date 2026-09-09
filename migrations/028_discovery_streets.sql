-- MAST Phase 2A — Global street inventory foundation.
--
-- Adds ONE new table: the GLOBAL identity of a geographic street. This is
-- deliberately the ONLY schema change this migration makes — it does not
-- touch businesses, leads, discovery_area_stats, or any existing
-- user/business dedup constraint (per this phase's own instructions).
--
-- Two completely separate concepts (per this phase's own architectural
-- rule):
--
--   GLOBAL   -> discovery_streets (this table)
--              = canonical identity of a geographic street
--   PER USER -> a future street-coverage table, NOT created here
--              = whether THIS USER has processed that street
--
-- discovery_streets therefore has NO user_id column, and no "completed" /
-- worker-claim column of any kind. A future phase that adds per-user street
-- progress should add its OWN table referencing discovery_streets(id) —
-- never widen this table to carry per-user state, for the same reason
-- discovery_area_stats (migration 026) itself is not a "which user visited
-- this area" table.
--
-- Street identity model
-- ----------------------
-- `street_key` is the durable canonical identity — built by
-- street_inventory/normalization.py:build_street_key() as
-- "{country_code}:{region}:{city}:{normalized_name}" (all four components
-- slugified; `region` uses an explicit "unk" placeholder rather than an
-- empty segment when unknown, so two regionless cities are still
-- distinguished by country_code + city instead of colliding on an empty
-- string). It is geographically scoped so that the same street name in two
-- different cities (e.g. "Main St") never collides — a bare, ungscoped
-- "main-street" is explicitly NOT a valid identity per this phase's own
-- instructions.
--
-- No street_serial column exists here, deliberately. This phase's own
-- instructions require any serial/order value to be ordering metadata only,
-- never identity, and to remain correct if ordering changes. Persisting and
-- maintaining a stored serial column would require either a trigger that
-- renumbers sibling rows on every insert (expensive, and a source of
-- exactly the "destructive refresh" this phase's instructions rule out) or
-- an application-side maintenance step that could silently drift from the
-- table. A plain, cheap-to-compute ordering is available on demand instead
-- — see `discovery_streets_ordered` view below — with no stored state to
-- keep in sync.
create table if not exists discovery_streets (
  id uuid primary key default gen_random_uuid(),
  street_key text not null,
  street_name text not null,
  normalized_name text not null,
  country_code text not null,
  country_name text,
  region text,
  city text not null,
  source text not null default 'overpass',
  source_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uniqueness on the canonical identity itself. `street_key` already
-- encodes the full geographic scope (country/region/city/normalized name),
-- so a single unique index on it is both necessary and sufficient to
-- prevent the same geographic street being duplicated in the global
-- inventory, while still allowing the same street NAME to exist
-- (correctly, as a different row) in a different city — see module
-- docstring above.
create unique index if not exists idx_discovery_streets_street_key
  on discovery_streets (street_key);

-- Supports the inventory builder's own lookup/refresh pattern (upsert on
-- street_key — see street_inventory/repository.py) and a future discovery
-- layer's "does this city have a usable street inventory at all" check,
-- without a full table scan.
create index if not exists idx_discovery_streets_city
  on discovery_streets (country_code, region, city);

alter table discovery_streets enable row level security;
-- No policies added, deliberately — matching discovery_area_stats
-- (migration 026) and discovery_location_stats (migration 015): this is
-- planner/inventory-builder-internal bookkeeping, not user-facing data, so
-- only service_role (which bypasses RLS) touches it. If a future phase
-- exposes street inventory directly to end users, add read-only policies
-- then — do not add write policies for any role other than service_role.

-- Keeps `updated_at` accurate on every upsert-driven UPDATE (PostgREST's
-- `Prefer: resolution=merge-duplicates` issues a real UPDATE on conflict,
-- which does not touch `updated_at` on its own since the upsert payload
-- itself never sets it).
create or replace function set_discovery_streets_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_discovery_streets_updated_at on discovery_streets;
create trigger trg_discovery_streets_updated_at
  before update on discovery_streets
  for each row
  execute function set_discovery_streets_updated_at();

-- Deterministic, computed-not-stored ordering within a city (see "No
-- street_serial column" note above). `serial` here is display/order
-- metadata only, recomputed from current data every time this view is
-- queried — it is NEVER a stable identifier and MUST NOT be persisted or
-- treated as one by any caller. Ordered by (country_code, region, city,
-- normalized_name) — normalized street name, the same deterministic,
-- collision-avoiding ordering key this phase's own instructions suggest.
create or replace view discovery_streets_ordered as
select
  ds.*,
  row_number() over (
    partition by ds.country_code, ds.region, ds.city
    order by ds.normalized_name
  ) as serial
from discovery_streets ds;

comment on table discovery_streets is
  'GLOBAL street identity inventory (Phase 2A). No user_id, no worker-claim '
  'state — see this table''s own migration header. Per-user street '
  'coverage belongs in a future, separate table.';
comment on column discovery_streets.street_key is
  'Durable canonical identity: "{country_code}:{region}:{city}:{normalized_name}", '
  'slugified. See street_inventory/normalization.py:build_street_key().';
comment on view discovery_streets_ordered is
  'Read-only convenience view adding a computed, non-persisted display '
  'serial per (country_code, region, city). Never treat "serial" as a '
  'stable identifier — use street_key for that.';
