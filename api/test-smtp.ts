import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticate } from "./_apiAuth.js";
import { createSmtpTransport } from "./_smtp.js";
import { createSupabaseSmtpStore } from "./_smtpStore.js";
import { SmtpServiceError, testStoredSmtp } from "./_smtpService.js";

/**
 * POST /api/test-smtp
 * Tests the user's SAVED SMTP configuration (credentials are decrypted
 * server-side; none are accepted from or returned to the browser) and persists
 * the result + timestamp against that configuration version.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const auth = await authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });

  const store = createSupabaseSmtpStore(auth.userSupabase);
  try {
    const outcome = await testStoredSmtp(store, auth.user.id, async (cfg) => {
      await createSmtpTransport({ ...cfg, connectionTimeout: 10000 }).verify();
    });

    if (!outcome.success) {
      console.error("[SMTP Test] connection failed");
      return res.status(422).json({
        success: false,
        error: outcome.error,
        recorded: outcome.recorded,
        settings: outcome.settings,
      });
    }
    return res.status(200).json({
      success: true,
      message: "SMTP connection established successfully.",
      recorded: outcome.recorded,
      settings: outcome.settings,
    });
  } catch (err) {
    const e =
      err instanceof SmtpServiceError
        ? err
        : new SmtpServiceError(500, "smtp_internal_error", "Unexpected error.");
    console.error("[SMTP Test]", e.code);
    return res.status(e.status).json({ success: false, error: e.message, code: e.code });
  }
}
