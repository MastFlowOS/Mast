import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";
import { env } from "../src/config/env.js";
import { createClient } from "@supabase/supabase-js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const GATEWAY_URL = "http://127.0.0.1:3000";
const TEST_EMAIL = "desktop-test-coord@test.mast-flow.local";
const TEST_PASSWORD = "CoordTestPassword2026!Secure";

function getDesktopDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
  const base = localAppData || path.join(os.homedir(), ".mast");
  return path.join(base, "MAST");
}

async function runStageC() {
  console.log("=== STARTING STAGE C: Worker Integration Test ===");

  const dataDir = getDesktopDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  const tokenFilePath = path.join(dataDir, "auth.token");

  // Step 1: Authenticate via Supabase Auth
  console.log("Step 1: Authenticating test account via Supabase Auth...");
  const authClient = createClient(
    env.SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: authSession, error: authErr } = await authClient.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (authErr || !authSession.session) {
    throw new Error(`Authentication failed: ${authErr?.message}`);
  }

  const userId = authSession.user.id;
  let currentSession = authSession.session;
  console.log("Authenticated! Test user ID:", userId);

  // Write token to %LOCALAPPDATA%\MAST\auth.token
  await fs.writeFile(tokenFilePath, currentSession.access_token, { encoding: "utf-8" });
  console.log("Wrote initial auth token to local disk token path.");

  // Ensure user has credits
  await supabaseAdmin.from("profiles").update({ credits: 100, plan: "pro" }).eq("id", userId);

  let workerProc: ChildProcess | null = null;
  const createdJobIds: string[] = [];
  const createdPlanIds: string[] = [];
  const createdTaskIds: string[] = [];

  try {
    // Step 2: Create a controlled test task in DB
    console.log("Step 2: Creating Task 1 (normal execution)...");
    const scrapeJobId1 = crypto.randomUUID();
    const planId1 = crypto.randomUUID();
    const taskId1 = crypto.randomUUID();
    createdJobIds.push(scrapeJobId1);
    createdPlanIds.push(planId1);
    createdTaskIds.push(taskId1);

    await supabaseAdmin.from("scrape_jobs").insert({
      id: scrapeJobId1,
      user_id: userId,
      mode: "live",
      status: "running",
      query: { region: "United States", niche: "test_worker_integration", quantity: 2, execution_target: "desktop" },
    });

    await supabaseAdmin.from("discovery_plans").insert({
      id: planId1,
      scrape_job_id: scrapeJobId1,
      user_id: userId,
      niche: "test_worker_integration",
      region: "United States",
      requested_count: 2,
      delivered_count: 0,
      status: "running",
    });

    await supabaseAdmin.from("discovery_tasks").insert({
      id: taskId1,
      plan_id: planId1,
      user_id: userId,
      niche: "test_worker_integration",
      country_code: "US",
      country_name: "United States",
      city: "TestCity",
      candidate_budget: 2,
      priority: 100,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    });

    // Step 3: Launch Python desktop worker against local gateway
    console.log("Step 3: Launching Python desktop worker process...");
    workerProc = spawn(
      "python",
      [
        "mast-lead-engine/desktop_worker.py",
        "--api-url", GATEWAY_URL,
        "--worker-id", "test-stage-c-worker-01",
        "--poll-interval", "1.0",
        "--heartbeat-interval", "3.0",
        "--batch-size", "2",
        "--skip-browser-check",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MAST_MOCK_DISCOVERY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    workerProc.stdout?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[worker-stdout] ${line}`);
    });
    workerProc.stderr?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[worker-stderr] ${line}`);
    });

    // Wait for Task 1 to complete
    console.log("Waiting for Task 1 to be claimed and processed by worker...");
    let task1Done = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data: t } = await supabaseAdmin
        .from("discovery_tasks")
        .select("status, discovered_count, accepted_count")
        .eq("id", taskId1)
        .single();

      if (t?.status === "completed") {
        console.log("Task 1 completed! Discovered:", t.discovered_count, "Accepted:", t.accepted_count);
        assert.equal(t.accepted_count, 2, "Expected 2 accepted leads");
        task1Done = true;
        break;
      }
    }
    assert.ok(task1Done, "Task 1 did not reach 'completed' status in time");

    // Verify leads were persisted in database
    const { data: leads, error: leadsErr } = await supabaseAdmin
      .from("leads")
      .select("id, business_name, location")
      .eq("scrape_job_id", scrapeJobId1);
    if (leadsErr) throw leadsErr;
    console.log("Persisted leads count for Task 1:", leads?.length ?? 0);
    assert.equal(leads?.length, 2, "Expected 2 persisted leads in leads table");

    // Step 4: Test Cancellation & Worker Standby
    console.log("\nStep 4: Testing Cancellation and Standby...");
    const scrapeJobId2 = crypto.randomUUID();
    const planId2 = crypto.randomUUID();
    const taskId2 = crypto.randomUUID();
    createdJobIds.push(scrapeJobId2);
    createdPlanIds.push(planId2);
    createdTaskIds.push(taskId2);

    await supabaseAdmin.from("scrape_jobs").insert({
      id: scrapeJobId2,
      user_id: userId,
      mode: "live",
      status: "running",
      query: { region: "United States", niche: "test_cancellation", quantity: 5, execution_target: "desktop" },
    });
    await supabaseAdmin.from("discovery_plans").insert({
      id: planId2,
      scrape_job_id: scrapeJobId2,
      user_id: userId,
      niche: "test_cancellation",
      region: "United States",
      requested_count: 5,
      delivered_count: 0,
      status: "running",
    });
    await supabaseAdmin.from("discovery_tasks").insert({
      id: taskId2,
      plan_id: planId2,
      user_id: userId,
      niche: "test_cancellation",
      country_code: "US",
      country_name: "United States",
      city: "TestCity",
      candidate_budget: 10,
      priority: 100,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    });

    console.log("Task 2 queued. Waiting for worker to claim it...");
    let claimed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data: t } = await supabaseAdmin
        .from("discovery_tasks")
        .select("status")
        .eq("id", taskId2)
        .single();
      if (t?.status === "running") {
        claimed = true;
        break;
      }
    }
    assert.ok(claimed, "Task 2 was not claimed by worker");
    console.log("Task 2 is now running. Cancelling plan in DB...");

    // Cancel plan on server
    await supabaseAdmin
      .from("discovery_plans")
      .update({ status: "cancelled" })
      .eq("id", planId2);

    // Cancel task on server
    await supabaseAdmin
      .from("discovery_tasks")
      .update({ status: "cancelled" })
      .eq("id", taskId2);

    // Wait for worker heartbeat to detect cancellation and abort task
    console.log("Waiting for worker to detect cancellation via heartbeat...");
    await new Promise((r) => setTimeout(r, 4000));

    // Confirm worker process is STILL alive and running in standby!
    assert.equal(workerProc.exitCode, null, "Worker process should NOT exit on task cancellation");
    console.log("Worker remains alive in standby after task cancellation!");

    // Step 5: Test Token Refresh
    console.log("\nStep 5: Testing Token Refresh using real Supabase Auth refreshSession...");
    const { data: refreshData, error: refreshErr } = await authClient.auth.refreshSession({
      refresh_token: currentSession.refresh_token,
    });
    if (refreshErr || !refreshData.session) {
      throw new Error(`Token refresh failed: ${refreshErr?.message}`);
    }
    currentSession = refreshData.session;
    console.log("Supabase Auth session refreshed successfully! (new token length:", currentSession.access_token.length, ")");

    // Write refreshed token to disk (mimicking desktop runtime updateDesktopWorkerToken)
    await fs.writeFile(tokenFilePath, currentSession.access_token, { encoding: "utf-8" });
    console.log("Wrote refreshed token to disk. Worker should pick it up automatically.");

    // Create Task 3 to prove worker processes jobs with refreshed token
    console.log("Creating Task 3 to verify processing with refreshed token...");
    const scrapeJobId3 = crypto.randomUUID();
    const planId3 = crypto.randomUUID();
    const taskId3 = crypto.randomUUID();
    createdJobIds.push(scrapeJobId3);
    createdPlanIds.push(planId3);
    createdTaskIds.push(taskId3);

    await supabaseAdmin.from("scrape_jobs").insert({
      id: scrapeJobId3,
      user_id: userId,
      mode: "live",
      status: "running",
      query: { region: "United States", niche: "test_token_refresh", quantity: 2, execution_target: "desktop" },
    });
    await supabaseAdmin.from("discovery_plans").insert({
      id: planId3,
      scrape_job_id: scrapeJobId3,
      user_id: userId,
      niche: "test_token_refresh",
      region: "United States",
      requested_count: 2,
      delivered_count: 0,
      status: "running",
    });
    await supabaseAdmin.from("discovery_tasks").insert({
      id: taskId3,
      plan_id: planId3,
      user_id: userId,
      niche: "test_token_refresh",
      country_code: "US",
      country_name: "United States",
      city: "TestCity",
      candidate_budget: 2,
      priority: 100,
      status: "queued",
      task_summary: { execution_target: "desktop" },
    });

    console.log("Waiting for Task 3 to complete using refreshed token...");
    let task3Done = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data: t } = await supabaseAdmin
        .from("discovery_tasks")
        .select("status, accepted_count")
        .eq("id", taskId3)
        .single();
      if (t?.status === "completed") {
        console.log("Task 3 completed with refreshed token! Accepted:", t.accepted_count);
        task3Done = true;
        break;
      }
    }
    assert.ok(task3Done, "Task 3 did not complete with refreshed token");

    console.log("\n=== STAGE C WORKER INTEGRATION VERIFIED! ===");
  } finally {
    console.log("Teardown: stopping worker process...");
    if (workerProc && workerProc.exitCode === null) {
      workerProc.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 1500));
      if (workerProc.exitCode === null) {
        workerProc.kill("SIGKILL");
      }
    }

    // Clean up token file
    try {
      await fs.unlink(tokenFilePath);
    } catch {}

    // Clean up test DB records
    console.log("Cleaning up database test records...");
    for (const tid of createdTaskIds) {
      await supabaseAdmin.from("discovery_tasks").delete().eq("id", tid);
    }
    for (const pid of createdPlanIds) {
      await supabaseAdmin.from("discovery_plans").delete().eq("id", pid);
    }
    for (const jid of createdJobIds) {
      await supabaseAdmin.from("leads").delete().eq("scrape_job_id", jid);
      await supabaseAdmin.from("scrape_jobs").delete().eq("id", jid);
    }
    await supabaseAdmin.from("businesses").delete().like("name", "Controlled Desktop Lead %");
    console.log("Teardown and cleanup completed.");
  }
}

runStageC()
  .then(() => {
    console.log("STAGE C VERIFICATION SUCCESS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("STAGE C FAILED:", err);
    process.exit(1);
  });
