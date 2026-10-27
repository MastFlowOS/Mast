import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const USER_ID = "417f227e-e2e6-4bd2-8283-58bb4eb46928";

async function main() {
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, email, phone, website, instagram_handle, location, created_at, scrape_job_id")
    .eq("user_id", USER_ID)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("Error:", error);
    return;
  }
  console.log(`Found ${leads?.length} recent leads:`);
  leads?.forEach((l, idx) => {
    console.log(`${idx + 1}. [${l.business_name}] job=${l.scrape_job_id} email=${l.email} phone=${l.phone} web=${l.website} ig=${l.instagram_handle} addr=${l.location} at=${l.created_at}`);
  });
}

main().catch(console.error);
