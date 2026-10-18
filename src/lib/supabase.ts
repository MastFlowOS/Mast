import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser client. Uses the public anon key and is safe to ship to the
 * client — Row Level Security governs everything it touches. This is the
 * ONLY Supabase client the frontend should ever import.
 *
 * The service-role client (`supabaseAdmin`, in `src/lib/supabaseAdmin.ts`)
 * bypasses RLS and must never be imported from anything under `src/routes`,
 * `src/components`, or `src/hooks` — it belongs to the gateway/worker only.
 */

const envObj = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : (process.env as Record<string, string | undefined>);
const supabaseUrl = envObj?.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = envObj?.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Non-null when required env vars are missing or contain placeholder values at
 * build/runtime. `__root.tsx` checks this before rendering anything else, and
 * every call site that uses `supabase` guards on `if (!supabase) ...` first.
 */
export const supabaseConfigError: string | null = (() => {
  const missing = [
    !supabaseUrl && "VITE_SUPABASE_URL",
    !supabaseAnonKey && "VITE_SUPABASE_ANON_KEY",
  ].filter(Boolean);

  if (missing.length > 0) {
    return `Missing required environment variable(s): ${missing.join(", ")}`;
  }

  const isPlaceholderUrl =
    !supabaseUrl ||
    /placeholder|your-project|example\.supabase/i.test(supabaseUrl);

  if (isPlaceholderUrl) {
    return "Invalid Supabase configuration: VITE_SUPABASE_URL contains a placeholder domain. Configure your production Supabase URL.";
  }

  const isPlaceholderKey =
    !supabaseAnonKey ||
    /placeholder|your-anon/i.test(supabaseAnonKey) ||
    supabaseAnonKey.length < 20;

  if (isPlaceholderKey) {
    return "Invalid Supabase configuration: VITE_SUPABASE_ANON_KEY contains a placeholder key. Configure your production Supabase anon/publishable key.";
  }

  const isSecretKey = /^sb_sec/i.test(supabaseAnonKey);
  if (isSecretKey) {
    return "Security error: VITE_SUPABASE_ANON_KEY must not contain a private server key. Use the public publishable or anon key.";
  }

  return null;
})();

// null when misconfigured, so every consumer must guard with `if (!supabase)`
// before use — the pattern already followed throughout src/lib/api.ts and
// the auth-related route components.
export let supabase: SupabaseClient | null =
  !supabaseConfigError && supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;

export function setSupabaseClient(client: SupabaseClient | null) {
  supabase = client;
}
