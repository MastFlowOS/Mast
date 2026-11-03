-- Migration 048: Atomic Post-Enrichment Contact & Fingerprint Synchronization (Phase 7.2)
--
-- Scope:
-- Atomically synchronizes newly discovered and validated contact information (email, phone,
-- instagram, facebook, linkedin) and their corresponding canonical fingerprints into an
-- existing business record by its known business_id.
--
-- Concurrency & Safety Guarantees:
-- 1. Targeted Row Locking: Explicitly locks public.businesses WHERE id = p_business_id FOR UPDATE.
--    Serializes concurrent enrichment passes and prevents lost-update overwrites.
-- 2. Atomic Set Unions: Contact arrays (emails, phones) and fingerprints are merged via
--    SQL UNION against the fresh committed state inside the row lock.
-- 3. Identity Immutability: Operates strictly on the supplied p_business_id.
--    Never performs global identity lookups, never modifies place_id or id, and never merges
--    different business records.
-- 4. Fail-Closed Existence Check: Fails with code P0002 if p_business_id does not exist.
-- 5. Security: SECURITY DEFINER with search_path = pg_catalog, EXECUTE restricted to service_role and postgres.

CREATE OR REPLACE FUNCTION public.sync_business_enrichment_fingerprints(
  p_business_id uuid,
  p_email text default null,
  p_emails jsonb default '[]'::jsonb,
  p_phone text default null,
  p_phones jsonb default '[]'::jsonb,
  p_instagram text default null,
  p_facebook text default null,
  p_linkedin text default null,
  p_fingerprints text[] default '{}'::text[],
  p_field_provenance jsonb default null,
  p_signals jsonb default null,
  p_website_is_weak boolean default null,
  p_ssl_valid boolean default null,
  p_load_time_ms integer default null,
  p_seo jsonb default null,
  p_blog jsonb default null
)
RETURNS TABLE (
  business_id uuid,
  email text,
  emails jsonb,
  phone text,
  phones jsonb,
  instagram text,
  facebook text,
  linkedin text,
  fingerprints text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current_email text;
  v_current_phone text;
  v_current_instagram text;
  v_current_facebook text;
  v_current_linkedin text;
  v_current_emails jsonb;
  v_current_phones jsonb;
  v_current_fingerprints text[];
  v_current_signals jsonb;
  v_current_provenance jsonb;

  v_next_email text;
  v_next_phone text;
  v_next_instagram text;
  v_next_facebook text;
  v_next_linkedin text;
  v_merged_emails jsonb;
  v_merged_phones jsonb;
  v_merged_fingerprints text[];

  -- Intermediate validated incoming contact values
  v_valid_incoming_email text := null;
  v_valid_incoming_phone text := null;
  v_valid_incoming_instagram text := null;
  v_valid_incoming_facebook text := null;
  v_valid_incoming_linkedin text := null;
  v_raw_val text;
  v_clean_handle text;
BEGIN
  -- 1. Validate supplied business ID
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'p_business_id is required' USING ERRCODE = '22023'; -- invalid_parameter_value
  END IF;

  -- 2. Acquire explicit row-level lock (FOR UPDATE) and fail if business does not exist
  SELECT
    b.email, b.phone, b.instagram, b.facebook, b.linkedin,
    b.emails, b.phones, b.fingerprints, b.signals, b.field_provenance
  INTO
    v_current_email, v_current_phone, v_current_instagram, v_current_facebook, v_current_linkedin,
    v_current_emails, v_current_phones, v_current_fingerprints, v_current_signals, v_current_provenance
  FROM public.businesses b
  WHERE b.id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'business_not_found: business with id % does not exist', p_business_id
      USING ERRCODE = 'P0002'; -- no_data_found
  END IF;

  -- 3. In-SQL validation of incoming primary contact fields (prevents invalid/empty overwrites)
  -- 3a. Email validation
  IF p_email IS NOT NULL AND trim(p_email) <> '' THEN
    v_raw_val := lower(trim(p_email));
    IF v_raw_val ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
       AND (length(v_raw_val) - length(replace(v_raw_val, '@', ''))) = 1
       AND v_raw_val !~ '\.(png|jpg|jpeg|svg|webp|gif|ico|bmp|tif|tiff|css|js|json|xml|pdf|zip)$'
       AND v_raw_val !~ '^(noreply|no-reply|donotreply|do-not-reply|wordpress|mailer-daemon)@'
    THEN
      v_valid_incoming_email := v_raw_val;
    END IF;
  END IF;

  -- 3b. Phone validation
  IF p_phone IS NOT NULL AND trim(p_phone) <> '' THEN
    v_raw_val := regexp_replace(p_phone, '\D', '', 'g');
    IF length(v_raw_val) BETWEEN 7 AND 15
       AND v_raw_val !~ '^([0-9])\1+$'
       AND v_raw_val NOT IN ('1234567890', '0123456789', '1000000000', '9999999999')
    THEN
      v_valid_incoming_phone := trim(p_phone);
    END IF;
  END IF;

  -- 3c. Instagram validation
  IF p_instagram IS NOT NULL AND trim(p_instagram) <> '' THEN
    v_raw_val := trim(p_instagram);
    v_raw_val := split_part(split_part(v_raw_val, '?', 1), '#', 1);
    IF v_raw_val ~* 'instagram\.com/' THEN
      v_clean_handle := substring(lower(v_raw_val) from 'instagram\.com/([^/?#]+)');
    ELSE
      v_clean_handle := lower(v_raw_val);
    END IF;
    v_clean_handle := trim(leading '@/' from trim(trailing '/' from v_clean_handle));
    IF length(v_clean_handle) BETWEEN 1 AND 30
       AND v_clean_handle ~ '^[a-z0-9_][a-z0-9_.]{0,29}$'
       AND v_clean_handle !~ '^[0-9]+$'
       AND v_clean_handle !~ '\.\.'
       AND v_clean_handle !~ '\.$'
       AND v_clean_handle !~ '^(p|reel|reels|tv|explore|stories|accounts|about|directory|legal|privacy|press|help|api|oauth|challenge|sharer|embed|static|web|developer|developers|nametag|oembed|emails|session|ajax|graphql|login|signup|direct|instagram|_u)$'
    THEN
      IF v_raw_val ~* '^https?://' THEN
        v_valid_incoming_instagram := v_raw_val;
      ELSE
        v_valid_incoming_instagram := 'https://www.instagram.com/' || v_clean_handle || '/';
      END IF;
    END IF;
  END IF;

  -- 3d. Facebook validation
  IF p_facebook IS NOT NULL AND trim(p_facebook) <> '' THEN
    v_raw_val := trim(p_facebook);
    v_raw_val := split_part(split_part(v_raw_val, '?', 1), '#', 1);
    IF v_raw_val ~* 'facebook\.com/' THEN
      v_clean_handle := substring(lower(v_raw_val) from 'facebook\.com/([^/?#]+)');
    ELSE
      v_clean_handle := lower(v_raw_val);
    END IF;
    v_clean_handle := trim(trailing '/' from v_clean_handle);
    IF length(v_clean_handle) BETWEEN 1 AND 50
       AND v_clean_handle ~ '^[a-z0-9_.-]{1,50}$'
       AND v_clean_handle !~ '^(profile\.php|pages|groups|events|watch|share|sharer|dialog|plugins|help|policies|login)$'
    THEN
      v_valid_incoming_facebook := trim(p_facebook);
    END IF;
  END IF;

  -- 3e. LinkedIn
  IF p_linkedin IS NOT NULL AND trim(p_linkedin) <> '' THEN
    v_valid_incoming_linkedin := trim(p_linkedin);
  END IF;

  -- 4. Merge additional emails array (preserves existing, unions validated incoming, rejects malformed)
  SELECT coalesce(jsonb_agg(DISTINCT e.val ORDER BY e.val), '[]'::jsonb)
  INTO v_merged_emails
  FROM (
    SELECT lower(trim(jsonb_array_elements_text(coalesce(v_current_emails, '[]'::jsonb)))) AS val
    UNION
    SELECT lower(trim(jsonb_array_elements_text(coalesce(p_emails, '[]'::jsonb)))) AS val
    UNION
    SELECT v_valid_incoming_email AS val
  ) e
  WHERE e.val IS NOT NULL
    AND e.val ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    AND (length(e.val) - length(replace(e.val, '@', ''))) = 1
    AND e.val !~ '\.(png|jpg|jpeg|svg|webp|gif|ico|bmp|tif|tiff|css|js|json|xml|pdf|zip)$'
    AND e.val !~ '^(noreply|no-reply|donotreply|do-not-reply|wordpress|mailer-daemon)@';

  -- 5. Merge additional phones array: deduplicate by canonical digits (last 10 digits for NANP/intl, or full 7-9 digits)
  -- Preserves all existing phones, unions validated incoming phones, prefers formatted representation over raw digits.
  SELECT coalesce(jsonb_agg(deduped.val ORDER BY deduped.val), '[]'::jsonb)
  INTO v_merged_phones
  FROM (
    SELECT DISTINCT ON (
      CASE
        WHEN length(regexp_replace(p.val, '\D', '', 'g')) >= 10
        THEN right(regexp_replace(p.val, '\D', '', 'g'), 10)
        ELSE regexp_replace(p.val, '\D', '', 'g')
      END
    )
    trim(p.val) AS val
    FROM (
      SELECT jsonb_array_elements_text(coalesce(v_current_phones, '[]'::jsonb)) AS val
      UNION
      SELECT jsonb_array_elements_text(coalesce(p_phones, '[]'::jsonb)) AS val
      UNION
      SELECT v_valid_incoming_phone AS val
    ) p
    WHERE p.val IS NOT NULL
      AND length(regexp_replace(p.val, '\D', '', 'g')) BETWEEN 7 AND 15
      AND regexp_replace(p.val, '\D', '', 'g') !~ '^([0-9])\1+$'
      AND regexp_replace(p.val, '\D', '', 'g') NOT IN ('1234567890', '0123456789', '1000000000', '9999999999')
    ORDER BY
      CASE
        WHEN length(regexp_replace(p.val, '\D', '', 'g')) >= 10
        THEN right(regexp_replace(p.val, '\D', '', 'g'), 10)
        ELSE regexp_replace(p.val, '\D', '', 'g')
      END,
      -- Prefer formatted number (with spaces, parens, hyphens, plus) over plain raw digits
      CASE WHEN p.val ~ '[\s().\-+]' THEN 0 ELSE 1 END,
      p.val
  ) deduped;

  -- 6. Primary contact fields: fill/update semantics with established precedence
  -- Newly extracted valid enrichment contact becomes primary; invalid/empty preserves existing.
  v_next_email := coalesce(
    v_valid_incoming_email,
    v_current_email,
    v_merged_emails->>0
  );

  v_next_phone := coalesce(
    v_valid_incoming_phone,
    v_current_phone,
    v_merged_phones->>0
  );

  -- Instagram follows established fill-only semantics: valid existing handle is preserved
  IF v_current_instagram IS NOT NULL AND trim(v_current_instagram) <> '' THEN
    v_raw_val := split_part(split_part(trim(v_current_instagram), '?', 1), '#', 1);
    IF v_raw_val ~* 'instagram\.com/' THEN
      v_clean_handle := substring(lower(v_raw_val) from 'instagram\.com/([^/?#]+)');
    ELSE
      v_clean_handle := lower(v_raw_val);
    END IF;
    v_clean_handle := trim(leading '@/' from trim(trailing '/' from v_clean_handle));
    IF length(v_clean_handle) BETWEEN 1 AND 30
       AND v_clean_handle ~ '^[a-z0-9_][a-z0-9_.]{0,29}$'
       AND v_clean_handle !~ '^[0-9]+$'
       AND v_clean_handle !~ '\.\.'
       AND v_clean_handle !~ '\.$'
       AND v_clean_handle !~ '^(p|reel|reels|tv|explore|stories|accounts|about|directory|legal|privacy|press|help|api|oauth|challenge|sharer|embed|static|web|developer|developers|nametag|oembed|emails|session|ajax|graphql|login|signup|direct|instagram|_u)$'
    THEN
      v_next_instagram := v_current_instagram;
    ELSE
      v_next_instagram := coalesce(v_valid_incoming_instagram, v_current_instagram);
    END IF;
  ELSE
    v_next_instagram := coalesce(v_valid_incoming_instagram, v_current_instagram);
  END IF;

  v_next_facebook := coalesce(
    v_valid_incoming_facebook,
    v_current_facebook
  );

  v_next_linkedin := coalesce(
    v_valid_incoming_linkedin,
    v_current_linkedin
  );

  -- 7. Fingerprint synchronization: atomic union of current committed fingerprints and validated incoming fingerprints
  -- Preserves all historical fingerprints intact. Validates incoming enrichment fingerprints against canonical
  -- formats from dedup.py:
  --   email: exactly 1 '@', valid local/domain format, no asset extensions.
  --   tel: 7 to 10 digits only, not all identical digits.
  --   ig: valid handle characters (1-30 chars), not all digits, no double dots or trailing dot, no routing tokens.
  --   fb: valid handle characters (1-50 chars), no routing tokens.
  -- Strictly rejects empty, whitespace, malformed, unsupported prefixes, and invented li:/linkedin: formats.
  SELECT coalesce(array_agg(DISTINCT trim(f) ORDER BY trim(f)), '{}'::text[])
  INTO v_merged_fingerprints
  FROM (
    -- 1. Historical fingerprints preserved without alteration
    SELECT trim(f) AS f
    FROM unnest(coalesce(v_current_fingerprints, '{}'::text[])) f
    WHERE f IS NOT NULL AND length(trim(f)) > 0
    UNION
    -- 2. Incoming enrichment fingerprints strictly validated
    SELECT lower(trim(f)) AS f
    FROM unnest(coalesce(p_fingerprints, '{}'::text[])) f
    WHERE f IS NOT NULL
      AND length(trim(f)) > 0
      AND (
        (
          lower(trim(f)) ~ '^email:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
          AND (length(trim(f)) - length(replace(trim(f), '@', ''))) = 1
          AND lower(trim(f)) !~ '\.(png|jpg|jpeg|svg|webp|gif|ico|bmp|tif|tiff|css|js|json|xml|pdf|zip)$'
        )
        OR (
          lower(trim(f)) ~ '^tel:[0-9]{7,10}$'
          AND lower(trim(f)) !~ '^tel:([0-9])\1{6,9}$'
        )
        OR (
          lower(trim(f)) ~ '^ig:[a-z0-9_][a-z0-9_.]{0,29}$'
          AND lower(trim(f)) !~ '^ig:[0-9]+$'
          AND lower(trim(f)) !~ '\.\.'
          AND lower(trim(f)) !~ '\.$'
          AND lower(trim(f)) !~ '^ig:(p|reel|reels|tv|explore|stories|accounts|about|directory|legal|privacy|press|help|api|oauth|challenge|sharer|embed|static|web|developer|developers|nametag|oembed|emails|session|ajax|graphql|login|signup|direct|instagram|_u)$'
        )
        OR (
          lower(trim(f)) ~ '^fb:[a-z0-9_.-]{1,50}$'
          AND lower(trim(f)) !~ '^fb:(profile\.php|pages|groups|events|watch|share|sharer|dialog|plugins|help|policies|login)$'
        )
      )
      AND NOT lower(trim(f)) LIKE 'li:%'
      AND NOT lower(trim(f)) LIKE 'linkedin:%'
  ) s
  WHERE s.f IS NOT NULL AND length(s.f) > 0;

  -- 7. Update business row atomically within the lock
  UPDATE public.businesses b
  SET
    email = v_next_email,
    emails = v_merged_emails,
    phone = v_next_phone,
    phones = v_merged_phones,
    instagram = v_next_instagram,
    facebook = v_next_facebook,
    linkedin = v_next_linkedin,
    fingerprints = v_merged_fingerprints,
    signals = coalesce(p_signals, b.signals),
    field_provenance = coalesce(p_field_provenance, b.field_provenance),
    website_is_weak = coalesce(p_website_is_weak, b.website_is_weak),
    ssl_valid = coalesce(p_ssl_valid, b.ssl_valid),
    load_time_ms = coalesce(p_load_time_ms, b.load_time_ms),
    seo = coalesce(p_seo, b.seo),
    blog = coalesce(p_blog, b.blog),
    last_verified_at = now(),
    updated_at = now()
  WHERE b.id = p_business_id;

  -- 8. Return synchronized result
  RETURN QUERY
  SELECT
    b.id,
    b.email,
    b.emails,
    b.phone,
    b.phones,
    b.instagram,
    b.facebook,
    b.linkedin,
    b.fingerprints
  FROM public.businesses b
  WHERE b.id = p_business_id;
END;
$$;

ALTER FUNCTION public.sync_business_enrichment_fingerprints(
  uuid, text, jsonb, text, jsonb, text, text, text, text[], jsonb, jsonb, boolean, boolean, integer, jsonb, jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.sync_business_enrichment_fingerprints(
  uuid, text, jsonb, text, jsonb, text, text, text, text[], jsonb, jsonb, boolean, boolean, integer, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.sync_business_enrichment_fingerprints(
  uuid, text, jsonb, text, jsonb, text, text, text, text[], jsonb, jsonb, boolean, boolean, integer, jsonb, jsonb
) TO service_role, postgres;

COMMENT ON FUNCTION public.sync_business_enrichment_fingerprints IS
  'Atomically synchronizes enriched contact data and canonical fingerprints for a known business ID. '
  'Uses row-level locking (FOR UPDATE) to serialize concurrent worker updates, unions contact arrays '
  'and fingerprints, and prevents lost-update overwrites.';
