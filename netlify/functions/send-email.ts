import { Handler } from "@netlify/functions";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export const handler: Handler = async (event) => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  if (!supabase) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Supabase not configured on the server." }),
    };
  }

  // 1. Verify User Token
  const authHeader = event.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Missing or invalid Authorization header." }),
    };
  }

  const token = authHeader.split(" ")[1];
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Unauthorized user token." }),
    };
  }

  // 2. Parse payload details
  let to: string;
  let subject: string;
  let body: string;

  try {
    const payload = JSON.parse(event.body || "{}");
    to = payload.to;
    subject = payload.subject;
    body = payload.body;

    if (!to || !subject || !body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Recipient email (to), subject, and body are required." }),
      };
    }
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON request body." }),
    };
  }

  // 3. Fetch user settings for SMTP credentials
  try {
    const { data: profile, error: dbError } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", user.id)
      .single();

    if (dbError || !profile) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "User profile or settings not found." }),
      };
    }

    const settings = (profile.settings as Record<string, string>) || {};
    const host = settings.smtpHost;
    const port = settings.smtpPort;
    const smtpUser = settings.smtpUser;
    const pass = settings.smtpPassword; // or settings.smtpAppPassword
    const encryption = settings.smtpEncryption;
    const senderName = settings.smtpSenderName || settings.senderName;
    const senderEmail = settings.smtpSenderEmail || settings.senderEmail || smtpUser;

    if (!host || !port || !smtpUser || !pass) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "SMTP settings are incomplete or not configured." }),
      };
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
      // Supposing we want html too, but plain text is standard for this template
    };

    const info = await transporter.sendMail(mailOptions);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        messageId: info.messageId,
        message: "Email sent successfully.",
      }),
    };
  } catch (error: any) {
    console.error("[SMTP Send Error]", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message || "Failed to send email via SMTP.",
      }),
    };
  }
};
