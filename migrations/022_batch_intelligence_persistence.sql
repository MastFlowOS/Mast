-- MAST Engine V2 — Batch Intelligence Persistence (Persistence Integration
-- milestone, Part 3)
--
-- FLAGGED, SAME PROVISIONAL STANDING AS 021: no Engine BluePrint document
-- and no prior migration defines tables for the batch intelligence chain's
-- five domain outputs (OpportunityPriority, RankedOpportunity, Mission,
-- WorkflowState, FeedbackRecord — opportunity_prioritization/models.py,
-- opportunity_ranking/models.py, mission_generation/models.py,
-- workflow/models.py, feedback/models.py). Repository audit (this
-- milestone) confirmed none of the five have a table, migration, or write
-- path anywhere in this repo. 021_qualified_opportunities.sql is the only
-- precedent for a V2 table, so these five follow its exact conventions:
-- plain `create table if not exists`, no RLS (these are backend/service-
-- role-only tables — the same SUPABASE_SERVICE_ROLE_KEY path
-- storage_backends/supabase_backend.py already uses, never a
-- browser-exposed anon key), one index per lookup column actually used by
-- a real caller.
--
-- Canonical identity note (repository evidence, engine/adapters.py):
-- the domain layer's `opportunity_id` on all five dataclasses IS
-- `QualifiedOpportunity.pipeline_id` — the same text uuid4 string
-- 021's `pipeline_id` column already stores, minted once per
-- BusinessCandidate in providers/google_maps_provider.py and never
-- reused across sessions. No `references qualified_opportunities` FK is
-- added: 021's own `pipeline_id` column has no unique constraint (a
-- provisional, non-primary-key text column), so a real FK is not
-- possible without changing 021's existing shape, which is out of this
-- migration's scope ("do not redesign the schema"). opportunity_id
-- remains a plain indexed text column here, exactly the same posture
-- 021 already established for pipeline_id.
--
-- `session_id` note: engine/coordinator.py's EngineCoordinator keeps
-- Ranking explicitly session-scoped (`_batch_cohorts` / `_batch_results`,
-- both keyed by session_id) and run_batch_intelligence() (execution_
-- driver.py) computes one batch per session_id. None of the five
-- dataclasses carry a session_id field themselves (by design — see e.g.
-- opportunity_ranking/models.py's own "Minimal ordinal positioning
-- representation" docstring), so it is not added as a mirrored dataclass
-- column. It IS added here as plain lineage/provenance metadata (the row
-- came from this batch run), the same role `created_at` already plays on
-- 021 — not a domain field, so this does not violate "mirror the
-- canonical dataclass exactly". discovery_sessions/ and engine/session.py
-- confirm DiscoverySession itself is in-memory only (never persisted
-- anywhere in this repo), so session_id cannot carry a `references`
-- constraint either — flagged the same way pipeline_id's missing FK is
-- flagged above, not silently worked around.
--
-- created_at on every table below is the same infrastructure-only
-- timestamp 021 already adds (not a field on any of the five
-- dataclasses) — consistent precedent, not a new pattern.

-- ─── Opportunity Priorities (opportunity_prioritization.OpportunityPriority) ──
-- One row per opportunity ever evaluated by run_batch_intelligence().
-- opportunity_id is globally unique (see canonical identity note above),
-- so it is this table's primary key — Prioritization is computed exactly
-- once per opportunity (execution_driver.py drains each session's cohort
-- exactly once; opportunity_id itself never repeats across sessions).
create table if not exists opportunity_priorities (
  opportunity_id        text primary key,
  session_id            text not null,
  priority_score        double precision not null,
  score_contribution     double precision not null,
  recency_contribution   double precision not null,
  is_eligible            boolean not null,
  created_at             timestamptz not null default now()
);

create index if not exists idx_opportunity_priorities_session
  on opportunity_priorities (session_id);

-- ─── Ranked Opportunities (opportunity_ranking.RankedOpportunity) ─────────────
-- Explicitly session-scoped (locked architecture — "Ranking compares the
-- entire discovery cohort"): rank is only meaningful relative to the
-- other opportunities ranked in the same run_batch_intelligence() call,
-- so the natural key is (session_id, opportunity_id), not opportunity_id
-- alone (unlike opportunity_priorities above, whose score is independent
-- per-opportunity). opportunity_id is still unique across the whole
-- table today (see canonical identity note), but the composite key is
-- kept to make the session-scoping requirement structurally explicit
-- rather than implicit.
create table if not exists ranked_opportunities (
  session_id       text not null,
  opportunity_id   text not null,
  rank             integer not null,
  priority_score   double precision not null,
  created_at       timestamptz not null default now(),
  primary key (session_id, opportunity_id)
);

create index if not exists idx_ranked_opportunities_session_rank
  on ranked_opportunities (session_id, rank);

-- ─── Missions (mission_generation.Mission) ────────────────────────────────────
-- Mission itself is documented as having "zero surrogate identifiers" —
-- workflow/service.py's WorkflowEngineService.initialize_workflow()
-- confirms mission_id == opportunity_id at runtime (there is exactly one
-- Mission per eligible, ranked opportunity produced by
-- MissionGenerationService.generate_missions()). opportunity_id is
-- therefore this table's primary key; no surrogate mission_id column is
-- invented.
create table if not exists missions (
  opportunity_id   text primary key,
  business_id      text not null,
  mission_type     text not null check (
    mission_type in ('OUTREACH', 'AUDIT', 'RECOVERY', 'CLAIM', 'NURTURE')
  ),
  session_id       text not null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_missions_session
  on missions (session_id);
create index if not exists idx_missions_business
  on missions (business_id);

-- ─── Workflow States (workflow.WorkflowState) ─────────────────────────────────
-- One row per Mission's current lifecycle state. mission_id and
-- opportunity_id are both stored even though they are identical at
-- runtime today (see Missions note above) because WorkflowState's own
-- dataclass carries both as separate fields — mirroring it exactly means
-- not collapsing them into one column. Primary key is opportunity_id
-- (same 1:1-with-Mission reasoning as the missions table); a workflow's
-- status is expected to be updated in place as the on-demand
-- WorkflowEngineService.transition() advances it, not re-inserted, so
-- this table is upserted, never append-only.
create table if not exists workflow_states (
  opportunity_id   text primary key,
  mission_id       text not null,
  business_id      text not null,
  status           text not null check (
    status in (
      'UNSTARTED', 'QUEUED', 'IN_PROGRESS', 'PAUSED',
      'COMPLETED', 'FAILED', 'CANCELLED'
    )
  ),
  session_id       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_workflow_states_session
  on workflow_states (session_id);
create index if not exists idx_workflow_states_mission
  on workflow_states (mission_id);

-- ─── Feedback Records (feedback.FeedbackRecord) ───────────────────────────────
-- FeedbackRecord's own docstring: "Natural identity is derived from
-- (target_type, target_id, outcome)" — but zero surrogate IDs is a
-- design rule of the dataclass itself, not a uniqueness constraint on
-- the observation stream (the same target can legitimately receive the
-- same outcome observed more than once over time, e.g. a mission
-- dismissed and later re-dismissed). A row is therefore append-only
-- (never upserted) and needs an infrastructure primary key the same way
-- 021_qualified_opportunities.sql already needed one for an identically
-- surrogate-free dataclass (StoredOpportunity/QualifiedOpportunity) —
-- `id uuid` here follows that exact precedent, not a new pattern.
-- evidence.metadata (tuple[tuple[str,str],...]) is stored as jsonb
-- (an array of [key, value] pairs) since Postgres/PostgREST has no
-- native tuple-of-tuples type and this is the least lossy direct
-- representation — not a denormalization, just a type mapping.
create table if not exists feedback_records (
  id             uuid primary key default gen_random_uuid(),
  target_type    text not null check (
    target_type in ('opportunity', 'mission', 'business', 'provider')
  ),
  target_id      text not null,
  outcome        text not null check (
    outcome in (
      'mission_accepted', 'mission_dismissed', 'opportunity_ignored',
      'opportunity_converted', 'meeting_booked', 'proposal_sent',
      'client_won', 'false_positive', 'duplicate_opportunity'
    )
  ),
  notes          text,
  metadata       jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists idx_feedback_records_target
  on feedback_records (target_type, target_id, created_at desc);
