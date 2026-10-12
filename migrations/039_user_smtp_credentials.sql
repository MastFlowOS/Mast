-- 039: Server-side encrypted SMTP credentials + persisted connection-test status.
--
-- The password is stored ONLY as AES-256-GCM ciphertext produced by the API
-- (key: SMTP_CREDENTIALS_KEY, server environment). The database never sees the
-- plaintext or the key. The frontend never reads this table: it uses
-- /api/smtp-settings, which returns non-secret fields and status only.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.user_smtp_credentials (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  host                text        NOT NULL CHECK (length(host) BETWEEN 1 AND 255),
  port                integer     NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username            text        NOT NULL CHECK (length(username) BETWEEN 1 AND 320),
  encryption          text        NOT NULL DEFAULT 'None' CHECK (encryption IN ('None', 'TLS', 'SSL')),
  password_ciphertext text        NOT NULL CHECK (length(password_ciphertext) > 0),
  -- Bumped by the API whenever host/port/username/encryption/password change.
  config_version      integer     NOT NULL DEFAULT 1,
  last_test_status    text        CHECK (last_test_status IN ('success', 'failed')),
  last_tested_at      timestamptz,
  last_test_error     text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_smtp_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smtp_credentials_select_own" ON public.user_smtp_credentials;
DROP POLICY IF EXISTS "smtp_credentials_insert_own" ON public.user_smtp_credentials;
DROP POLICY IF EXISTS "smtp_credentials_update_own" ON public.user_smtp_credentials;
DROP POLICY IF EXISTS "smtp_credentials_delete_own" ON public.user_smtp_credentials;

-- Owner-only. The API runs these queries with the caller's JWT.
CREATE POLICY "smtp_credentials_select_own" ON public.user_smtp_credentials
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "smtp_credentials_insert_own" ON public.user_smtp_credentials
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "smtp_credentials_update_own" ON public.user_smtp_credentials
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "smtp_credentials_delete_own" ON public.user_smtp_credentials
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Explicit grants (see migration 011: restored schemas lose default grants).
-- No access for anon.
REVOKE ALL ON public.user_smtp_credentials FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_smtp_credentials TO authenticated;
GRANT ALL ON public.user_smtp_credentials TO service_role;
