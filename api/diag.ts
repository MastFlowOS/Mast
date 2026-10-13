import type { VercelRequest, VercelResponse } from "@vercel/node";

// TEMPORARY diagnostic. Delete after use. Returns only error messages and
// booleans, never secret values.
async function attempt(name: string, load: () => Promise<unknown>) {
  try {
    await load();
    return { name, ok: true };
  } catch (e: any) {
    return { name, ok: false, error: String(e?.message ?? e).slice(0, 300), code: e?.code };
  }
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const results = [
    await attempt("nodemailer", () => import("nodemailer")),
    await attempt("@supabase/supabase-js", () => import("@supabase/supabase-js")),
    await attempt("_dbErrors.js", () => import("./_dbErrors.js")),
    await attempt("_smtpCrypto.js", () => import("./_smtpCrypto.js")),
    await attempt("_smtpService.js", () => import("./_smtpService.js")),
    await attempt("_smtpStore.js", () => import("./_smtpStore.js")),
    await attempt("_smtpLegacy.js", () => import("./_smtpLegacy.js")),
    await attempt("_apiAuth.js", () => import("./_apiAuth.js")),
    await attempt("_smtp.js", () => import("./_smtp.js")),
    await attempt("_formatEmail.js", () => import("./_formatEmail.js")),
    await attempt("smtp-settings.js", () => import("./smtp-settings.js")),
  ];
  res.status(200).json({
    node: process.version,
    env: {
      SMTP_CREDENTIALS_KEY: Boolean(process.env.SMTP_CREDENTIALS_KEY),
      VITE_SUPABASE_URL: Boolean(process.env.VITE_SUPABASE_URL),
      VITE_SUPABASE_ANON_KEY: Boolean(process.env.VITE_SUPABASE_ANON_KEY),
    },
    results,
  });
}
