import { Handler } from "@netlify/functions";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

// Create a single Supabase client for token validation
const supabase = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export const handler: Handler = async (event) => {
  // Handle CORS preflight
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

  // 1. Verify User Session
  if (!supabase) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Supabase not configured on the server." }),
    };
  }

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

  // 2. Parse SMTP Config
  try {
    const { host, port, user: smtpUser, pass, encryption } = JSON.parse(event.body || "{}");

    if (!host || !port || !smtpUser || !pass) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "All connection fields (host, port, username, password) are required." }),
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
        rejectUnauthorized: false, // For maximum compatibility with mail servers
      },
      requireTLS,
      connectionTimeout: 10000, // 10s timeout
    });

    // 3. Perform connection test
    await transporter.verify();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: "SMTP connection established successfully." }),
    };
  } catch (error: any) {
    console.error("[SMTP Test Error]", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message || "Failed to connect to SMTP server.",
      }),
    };
  }
};
