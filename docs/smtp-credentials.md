# SMTP credentials: storage, configuration, and cleanup

## How it works now

| Concern | Where it lives |
| --- | --- |
| Host, port, username, TLS mode | `public.user_smtp_credentials` (migration `039`) |
| Password | Same row, **AES-256-GCM ciphertext only** (`password_ciphertext`) |
| Encryption key | Server environment variable `SMTP_CREDENTIALS_KEY` (never in the DB, never `VITE_`-prefixed) |
| Last test result, time, error | Same row (`last_test_status`, `last_tested_at`, `last_test_error`) |
| Browser access | `GET/PUT/DELETE /api/smtp-settings`, `POST /api/test-smtp` — non-secret fields and status only |

- Ciphertext is bound to the owning user id (GCM additional authenticated data), so a row copied to another user fails to decrypt.
- Any change to host, port, username, TLS mode, or password bumps `config_version` and clears the test result. A test result is only stored if the config version is unchanged when the test finishes.
- "Connected" is shown only for a saved configuration whose latest test succeeded and that has no unsaved edits. Failed, untested, and unsaved states are shown distinctly. A last-tested timestamp is displayed; it records the last result, not a guarantee of future reachability.
- Disconnect deletes the whole row (ciphertext and status).
- Per-user isolation: owner-only RLS (`user_id = auth.uid()`), plus every query is scoped by `user_id`. The API runs queries with the caller's JWT.

## Required environment variable (do not commit a value)

```
SMTP_CREDENTIALS_KEY   base64 of exactly 32 random bytes
```

Generate: `openssl rand -base64 32`. Set it only on the server runtime that hosts `/api/*` (e.g. the Vercel project environment). It is **not** configured by this change.

If it is missing or malformed, saving or testing SMTP returns HTTP 503 with code `smtp_key_not_configured` / `smtp_key_invalid`, the Settings page shows a configuration error, and nothing is stored. Existing legacy users can still send until migrated (see below).

Key rotation is not automated. Ciphertext is versioned (`v1.`), so a future key-id scheme can be added; until then, rotating the key requires users to re-enter their SMTP password.

## Rollout order

1. Apply `migrations/039_user_smtp_credentials.sql`.
2. Set `SMTP_CREDENTIALS_KEY` on the server runtime.
3. Deploy. 

## Legacy plaintext cleanup (required follow-up)

Before this change, the Settings page saved `smtpPassword` as **plaintext inside `profiles.settings`**, and the browser read it back. Code in this change does the following:

- The client never writes `smtpPassword` and never keeps a legacy value in UI state.
- When a user with legacy settings opens Settings (`GET /api/smtp-settings`) and the key is configured, host/port/username/TLS/password are encrypted into the new table (status: untested) and the plaintext `smtpPassword` key is removed from **that user's own** `profiles.settings`.
- Until a user is migrated, `/api/send-email` falls back to the legacy plaintext values so sending keeps working.

What remains for an operator (not performed by code, because it touches production data):

1. Users who never open Settings keep a plaintext `smtpPassword`. Either ask them to open Settings, or run a one-off migration with the service role and the production key that encrypts each remaining legacy password into `user_smtp_credentials` using the same AES-256-GCM format (`api/_smtpCrypto.ts`).
2. After confirming users are migrated, verify nothing is left:
   ```sql
   select count(*) from public.profiles where settings ? 'smtpPassword';
   ```
3. Then remove any stragglers (only after step 1, or those passwords are lost):
   ```sql
   update public.profiles set settings = settings - 'smtpPassword' where settings ? 'smtpPassword';
   ```
4. Treat previously stored plaintext passwords as exposed (they were readable by the browser, and may exist in database backups and logs). Recommend users rotate their SMTP app passwords.
5. Once all users are migrated, delete the legacy fallback in `api/send-email.ts` and `api/_smtpLegacy.ts`.

## Known limitations

- The ciphertext is readable by its owner through RLS (the browser never queries the table, but the grant exists because the API uses the caller's JWT). A service-role-only table would remove that; it needs a service-role key in the `/api` runtime.
- No automated key rotation.
- Failed-connection errors come from the SMTP server and are redacted of the password and truncated, but may still contain the username or server banner text.

## Verifying a deployment is actually running this code

If Settings still resets to "Not tested" or Send Email still says "User profile or settings not found", the deployed app is **not** running this change: that wording no longer exists anywhere in the code, and the status is no longer component state.

1. Open the deployed site, DevTools → Network, reload **Settings**. A `GET /api/smtp-settings` request must appear. If it does not, the frontend bundle is old.
2. Click **Send Email**. The JSON response of `/api/send-email` must contain a `code` field on every failure (`profile_not_found`, `db_permission_denied`, `smtp_not_configured`, ...). If you see the old sentence, the `api/` functions are old.
3. If `/api/smtp-settings` returns 503: `storage_unavailable` means migration 039 is not applied; `smtp_key_not_configured` means `SMTP_CREDENTIALS_KEY` is not set on the server running `/api/*`.
4. Only Vercel serves `api/` (see `vercel.json`). `netlify.toml` rewrites everything to `index.html` and has no functions, so a Netlify deploy cannot serve these endpoints.

Local wiring check (no credentials needed): `npx tsx scripts/e2e-smtp-check.mts`
