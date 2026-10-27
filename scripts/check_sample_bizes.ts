import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const ids = [
    "85374571-994c-4020-b78e-ad086cb751a0",
    "55808586-5f50-4e0f-a846-d298f9805faa",
    "471c72f9-b99b-4af6-8b88-124500feba0d",
  ];
  const { data: tasks } = await supabase
    .from("business_processing_tasks")
    .select("business_id, kind, status, attempts, error, started_at, completed_at")
    .in("business_id", ids);

  console.log(JSON.stringify(tasks, null, 2));
}

main().catch(console.error);
