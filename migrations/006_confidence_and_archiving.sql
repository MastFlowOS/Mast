-- MAST Opportunity Engine — Part 3, Phase 7
-- Background verification: gradual confidence, archiving (never deleting).

alter table businesses add column if not exists confidence numeric(5,2) not null default 65;
alter table businesses add column if not exists archived_at timestamptz;
alter table businesses add column if not exists archived_reason text;
alter table businesses add column if not exists last_verification_kind text; -- 'full' | 'rediscovery'

-- Archived businesses are never deleted (per product requirement) but must
-- never be delivered to a user again — pool_lookup excludes them the same
-- way it already excludes is_disqualified.
create index if not exists idx_businesses_archived on businesses (archived_at) where archived_at is null;

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
    and b.archived_at is null
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

comment on column businesses.confidence is
  'Gradual 0-100 trust signal, NOT a binary validity flag. Increases on '
  'successful verification/rediscovery, decreases on failed verification. '
  'Repeated failures drive this toward 0, which is what triggers '
  'archiving — businesses are never deleted, only archived (see '
  'archived_at) once confidence bottoms out.';

comment on column businesses.last_verification_kind is
  'Which mechanism last confirmed this business is still real: '
  '''full'' (a scheduled verification job actually re-crawled it) or '
  '''rediscovery'' (it turned up again in a normal user search, treated as '
  'a lightweight successful verification — see deliverLead.ts). Lets the '
  'verification job distinguish "genuinely unchecked" from "recently '
  'confirmed incidentally" without re-crawling businesses that are '
  'already being observed regularly.';
