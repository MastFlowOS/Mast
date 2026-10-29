import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const USER_ID = "417f227e-e2e6-4bd2-8283-58bb4eb46928";

async function main() {
  const { data: allLeads, error } = await supabase
    .from("leads")
    .select("id, business_name, location")
    .eq("user_id", USER_ID);

  if (error) {
    console.error("Query error:", error);
    return;
  }

  console.log(`Total leads for user: ${allLeads?.length}`);
  const cityCounts = new Map<string, number>();
  for (const l of (allLeads || [])) {
    const loc = l.location || "Unknown";
    const parts = loc.split(",");
    const c = parts.length > 1 ? parts[parts.length - 2].trim() : parts[0].trim();
    cityCounts.set(c, (cityCounts.get(c) || 0) + 1);
  }
  console.log("Leads by location:", Array.from(cityCounts.entries()).sort((a,b) => b[1] - a[1]).slice(0, 10));
}

main().catch(console.error);
