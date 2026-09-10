-- CRITMODE — contaminated New York street inventory.
--
-- PROBLEM
-- -------
-- Production `discovery_streets` holds 114,103 rows for
-- (country_code='US', city='New York'). They were generated before
-- `street_inventory/overpass_source.py` was fixed to resolve "New York"
-- to the NYC boundary (admin_level=8) instead of falling back to an
-- exact-string match against New York STATE's boundary (admin_level=4).
-- The resulting rows enumerate every named road in the state, including
-- Warwick/Orange County artifacts ("1/2 Mile Plungis Road") and bare
-- route-number "streets" ("1", "1-3") that are not New York City streets
-- at all — see that module's own "CRITMODE — street inventory geography
-- bug" docstring for the full root-cause writeup.
--
-- That code fix alone does not repair production data:
-- `ensureStreetInventory()` (src/discovery/streetDiscovery.ts) only
-- checks `count(*) > 0` for a (country_code, city) scope before deciding
-- inventory already exists — a bare row count cannot tell "correct
-- inventory" apart from "inventory built under boundary logic that has
-- since been fixed". The 114,103 contaminated rows satisfy that check
-- forever, so the corrected builder is never invoked for New York
-- without a manual, explicit rebuild — this migration is that rebuild's
-- data half; the corresponding freshness-check fix is in
-- `streetDiscovery.ts` (`CURRENT_STREET_BOUNDARY_VERSION`).
--
-- WHAT THIS MIGRATION DOES
-- -------------------------
--   1. Adds `discovery_streets.boundary_version` — every row from now on
--      carries proof of which boundary-resolution/verification logic
--      produced it (see `street_inventory/overpass_source.py:
--      BOUNDARY_VERSION` / `models.py:StreetRecord.boundary_version`).
--      Existing rows (all of them, every city, not just New York) are
--      backfilled to the explicit sentinel `'unversioned'` — a value the
--      current builder will never write — rather than left NULL, so
--      "produced before this column existed" is a distinguishable,
--      queryable fact, not an ambiguous NULL.
--   2. Archives (never silently drops) the exact contaminated New York
--      rows into `discovery_streets_contamination_archive_2026_09`, for
--      audit/rollback, before touching anything.
--   3. Deletes ONLY those archived rows from `discovery_streets`, scoped
--      precisely to `country_code = 'US' AND city = 'New York' AND
--      boundary_version = 'unversioned'` — i.e. exactly the rows this
--      migration itself just proved are New York AND pre-fix. No other
--      city's inventory (Queens, Brooklyn, Los Angeles, ...) matches
--      this predicate, and a hypothetical already-corrected New York row
--      (boundary_version <> 'unversioned') is explicitly excluded, so
--      re-running this fix after a partial prior attempt can never
--      delete good data.
--   4. Reports (via a NOTICE) exactly how many `user_discovery_street_state`
--      rows the delete's ON DELETE CASCADE (migration 029) removes as a
--      side effect, and archives THEIR data too, before the cascade runs.
--
-- WHY DELETING THE CASCADED user_discovery_street_state ROWS IS SAFE
-- ---------------------------------------------------------------------
-- `user_discovery_street_state.street_id` references `discovery_streets
-- (id) on delete cascade` (migration 029). Deleting a contaminated
-- street row therefore deletes any per-user progress claimed against
-- THAT EXACT street identity too. This is judged safe, not a loss of
-- durable progress, because:
--   - The street identities being removed are wrong: many are literally
--     Orange County/Warwick roads or bare route-number artifacts that
--     are not New York City streets, so a claim against one records
--     work against the wrong geography, not real NYC coverage.
--   - The corrected builder (run immediately after this migration, with
--     `region='NY'` passed explicitly) produces an entirely different
--     set of `street_key`s (scoped to the real NYC boundary, and tagged
--     `region='ny'` instead of the historical `unk`), so even leaving
--     the old rows in place would not let any future claim line back up
--     against them — there is no valid post-fix state to "preserve" a
--     pointer to.
-- The archive table (below) keeps the pre-deletion row contents —
-- including which users/niches had claimed which now-defunct streets —
-- available for support/audit purposes without keeping the contaminated
-- rows live in the production coverage tables.
--
-- This migration does not touch poolExpandJob.ts, worker concurrency,
-- or the claim/heartbeat/complete RPCs — it only adds one column and
-- performs one precisely-scoped, one-time data purge.

-- ---------------------------------------------------------------------
-- 1. Freshness column.
-- ---------------------------------------------------------------------
alter table discovery_streets
  add column if not exists boundary_version text not null default 'unversioned';

comment on column discovery_streets.boundary_version is
  'Identifies which version of street_inventory/overpass_source.py''s '
  'boundary resolution + verification logic produced this row (see that '
  'module''s BOUNDARY_VERSION constant). ''unversioned'' means the row '
  'predates this column and must not be trusted as proof of a fresh, '
  'boundary-verified inventory regardless of row count — see migration '
  '032''s own header for the incident this exists to prevent from '
  'recurring silently.';

-- Supports the Node-side freshness check
-- (`streetInventoryCount(db, country, city, boundaryVersion)` in
-- streetDiscovery.ts): "does this scope have inventory built under the
-- CURRENT boundary logic", not just "does this scope have any rows at
-- all". Mirrors migration 028's own idx_discovery_streets_city index,
-- with boundary_version appended.
create index if not exists idx_discovery_streets_city_boundary_version
  on discovery_streets (country_code, city, boundary_version);

-- ---------------------------------------------------------------------
-- 2. Archive tables (audit trail — never blind-deleted).
-- ---------------------------------------------------------------------
create table if not exists discovery_streets_contamination_archive_2026_09 (
  like discovery_streets including all
);
comment on table discovery_streets_contamination_archive_2026_09 is
  'CRITMODE snapshot of the pre-fix New York street inventory '
  '(country_code=US, city=New York, boundary_version=unversioned), '
  'taken immediately before migration 032 deleted those rows from '
  'discovery_streets. Retained for audit/rollback only; not read by any '
  'production code path.';

create table if not exists user_discovery_street_state_contamination_archive_2026_09 (
  like user_discovery_street_state including all
);
comment on table user_discovery_street_state_contamination_archive_2026_09 is
  'CRITMODE snapshot of every user_discovery_street_state row that '
  'referenced a contaminated New York discovery_streets row, taken '
  'immediately before migration 032''s delete cascaded onto this table '
  '(see migration 029''s ON DELETE CASCADE). Retained for audit/support '
  'purposes only — no production code reads or restores from this table '
  'automatically; a corrected claim must come from the rebuilt, '
  'boundary-verified inventory instead.';

-- ---------------------------------------------------------------------
-- 3. Snapshot, then delete, precisely scoped to the contaminated rows.
-- ---------------------------------------------------------------------
do $$
declare
  v_street_rows integer;
  v_state_rows integer;
begin
  -- Snapshot the per-user progress that is about to cascade-delete,
  -- BEFORE the street rows are removed (the join still resolves).
  insert into user_discovery_street_state_contamination_archive_2026_09
  select uds.*
  from user_discovery_street_state uds
  join discovery_streets ds on ds.id = uds.street_id
  where ds.country_code = 'US'
    and ds.city = 'New York'
    and ds.boundary_version = 'unversioned';
  get diagnostics v_state_rows = row_count;

  -- Snapshot the contaminated street rows themselves.
  insert into discovery_streets_contamination_archive_2026_09
  select * from discovery_streets
  where country_code = 'US'
    and city = 'New York'
    and boundary_version = 'unversioned';
  get diagnostics v_street_rows = row_count;

  raise notice
    'CRITMODE migration 032: archiving % contaminated New York discovery_streets rows and % dependent user_discovery_street_state rows before delete',
    v_street_rows, v_state_rows;

  -- The delete itself. Scoped identically to the archive insert above,
  -- so what gets removed is exactly what was just snapshotted — no
  -- other city, and no already-corrected New York row (a future row
  -- with a real boundary_version would not match 'unversioned').
  delete from discovery_streets
  where country_code = 'US'
    and city = 'New York'
    and boundary_version = 'unversioned';

  raise notice 'CRITMODE migration 032: contaminated New York inventory purged (user_discovery_street_state rows removed via ON DELETE CASCADE, snapshot preserved above)';
end $$;
