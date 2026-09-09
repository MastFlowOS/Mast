-- MAST Phase 2B — per-user, per-search-scope street coverage.
-- `discovery_streets` remains the GLOBAL inventory.  This table is only
-- user-specific progress for one discovery scope.
--
-- Scope identity: user_id + niche + profession_slug (NULL means absent)
-- + country_code + city + source + street_id. `source` is the discovery
-- provider, not discovery_streets.source (which is inventory provenance).
create table if not exists user_discovery_street_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  street_id uuid not null references discovery_streets(id) on delete cascade,
  niche text not null check (btrim(niche) <> ''),
  profession_slug text references professions(slug) on delete restrict,
  country_code text not null check (btrim(country_code) <> ''),
  city text not null check (btrim(city) <> ''),
  source text not null check (btrim(source) <> ''),
  status text not null default 'UNSEEN'
    check (status in ('UNSEEN', 'IN_PROGRESS', 'COMPLETED')),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  claim_token uuid,
  worker_id text,
  run_id text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'IN_PROGRESS'
      and claimed_at is not null
      and lease_expires_at is not null
      and claim_token is not null
      and worker_id is not null)
    or
    (status in ('UNSEEN', 'COMPLETED')
      and lease_expires_at is null
      and claim_token is null
      and worker_id is null
      and run_id is null)
  ),
  check ((status = 'COMPLETED') = (completed_at is not null))
);

-- NULL is a meaningful "no profession definition" scope.  The expression
-- index makes it unique even on PostgreSQL versions where UNIQUE treats NULLs
-- as distinct.
create unique index if not exists idx_user_discovery_street_state_scope_street
  on user_discovery_street_state (
    user_id, niche, coalesce(profession_slug, ''), country_code, city, source, street_id
  );

create index if not exists idx_user_discovery_street_state_claim
  on user_discovery_street_state (
    user_id, niche, profession_slug, country_code, city, source,
    status, lease_expires_at, street_id
  );

-- Migration 028's location index includes region. Claims use country + city,
-- so this gives the selection query a direct deterministic inventory path.
create index if not exists idx_discovery_streets_coverage_location
  on discovery_streets (country_code, city, normalized_name, id);

alter table user_discovery_street_state enable row level security;
-- Service-role worker bookkeeping only; no user-facing policies are added.

create or replace function set_user_discovery_street_state_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_discovery_street_state_updated_at on user_discovery_street_state;
create trigger trg_user_discovery_street_state_updated_at
  before update on user_discovery_street_state
  for each row execute function set_user_discovery_street_state_updated_at();

-- Enforces that a state does not claim a street from a different geographic
-- scope. Source is intentionally independent: it is the search provider.
create or replace function validate_user_discovery_street_state_location()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from discovery_streets ds
    where ds.id = new.street_id
      and ds.country_code = new.country_code
      and ds.city = new.city
  ) then
    raise exception 'street % does not belong to coverage location (%, %)',
      new.street_id, new.country_code, new.city;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_user_discovery_street_state_location on user_discovery_street_state;
create trigger trg_user_discovery_street_state_location
  before insert or update of street_id, country_code, city
  on user_discovery_street_state
  for each row execute function validate_user_discovery_street_state_location();

-- Idempotently materialises an explicit UNSEEN state for one known street.
-- Claiming is still lazy: an absent row is logically UNSEEN and only the
-- winning claim writes it, avoiding a city-wide application-memory scan.
create or replace function initialize_user_discovery_street_state(
  p_user_id uuid,
  p_street_id uuid,
  p_niche text,
  p_profession_slug text,
  p_country_code text,
  p_city text,
  p_source text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_state_id uuid;
begin
  insert into user_discovery_street_state (
    user_id, street_id, niche, profession_slug, country_code, city, source, status
  ) values (
    p_user_id, p_street_id, p_niche, p_profession_slug, p_country_code, p_city, p_source, 'UNSEEN'
  ) on conflict do nothing
  returning id into v_state_id;

  if v_state_id is null then
    select uds.id into v_state_id
    from user_discovery_street_state uds
    where uds.user_id = p_user_id
      and uds.street_id = p_street_id
      and uds.niche = p_niche
      and uds.profession_slug is not distinct from p_profession_slug
      and uds.country_code = p_country_code
      and uds.city = p_city
      and uds.source = p_source;
  end if;
  return v_state_id;
end;
$$;

-- Atomically claims exactly one eligible street. The unique scope/street
-- index is the authority for first claims. For existing rows, PostgreSQL
-- locks the conflicting row and re-evaluates the UPDATE predicate after a
-- concurrent transaction commits. A loser loops, sees that active row as
-- ineligible, and selects another street. This is an atomic upsert-equivalent
-- to SELECT FOR UPDATE SKIP LOCKED for lazily-created state rows.
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
    -- One database-side scoped selection; no N+1 or worker-local coverage map.
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
    ) on conflict do update set
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
    -- A concurrent transaction won this scope/street. Retry after its row
    -- lock releases; the next lookup excludes its active lease.
  end loop;
end;
$$;

-- Renewal and completion require the current opaque claim token. A stale
-- worker can neither extend nor complete a street once another worker has
-- reclaimed it.
create or replace function heartbeat_discovery_street_claim(
  p_state_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_lease_seconds <= 0 then
    raise exception 'p_lease_seconds must be greater than zero';
  end if;
  update user_discovery_street_state
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_state_id
    and user_id = p_user_id
    and status = 'IN_PROGRESS'
    and claim_token = p_claim_token
    and worker_id = p_worker_id
    and lease_expires_at > now();
  return found;
end;
$$;

-- Only this explicit successful street-level completion transition writes
-- COMPLETED. Finding a business or reaching a run-wide target is not enough.
create or replace function complete_discovery_street_claim(
  p_state_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_worker_id text
)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update user_discovery_street_state
  set status = 'COMPLETED',
      completed_at = now(),
      lease_expires_at = null,
      claim_token = null,
      worker_id = null,
      run_id = null,
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

comment on table user_discovery_street_state is
  'Phase 2B per-user, per-search-scope coverage; discovery_streets remains global.';
comment on function claim_discovery_street(uuid, text, text, text, text, text, text, text, integer) is
  'Atomically claims one UNSEEN or expired IN_PROGRESS street for one user/search scope; COMPLETED is never eligible.';
comment on function complete_discovery_street_claim(uuid, uuid, uuid, text) is
  'Completes only a current, unexpired claim after successful street-level discovery.';

grant execute on function public.initialize_user_discovery_street_state(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.claim_discovery_street(uuid, text, text, text, text, text, text, text, integer) to service_role;
grant execute on function public.heartbeat_discovery_street_claim(uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.complete_discovery_street_claim(uuid, uuid, uuid, text) to service_role;
