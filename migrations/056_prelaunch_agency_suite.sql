-- =============================================================================
-- Migration 056: Pre-Launch Agency Suite
-- =============================================================================
-- Adds tables for:
--   1. public.outreach_playbooks       — Custom user AI voices / prompt skills
--   2. public.lead_website_audits      — Cached homepage screenshots, visual critiques & mini-audit bullets
--   3. public.workspace_booking_settings — Calendly / Cal.com booking link & webhook sync
--   4. public.workspace_suppressions   — Agency-wide Do-Not-Contact blocklist (email, domain, instagram)
-- =============================================================================

-- ─── 1. Custom AI Outreach Playbooks / Skills ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.outreach_playbooks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name                text NOT NULL,
  description         text,
  prompt_instructions text NOT NULL,
  example_messages    text,
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_playbooks_user
  ON public.outreach_playbooks (user_id, is_default DESC, updated_at DESC);

ALTER TABLE public.outreach_playbooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_playbooks_workspace_access ON public.outreach_playbooks;
CREATE POLICY outreach_playbooks_workspace_access
  ON public.outreach_playbooks FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(user_id))
  WITH CHECK (public.mast_can_access_user_data(user_id));

REVOKE ALL ON public.outreach_playbooks FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outreach_playbooks TO authenticated;
GRANT ALL ON public.outreach_playbooks TO service_role;

-- ─── 2. Lead Website Screenshots & Mini Audits ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.lead_website_audits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             bigint NOT NULL UNIQUE REFERENCES public.leads(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  website_url         text,
  screenshot_data_url text,
  visual_summary      text,
  audit_bullets       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ux_findings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  mode                text NOT NULL DEFAULT 'verified_data',
  checked_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_website_audits_user_lead
  ON public.lead_website_audits (user_id, lead_id);

ALTER TABLE public.lead_website_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_website_audits_workspace_access ON public.lead_website_audits;
CREATE POLICY lead_website_audits_workspace_access
  ON public.lead_website_audits FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(user_id))
  WITH CHECK (public.mast_can_access_user_data(user_id));

REVOKE ALL ON public.lead_website_audits FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_website_audits TO authenticated;
GRANT ALL ON public.lead_website_audits TO service_role;

-- ─── 3. Booking Link Sync (Calendly / Cal.com) ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.workspace_booking_settings (
  owner_id        uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'calcom' CHECK (provider IN ('calcom', 'calendly', 'custom')),
  booking_url     text,
  webhook_token   text NOT NULL UNIQUE,
  auto_move_stage boolean NOT NULL DEFAULT true,
  last_event_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_booking_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_booking_settings_select ON public.workspace_booking_settings;
CREATE POLICY workspace_booking_settings_select
  ON public.workspace_booking_settings FOR SELECT
  TO authenticated
  USING (public.mast_can_access_user_data(owner_id));

REVOKE ALL ON public.workspace_booking_settings FROM anon;
GRANT SELECT ON public.workspace_booking_settings TO authenticated;
GRANT ALL ON public.workspace_booking_settings TO service_role;

-- ─── 4. Do-Not-Contact Suppression Blocklist ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workspace_suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('email', 'domain', 'instagram')),
  value      text NOT NULL,
  reason     text,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bounce', 'unsubscribe', 'reply_optout')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_workspace_suppressions_owner_kind
  ON public.workspace_suppressions (owner_id, kind, value);

ALTER TABLE public.workspace_suppressions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_suppressions_workspace_access ON public.workspace_suppressions;
CREATE POLICY workspace_suppressions_workspace_access
  ON public.workspace_suppressions FOR ALL
  TO authenticated
  USING (public.mast_can_access_user_data(owner_id))
  WITH CHECK (public.mast_can_access_user_data(owner_id));

REVOKE ALL ON public.workspace_suppressions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_suppressions TO authenticated;
GRANT ALL ON public.workspace_suppressions TO service_role;
