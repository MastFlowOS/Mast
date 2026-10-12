import type { VercelRequest } from "@vercel/node";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

export type AuthResult =
  | { ok: true; user: User; userSupabase: SupabaseClient }
  | { ok: false; status: number; error: string; code: string };

/**
 * Verifies the caller's bearer token and returns a Supabase client that runs
 * AS that user (so RLS applies). All SMTP data access goes through this client.
 */
export async function authenticate(req: VercelRequest): Promise<AuthResult> {
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      ok: false,
      status: 500,
      code: "server_misconfigured",
      error: "Supabase not configured on the server.",
    };
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      code: "auth_failed",
      error: "Missing or invalid Authorization header.",
    };
  }
  const token = authHeader.split(" ")[1];
  const anon = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
    error,
  } = await anon.auth.getUser(token);
  if (error || !user) {
    return { ok: false, status: 401, code: "auth_failed", error: "Unauthorized user token." };
  }
  const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  return { ok: true, user, userSupabase };
}
