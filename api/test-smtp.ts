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

  // 2. Parse SMTP Config
  try {
    const { host, port, user: smtpUser, pass, encryption } = req.body ?? {};

    if (!host || !port || !smtpUser || !pass) {
      return res.status(400).json({
        error:
          "All connection fields (host, port, username, password) are required.",
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
        rejectUnauthorized: false, // Maximum compatibility
      },
      requireTLS,
      connectionTimeout: 10000, // 10s timeout
    });

    // 3. Perform connection test
    await transporter.verify();

    return res
      .status(200)
      .json({ success: true, message: "SMTP connection established successfully." });
  } catch (error: any) {
    console.error("[SMTP Test Error]", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to connect to SMTP server.",
    });
  }
}
