import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const PLAN_ID = "9be16c32-e31d-4665-ab09-4378d1bf162c";

async function main() {
  const { data: events } = await supabase
    .from("discovery_live_events")
    .select("event_type, scout_id, area_label, business_name, reason, event_timestamp")
    .eq("plan_id", PLAN_ID)
    .order("event_timestamp", { ascending: true });

  if (!events || events.length === 0) return;
  const startTs = new Date(events[0].event_timestamp).getTime();

  for (const e of events) {
    const elapsed = ((new Date(e.event_timestamp).getTime() - startTs) / 1000).toFixed(1);
    if (parseFloat(elapsed) > 120) break;
    console.log(`[+${elapsed}s] ${e.event_type} scout=${e.scout_id} area=${e.area_label} name=${e.business_name} reason=${e.reason}`);
  }
}

main().catch(console.error);
