import type { VercelRequest, VercelResponse } from "@vercel/node";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Supabase not configured on the server." });
  }

  // 1. Verify User Token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header." });
  }

  const token = authHeader.split(" ")[1];
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: "Unauthorized user token." });
  }

  // 2. Parse payload
  let to: string;
  let subject: string;
  let body: string;

  try {
    const payload = req.body ?? {};
    to = payload.to;
    subject = payload.subject;
    body = payload.body;

    if (!to || !subject || !body) {
      return res.status(400).json({
        error: "Recipient email (to), subject, and body are required.",
      });
    }
  } catch {
    return res.status(400).json({ error: "Invalid request body." });
  }

  // 3. Fetch user SMTP settings from Supabase
  try {
    const { data: profile, error: dbError } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", user.id)
      .single();

    if (dbError || !profile) {
      return res
        .status(404)
        .json({ error: "User profile or settings not found." });
    }

    const settings = (profile.settings as Record<string, string>) || {};
    const host = settings.smtpHost;
    const port = settings.smtpPort;
    const smtpUser = settings.smtpUser;
    const pass = settings.smtpPassword;
    const encryption = settings.smtpEncryption;
    const senderName = settings.smtpSenderName || settings.senderName;
    const senderEmail =
      settings.smtpSenderEmail || settings.senderEmail || smtpUser;

    if (!host || !port || !smtpUser || !pass) {
      return res.status(400).json({
        error: "SMTP settings are incomplete or not configured.",
      });
    }

    const secure = encryption === "SSL";
    const requireTLS = encryption === "TLS";

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure,
      auth: {
        user: smtpUser,
        pass,
      },
      tls: {
        rejectUnauthorized: false,
      },
      requireTLS,
    });

    const mailOptions = {
      from: senderName ? `"${senderName}" <${senderEmail}>` : senderEmail,
      to,
      subject,
      text: body,
    };

    const info = await transporter.sendMail(mailOptions);

    return res.status(200).json({
      success: true,
      messageId: info.messageId,
      message: "Email sent successfully.",
    });
  } catch (error: any) {
    console.error("[SMTP Send Error]", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to send email via SMTP.",
    });
  }
}
