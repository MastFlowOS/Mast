import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: plans, error } = await supabase
    .from("discovery_plans")
    .select("id, scrape_job_id, status, requested_count, delivered_count, failed_count, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log("Recent Plans:", JSON.stringify(plans, null, 2), "error:", error);
  console.log("Recent Tasks:", JSON.stringify(tasks, null, 2), "tErr:", tErr);
}

main().catch(console.error);
