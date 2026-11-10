import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;
const API_URL = process.env.API_URL || "http://127.0.0.1:8080";
const USER_ID = "417f227e-e2e6-4bd2-8283-58bb4eb46928";
const USER_EMAIL = "mastflow.os@gmail.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const iterNum = process.argv[2] || "12";
  console.log(`=== STARTING MAST LIVE DISCOVERY BENCHMARK (Iteration ${iterNum}) ===`);
  console.log("Target: 10 Coffee Shops in United States with Email, Phone, Website, Instagram in < 180s (Max ceiling: 600s)");

  if (!fs.existsSync("output")) {
    fs.mkdirSync("output", { recursive: true });
  }

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
  const resetState = process.env.RESET_BENCHMARK_STATE === "true";
  if (resetState) {
    console.log("Cleaning up prior test leads for USER_ID (RESET_BENCHMARK_STATE=true)...");
    await supabase.from("leads").delete().eq("user_id", USER_ID);
    console.log("Resetting discovery_area_stats for Coffee Shop niche...");
    await supabase.from("discovery_area_stats").delete().eq("niche", "Coffee Shop");
  } else {
    console.log("Preserving prior test leads and discovery_area_stats for real deduplication & area rotation...");
  }

  await new Promise((r) => setTimeout(r, 2000));

  // If local API, start local gateway server
  let serverProc: any = null;
  const isLocalApi = API_URL.includes("127.0.0.1") || API_URL.includes("localhost");

  if (isLocalApi) {
    console.log(`Spawning local gateway server on ${API_URL}...`);
    const serverLogStream = fs.createWriteStream(`output/iteration_${iterNum}_server.log`, { flags: "w" });
    serverProc = spawn("npx", ["tsx", "src/server.ts"], {
      env: { ...process.env, PORT: "8080", USE_PERSISTENT_ENRICHMENT: "true", MAST_DESKTOP_INGEST_CONCURRENCY: "2", NODE_OPTIONS: "--max-old-space-size=2048", MAST_MAX_SCOUTS: "2" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    serverProc.stdout.pipe(serverLogStream);
    serverProc.stderr.pipe(serverLogStream);

    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const h = await fetch(`${API_URL}/health`);
        if (h.ok) {
          ready = true;
          console.log(`[${new Date().toISOString()}] Local gateway server is healthy and ready!`);
          break;
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ready) {
      console.error("Local gateway server failed to start within 30 seconds!");
      serverProc.kill("SIGTERM");
      process.exit(1);
    }
  }

  const t0 = Date.now();
  const startTimeIso = new Date(t0).toISOString();

  // Start local desktop worker process running our updated Python lead engine (concurrency=2)
  console.log(`[${startTimeIso}] Spawning local desktop worker (concurrency=2)...`);
  const workerLogStream = fs.createWriteStream(`output/iteration_${iterNum}_worker.log`, { flags: "w" });
  const workerProc = spawn("python", [
    "-u",
    "mast-lead-engine/desktop_worker.py",
    "--api-url", API_URL,
    "--auth-token", token,
    "--concurrency", "2",
    "--batch-size", "1",
    "--poll-interval", "1.0",
  ], {
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      NODE_OPTIONS: "--max-old-space-size=1024 --max-semi-space-size=64",
      PLACE_EXTRACT_TIMEOUT_MS: "8000",
      CARD_OPERATION_TIMEOUT_MS: "25000",
      RETURN_TO_RESULTS_TIMEOUT_MS: "2500",
      MAST_PANEL_MARKER_WAIT_MS: "5000",
      MAST_STAGE_A_COLD_MOUNT_WAIT_MS: "8000",
      MAST_STAGE_A_MOUNT_WAIT_MS: "4000",
      MAST_STAGE_B_MOUNT_WAIT_MS: "1500",
      MAST_DISABLE_EXCEPTIONAL_GOTO: "true",
      MAX_STALE_PANEL_RETRIES_PER_CARD: "0",
      MAX_UNOPENED_PANEL_RETRIES_PER_CARD: "0",
      MAST_MAX_CONSECUTIVE_DUPLICATES: "4",
      MAST_MAX_ZERO_YIELD_REJECTIONS: "5",
      MAST_MAX_CONSECUTIVE_REJECTIONS: "8",
      MAST_MAX_TASK_DURATION_S: "120.0",
    },
  });

  workerProc.stdout.pipe(workerLogStream);
  workerProc.stderr.pipe(workerLogStream);

  console.log(`[${startTimeIso}] Submitting discovery request to ${API_URL}/v1/discover...`);

  let response: any = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      response = await fetch(`${API_URL}/v1/discover`, {
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
          channelMatch: "all",
          method: "live",
          execution_target: "desktop",
        }),
      });
      break;
    } catch (netErr: any) {
      console.warn(`Attempt ${attempt} network error connecting to API: ${netErr?.message || netErr}. Retrying in 1.5s...`);
      if (attempt === 5) {
        workerProc.kill("SIGTERM");
        throw netErr;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const respText = await response.text();
  console.log(`HTTP ${response.status}: ${respText}`);

  if (!response.ok) {
    console.error("Discovery request failed to submit!");
    workerProc.kill("SIGTERM");
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
  const eventsLog: string[] = [];

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
        .order("event_timestamp", { ascending: true })
        .range(lastLoggedEvents, lastLoggedEvents + 100);

      if (events && events.length > 0) {
        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          const ts = ((new Date(ev.event_timestamp).getTime() - t0) / 1000).toFixed(1);
          const line = `[+${ts}s] [Event:${ev.event_type}] scout=${ev.scout_id} area="${ev.area_label}" biz="${ev.business_name ?? ""}" reason="${ev.reason ?? ""}" outcome=${JSON.stringify(ev.area_outcome ?? "")}`;
          console.log(line);
          eventsLog.push(line);

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
        lastLoggedEvents += events.length;
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

    if (jobRow?.status === "completed" || jobRow?.status === "completed_partial" || jobRow?.status === "failed" || jobRow?.status === "cancelled") {
      console.log(`Job finished with terminal status: ${jobRow.status}`);
      break;
    }

    if (Date.now() >= deadline && deliveredCount < 10) {
      console.log(`\n⏱️ 10-MINUTE OBSERVATION WINDOW EXPIRED. Cancelling job cleanly via supported path...`);
      try {
        const cancelResp = await fetch(`${API_URL}/v1/discover/${jobId}/cancel`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        console.log(`Cancel response status: ${cancelResp.status}`);
      } catch (cancelErr) {
        console.error("Cancel request error:", cancelErr);
      }
      break;
    }
  }

  // Terminate worker child process cleanly
  console.log("Shutting down desktop worker process...");
  try {
    workerProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {}

  if (serverProc) {
    console.log("Shutting down local gateway server...");
    try {
      serverProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {}
  }

  const totalDuration = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n================ BENCHMARK REPORT ================");
  console.log(`Total duration: ${totalDuration}s`);
  console.log(`Time to 1st lead: ${firstLeadTime ? firstLeadTime.toFixed(1) + "s" : "N/A"}`);
  console.log(`Time to 10th lead: ${tenthLeadTime ? tenthLeadTime.toFixed(1) + "s" : "N/A"}`);
  console.log(`Candidates Discovered: ${discoveredPids.size}`);
  console.log(`Candidates Accepted: ${acceptedPids.size}`);
  console.log(`Rejections by reason:`, Object.fromEntries(rejectedReasons.entries()));

  // Write events to output log
  fs.writeFileSync(`output/iteration_${iterNum}_events.log`, eventsLog.join("\n"), "utf-8");
  console.log(`Saved events to output/iteration_${iterNum}_events.log`);

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

  const success = (deliveredLeads?.length ?? 0) >= 10 && Number(totalDuration) <= 180;
  console.log(`\nBENCHMARK MET OBJECTIVE (<180s and >=10 4-channel coffee shops): ${success ? "YES" : "NO"}`);

  if (!isLocalApi) {
    // Fetch complete Railway server logs for this run
    const sinceTime = new Date(t0 - 10_000).toISOString();
    console.log(`\nFetching complete Railway server logs since ${sinceTime}...`);
    try {
      const rawRailwayLogs = execSync(`railway logs -s Mast --since "${sinceTime}"`, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      });
      fs.writeFileSync("output/iteration_11_railway.log", rawRailwayLogs, "utf-8");
      console.log(`Successfully saved Railway logs to output/iteration_11_railway.log (${rawRailwayLogs.split("\n").length} lines)`);
    } catch (err: any) {
      console.warn("Could not fetch Railway logs via CLI:", err?.message);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
