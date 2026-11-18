-- =============================================================================
-- Migration 054: Inbox Connections (IMAP / Inbound Webhook / IG Alert Bridge)
--                and Outbound/Inbound Message Thread Tracking
-- =============================================================================
-- Stores encrypted IMAP polling credentials (AES-256-GCM via SMTP_CREDENTIALS_KEY)
-- plus a per-user inbound webhook alias token for forwarding / Reply-To parsing.
-- Also adds thread correlation columns on lead_messages for In-Reply-To matching.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_inbox_connections (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider                text NOT NULL DEFAULT 'imap' CHECK (provider IN ('imap', 'inbound_only')),
  imap_host               text CHECK (imap_host IS NULL OR length(imap_host) BETWEEN 1 AND 255),
  imap_port               integer CHECK (imap_port IS NULL OR (imap_port BETWEEN 1 AND 65535)),
  imap_username           text CHECK (imap_username IS NULL OR length(imap_username) BETWEEN 1 AND 320),
  imap_tls                boolean NOT NULL DEFAULT true,
  password_ciphertext     text,
  inbound_token           text NOT NULL UNIQUE,
  ig_email_alerts_enabled boolean NOT NULL DEFAULT true,
  enabled                 boolean NOT NULL DEFAULT true,
  last_uid                bigint NOT NULL DEFAULT 0,
  uid_validity            bigint,
  last_synced_at          timestamptz,
  last_sync_status        text CHECK (last_sync_status IS NULL OR last_sync_status IN ('success', 'failed')),
  last_sync_error         text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_inbox_connections_active_imap
  ON public.user_inbox_connections (enabled, provider)
  WHERE enabled = true AND provider = 'imap';

ALTER TABLE public.user_inbox_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_connections_select_own ON public.user_inbox_connections;
CREATE POLICY inbox_connections_select_own ON public.user_inbox_connections
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS inbox_connections_insert_own ON public.user_inbox_connections;
CREATE POLICY inbox_connections_insert_own ON public.user_inbox_connections
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS inbox_connections_update_own ON public.user_inbox_connections;
CREATE POLICY inbox_connections_update_own ON public.user_inbox_connections
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS inbox_connections_delete_own ON public.user_inbox_connections;
CREATE POLICY inbox_connections_delete_own ON public.user_inbox_connections
  FOR DELETE TO authenticated USING (user_id = auth.uid());

REVOKE ALL ON public.user_inbox_connections FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_inbox_connections TO authenticated;
GRANT ALL ON public.user_inbox_connections TO service_role;

-- Add thread tracking columns to lead_messages for deterministic reply correlation.
ALTER TABLE public.lead_messages
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound', 'inbound')),
  ADD COLUMN IF NOT EXISTS external_message_id text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_lead_messages_user_external_id
  ON public.lead_messages (user_id, external_message_id)
  WHERE external_message_id IS NOT NULL;
