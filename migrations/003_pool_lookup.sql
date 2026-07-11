-- MAST Opportunity Engine — Part 3, Phase 3
-- Global Lead Pool: real pool-first lookup for Instant Discovery.

create extension if not exists "pg_trgm";

-- ilike '%term%' on region/niche doesn't use a plain btree index — trigram
-- GIN indexes make that fast without requiring exact matches, which
-- matters since region/niche are free text typed by the user, not a
-- controlled vocabulary.
create index if not exists idx_businesses_region_trgm on businesses using gin (region gin_trgm_ops);
create index if not exists idx_businesses_niche_trgm on businesses using gin (niche gin_trgm_ops);

-- ─── Pool lookup ─────────────────────────────────────────────────────────
-- Single round trip for "find businesses matching this region/niche that
-- this user hasn't already received, optionally ranked by their
-- profession's Opportunity Score." Kept as a SQL function rather than
-- assembled client-side so the anti-join against `leads` (never re-deliver
-- an already-owned business) and the ranking join both run as one indexed
-- query instead of N round trips from Node.
--
-- p_rank = false: plain freshness ordering (Starter). Opportunity Score
-- doesn't exist yet in a meaningful way until Phase 6 anyway (scorer.py is
-- still the pre-inversion Lead Score) — this function already accepts a
-- profession dimension so Phase 6 is a pure data change, not a query
-- rewrite here.
create or replace function pool_lookup(
  p_user_id uuid,
  p_region text,
  p_niche text,
  p_profession_slug text,
  p_rank boolean,
  p_limit int
)
returns table (
  business_id uuid,
  opportunity_score numeric
)
language sql
stable
as $$
  select b.id as business_id,
         s.opportunity_score
  from businesses b
  left join business_opportunity_scores s
    on s.business_id = b.id and s.profession_slug = p_profession_slug
  where b.is_disqualified = false
    and (p_region = '' or b.region ilike '%' || p_region || '%')
    and (p_niche = '' or b.niche ilike '%' || p_niche || '%')
    and not exists (
      select 1 from leads l
      where l.user_id = p_user_id and l.business_id = b.id
    )
  order by
    (case when p_rank then coalesce(s.opportunity_score, -1) else 0 end) desc,
    b.first_discovered_at desc
  limit p_limit;
$$;
