-- MAST Phase 2B hotfix: migration 029 created an expression unique index:
--   (user_id, niche, coalesce(profession_slug, ''), country_code, city,
--    source, street_id)
-- A bare ON CONFLICT DO UPDATE cannot infer an expression-only unique index.
-- This replacement function names the exact index expressions as its conflict
-- target; no table, state, lease, token, or discovery-worker behavior changes.
create or replace function claim_discovery_street(
  p_user_id uuid,
  p_niche text,
  p_profession_slug text,
  p_country_code text,
  p_city text,
  p_source text,
  p_worker_id text,
  p_run_id text default null,
  p_lease_seconds integer default 300
)
returns table (
  state_id uuid,
  street_id uuid,
  street_key text,
  street_name text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_street_id uuid;
  v_state_id uuid;
  v_token uuid;
begin
  if p_lease_seconds <= 0 then
    raise exception 'p_lease_seconds must be greater than zero';
  end if;
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'p_worker_id is required';
  end if;

  loop
    select ds.id into v_street_id
    from discovery_streets ds
    left join user_discovery_street_state uds
      on uds.street_id = ds.id
     and uds.user_id = p_user_id
     and uds.niche = p_niche
     and uds.profession_slug is not distinct from p_profession_slug
     and uds.country_code = p_country_code
     and uds.city = p_city
     and uds.source = p_source
    where ds.country_code = p_country_code
      and ds.city = p_city
      and (
        uds.id is null
        or uds.status = 'UNSEEN'
        or (uds.status = 'IN_PROGRESS' and uds.lease_expires_at <= now())
      )
    order by ds.normalized_name, ds.id
    limit 1;

    if v_street_id is null then
      return;
    end if;

    v_token := gen_random_uuid();
    insert into user_discovery_street_state (
      user_id, street_id, niche, profession_slug, country_code, city, source,
      status, claimed_at, lease_expires_at, claim_token, worker_id, run_id
    ) values (
      p_user_id, v_street_id, p_niche, p_profession_slug, p_country_code, p_city, p_source,
      'IN_PROGRESS', now(), now() + make_interval(secs => p_lease_seconds), v_token, p_worker_id, p_run_id
    ) on conflict (
      user_id,
      niche,
      (coalesce(profession_slug, '')),
      country_code,
      city,
      source,
      street_id
    ) do update set
      status = 'IN_PROGRESS',
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      claim_token = v_token,
      worker_id = p_worker_id,
      run_id = p_run_id,
      completed_at = null,
      updated_at = now()
    where user_discovery_street_state.status = 'UNSEEN'
       or (user_discovery_street_state.status = 'IN_PROGRESS'
           and user_discovery_street_state.lease_expires_at <= now())
    returning id into v_state_id;

    if v_state_id is not null then
      return query
      select uds.id, ds.id, ds.street_key, ds.street_name,
             uds.claim_token, uds.claimed_at, uds.lease_expires_at
      from user_discovery_street_state uds
      join discovery_streets ds on ds.id = uds.street_id
      where uds.id = v_state_id;
      return;
    end if;
    -- A concurrent transaction acquired this exact scope/street first. Its
    -- active lease is excluded by the next scoped selection, so retrying is
    -- safe and cannot return duplicate ownership.
  end loop;
end;
$$;

comment on function claim_discovery_street(uuid, text, text, text, text, text, text, text, integer) is
  'Atomically claims one UNSEEN or expired IN_PROGRESS street for one user/search scope; '
  'the ON CONFLICT target exactly infers idx_user_discovery_street_state_scope_street.';

grant execute on function public.claim_discovery_street(uuid, text, text, text, text, text, text, text, integer) to service_role;
