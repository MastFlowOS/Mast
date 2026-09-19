-- Country-level discovery scope.
--
-- Until now the only geographic key on a pooled business was the free-text
-- `region` label of the REQUEST that first discovered it (e.g. "North
-- America"), which cannot answer "is this business in Canada?". This adds
-- the business's actual ISO-3166 alpha-2 country and teaches pool_lookup() to
-- filter on it.
--
--   * Continent / Global lookups keep the legacy `region ilike` match and
--     additionally match any business whose country_code is in the requested
--     set → a strict SUPERSET of the previous behavior.
--   * Country lookups (p_country_strict = true) match ONLY on country_code:
--     a Canada request can never return a US business, and a US request can
--     never return a Canadian one. Rows whose country is unknown (NULL) are
--     never returned for a country search — unknown is not "probably here".

alter table businesses add column if not exists country_code text;

create index if not exists idx_businesses_country_niche
  on businesses (country_code, niche) where country_code is not null;

-- Best-effort backfill from the engine payload we already store. The engine
-- echoes the ISO code it was asked to search; only well-formed 2-letter
-- values are trusted. Anything else stays NULL (and is simply not eligible
-- for country-scoped pool lookups until it is rediscovered, which fills it).
update businesses
   set country_code = upper(raw_data->>'country')
 where country_code is null
   and raw_data->>'country' ~ '^[A-Za-z]{2}$';

-- Signature changes (two new defaulted params) → drop the old overload so
-- named-argument RPC calls stay unambiguous.
drop function if exists pool_lookup(uuid, text, text, text, boolean, int);

create or replace function pool_lookup(
  p_user_id uuid,
  p_region text,
  p_niche text,
  p_profession_slug text,
  p_rank boolean,
  p_limit int,
  p_country_codes text[] default null,
  p_country_strict boolean default false
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
      select 1 from leads l
      where l.user_id = p_user_id and l.business_id = b.id
    )
  order by
    (case when p_rank then coalesce(s.opportunity_score, -1) else 0 end) desc,
    b.first_discovered_at desc
  limit p_limit;
$$;

grant execute on function public.pool_lookup(uuid, text, text, text, boolean, int, text[], boolean) to service_role;

comment on column businesses.country_code is
  'ISO-3166 alpha-2 country the business was discovered in (the country the '
  'provider was asked to search). NULL = unknown. Used by pool_lookup() for '
  'country-scoped searches; `region` remains the legacy request label.';
