import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const JOB_ID = "8a9f0826-3462-44b7-a599-91d888fa16a8";

async function main() {
  const { data: job } = await supabase.from("scrape_jobs").select("*").eq("id", JOB_ID).maybeSingle();
  console.log("Scrape Job:", job?.id, job?.status, "results_count:", job?.results_count);

  const { data: plans } = await supabase.from("discovery_plans").select("*").eq("scrape_job_id", JOB_ID);
  console.log("Plans found:", plans?.length);
  if (plans && plans.length > 0) {
    for (const p of plans) {
      console.log(`Plan ID: ${p.id}, status: ${p.status}, requested: ${p.requested_count}, delivered: ${p.delivered_count}`);
      const { data: events } = await supabase.from("discovery_live_events").select("event_type, scout_id, business_name, reason").eq("plan_id", p.id);
      console.log(`Events for plan ${p.id}:`, events?.length);
      events?.slice(-5).forEach(e => console.log("  Event:", e));
    }
  }

  const { data: leads } = await supabase.from("leads").select("id, business_name, email, phone, website, instagram_handle, location, created_at").eq("scrape_job_id", JOB_ID);
  console.log(`Leads attributed to job ${JOB_ID}:`, leads?.length);
  leads?.forEach((l, i) => console.log(`  ${i+1}. [${l.business_name}] ${l.website} ${l.email} ${l.phone} ${l.instagram_handle}`));
}

main().catch(console.error);
