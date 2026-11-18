-- =============================================================================
-- Migration 053: Server-backed Real-Time User Notifications
-- =============================================================================
-- Moves critical real-time alerts (starting with client replies from Email and
-- Instagram) from localStorage-only to Postgres + Supabase Realtime so background
-- workers, webhooks, and multi-device sessions can push instant alerts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id      bigint REFERENCES public.leads(id) ON DELETE CASCADE,
  type         text NOT NULL DEFAULT 'reply_received',
  channel      text,
  title        text NOT NULL,
  body         text NOT NULL,
  action_url   text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text,
  read_at      timestamptz,
  dismissed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
  ON public.user_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread
  ON public.user_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL AND dismissed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notifications_dedupe
  ON public.user_notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_notifications_owner_select ON public.user_notifications;
CREATE POLICY user_notifications_owner_select
  ON public.user_notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_notifications_owner_insert ON public.user_notifications;
CREATE POLICY user_notifications_owner_insert
  ON public.user_notifications FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_notifications_owner_update ON public.user_notifications;
CREATE POLICY user_notifications_owner_update
  ON public.user_notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_notifications_owner_delete ON public.user_notifications;
CREATE POLICY user_notifications_owner_delete
  ON public.user_notifications FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.user_notifications FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notifications TO authenticated;
GRANT ALL ON public.user_notifications TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'user_notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notifications;
  END IF;
END $$;
