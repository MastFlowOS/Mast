-- Migration 047: Atomic Business Deduplication & Idempotent Lead Delivery (Phase 7.1)
--
-- Scope:
-- 1. upsert_business_from_fingerprints:
--    - Transaction-level advisory locking (namespace 424242) sorted by canonical fingerprint string.
--    - Atomic resolution of business identity across concurrent scouts and discovery plans.
--    - Handles three outcomes explicitly:
--        a) Zero matches: inserts one new business row.
--        b) Exactly one match: updates verification timestamps, applies confidence boost,
--           merges contact channels, and unifies fingerprints.
--        c) Multiple matches: returns an explicit 'ambiguous' status with candidate IDs.
--    - Preserves branch/location distinctions by rejecting matches with conflicting place_ids.
--
-- 2. deliver_lead_for_user:
--    - Transaction-level advisory locking (namespace 424243) keyed on (user_id, business_id).
--    - Atomic composition of:
--        a) Existing lead ownership check.
--        b) Discovery plan reservation via claim_discovery_delivery().
--        c) Authoritative credit reservation via try_increment_lead_usage().
--        d) Lead insertion with ON CONFLICT (user_id, business_id) DO NOTHING guard.
--        e) Atomic rollback of credit and plan reservation on duplicate race.
--    - Guarantees exactly one lead, exactly one credit charged, exactly one plan slot counted.
--    - Retries remain idempotent.

-- ─── 1. Atomic Business Upsert ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_business_from_fingerprints(
  p_name text,
  p_category text default null,
  p_niche text default null,
  p_query_used text default null,
  p_region text default null,
  p_country_code text default null,
  p_address text default null,
  p_website text default null,
  p_email text default null,
  p_phone text default null,
  p_instagram text default null,
  p_facebook text default null,
  p_linkedin text default null,
  p_emails jsonb default '[]'::jsonb,
  p_phones jsonb default '[]'::jsonb,
  p_field_provenance jsonb default '{}'::jsonb,
  p_website_is_weak boolean default null,
  p_ssl_valid boolean default null,
  p_load_time_ms integer default null,
  p_seo jsonb default '{}'::jsonb,
  p_blog jsonb default '{}'::jsonb,
  p_reviews_count integer default 0,
  p_reviews_rating numeric default null,
  p_has_photos boolean default false,
  p_is_disqualified boolean default false,
  p_signals jsonb default '{}'::jsonb,
  p_raw_data jsonb default '{}'::jsonb,
  p_fingerprints text[] default '{}'::text[],
  p_place_id text default null
)
RETURNS TABLE (
  business_id uuid,
  action text,              -- 'inserted' | 'updated' | 'ambiguous'
  ambiguous_ids uuid[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_sorted_fingerprints text[];
  v_fp text;
  v_matching_ids uuid[];
  v_match_count integer;
  v_existing_id uuid;
  v_place_id text;
  v_current_fps text[];
  v_current_emails jsonb;
  v_current_phones jsonb;
  v_current_place_id text;
  v_merged_fingerprints text[];
  v_merged_emails jsonb;
  v_merged_phones jsonb;
BEGIN
  -- Normalize place_id
  v_place_id := nullif(trim(p_place_id), '');

  -- Filter, clean, and deterministically sort fingerprints
  -- Whitespace-only strings and null entries are stripped
  SELECT array_agg(DISTINCT trim(f) ORDER BY trim(f))
  INTO v_sorted_fingerprints
  FROM unnest(p_fingerprints) f
  WHERE f IS NOT NULL AND length(trim(f)) > 0;

  IF v_sorted_fingerprints IS NULL THEN
    v_sorted_fingerprints := '{}'::text[];
  END IF;

  -- Ensure place:<place_id> is present if place_id was provided
  IF v_place_id IS NOT NULL THEN
    IF NOT ('place:' || lower(v_place_id) = ANY(v_sorted_fingerprints)) THEN
      SELECT array_agg(DISTINCT f ORDER BY f)
      INTO v_sorted_fingerprints
      FROM unnest(v_sorted_fingerprints || ARRAY['place:' || lower(v_place_id)]) f;
    END IF;
  END IF;

  -- Reject unidentifiable business candidates:
  -- Must have at least one valid identity fingerprint or a valid place_id.
  IF v_place_id IS NULL AND coalesce(cardinality(v_sorted_fingerprints), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_identity: business candidate must have a valid place_id or at least one valid fingerprint'
      USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  -- 1. Deterministic transaction-level advisory locking (Sorted Order)
  -- Namespace: 424242 (mast_business_identity)
  -- Prevents concurrent workers from creating duplicate rows for the same identity.
  -- Hash collisions only cause brief serialization without data corruption.
  IF array_length(v_sorted_fingerprints, 1) > 0 THEN
    FOREACH v_fp IN ARRAY v_sorted_fingerprints LOOP
      PERFORM pg_advisory_xact_lock(424242, hashtext(v_fp));
    END LOOP;
  END IF;

  -- 2. Conflicting Place ID Protection:
  -- A stored fingerprint such as 'place:P1' must NEVER override an existing non-null place_id = P2.
  -- If incoming place_id is P1 and an existing record has place_id P2 (where P2 <> P1),
  -- but its fingerprints array contradictory contains 'place:p1', this contradictory stale state
  -- makes identity uncertain: return ambiguous and NEVER update the conflicting record.
  IF v_place_id IS NOT NULL THEN
    SELECT array_agg(b.id)
    INTO v_matching_ids
    FROM public.businesses b
    WHERE b.place_id IS NOT NULL
      AND b.place_id <> v_place_id
      AND 'place:' || lower(v_place_id) = ANY(b.fingerprints);

    IF v_matching_ids IS NOT NULL AND cardinality(v_matching_ids) > 0 THEN
      RETURN QUERY SELECT NULL::uuid, 'ambiguous'::text, v_matching_ids;
      RETURN;
    END IF;
  END IF;

  -- 3. Lookup existing business matches
  -- If v_place_id is provided:
  --   A row is a valid candidate if it matches on exact place_id (b.place_id = v_place_id)
  --   OR if it is an unanchored record (b.place_id IS NULL) matching on fingerprints.
  --   Rows with a conflicting non-null place_id (b.place_id <> v_place_id) are strictly excluded!
  IF v_place_id IS NOT NULL THEN
    SELECT array_agg(b.id)
    INTO v_matching_ids
    FROM public.businesses b
    WHERE (
      b.place_id = v_place_id
      OR (
        b.place_id IS NULL
        AND (
          'place:' || lower(v_place_id) = ANY(b.fingerprints)
          OR b.fingerprints && v_sorted_fingerprints
        )
      )
    );
  ELSE
    SELECT array_agg(b.id)
    INTO v_matching_ids
    FROM public.businesses b
    WHERE b.fingerprints && v_sorted_fingerprints;
  END IF;

  v_match_count := coalesce(cardinality(v_matching_ids), 0);

  -- 4. Outcome A: Multiple matching records -> AMBIGUOUS
  IF v_match_count > 1 THEN
    RETURN QUERY SELECT NULL::uuid, 'ambiguous'::text, v_matching_ids;
    RETURN;
  END IF;

  -- 5. Outcome B: Exactly one matching record -> ROW LOCK & IDENTITY AUDIT
  IF v_match_count = 1 THEN
    v_existing_id := v_matching_ids[1];

    -- Explicitly lock the existing business row with FOR UPDATE before reading mutable fields.
    -- This synchronizes concurrent transactions that matched on disjoint fingerprints (e.g. Tx A via
    -- fingerprint X, Tx B via fingerprint Y) and eliminates lost-update races.
    SELECT b.fingerprints, b.emails, b.phones, b.place_id
    INTO v_current_fps, v_current_emails, v_current_phones, v_current_place_id
    FROM public.businesses b
    WHERE b.id = v_existing_id
    FOR UPDATE;

    -- Strict Branch Identity Enforcement:
    -- Rule 1: Conflicting place_id guard (a stored fingerprint must never override place_id)
    IF v_place_id IS NOT NULL AND v_current_place_id IS NOT NULL AND v_current_place_id <> v_place_id THEN
      RETURN QUERY SELECT NULL::uuid, 'ambiguous'::text, ARRAY[v_existing_id];
      RETURN;
    END IF;

    -- Rule 2: Both records lacking Place IDs (v_place_id IS NULL AND v_current_place_id IS NULL)
    -- Shared domain, phone, corporate email, Instagram, Facebook, or name/city are potentially
    -- shared corporate/multi-branch identifiers and do NOT establish sufficient branch identity by themselves.
    -- Ambiguous: preserve existing record untouched.
    IF v_place_id IS NULL AND v_current_place_id IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, 'ambiguous'::text, ARRAY[v_existing_id];
      RETURN;
    END IF;

    -- Rule 3: One record has Place ID and the other has no Place ID
    -- Ambiguous unless an exact trustworthy place identity ('place:' || lower(v_place_id))
    -- is already recorded in the existing row's fingerprints.
    IF (v_place_id IS NOT NULL AND v_current_place_id IS NULL)
       OR (v_place_id IS NULL AND v_current_place_id IS NOT NULL) THEN
      IF v_place_id IS NOT NULL AND ('place:' || lower(v_place_id) = ANY(coalesce(v_current_fps, '{}'::text[]))) THEN
        -- Exact trustworthy place identity was recorded in fingerprints (place_id column was null)
        NULL;
      ELSE
        -- Identity cannot be established with certainty: preserve existing record untouched and return ambiguous.
        RETURN QUERY SELECT NULL::uuid, 'ambiguous'::text, ARRAY[v_existing_id];
        RETURN;
      END IF;
    END IF;

    -- Merge fingerprints: union of fresh locked fingerprints and incoming fingerprints
    SELECT array_agg(DISTINCT f ORDER BY f)
    INTO v_merged_fingerprints
    FROM (
      SELECT unnest(coalesce(v_current_fps, '{}'::text[])) AS f
      UNION
      SELECT unnest(v_sorted_fingerprints) AS f
    ) s;

    -- Merge emails array (jsonb array union)
    SELECT coalesce(jsonb_agg(DISTINCT e.val), '[]'::jsonb)
    INTO v_merged_emails
    FROM (
      SELECT jsonb_array_elements_text(coalesce(v_current_emails, '[]'::jsonb)) AS val
      UNION
      SELECT jsonb_array_elements_text(coalesce(p_emails, '[]'::jsonb)) AS val
    ) e
    WHERE e.val IS NOT NULL AND length(trim(e.val)) > 0;

    -- Merge phones array (jsonb array union)
    SELECT coalesce(jsonb_agg(DISTINCT p.val), '[]'::jsonb)
    INTO v_merged_phones
    FROM (
      SELECT jsonb_array_elements_text(coalesce(v_current_phones, '[]'::jsonb)) AS val
      UNION
      SELECT jsonb_array_elements_text(coalesce(p_phones, '[]'::jsonb)) AS val
    ) p
    WHERE p.val IS NOT NULL AND length(trim(p.val)) > 0;

    UPDATE public.businesses b
    SET
      last_verified_at = now(),
      verification_due_at = now() + interval '30 days',
      last_verification_kind = 'rediscovery',
      confidence = least(coalesce(b.confidence, 65) + 5, 100),
      niche = coalesce(b.niche, p_niche),
      country_code = coalesce(b.country_code, p_country_code),
      website = coalesce(b.website, p_website),
      email = coalesce(b.email, p_email),
      phone = coalesce(b.phone, p_phone),
      instagram = coalesce(b.instagram, p_instagram),
      facebook = coalesce(b.facebook, p_facebook),
      linkedin = coalesce(p_linkedin, b.linkedin),
      emails = v_merged_emails,
      phones = v_merged_phones,
      website_is_weak = coalesce(p_website_is_weak, b.website_is_weak),
      ssl_valid = coalesce(p_ssl_valid, b.ssl_valid),
      load_time_ms = coalesce(p_load_time_ms, b.load_time_ms),
      place_id = coalesce(b.place_id, v_place_id),
      fingerprints = v_merged_fingerprints,
      updated_at = now()
    WHERE b.id = v_existing_id;

    RETURN QUERY SELECT v_existing_id, 'updated'::text, NULL::uuid[];
    RETURN;
  END IF;

  -- 5. Outcome C: Zero matching records -> INSERT
  INSERT INTO public.businesses (
    name,
    category,
    niche,
    query_used,
    region,
    country_code,
    address,
    website,
    email,
    phone,
    instagram,
    facebook,
    linkedin,
    emails,
    phones,
    field_provenance,
    website_is_weak,
    ssl_valid,
    load_time_ms,
    seo,
    blog,
    reviews_count,
    reviews_rating,
    has_photos,
    is_disqualified,
    last_verification_kind,
    signals,
    raw_data,
    fingerprints,
    place_id
  ) VALUES (
    coalesce(p_name, 'Unnamed Business'),
    p_category,
    p_niche,
    p_query_used,
    p_region,
    p_country_code,
    p_address,
    p_website,
    p_email,
    p_phone,
    p_instagram,
    p_facebook,
    p_linkedin,
    coalesce(p_emails, '[]'::jsonb),
    coalesce(p_phones, '[]'::jsonb),
    coalesce(p_field_provenance, '{}'::jsonb),
    p_website_is_weak,
    p_ssl_valid,
    p_load_time_ms,
    coalesce(p_seo, '{}'::jsonb),
    coalesce(p_blog, '{}'::jsonb),
    coalesce(p_reviews_count, 0),
    p_reviews_rating,
    coalesce(p_has_photos, false),
    coalesce(p_is_disqualified, false),
    'full',
    coalesce(p_signals, '{}'::jsonb),
    coalesce(p_raw_data, '{}'::jsonb),
    v_sorted_fingerprints,
    v_place_id
  )
  RETURNING id INTO v_existing_id;

  RETURN QUERY SELECT v_existing_id, 'inserted'::text, NULL::uuid[];
  RETURN;
END;
$$;

ALTER FUNCTION public.upsert_business_from_fingerprints(
  text, text, text, text, text, text, text, text, text, text,
  text, text, text, jsonb, jsonb, jsonb, boolean, boolean, integer, jsonb,
  jsonb, integer, numeric, boolean, boolean, jsonb, jsonb, text[], text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.upsert_business_from_fingerprints(
  text, text, text, text, text, text, text, text, text, text,
  text, text, text, jsonb, jsonb, jsonb, boolean, boolean, integer, jsonb,
  jsonb, integer, numeric, boolean, boolean, jsonb, jsonb, text[], text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_business_from_fingerprints(
  text, text, text, text, text, text, text, text, text, text,
  text, text, text, jsonb, jsonb, jsonb, boolean, boolean, integer, jsonb,
  jsonb, integer, numeric, boolean, boolean, jsonb, jsonb, text[], text
) TO service_role, postgres;

COMMENT ON FUNCTION public.upsert_business_from_fingerprints IS
  'Atomic, race-safe business identity resolution using sorted advisory locks. '
  'Guarantees concurrent workers resolve to a single business ID, merges contact data '
  'and fingerprints on update, and returns ambiguous status when multiple distinct records match.';


-- ─── 2. Idempotent Lead Delivery & Credit Accounting ─────────────────────────

CREATE OR REPLACE FUNCTION public.deliver_lead_for_user(
  p_user_id uuid,
  p_business_id uuid,
  p_lead_row jsonb,
  p_daily_limit integer default null,
  p_monthly_limit integer default null,
  p_discovery_plan_id uuid default null
)
RETURNS TABLE (
  status text,              -- 'delivered' | 'duplicate' | 'plan_limit_reached' | 'credit_limit_reached'
  lead_id uuid,
  was_new_for_user boolean,
  credit_charged boolean,
  limit_reached boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing_lead_id uuid;
  v_inserted_lead_id uuid;
  v_plan_claimed boolean := false;
  v_credit_allowed boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'p_business_id is required';
  END IF;

  -- 1. Advisory transaction lock on (user_id, business_id) to serialize concurrent deliveries
  -- Namespace: 424243 (mast_lead_delivery)
  PERFORM pg_advisory_xact_lock(424243, hashtext(p_user_id::text || ':' || p_business_id::text));

  -- 2. Fast check: is this business already owned by this user?
  SELECT id INTO v_existing_lead_id
  FROM public.leads
  WHERE user_id = p_user_id AND business_id = p_business_id
  LIMIT 1;

  IF v_existing_lead_id IS NOT NULL THEN
    RETURN QUERY SELECT 'duplicate'::text, v_existing_lead_id, false, false, false;
    RETURN;
  END IF;

  -- 3. Plan reservation (if discovery plan is specified)
  IF p_discovery_plan_id IS NOT NULL THEN
    v_plan_claimed := public.claim_discovery_delivery(p_discovery_plan_id);
    IF NOT v_plan_claimed THEN
      RETURN QUERY SELECT 'plan_limit_reached'::text, NULL::uuid, false, false, true;
      RETURN;
    END IF;
  END IF;

  -- 4. Credit reservation via authoritative try_increment_lead_usage
  SELECT u.allowed
    INTO v_credit_allowed
  FROM public.try_increment_lead_usage(p_user_id, p_daily_limit, p_monthly_limit, 1) u;

  IF NOT coalesce(v_credit_allowed, false) THEN
    -- If plan reservation was claimed, rollback the reservation
    IF v_plan_claimed THEN
      PERFORM public.release_discovery_delivery(p_discovery_plan_id);
    END IF;
    RETURN QUERY SELECT 'credit_limit_reached'::text, NULL::uuid, false, false, true;
    RETURN;
  END IF;

  -- 5. Insert lead row with ON CONFLICT (user_id, business_id) DO NOTHING guard
  INSERT INTO public.leads (
    user_id,
    business_id,
    profession_slug,
    opportunity_score,
    discovery_mode,
    scrape_job_id,
    credit_charged,
    business_name,
    instagram_handle,
    linkedin_handle,
    email,
    website,
    phone,
    niche,
    location,
    status,
    ig_followers,
    ig_bio,
    ig_last_post,
    source
  ) VALUES (
    p_user_id,
    p_business_id,
    p_lead_row->>'profession_slug',
    nullif(p_lead_row->>'opportunity_score', '')::numeric,
    coalesce(p_lead_row->>'discovery_mode', 'live'),
    nullif(p_lead_row->>'scrape_job_id', '')::uuid,
    true,
    coalesce(p_lead_row->>'business_name', 'Unnamed Business'),
    p_lead_row->>'instagram_handle',
    p_lead_row->>'linkedin_handle',
    p_lead_row->>'email',
    p_lead_row->>'website',
    p_lead_row->>'phone',
    p_lead_row->>'niche',
    p_lead_row->>'location',
    coalesce(p_lead_row->>'status', 'new'),
    p_lead_row->>'ig_followers',
    p_lead_row->>'ig_bio',
    p_lead_row->>'ig_last_post',
    coalesce(p_lead_row->>'source', 'discover_live')
  )
  ON CONFLICT (user_id, business_id) WHERE business_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_inserted_lead_id;

  -- 6. Check for conflict race
  IF v_inserted_lead_id IS NULL THEN
    -- Rollback credit
    PERFORM public.try_increment_lead_usage(p_user_id, p_daily_limit, p_monthly_limit, -1);
    -- Rollback plan slot
    IF v_plan_claimed THEN
      PERFORM public.release_discovery_delivery(p_discovery_plan_id);
    END IF;
    -- Find existing ID
    SELECT id INTO v_existing_lead_id
    FROM public.leads
    WHERE user_id = p_user_id AND business_id = p_business_id
    LIMIT 1;

    RETURN QUERY SELECT 'duplicate'::text, v_existing_lead_id, false, false, false;
    RETURN;
  END IF;

  -- 7. Success
  RETURN QUERY SELECT 'delivered'::text, v_inserted_lead_id, true, true, false;
  RETURN;
END;
$$;

ALTER FUNCTION public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.deliver_lead_for_user(uuid, uuid, jsonb, integer, integer, uuid) TO service_role, postgres;

COMMENT ON FUNCTION public.deliver_lead_for_user IS
  'Atomic, transaction-safe lead delivery and credit accounting. '
  'Coordinates ownership check, plan delivery count increment, credit charging, and '
  'lead insertion into a single atomic transaction. Guarantees exactly one credit charged '
  'and exactly one lead created under concurrent delivery attempts.';
