-- Apply requested-channel filtering inside the pool query, before ORDER BY/LIMIT.
-- This prevents recent but incomplete rows from consuming the candidate window
-- and hiding older businesses that actually satisfy the user's channel selection.
--
-- Keep the existing 8-argument overload during rollout so the currently
-- deployed API remains compatible. Updated application code passes all 9 args;
-- after deployment the old overload can be removed in a later cleanup.

create or replace function public.pool_lookup(
  p_user_id uuid,
  p_region text,
  p_niche text,
  p_profession_slug text,
  p_rank boolean,
  p_limit integer,
  p_country_codes text[],
  p_country_strict boolean,
  p_channels text[]
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
  order by
    (case when p_rank then coalesce(s.opportunity_score, -1) else 0 end) desc,
    b.first_discovered_at desc
  limit p_limit;
$$;

grant execute on function public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[]) to service_role;

comment on function public.pool_lookup(uuid, text, text, text, boolean, integer, text[], boolean, text[]) is
  'Shared pool lookup. Applies every requested channel as an AND filter before ORDER BY/LIMIT; rank only changes ordering, never eligibility.';
