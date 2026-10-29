import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PLAN_ID = process.argv[2] || "9c08d52d-0196-4ff8-bed2-3d506702b4cf";

async function main() {
  console.log(`Inspecting plan: ${PLAN_ID}`);
  const { data: plan } = await supabase.from("discovery_plans").select("*").eq("id", PLAN_ID).single();
  console.log("Plan row:", plan);

  const { data: tasks } = await supabase.from("discovery_tasks").select("id, status, city, area_name, candidate_count, error, started_at, completed_at").eq("plan_id", PLAN_ID);
  console.log("Tasks count:", tasks?.length);
  for (const t of (tasks || [])) {
    console.log(`Task ${t.id} [${t.status}] city=${t.city} area=${t.area_name} candidates=${t.candidate_count} error=${t.error}`);
  }

  const { data: events } = await supabase
    .from("discovery_live_events")
    .select("event_type, scout_id, area_label, business_name, reason, event_timestamp")
    .eq("plan_id", PLAN_ID)
    .order("event_timestamp", { ascending: true });

  console.log(`Total events: ${events?.length}`);
  if (events) {
    for (const e of events) {
      console.log(`[${e.event_timestamp}] ${e.event_type} scout=${e.scout_id} area=${e.area_label} biz=${e.business_name || ""} reason=${e.reason || ""}`);
    }
  }
}

main().catch(console.error);
