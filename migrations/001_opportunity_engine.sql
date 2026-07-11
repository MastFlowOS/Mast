-- MAST Opportunity Engine — Part 3, Phase 1
-- Core schema for the Global Lead Pool and supporting job/credit tracking.
-- Run against the same Supabase/Postgres project the frontend already uses.

create extension if not exists "pgcrypto";

-- ─── Professions ────────────────────────────────────────────────────────────
-- Mirrors src/routes/onboarding.tsx FOCUS_AREAS exactly. Kept as a lookup
-- table (not a Postgres enum) so new professions can be added without a
-- schema migration — only a row insert.
create table if not exists professions (
  slug text primary key,
  label text not null
);

insert into professions (slug, label) values
  ('graphic_design',            'Graphic Design'),
  ('digital_marketing',         'Digital Marketing'),
  ('writing_translation',       'Writing & Translation'),
  ('video_animation',           'Video & Animation'),
  ('music_audio',               'Music & Audio'),
  ('programming_tech',          'Programming & Tech'),
  ('data',                      'Data'),
  ('business',                  'Business'),
  ('personal_growth_hobbies',   'Personal Growth & Hobbies'),
  ('photography',               'Photography'),
  ('finance',                   'Finance'),
  ('end_to_end_project',        'End-to-End Project')
on conflict (slug) do nothing;

-- ─── Global Lead Pool (businesses) ─────────────────────────────────────────
-- One row per real-world business, deduplicated globally. This is the asset
-- that compounds over time — never deleted for being "old".
create table if not exists businesses (
  id uuid primary key default gen_random_uuid(),

  -- Dedup keys carried over from the Part 1 engine's storage/dedup.py logic
  place_id text unique,
  normalized_name text,
  normalized_phone text,
  domain text,

  name text not null,
  category text,
  niche text,
  query_used text,
  region text,
  address text,
  lat double precision,
  lng double precision,

  website text,
  email text,
  phone text,
  instagram text,
  facebook text,

  reviews_count int default 0,
  reviews_rating numeric(3,2),
  has_photos boolean default false,

  -- Raw structured signals from Part 1 enrichment (site_crawler, ig_intel).
  -- Kept as-is so scoring can be recomputed later without re-scraping.
  signals jsonb not null default '{}'::jsonb,

  -- Full raw payload from the scraper for auditability / debugging.
  raw_data jsonb,

  first_discovered_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  verification_due_at timestamptz not null default (now() + interval '14 days'),

  is_disqualified boolean not null default false, -- chain / cannabis / permanently closed
  disqualify_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_businesses_region_niche on businesses (region, niche);
create index if not exists idx_businesses_verification_due on businesses (verification_due_at) where not is_disqualified;
create index if not exists idx_businesses_domain on businesses (domain);

-- ─── Per-profession Opportunity Scores ─────────────────────────────────────
-- The Opportunity Score is a function of (business signals, profession), not
-- of the individual user. Precomputing one row per (business, profession)
-- means we score once per verification cycle instead of once per user —
-- the same cached score is reused for every freelancer sharing a profession.
create table if not exists business_opportunity_scores (
  business_id uuid not null references businesses(id) on delete cascade,
  profession_slug text not null references professions(slug),

  opportunity_score numeric(5,2) not null,
  score_breakdown jsonb not null default '{}'::jsonb, -- per-signal contribution, for AI Opportunity Insights later
  computed_at timestamptz not null default now(),

  primary key (business_id, profession_slug)
);

create index if not exists idx_scores_profession_score
  on business_opportunity_scores (profession_slug, opportunity_score desc);

-- ─── Scrape / verification jobs ────────────────────────────────────────────
-- pg-boss owns actual queue delivery; this table is the user/product-facing
-- record Discover polls or subscribes to via Supabase Realtime.
create table if not exists scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,

  mode text not null check (mode in ('live', 'instant_pool', 'instant_pool_ranked', 'background_expand', 'verification')),
  status text not null default 'queued' check (status in ('queued','running','streaming','completed','failed')),

  query jsonb not null, -- { niche, region, profession_slug, requested_count }
  results_count int not null default 0,
  error text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_scrape_jobs_user on scrape_jobs (user_id, created_at desc);

-- ─── CRM linkage + credit enforcement, on the EXISTING `leads` table ───────
-- Relationships / Pipeline / Mission already read and write a `leads` table
-- directly (see src/lib/api.ts — dbRowToLead, generateLeads' mock insert).
-- Per the doc, Discover results become CRM records automatically with no
-- manual "Save Lead" step, and that's already how `leads` behaves today.
--
-- Rather than introduce a second, competing per-user table, Phase 1 extends
-- `leads` with a link back to the Global Lead Pool. A row here IS the CRM
-- record; `business_id` + the unique index below is what makes it also the
-- single source of truth for "has this user already been charged for this
-- business".
alter table leads add column if not exists business_id uuid references businesses(id);
alter table leads add column if not exists profession_slug text references professions(slug);
alter table leads add column if not exists opportunity_score numeric(5,2); -- snapshot at delivery time, for display stability
alter table leads add column if not exists discovery_mode text; -- 'live' | 'instant_pool' | 'instant_pool_ranked'
alter table leads add column if not exists scrape_job_id uuid references scrape_jobs(id);
alter table leads add column if not exists credit_charged boolean not null default true;

-- Never charge the same user twice for the same business. Partial index so
-- historical rows without a business_id (pre-Part-3, CSV imports, etc.)
-- don't collide.
create unique index if not exists idx_leads_user_business_unique
  on leads (user_id, business_id) where business_id is not null;

create index if not exists idx_leads_business on leads (business_id);

-- ─── Row Level Security ─────────────────────────────────────────────────────
-- businesses / scores are a shared global asset: readable by any
-- authenticated user, writable only by the backend service role.
alter table businesses enable row level security;
alter table business_opportunity_scores enable row level security;
alter table scrape_jobs enable row level security;
-- `leads` already has RLS policies from the existing app (per-user select/
-- insert/update/delete scoped to auth.uid() = user_id) — left untouched.

create policy "businesses readable by authenticated" on businesses
  for select to authenticated using (true);

create policy "scores readable by authenticated" on business_opportunity_scores
  for select to authenticated using (true);

create policy "users see own scrape jobs" on scrape_jobs
  for select to authenticated using (auth.uid() = user_id);

-- All INSERT/UPDATE/DELETE on businesses / business_opportunity_scores /
-- scrape_jobs happens exclusively through the backend service (service-role
-- key), never directly from the client. Writes to `leads` continue to be
-- scoped by the app's existing RLS policies, now additionally populated by
-- the worker fleet via service role during Discover deliveries.
