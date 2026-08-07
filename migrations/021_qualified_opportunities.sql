-- MAST Engine V2 — qualified_opportunities table (Phase 6.6, Storage Backend)
--
-- FLAGGED, NOT AN ARCHITECTURE DECISION: no migration in this repo and no
-- Engine BluePrint document (Phase 1.1-1.5, Architecture Decisions.md)
-- defines a table for engine/contracts.py's StoredOpportunity. The
-- `businesses` / `leads` / `scrape_jobs` tables in
-- 001_opportunity_engine.sql belong to a different, older system than this
-- V2 engine's contracts and are not reused here. This migration is the
-- smallest table that lets storage_backends/supabase_backend.py's
-- SupabaseStorageBackend satisfy workers/storage_worker.py's
-- _StoragePersistenceProtocol — it mirrors StoredOpportunity's own fields
-- exactly (opportunity_id/id, pipeline_id, created_at) and nothing more,
-- since engine/contracts.py is out of this milestone's scope to widen.
-- Table name and shape should be treated as provisional until a real
-- schema decision is made for the V2 pipeline's storage stage.

create table if not exists qualified_opportunities (
  id uuid primary key default gen_random_uuid(),
  pipeline_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_qualified_opportunities_pipeline
  on qualified_opportunities (pipeline_id);
