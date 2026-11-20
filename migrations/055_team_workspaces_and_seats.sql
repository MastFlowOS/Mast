-- =============================================================================
-- Migration 055: Agency Workspaces & Team Seats
-- =============================================================================
-- Adds multi-user workspace membership (`workspace_members`) and email invites
-- (`workspace_invites`) so Pro (3 seats) and Premium (7 seats) plans can
-- share a single agency CRM, pipeline, follow-ups, and credit pool.
--
-- Also introduces `assigned_to` on `public.leads` and RLS helper functions so
-- active team members seamlessly access their workspace owner's shared CRM
-- data without duplicating leads or migrating historical user_id rows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_owner_status
  ON public.workspace_members (owner_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_active_member
  ON public.workspace_members (member_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.workspace_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invited_email text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token         text NOT NULL UNIQUE,
  invited_by    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invites_owner_status
  ON public.workspace_invites (owner_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_pending_email
  ON public.workspace_invites (owner_id, lower(invited_email))
  WHERE status = 'pending';

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_assigned_to
  ON public.leads (user_id, assigned_to)
  WHERE assigned_to IS NOT NULL;

-- ─── RLS Helper Functions ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mast_workspace_owner_id(p_uid uuid DEFAULT auth.uid())
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT wm.owner_id
      FROM public.workspace_members wm
      WHERE wm.member_id = p_uid
        AND wm.status = 'active'
      ORDER BY wm.created_at ASC
      LIMIT 1
    ),
    p_uid
  );
$$;

ALTER FUNCTION public.mast_workspace_owner_id(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mast_workspace_owner_id(uuid) FROM public;
REVOKE ALL ON FUNCTION public.mast_workspace_owner_id(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mast_workspace_owner_id(uuid) TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.mast_can_access_user_data(p_row_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_row_user_id = auth.uid()
    OR p_row_user_id = public.mast_workspace_owner_id(auth.uid());
$$;

ALTER FUNCTION public.mast_can_access_user_data(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mast_can_access_user_data(uuid) FROM public;
REVOKE ALL ON FUNCTION public.mast_can_access_user_data(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mast_can_access_user_data(uuid) TO authenticated, service_role, postgres;

-- ─── RLS for workspace_members & workspace_invites ───────────────────────────

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_members_participant_select ON public.workspace_members;
CREATE POLICY workspace_members_participant_select
  ON public.workspace_members FOR SELECT
  TO authenticated
  USING (
    owner_id = auth.uid()
    OR member_id = auth.uid()
    OR owner_id = public.mast_workspace_owner_id(auth.uid())
  );

REVOKE ALL ON public.workspace_members FROM anon;
GRANT SELECT ON public.workspace_members TO authenticated;
GRANT ALL ON public.workspace_members TO service_role;

ALTER TABLE public.workspace_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_invites_owner_select ON public.workspace_invites;
CREATE POLICY workspace_invites_owner_select
  ON public.workspace_invites FOR SELECT
  TO authenticated
  USING (
    owner_id = auth.uid()
    OR owner_id = public.mast_workspace_owner_id(auth.uid())
  );

REVOKE ALL ON public.workspace_invites FROM anon;
GRANT SELECT ON public.workspace_invites TO authenticated;
GRANT ALL ON public.workspace_invites TO service_role;

-- ─── Workspace-Shared RLS Policies on CRM & Discovery Tables ─────────────────
-- Additive permissive policies so existing single-user policies remain intact
-- while active team members seamlessly read and write their owner's workspace.

DROP POLICY IF EXISTS leads_workspace_team_access ON public.leads;
CREATE POLICY leads_workspace_team_access
  ON public.leads FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(user_id))
  WITH CHECK (public.mast_can_access_user_data(user_id));

DROP POLICY IF EXISTS lead_activities_workspace_team_access ON public.lead_activities;
CREATE POLICY lead_activities_workspace_team_access
  ON public.lead_activities FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(user_id))
  WITH CHECK (public.mast_can_access_user_data(user_id));

DROP POLICY IF EXISTS lead_messages_workspace_team_access ON public.lead_messages;
CREATE POLICY lead_messages_workspace_team_access
  ON public.lead_messages FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(user_id))
  WITH CHECK (public.mast_can_access_user_data(user_id));

DROP POLICY IF EXISTS lead_followups_workspace_team_access ON public.lead_followups;
CREATE POLICY lead_followups_workspace_team_access
  ON public.lead_followups FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(user_id))
  WITH CHECK (public.mast_can_access_user_data(user_id));

DROP POLICY IF EXISTS scrape_jobs_workspace_team_select ON public.scrape_jobs;
CREATE POLICY scrape_jobs_workspace_team_select
  ON public.scrape_jobs FOR SELECT
  TO authenticated
  USING (public.mast_can_access_user_data(user_id));

DROP POLICY IF EXISTS discovery_plans_workspace_team_select ON public.discovery_plans;
CREATE POLICY discovery_plans_workspace_team_select
  ON public.discovery_plans FOR SELECT
  TO authenticated
  USING (public.mast_can_access_user_data(user_id));

DROP POLICY IF EXISTS discovery_live_events_workspace_team_select ON public.discovery_live_events;
CREATE POLICY discovery_live_events_workspace_team_select
  ON public.discovery_live_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.discovery_plans p
      WHERE p.id = discovery_live_events.plan_id
        AND public.mast_can_access_user_data(p.user_id)
    )
  );

-- Update business intelligence pool RLS (Migration 043) so team members can
-- read businesses/scores/health/insights linked to their workspace's leads.
DROP POLICY IF EXISTS "businesses_owner_select" ON public.businesses;
CREATE POLICY "businesses_owner_select"
  ON public.businesses FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.business_id = businesses.id
        AND public.mast_can_access_user_data(l.user_id)
    )
  );

DROP POLICY IF EXISTS "scores_owner_select" ON public.business_opportunity_scores;
CREATE POLICY "scores_owner_select"
  ON public.business_opportunity_scores FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.business_id = business_opportunity_scores.business_id
        AND public.mast_can_access_user_data(l.user_id)
    )
  );

DROP POLICY IF EXISTS "health_scores_owner_select" ON public.business_health_scores;
CREATE POLICY "health_scores_owner_select"
  ON public.business_health_scores FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.business_id = business_health_scores.business_id
        AND public.mast_can_access_user_data(l.user_id)
    )
  );

DROP POLICY IF EXISTS "insights_owner_select" ON public.business_opportunity_insights;
CREATE POLICY "insights_owner_select"
  ON public.business_opportunity_insights FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.business_id = business_opportunity_insights.business_id
        AND public.mast_can_access_user_data(l.user_id)
    )
  );

-- ─── Workspace-Aware CRM Lead & Credit RPCs ──────────────────────────────────
-- Routes manual CRM lead creation and credit consumption to the workspace owner
-- when called by an active team member so shared seats share one credit pool
-- and one CRM lead table.

CREATE OR REPLACE FUNCTION public.create_crm_lead(p_lead jsonb)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_user_id uuid;
  v_allowed boolean;
  v_plan text;
  v_inserted public.leads;
  v_status text;
  v_priority text;
  v_name text;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_user_id := public.mast_workspace_owner_id(v_actor_id);

  SELECT allowed, subscription_plan INTO v_allowed, v_plan
  FROM public.try_increment_lead_usage(v_user_id, NULL, NULL, 1);

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'Lead generation quota exceeded' USING ERRCODE = '54000';
  END IF;

  v_status := lower(coalesce(p_lead->>'status', 'new'));
  IF v_status NOT IN ('new', 'email_sent', 'called', 'instagram_sent', 'replied', 'meeting_booked', 'closed', 'dead') THEN
    v_status := 'new';
  END IF;

  v_priority := lower(coalesce(p_lead->>'priority', 'medium'));
  IF v_priority NOT IN ('low', 'medium', 'high') THEN
    v_priority := 'medium';
  END IF;

  v_name := trim(coalesce(p_lead->>'business_name', p_lead->>'businessName', 'New Lead'));
  IF length(v_name) = 0 THEN
    v_name := 'New Lead';
  END IF;
  IF length(v_name) > 255 THEN
    v_name := substr(v_name, 1, 255);
  END IF;

  INSERT INTO public.leads (
    user_id,
    business_name,
    email,
    phone,
    website,
    instagram_handle,
    linkedin_handle,
    niche,
    location,
    status,
    priority,
    credit_charged,
    discovery_mode,
    opportunity_score,
    scrape_job_id
  ) VALUES (
    v_user_id,
    v_name,
    nullif(trim(p_lead->>'email'), ''),
    nullif(trim(p_lead->>'phone'), ''),
    nullif(trim(p_lead->>'website'), ''),
    nullif(trim(coalesce(p_lead->>'instagram_handle', p_lead->>'instagramHandle')), ''),
    nullif(trim(coalesce(p_lead->>'linkedin_handle', p_lead->>'linkedinHandle')), ''),
    nullif(trim(p_lead->>'niche'), ''),
    nullif(trim(p_lead->>'location'), ''),
    v_status,
    v_priority,
    true,
    'manual',
    NULL,
    NULL
  )
  RETURNING * INTO v_inserted;

  RETURN v_inserted;
END;
$$;

ALTER FUNCTION public.create_crm_lead(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_crm_lead(jsonb) FROM public;
REVOKE ALL ON FUNCTION public.create_crm_lead(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_crm_lead(jsonb) TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.consume_crm_lead_credit(p_count integer DEFAULT 1)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_user_id uuid;
  v_allowed boolean;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_count IS NULL OR p_count <= 0 THEN
    RAISE EXCEPTION 'Requested credit count must be a positive integer' USING ERRCODE = '22023';
  END IF;

  IF p_count > 1000 THEN
    RAISE EXCEPTION 'Requested credit count exceeds maximum batch limit (1000)' USING ERRCODE = '22023';
  END IF;

  v_user_id := public.mast_workspace_owner_id(v_actor_id);

  SELECT allowed INTO v_allowed
  FROM public.try_increment_lead_usage(v_user_id, NULL, NULL, p_count);

  RETURN coalesce(v_allowed, false);
END;
$$;

ALTER FUNCTION public.consume_crm_lead_credit(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.consume_crm_lead_credit(integer) FROM public;
REVOKE ALL ON FUNCTION public.consume_crm_lead_credit(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.consume_crm_lead_credit(integer) TO authenticated, service_role, postgres;
