-- MAST Phase 2B Repair — fair street ordering and explicit claim release.
--
-- Adds attempt tracking to user_discovery_street_state so streets that stop
-- early (target reached, timeout, cancel, transient failure) are returned to
-- UNSEEN and retried AFTER untouched streets rather than re-claimed first.
-- Preserves all status invariants and CHECK constraints from migration 029.

alter table user_discovery_street_state
  add column if not exists attempt_count integer not null default 0;

alter table user_discovery_street_state
  add column if not exists last_attempt_at timestamptz;

-- Returns an active IN_PROGRESS claim to UNSEEN, clearing its lease, token,
-- worker, and run while incrementing attempt_count and updating last_attempt_at.
-- Only operates on the current valid claim holder with an unexpired lease.
-- COMPLETED rows are never modified.
create or replace function release_discovery_street_claim(
  p_state_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_worker_id text
)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update user_discovery_street_state
  set status = 'UNSEEN',
      lease_expires_at = null,
      claim_token = null,
      worker_id = null,
      run_id = null,
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      updated_at = now()
  where id = p_state_id
    and user_id = p_user_id
    and status = 'IN_PROGRESS'
    and claim_token = p_claim_token
    and worker_id = p_worker_id
    and lease_expires_at > now();
  return found;
end;
$$;

comment on function release_discovery_street_claim(uuid, uuid, uuid, text) is
  'Releases a current, unexpired IN_PROGRESS street claim back to UNSEEN and increments attempt_count; never touches COMPLETED rows.';

grant execute on function public.release_discovery_street_claim(uuid, uuid, uuid, text) to service_role;

-- Replacement claim_discovery_street:
-- Ordering considers attempt_count asc (absent rows count as 0) before
-- normalized_name and id, ensuring untouched streets are claimed before
-- previously-attempted streets.
-- Retains #variable_conflict use_column and the exact ON CONFLICT expression target.
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
#variable_conflict use_column
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
    order by coalesce(uds.attempt_count, 0) asc, ds.normalized_name, ds.id
    for update of ds skip locked
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
  'orders by attempt_count asc (absent row = 0), normalized_name, id; '
  'the ON CONFLICT target exactly infers idx_user_discovery_street_state_scope_street.';

grant execute on function public.claim_discovery_street(uuid, text, text, text, text, text, text, text, integer) to service_role;
