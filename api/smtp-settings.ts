import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticate } from "./_apiAuth.js";
import { createSupabaseSmtpStore } from "./_smtpStore.js";
import {
  SmtpServiceError,
  deleteSmtpSettings,
  getSmtpSettings,
  saveSmtpSettings,
} from "./_smtpService.js";
import { adoptLegacySmtpIfNeeded, stripLegacyPassword } from "./_smtpLegacy.js";

/**
 * GET    /api/smtp-settings  → non-secret config + persisted test status
 * PUT    /api/smtp-settings  → save config (password optional on update)
 * DELETE /api/smtp-settings  → delete config, credentials, and status
 *
 * Responses never contain the password or its ciphertext.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["GET", "PUT", "DELETE"].includes(req.method ?? "")) {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const auth = await authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });

  const { user, userSupabase } = auth;
  const store = createSupabaseSmtpStore(userSupabase);

  try {
    if (req.method === "GET") {
      await adoptLegacySmtpIfNeeded(userSupabase, store, user.id).catch(() => undefined);
      return res.status(200).json({ settings: await getSmtpSettings(store, user.id) });
    }

    if (req.method === "PUT") {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const settings = await saveSmtpSettings(store, user.id, {
        host: body.host,
        port: body.port,
        username: body.username,
        encryption: body.encryption,
        password: body.password,
      });
      await stripLegacyPassword(userSupabase, user.id).catch(() => undefined);
      return res.status(200).json({ settings });
    }

    await deleteSmtpSettings(store, user.id);
    await stripLegacyPassword(userSupabase, user.id).catch(() => undefined);
    return res.status(200).json({ settings: await getSmtpSettings(store, user.id) });
  } catch (err) {
    const e =
      err instanceof SmtpServiceError
        ? err
        : new SmtpServiceError(500, "smtp_internal_error", "Unexpected error.");
    // Log only a code: never the request body, error object, or any secret.
    console.error("[smtp-settings]", req.method, e.code);
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
}
