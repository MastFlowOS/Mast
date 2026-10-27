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

  console.log(`Total events: ${events?.length}`);
  const areaCounts = new Map<string, number>();
  const rejections = new Map<string, number>();
  let discovered = 0;
  let delivered = 0;

  events?.forEach(e => {
    if (e.event_type === "candidate_discovered") discovered++;
    if (e.event_type === "lead_delivered") delivered++;
    if (e.event_type === "candidate_rejected") {
      rejections.set(e.reason, (rejections.get(e.reason) ?? 0) + 1);
    }
    if (e.area_label) {
      areaCounts.set(e.area_label, (areaCounts.get(e.area_label) ?? 0) + 1);
    }
  });

  console.log(`Summary: Discovered=${discovered}, Delivered=${delivered}`);
  console.log("Rejection reasons:", Object.fromEntries(rejections.entries()));
  console.log("Areas visited count:", areaCounts.size);
  console.log("Sample areas:", Array.from(areaCounts.keys()).slice(0, 20));
}

main().catch(console.error);
