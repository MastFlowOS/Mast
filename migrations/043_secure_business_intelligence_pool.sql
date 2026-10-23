-- Migration 043: Secure Business Intelligence Pool & Ownership-Scoped RLS
--
-- Security Boundary:
-- 1. Shared vs. Private Data Architecture:
--    - Businesses, opportunity scores, health scores, and AI opportunity insights
--      are shared assets in a centralized global pool. This prevents redundant web scraping
--      and allows signals to compound over time across all platform users.
--    - However, client visibility to business intelligence records is strictly private and
--      permission-gated by CRM ownership: an authenticated user may only read business
--      intelligence records for businesses they have discovered or imported into their CRM (leads).
--    - Multiple users may legitimately hold leads for the same business; in that case, each
--      user has access to the business's public profile and scores, but their private CRM fields
--      (notes, tags, stage, communication history) remain strictly isolated in public.leads.
--    - Proprietary crawler signals (signals) and scraper audit dumps (raw_data) are private
--      to the worker fleet (service_role) and are not accessible to client roles.
-- 2. Realtime Hardening:
--    - Removes public.businesses from supabase_realtime publication to prevent unauthorized
--      streaming of newly discovered or updated businesses across tenant boundaries.
-- 3. Access Control:
--    - Revokes all permissions from anon and public.
--    - Revokes table-level write privileges (INSERT, UPDATE, DELETE) from authenticated.
--      All writes to businesses and intelligence tables must occur exclusively through
--      authorized server-side workers and routes (service_role).
--    - Restricts authenticated SELECT privileges on public.businesses to safe client-facing
--      columns, excluding raw_data and signals.

-- ─── 1. Realtime Publication Hardening ────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'businesses'
  ) then
    alter publication supabase_realtime drop table public.businesses;
  end if;
end $$;

-- ─── 2. Revoke Permissive RLS Policies ────────────────────────────────────────
drop policy if exists "businesses readable by authenticated" on public.businesses;
drop policy if exists "businesses_readable_by_authenticated" on public.businesses;

drop policy if exists "scores readable by authenticated" on public.business_opportunity_scores;
drop policy if exists "scores_readable_by_authenticated" on public.business_opportunity_scores;

drop policy if exists "business health readable by authenticated" on public.business_health_scores;
drop policy if exists "business_health_readable_by_authenticated" on public.business_health_scores;

drop policy if exists "business_opportunity_insights_read" on public.business_opportunity_insights;
drop policy if exists "insights readable by authenticated" on public.business_opportunity_insights;

-- ─── 3. Privilege Management ──────────────────────────────────────────────────
-- Revoke all privileges from anon and public on all four tables
revoke all on table public.businesses from anon, public;
revoke all on table public.business_opportunity_scores from anon, public;
revoke all on table public.business_health_scores from anon, public;
revoke all on table public.business_opportunity_insights from anon, public;

-- Revoke write privileges from authenticated (only service_role may write)
revoke insert, update, delete on table public.businesses from authenticated;
revoke insert, update, delete on table public.business_opportunity_scores from authenticated;
revoke insert, update, delete on table public.business_health_scores from authenticated;
revoke insert, update, delete on table public.business_opportunity_insights from authenticated;

-- Revoke table-level select on businesses from authenticated to prevent raw_data / signals extraction
revoke select on table public.businesses from authenticated;

-- Grant column-level SELECT on non-sensitive business fields to authenticated
grant select (
  id, place_id, normalized_name, normalized_phone, domain,
  name, category, niche, query_used, region, country_code,
  address, lat, lng, website, email, phone, instagram, facebook, linkedin,
  reviews_count, reviews_rating, has_photos,
  first_discovered_at, last_verified_at, verification_due_at,
  is_disqualified, disqualify_reason,
  confidence, archived_at, archived_reason, last_verification_kind,
  website_is_weak, ssl_valid, load_time_ms,
  created_at, updated_at
) on table public.businesses to authenticated;

-- Grant SELECT on scores and insights to authenticated (gated by RLS below)
grant select on table public.business_opportunity_scores to authenticated;
grant select on table public.business_health_scores to authenticated;
grant select on table public.business_opportunity_insights to authenticated;

-- Ensure service_role has full access for worker and gateway operations
grant all on table public.businesses to service_role;
grant all on table public.business_opportunity_scores to service_role;
grant all on table public.business_health_scores to service_role;
grant all on table public.business_opportunity_insights to service_role;

-- ─── 4. Performance Index for RLS Subquery ───────────────────────────────────
-- Accelerates `exists (select 1 from leads where business_id = ... and user_id = ...)`
create index if not exists idx_leads_business_user on public.leads (business_id, user_id);

-- ─── 5. Ownership-Scoped Row Level Security Policies ──────────────────────────
alter table public.businesses enable row level security;
alter table public.business_opportunity_scores enable row level security;
alter table public.business_health_scores enable row level security;
alter table public.business_opportunity_insights enable row level security;

-- businesses: Authenticated users can only select businesses linked to their own leads
create policy "businesses_owner_select"
  on public.businesses
  for select
  to authenticated
  using (
    exists (
      select 1 from public.leads l
      where l.business_id = businesses.id
        and l.user_id = auth.uid()
    )
  );

-- business_opportunity_scores: Scoped to businesses linked to the user's leads
create policy "scores_owner_select"
  on public.business_opportunity_scores
  for select
  to authenticated
  using (
    exists (
      select 1 from public.leads l
      where l.business_id = business_opportunity_scores.business_id
        and l.user_id = auth.uid()
    )
  );

-- business_health_scores: Scoped to businesses linked to the user's leads
create policy "health_scores_owner_select"
  on public.business_health_scores
  for select
  to authenticated
  using (
    exists (
      select 1 from public.leads l
      where l.business_id = business_health_scores.business_id
        and l.user_id = auth.uid()
    )
  );

-- business_opportunity_insights: Scoped to businesses linked to the user's leads
create policy "insights_owner_select"
  on public.business_opportunity_insights
  for select
  to authenticated
  using (
    exists (
      select 1 from public.leads l
      where l.business_id = business_opportunity_insights.business_id
        and l.user_id = auth.uid()
    )
  );
