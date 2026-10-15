-- Internal lead-quality filter (minimum rating / minimum review count) applied
-- inside the pool query, in the WHERE clause, i.e. BEFORE ORDER BY / LIMIT, so
-- low-quality rows cannot consume the candidate window (plain or ranked).
--
-- Thresholds are NOT hardcoded here: the application passes them
-- (src/lib/leadQualityPolicy.ts). NULL threshold = that check disabled.
--
-- "Unknown never rejects" — mirrors src/lib/leadQualityPolicy.ts exactly. The
-- scraper stores reviews_rating = NULL and reviews_count = 0 when extraction
-- failed, which is indistinguishable from a genuinely unrated/unreviewed
-- place, so only positively observed values are judged:
--   rating : judged only when 0 < reviews_rating <= 5
--   reviews: judged only when reviews_count > 0
--
-- Adds an 11-argument overload; migration 037's 9-argument function is left
-- untouched (already applied) so the currently deployed API keeps working
-- during rollout. Apply this migration BEFORE deploying the application code
-- that passes p_min_rating / p_min_reviews. Remove the old overload in a
-- later cleanup once nothing calls it.

create or replace function public.pool_lookup(
  p_user_id uuid,
  p_region text,
  p_niche text,
  p_profession_slug text,
  p_rank boolean,
  p_limit integer,
  p_country_codes text[],
  p_country_strict boolean,
  p_channels text[],
  p_min_rating numeric,
  p_min_reviews integer
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
  from public.businesses b
  left join public.business_opportunity_scores s
    on s.business_id = b.id and s.profession_slug = p_profession_slug
  where b.is_disqualified = false
    and b.archived_at is null
    and (
      case
        when p_country_strict then coalesce(b.country_code = any(p_country_codes), false)
        else (
          p_region = ''
          or b.region ilike '%' || p_region || '%'
          or coalesce(b.country_code = any(p_country_codes), false)
        )
      end
    )
    and (p_niche = '' or b.niche ilike '%' || p_niche || '%')
    and not exists (
      select 1 from public.leads l
      where l.user_id = p_user_id and l.business_id = b.id
    )
    and not exists (
      select 1
      from unnest(coalesce(p_channels, array[]::text[])) as requested(channel)
      where not coalesce(
        case requested.channel
          when 'email' then nullif(btrim(b.email), '') is not null
          when 'phone' then nullif(btrim(b.phone), '') is not null
          when 'instagram' then nullif(btrim(b.instagram), '') is not null
          when 'website' then nullif(btrim(b.website), '') is not null
          else false
        end,
        false
      )
    )
    -- Quality: reject only on positively observed low values.
    and (
      p_min_rating is null
      or b.reviews_rating is null
      or b.reviews_rating <= 0
      or b.reviews_rating > 5
      or b.reviews_rating >= p_min_rating
    )
    and (
      p_min_reviews is null
      or coalesce(b.reviews_count, 0) <= 0
      or b.reviews_count >= p_min_reviews
    )
  order by
    (case when p_rank then coalesce(s.opportunity_score, -1) else 0 end) desc,
    b.first_discovered_at desc
  limit p_limit;
$$;

grant execute on function public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[], numeric, integer) to service_role;

comment on function public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[], numeric, integer) is
  'Shared pool lookup. Applies channel AND filters and the internal rating/review quality filter before ORDER BY/LIMIT; rank only changes ordering, never eligibility. Unknown rating/review values never reject.';
