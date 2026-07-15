import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import type { Database } from "../types/database.types.js";

/**
 * Service-role client. Bypasses Row Level Security — every write to
 * `businesses`, `business_opportunity_scores`, `scrape_jobs`, and
 * `user_opportunities` goes through here (from the gateway or a worker),
 * never from the browser.
 *
 * Typed against `Database` (src/types/database.types.ts) so `.from(...)`,
 * `.select(...)`, `.insert(...)`, `.update(...)`, and `.rpc(...)` are all
 * checked against the real schema instead of falling back to postgrest-js's
 * generic (untyped) query builder.
 */
export const supabaseAdmin = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
