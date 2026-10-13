import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticate } from "./_apiAuth";
import { classifyDbError } from "./_dbErrors";
import { createSmtpTransport } from "./_smtp";
import { createSupabaseSmtpStore } from "./_smtpStore";
import { SmtpServiceError, loadSmtpCredentials } from "./_smtpService";
import { readLegacySmtp } from "./_smtpLegacy";
import { validateEmailInput, formatHtmlEmail, formatPlainTextAlternative } from "./_formatEmail";

export interface SendEmailDeps {
  authenticate: typeof authenticate;
  loadCredentials: (db: SupabaseClient, userId: string) => ReturnType<typeof loadSmtpCredentials>;
  createTransport: typeof createSmtpTransport;
}

const defaultDeps: SendEmailDeps = {
  authenticate,
  loadCredentials: (db, userId) => loadSmtpCredentials(createSupabaseSmtpStore(db), userId),
  createTransport: createSmtpTransport,
};

export async function handleSendEmail(
  req: VercelRequest,
  res: VercelResponse,
  deps: SendEmailDeps = defaultDeps,
) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // 1. Verify the caller. userSupabase runs AS the caller so RLS applies.
  const auth = await deps.authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error, code: auth.code });
  }
  const { user, userSupabase } = auth;

  // 2. Parse and validate payload
  let to: string;
  let subject: string;
  let body: string;

  try {
    const payload = req.body ?? {};
    const validationError = validateEmailInput(payload);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    to = (payload.to as string).trim();
    subject = (payload.subject as string).trim();
    body = (payload.body as string).trim();
  } catch {
    return res.status(400).json({ error: "Invalid request body." });
  }

  // 3. Load sender profile settings and SMTP credentials
  try {
    const { data: profile, error: dbError } = await userSupabase
      .from("profiles")
      .select("settings")
      .eq("id", user.id)
      .single();

    // Distinguish a genuinely missing profile from auth and permission failures.
    const failure = classifyDbError(dbError, "profile");
    if (failure) {
      console.error("[SMTP Send] profile lookup failed:", failure.code);
      return res.status(failure.status).json({ error: failure.message, code: failure.code });
    }
    if (!profile) {
      return res
        .status(404)
        .json({ error: "No profile record exists for this account.", code: "profile_not_found" });
    }

    const settings = (profile.settings as Record<string, string>) || {};

    // Credentials come from encrypted server-side storage. Transitional
    // fallback: legacy plaintext settings for users not yet migrated.
    let creds = await deps.loadCredentials(userSupabase, user.id);
    if (!creds) {
      const legacy = readLegacySmtp(settings);
      if (legacy) {
        creds = {
          host: legacy.host,
          port: Number(legacy.port),
          user: legacy.user,
          pass: legacy.pass,
          encryption: legacy.encryption,
        };
      }
    }
    if (!creds) {
      return res.status(400).json({
        error: "SMTP settings are incomplete or not configured.",
        code: "smtp_not_configured",
      });
    }

    const { host, port, user: smtpUser, pass, encryption } = creds;
    const senderName = settings.smtpSenderName || settings.senderName;
    const senderEmail = settings.smtpSenderEmail || settings.senderEmail || smtpUser;

    const transporter = deps.createTransport({
      host,
      port,
      user: smtpUser,
      pass,
      encryption,
    });

    const signature = settings.signature?.trim();
    let finalBody = body;
    if (signature && !finalBody.includes(signature)) {
      finalBody = `${finalBody.trim()}\n\n${signature}`;
    }

    const htmlBody = formatHtmlEmail(finalBody);
    const plainText = formatPlainTextAlternative(finalBody);

    const mailOptions = {
      from: senderName ? `"${senderName}" <${senderEmail}>` : senderEmail,
      to,
      subject,
      text: plainText,
      html: htmlBody,
    };

    const info = await transporter.sendMail(mailOptions);

    return res.status(200).json({
      success: true,
      messageId: info.messageId,
      message: "Email sent successfully.",
    });
  } catch (error: unknown) {
    if (error instanceof SmtpServiceError) {
      console.error("[SMTP Send]", error.code);
      return res
        .status(error.status)
        .json({ success: false, error: error.message, code: error.code });
    }
    // Log the error code only: SMTP errors can echo connection details.
    const code = (error as { code?: string } | null)?.code ?? "send_failed";
    console.error("[SMTP Send Error]", code);
    return res.status(500).json({
      success: false,
      error:
        error instanceof Error && error.message ? error.message : "Failed to send email via SMTP.",
      code: "send_failed",
    });
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleSendEmail(req, res);
}
