import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

console.log("[Mast] VITE_SUPABASE_URL exists:", !!supabaseUrl);
console.log("[Mast] VITE_SUPABASE_ANON_KEY exists:", !!supabaseAnonKey);

/** True when Supabase credentials are properly injected at build time. */
export const supabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

/**
 * The Supabase client. Will be `null` when env vars are missing.
 * Always check `supabaseConfigured` before using this client.
 */
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : null;

/** Human-readable error message when credentials are absent. */
export const supabaseConfigError: string | null = supabaseConfigured
  ? null
  : "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set. " +
    "Add them in Netlify → Site Settings → Environment Variables, " +
    "then trigger a new deploy. Do NOT define them in netlify.toml — " +
    "values in netlify.toml override Netlify dashboard values.";
