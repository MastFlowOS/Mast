import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * Service-role client. Bypasses Row Level Security — every write to
 * `businesses`, `business_opportunity_scores`, `scrape_jobs`, and
 * `user_opportunities` goes through here (from the gateway or a worker),
 * never from the browser.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
