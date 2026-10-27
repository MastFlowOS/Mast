import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;
const API_URL = "https://mast-production-4e64.up.railway.app";
const USER_ID = "417f227e-e2e6-4bd2-8283-58bb4eb46928";
const USER_EMAIL = "mastflow.os@gmail.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  console.log("=== STARTING MAST LIVE DISCOVERY BENCHMARK ===");
  console.log("Target: 10 Coffee Shops in United States with Email, Phone, Website, Instagram in < 120s");

  const token = jwt.sign(
    { sub: USER_ID, email: USER_EMAIL, role: "authenticated" },
    SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "2h" }
  );

  // Ensure no stale jobs/tasks from prior benchmark runs are running
  console.log("Cancelling any prior active jobs/tasks for test user...");
  await supabase
    .from("discovery_tasks")
    .update({ status: "cancelled", termination_reason: "USER_CANCELLED", completed_at: new Date().toISOString() })
    .eq("user_id", USER_ID)
    .in("status", ["queued", "running"]);
  await supabase
    .from("discovery_plans")
    .update({ status: "cancelled", terminal_reason: "USER_CANCELLED", completed_at: new Date().toISOString() })
    .eq("user_id", USER_ID)
    .in("status", ["queued", "running"]);
  await supabase
    .from("scrape_jobs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("user_id", USER_ID)
    .in("status", ["queued", "running", "streaming"]);
  await new Promise((r) => setTimeout(r, 2000));

  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] Submitting discovery request to ${API_URL}/v1/discover...`);

  const response = await fetch(`${API_URL}/v1/discover`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      quantity: 10,
      region: "United States",
      niche: "Coffee Shop",
      channels: ["email", "phone", "website", "instagram"],
      method: "live",
      execution_target: "cloud",
    }),
  });

  const respText = await response.text();
  console.log(`HTTP ${response.status}: ${respText}`);

  if (!response.ok) {
    console.error("Discovery request failed to submit!");
    process.exit(1);
  }

  let jobInfo: any;
  try {
    jobInfo = JSON.parse(respText);
  } catch (e) {
    console.error("Failed to parse response JSON", e);
    process.exit(1);
  }

  const jobId = jobInfo.jobId ?? jobInfo.id;
  const planId = jobInfo.planId;
  console.log(`Scrape Job ID: ${jobId}, Plan ID: ${planId ?? "pending"}`);

  let firstLeadTime: number | null = null;
  let tenthLeadTime: number | null = null;
  const discoveredPids = new Set<string>();
  const acceptedPids = new Set<string>();
  const rejectedReasons = new Map<string, number>();

  const deadline = t0 + 600_000; // 10 minute hard ceiling

  let lastLoggedEvents = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

    // 1. Check scrape_jobs
    const { data: jobRow } = await supabase
      .from("scrape_jobs")
      .select("status, results_count, job_summary, error")
      .eq("id", jobId)
      .maybeSingle();

    // 2. Check discovery_live_events if planId is known or found
    let effectivePlanId = planId;
    if (!effectivePlanId) {
      const { data: planRow } = await supabase
        .from("discovery_plans")
        .select("id")
        .eq("scrape_job_id", jobId)
        .maybeSingle();
      if (planRow) effectivePlanId = planRow.id;
    }

    if (effectivePlanId) {
      const { data: events } = await supabase
        .from("discovery_live_events")
        .select("*")
        .eq("plan_id", effectivePlanId)
        .order("event_timestamp", { ascending: true });

      if (events && events.length > lastLoggedEvents) {
        for (let i = lastLoggedEvents; i < events.length; i++) {
          const ev = events[i];
          const ts = ((new Date(ev.event_timestamp).getTime() - t0) / 1000).toFixed(1);
          console.log(`[+${ts}s] [Event:${ev.event_type}] scout=${ev.scout_id} area="${ev.area_label}" biz="${ev.business_name ?? ""}" reason="${ev.reason ?? ""}" outcome=${JSON.stringify(ev.area_outcome ?? "")}`);

          if (ev.event_type === "candidate_discovered" && ev.pipeline_id) {
            discoveredPids.add(ev.pipeline_id);
          } else if (ev.event_type === "candidate_accepted" || ev.event_type === "lead_delivered") {
            acceptedPids.add(ev.business_name || ev.pipeline_id || String(acceptedPids.size + 1));
            if (firstLeadTime === null) firstLeadTime = (new Date(ev.event_timestamp).getTime() - t0) / 1000;
            if (acceptedPids.size >= 10 && tenthLeadTime === null) tenthLeadTime = (new Date(ev.event_timestamp).getTime() - t0) / 1000;
          } else if (ev.event_type === "candidate_rejected") {
            const r = ev.reason ?? "unknown";
            rejectedReasons.set(r, (rejectedReasons.get(r) ?? 0) + 1);
          }
        }
        lastLoggedEvents = events.length;
      }
    }

    // 3. Check delivered leads in leads table associated with this user
    const { data: leads, error: leadsErr } = await supabase
      .from("leads")
      .select("id, business_name, email, phone, website, instagram_handle, location, created_at")
      .eq("user_id", USER_ID)
      .gte("created_at", new Date(t0).toISOString())
      .order("created_at", { ascending: true });

    const deliveredCount = leads?.length ?? 0;
    if (deliveredCount > 0 && firstLeadTime === null) {
      firstLeadTime = ((Date.now() - t0) / 1000);
    }
    if (deliveredCount >= 10 && tenthLeadTime === null) {
      tenthLeadTime = ((Date.now() - t0) / 1000);
    }

    console.log(`[+${elapsedSec}s] Job status: ${jobRow?.status ?? "unknown"} | Discovered: ${discoveredPids.size} | Accepted events: ${acceptedPids.size} | Delivered DB leads: ${deliveredCount}`);

    if (deliveredCount >= 10) {
      console.log(`\n🎉 TARGET REACHED: 10 leads delivered in ${tenthLeadTime?.toFixed(1)}s!`);
      break;
    }

    if (jobRow?.status === "completed" || jobRow?.status === "failed" || jobRow?.status === "cancelled") {
      console.log(`Job finished with terminal status: ${jobRow.status}`);
      break;
    }
  }

  const totalDuration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n================ BENCHMARK REPORT ================");
  console.log(`Total duration: ${totalDuration}s`);
  console.log(`Time to 1st lead: ${firstLeadTime ? firstLeadTime.toFixed(1) + "s" : "N/A"}`);
  console.log(`Time to 10th lead: ${tenthLeadTime ? tenthLeadTime.toFixed(1) + "s" : "N/A"}`);
  console.log(`Candidates Discovered: ${discoveredPids.size}`);
  console.log(`Candidates Accepted: ${acceptedPids.size}`);
  console.log(`Rejections by reason:`, Object.fromEntries(rejectedReasons.entries()));

  // Fetch delivered businesses from leads table
  const { data: deliveredLeads } = await supabase
    .from("leads")
    .select("id, business_name, email, phone, website, instagram_handle, location, created_at")
    .eq("user_id", USER_ID)
    .gte("created_at", new Date(t0).toISOString())
    .order("created_at", { ascending: true });

  console.log(`\nDelivered Leads Count: ${deliveredLeads?.length ?? 0}`);
  if (deliveredLeads) {
    deliveredLeads.forEach((lead: any, idx: number) => {
      console.log(`${idx + 1}. [${lead.business_name}] Website: ${lead.website} | Email: ${lead.email} | Phone: ${lead.phone} | IG: ${lead.instagram_handle} | Addr: ${lead.location}`);
    });
  }

  const success = (deliveredLeads?.length ?? 0) >= 10 && Number(totalDuration) <= 120;
  console.log(`\nBENCHMARK MET OBJECTIVE (<120s and >=10 4-channel coffee shops): ${success ? "YES" : "NO"}`);
}

main().catch(console.error);
