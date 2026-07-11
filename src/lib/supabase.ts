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

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

/**
 * Non-null when required env vars are missing at build/runtime. `__root.tsx`
 * checks this before rendering anything else, and every call site that uses
 * `supabase` guards on `if (!supabase) ...` first (see src/lib/api.ts).
 */
export const supabaseConfigError: string | null = (() => {
  const missing = [
    !supabaseUrl && "VITE_SUPABASE_URL",
    !supabaseAnonKey && "VITE_SUPABASE_ANON_KEY",
  ].filter(Boolean);

  if (missing.length === 0) return null;
  return `Missing required environment variable(s): ${missing.join(", ")}`;
})();

// null when misconfigured, so every consumer must guard with `if (!supabase)`
// before use — the pattern already followed throughout src/lib/api.ts and
// the auth-related route components.
export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;
