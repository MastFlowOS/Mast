import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: jobs, error } = await supabase
    .from("scrape_jobs")
    .select("id, status, created_at, results_count, query")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log(JSON.stringify(jobs, null, 2));
}

main().catch(console.error);
