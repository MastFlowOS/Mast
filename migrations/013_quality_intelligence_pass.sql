-- MAST Opportunity Engine — Quality & Intelligence Implementation Pass
-- Implements the Step 2 audit's Critical fixes (C1-C5) plus the brief's
-- Priorities 2 (field-level trust), 3 (source attribution), 4 (contact
-- intelligence), 5/6 (opportunity + business intelligence signals), and
-- 7 (a separate Business Health Score). Additive only — no destructive
-- changes to existing columns/rows.

-- ─── C4 fix: LinkedIn gets a real column ───────────────────────────────────
-- ROOT CAUSE this fixes: LinkedIn discovery works end-to-end in the Python
-- engine (enrichment/site_crawler.py) and was written into `signals.linkedin`
-- (a jsonb bag) rather than a real column, so `socialOpportunity()` and every
-- frontend surface never read it. A real column makes it a first-class
-- contact channel exactly like instagram/facebook.
alter table businesses add column if not exists linkedin text;

-- The CRM-facing `leads` row mirrors instagram_handle/website etc. today;
-- linkedin_handle gives it the same first-class treatment there.
alter table leads add column if not exists linkedin_handle text;

-- ─── C5 fix: preserve every contact found, not just one winner ────────────
-- `email`/`phone` remain the single "best pick" display columns (unchanged
-- behavior for existing consumers). `emails`/`phones` carry everything the
-- engine actually found, so a founder's personal address next to a generic
-- info@ is never silently discarded.
alter table businesses add column if not exists emails jsonb not null default '[]'::jsonb;
alter table businesses add column if not exists phones jsonb not null default '[]'::jsonb;
comment on column businesses.emails is
  'Every email address found for this business, role-ranked: [{email, role}], '
  'role in (owner, founder, ceo, hello, info, sales, support, other). Role '
  'emails are NOT interchangeable for outreach — see Priority 4.';
comment on column businesses.phones is
  'Every distinct phone number found for this business (Google Business + '
  'website + Instagram bio), not just the single display `phone` column.';

-- ─── Priority 2/3 fix: field-level confidence + source attribution ────────
-- ROOT CAUSE this fixes: `confidence` was a single whole-record number with
-- no way to know, per field, where a value came from, how it was verified,
-- or when. `field_provenance` is keyed by field name (email, phone,
-- instagram, linkedin, website, contact_form, ...), each entry:
--   { value, source: <url or 'google_maps'/'instagram_bio'>,
--     method: 'website_crawl' | 'google_maps' | 'instagram_bio' | 'google_business',
--     confidence: 0-100, verified_at: timestamptz }
-- Confidence per field is computed at write time in fieldTrust.ts from the
-- (source, method) pair — see that file's SOURCE_CONFIDENCE table.
alter table businesses add column if not exists field_provenance jsonb not null default '{}'::jsonb;
comment on column businesses.field_provenance is
  'Per-field source attribution and trust: field_name -> {value, source, '
  'method, confidence, verified_at}. This is the field-level counterpart to '
  'the whole-record `confidence` column — every important field can now '
  'explain itself (where it came from, how it was verified, how much to '
  'trust it) instead of inheriting one number for the entire business.';

-- ─── Priority 5/6 fix: real, verifiable intelligence signals ──────────────
-- Each of these is populated by a real, cheap detector reusing HTML already
-- fetched during the site crawl (site_crawler.py) — never a placeholder
-- that is narrated to users as a checked-and-empty result.
alter table businesses add column if not exists website_is_weak boolean;
comment on column businesses.website_is_weak is
  'O2 fix: computed ONCE by the Python engine (utils/parsing.py::is_weak_site, '
  'the original, maintained domain list) and stored here, so the TS scoring '
  'layer reads this instead of keeping its own separately hand-written, '
  'already-drifted copy of the same weak-site domain list.';

alter table businesses add column if not exists ssl_valid boolean;
comment on column businesses.ssl_valid is
  'I2 fix: a real certificate probe (Playwright security_details()) taken '
  'during the site crawl, not a bare startswith("https://") string check. '
  'NULL = plain http:// or never crawled (not "broken"); false = downgraded '
  'or expired/invalid cert; true = valid.';

alter table businesses add column if not exists load_time_ms integer;
comment on column businesses.load_time_ms is
  'I3 fix: real page-load timing captured around the crawler''s existing '
  'page.goto() call, zero extra requests. Backs the "slow site" Web '
  'Developer opportunity example from the brief.';

alter table businesses add column if not exists seo jsonb not null default '{}'::jsonb;
comment on column businesses.seo is
  'On-page SEO signals from already-fetched HTML: has_title, title_length, '
  'has_meta_description, meta_description_length. Backs the "poor SEO, '
  'missing metadata" Marketing opportunity example.';

alter table businesses add column if not exists blog jsonb not null default '{}'::jsonb;
comment on column businesses.blog is
  'Blog/news section presence + staleness (has_blog, blog_url, '
  'last_post_days when a date could be parsed). Backs "stale blog" Marketing '
  'opportunity example.';

-- ─── Priority 7: Business Health Score (kept SEPARATE from Opportunity
-- Score per the brief's explicit instruction — "Do NOT merge it with
-- Opportunity Score") ──────────────────────────────────────────────────────
-- Answers "how healthy is this business digitally?" as opposed to Opportunity
-- Score's "how good a sales target is this for profession X?". Deliberately
-- NOT scoped per-profession — same rationale as business_opportunity_scores
-- being scoped per-profession while this one is universal: health is a fact
-- about the business, not about who's asking.
create table if not exists business_health_scores (
  business_id uuid primary key references businesses(id) on delete cascade,
  health_score numeric(5,2) not null,
  breakdown jsonb not null default '{}'::jsonb, -- {website, brand, seo, social, reviews, trust, tech, freshness}
  computed_at timestamptz not null default now()
);

alter table business_health_scores enable row level security;

create policy "business health readable by authenticated" on business_health_scores
  for select to authenticated using (true);

-- All writes happen exclusively via the backend service-role client
-- (src/scoring/storeBusinessHealth.ts), same pattern as
-- business_opportunity_scores.

comment on table business_health_scores is
  'Priority 7 — Business Health Score. A separate, profession-agnostic 0-100 '
  'read on a business''s overall digital health (website, brand, SEO, '
  'social, reviews, trust/confidence, tech stack, freshness). '
  'Opportunity Score can later combine this with profession-specific '
  'weighting; the two scores are computed and stored independently so '
  'either can evolve without forcing a migration of the other.';
