import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PLAN_ID = "9be16c32-e31d-4665-ab09-4378d1bf162c";

async function main() {
  const { data: tasks, error } = await supabase
    .from("discovery_tasks")
    .select("id, city, street, status, result, created_at, started_at, completed_at")
    .eq("plan_id", PLAN_ID)
    .order("started_at", { ascending: true });

  console.log(`Total tasks for plan: ${tasks?.length}`);
  tasks?.forEach((t, i) => {
    const dur = t.started_at && t.completed_at ? ((new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()) / 1000).toFixed(1) + "s" : "in-progress";
    console.log(`${i+1}. city=${t.city} street=${t.street} status=${t.status} dur=${dur} res=${JSON.stringify(t.result)}`);
  });
}

main().catch(console.error);
