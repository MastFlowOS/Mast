-- MAST Opportunity Engine — Part 3, Phase 8
-- Opportunity Intelligence: cached AI-generated content.
--
-- Per the product doc, AI is an explanation/prioritization layer on top of
-- the Opportunity Engine, not the product itself. Every row here is
-- generated FROM real data already in Postgres (business_opportunity_scores,
-- leads, scrape_jobs) — never fabricated, and never the sole source of
-- truth for a number the user could otherwise see.
--
-- Everything is cached per (user, kind, period_key) rather than regenerated
-- on every request:
--  - keeps LLM spend bounded and predictable per plan tier
--  - "Today's Briefing" / "Weekly Intelligence" are meant to read as a
--    considered snapshot, not something that reshuffles on every refresh

create table if not exists ai_intelligence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null, -- 'executive_briefing' | 'weekly_intelligence' | 'pipeline_coaching'
  period_key text not null, -- e.g. '2026-07-10' (daily) or '2026-W28' (weekly)
  content jsonb not null,
  model text not null,
  generated_at timestamptz not null default now(),
  unique (user_id, kind, period_key)
);

create index if not exists idx_ai_intelligence_user_kind on ai_intelligence (user_id, kind, generated_at desc);

alter table ai_intelligence enable row level security;

create policy if not exists ai_intelligence_owner_read
  on ai_intelligence for select
  using (auth.uid() = user_id);

-- Opportunity Insights are cached per (business, profession) — same
-- rationale as business_opportunity_scores: the underlying facts about a
-- business don't change per-user, only which profession is asking. Cheap
-- to reuse across every freelancer in the same profession who lands on the
-- same business, same as scoring already works.
create table if not exists business_opportunity_insights (
  business_id uuid not null references businesses(id) on delete cascade,
  profession_slug text not null references professions(slug),
  headline text not null,
  talking_points jsonb not null, -- string[]
  opening_line text not null,
  score_snapshot numeric(5,2) not null, -- opportunity_score at generation time; regenerate if stale
  model text not null,
  generated_at timestamptz not null default now(),
  primary key (business_id, profession_slug)
);

alter table business_opportunity_insights enable row level security;

create policy if not exists business_opportunity_insights_read
  on business_opportunity_insights for select
  using (true);

comment on table ai_intelligence is
  'Cached AI Opportunity Intelligence output (Phase 8): executive briefings, '
  'weekly intelligence, pipeline coaching. One row per user per period — '
  'regenerated when the period rolls over, not on every page view.';

comment on table business_opportunity_insights is
  'Cached per-business, per-profession AI explanation of an Opportunity '
  'Score: why it was surfaced and a suggested opening line. Grounded in '
  'business_opportunity_scores.score_breakdown, not freeform generation.';
