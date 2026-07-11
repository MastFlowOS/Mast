-- MAST Opportunity Engine — Part 3, Phase 2
-- Supports wiring the Part 1 engine into the worker fleet.

-- ─── Fingerprint-based dedup ────────────────────────────────────────────────
-- Phase 1's businesses table had place_id/domain/normalized_phone columns
-- for dedup. Phase 2 replaces that plan with reusing the engine's own
-- `storage/dedup.py::fingerprints_for()` output directly (service.py now
-- attaches it to every lead) — so dedup semantics live in exactly one place
-- (the untouched Python engine), not duplicated as a second normalization
-- implementation in this migration or in TypeScript.
alter table businesses add column if not exists fingerprints text[] not null default '{}';

create index if not exists idx_businesses_fingerprints on businesses using gin (fingerprints);

-- The old single-column unique constraint on place_id no longer reflects
-- how dedup actually happens (fingerprint-set overlap, checked in
-- application code before insert) — drop it so it can't silently reject a
-- legitimate insert that merely shares a null place_id with another row.
alter table businesses drop constraint if exists businesses_place_id_key;

-- ─── Safe, concurrent-friendly usage counters ──────────────────────────────
-- Every delivered opportunity increments daily_leads_used / monthly_leads_used
-- on `profiles`. Multiple worker processes may deliver to the same user
-- concurrently (unlikely, but the Global Lead Pool makes it possible), so
-- this is a single atomic UPDATE rather than a read-modify-write from Node.
create or replace function increment_lead_usage(p_user_id uuid, p_count int default 1)
returns void
language sql
as $$
  update profiles
  set daily_leads_used = coalesce(daily_leads_used, 0) + p_count,
      monthly_leads_used = coalesce(monthly_leads_used, 0) + p_count
  where id = p_user_id;
$$;
