import { supabaseAdmin } from "../src/lib/supabaseAdmin.js";
import { env } from "../src/config/env.js";
import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";

const GATEWAY_URL = "http://127.0.0.1:3000";
const TEST_EMAIL = "desktop-test-coord@test.mast-flow.local";
const TEST_PASSWORD = "CoordTestPassword2026!Secure";

async function runStageB() {
  console.log("=== STARTING STAGE B: Authenticated Coordination Test ===");

  // 1. Authenticate through the existing supported flow
  console.log("Step 1: Setting up dedicated test account in Supabase...");
  const { data: users, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
  if (listErr) throw listErr;

  let testUser = users.users.find((u) => u.email === TEST_EMAIL);
  if (!testUser) {
    console.log("Creating new test user:", TEST_EMAIL);
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { name: "Coordination Test User" },
    });
    if (createErr) throw createErr;
    testUser = created.user;
  } else {
    console.log("Reusing existing test user:", testUser.id);
    await supabaseAdmin.auth.admin.updateUserById(testUser.id, {
      password: TEST_PASSWORD,
      email_confirm: true,
    });
  }

  // Ensure test profile exists and has sufficient credits
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("id, plan, credits")
    .eq("id", testUser.id)
    .maybeSingle();

  if (!profile) {
    console.log("Creating profile for test user with 100 credits...");
    await supabaseAdmin.from("profiles").insert({
      id: testUser.id,
      email: TEST_EMAIL,
      plan: "pro",
      credits: 100,
    });
  } else if ((profile.credits ?? 0) < 50) {
    console.log("Refilling test profile credits to 100...");
    await supabaseAdmin.from("profiles").update({ credits: 100, plan: "pro" }).eq("id", testUser.id);
  }

  // Sign in through standard client
  console.log("Authenticating via Supabase Auth (signInWithPassword)...");
  const authClient = createClient(env.SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: authSession, error: authErr } = await authClient.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (authErr || !authSession.session) {
    throw new Error(`Authentication failed: ${authErr?.message}`);
  }

  const accessToken = authSession.session.access_token;
  console.log("Authentication successful! Token acquired (length:", accessToken.length, ")");

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };

  // 2. Create a legitimate desktop-target discovery plan & task
  console.log("Step 2: Creating controlled test plan and task in database...");
  const scrapeJobId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const taskId = crypto.randomUUID();

  const { error: jobInsertErr } = await supabaseAdmin.from("scrape_jobs").insert({
    id: scrapeJobId,
    user_id: testUser.id,
    mode: "live",
    status: "running",
    query: {
      region: "United States",
      niche: "test_software_consulting",
      quantity: 5,
      execution_target: "desktop",
    },
  });
  if (jobInsertErr) throw jobInsertErr;

  const { error: planInsertErr } = await supabaseAdmin.from("discovery_plans").insert({
    id: planId,
    scrape_job_id: scrapeJobId,
    user_id: testUser.id,
    niche: "test_software_consulting",
    region: "United States",
    requested_count: 5,
    delivered_count: 0,
    status: "running",
  });
  if (planInsertErr) throw planInsertErr;

  const { error: taskInsertErr } = await supabaseAdmin.from("discovery_tasks").insert({
    id: taskId,
    plan_id: planId,
    user_id: testUser.id,
    niche: "test_software_consulting",
    country_code: "US",
    country_name: "United States",
    city: "TestCity",
    candidate_budget: 10,
    priority: 100,
    status: "queued",
    task_summary: {
      execution_target: "desktop",
    },
  });
  if (taskInsertErr) throw taskInsertErr;
  console.log("Created test job", scrapeJobId, "test plan", planId, "and test task", taskId);

  let leaseToken: string = "";
  try {
    // 3. Claim the task from the desktop worker
    console.log("Step 3: Claiming task via POST /v1/desktop/tasks/claim...");
    const claimRes = await fetch(`${GATEWAY_URL}/v1/desktop/tasks/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workerId: "test-worker-e2e-01",
        preferredTaskId: taskId,
      }),
    });

    assert.equal(claimRes.status, 200, `Claim failed with status ${claimRes.status}`);
    const claimData = (await claimRes.json()) as any;
    assert.ok(claimData.task, "Expected claimed task in response");
    assert.equal(claimData.task.id, taskId, "Claimed task ID does not match");
    leaseToken = claimData.task.leaseToken;
    assert.ok(leaseToken, "Expected leaseToken in claim response");
    console.log("Task claimed successfully! Lease token acquired.");

    // Verify task state in database
    const { data: claimedDbTask } = await supabaseAdmin
      .from("discovery_tasks")
      .select("status, task_summary")
      .eq("id", taskId)
      .single();
    assert.equal(claimedDbTask?.status, "running", "Task status should be 'running' in DB");
    assert.equal(claimedDbTask?.task_summary?.lease_token, leaseToken, "Lease token mismatch in DB");

    // 4. Send a heartbeat and verify lease renewal
    console.log("Step 4: Sending heartbeat via POST /v1/desktop/tasks/:id/heartbeat...");
    const hbRes = await fetch(`${GATEWAY_URL}/v1/desktop/tasks/${taskId}/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        leaseToken,
        metrics: { discovered: 1, durationMs: 1200 },
      }),
    });

    assert.equal(hbRes.status, 200, `Heartbeat failed with status ${hbRes.status}`);
    const hbData = (await hbRes.json()) as any;
    assert.equal(hbData.renewed, true, "Heartbeat should return renewed: true");
    assert.ok(hbData.leaseExpiresAt, "Heartbeat should return leaseExpiresAt");
    console.log("Heartbeat succeeded! Lease renewed until", hbData.leaseExpiresAt);

    // 5. Ingest a tiny test batch
    console.log("Step 5: Ingesting test candidate batch via POST /v1/desktop/tasks/:id/ingest...");
    const batchId = `batch-e2e-${Date.now()}`;
    const testCandidate = {
      name: "Acme Test Coordination Lab",
      query: "test software consulting TestCity",
      city: "TestCity",
      country: "United States",
      country_code: "US",
      niche: "test_software_consulting",
      region: "TestRegion",
      address: "100 Innovation Blvd, TestCity, US",
      phone: "+15555550199",
      website: "https://acme-test-coord-lab.example.com",
      maps_link: "https://maps.google.com/?cid=99999999999999",
      rating: 4.8,
      reviews: 42,
    };

    const ingestRes1 = await fetch(`${GATEWAY_URL}/v1/desktop/tasks/${taskId}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        leaseToken,
        batchId,
        candidates: [testCandidate],
      }),
    });

    assert.equal(ingestRes1.status, 200, `Ingest 1 failed with status ${ingestRes1.status}`);
    const ingestData1 = (await ingestRes1.json()) as any;
    console.log("Ingest response 1:", JSON.stringify(ingestData1));
    assert.ok(ingestData1.accepted >= 0, "Ingest result should contain accepted count");

    // 6. Retry the same batch ID and verify idempotency
    console.log("Step 6: Retrying same batchId to verify idempotency...");
    const ingestRes2 = await fetch(`${GATEWAY_URL}/v1/desktop/tasks/${taskId}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        leaseToken,
        batchId,
        candidates: [testCandidate],
      }),
    });

    assert.equal(ingestRes2.status, 200, `Ingest 2 failed with status ${ingestRes2.status}`);
    const ingestData2 = (await ingestRes2.json()) as any;
    console.log("Ingest response 2 (cached/idempotent):", JSON.stringify(ingestData2));
    assert.deepEqual(ingestData1, ingestData2, "Cached batch response should match original");

    // 7. Complete the task and verify final server state
    console.log("Step 7: Completing task via POST /v1/desktop/tasks/:id/complete...");
    const completeRes = await fetch(`${GATEWAY_URL}/v1/desktop/tasks/${taskId}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        leaseToken,
        status: "completed",
        discovered: 1,
        accepted: ingestData1.accepted,
        rejected: ingestData1.rejected || 0,
        duplicates: ingestData1.duplicates || 0,
      }),
    });

    assert.equal(completeRes.status, 200, `Complete failed with status ${completeRes.status}`);
    const completeData = (await completeRes.json()) as any;
    console.log("Complete response:", JSON.stringify(completeData));
    assert.equal(completeData.status, "completed", "Complete response status should be completed");

    // Verify final state in DB
    const { data: finalDbTask } = await supabaseAdmin
      .from("discovery_tasks")
      .select("status, task_summary")
      .eq("id", taskId)
      .single();

    assert.equal(finalDbTask?.status, "completed", "Final DB task status should be completed");
    assert.ok(!finalDbTask?.task_summary?.lease_token, "Lease token should be cleared in DB");
    console.log("Final database task state verified: status='completed', lease cleared.");

    console.log("=== STAGE B PASSED COMPLETELY! ===");
  } finally {
    // Clean up test records
    console.log("Cleaning up test records from database...");
    await supabaseAdmin.from("discovery_tasks").delete().eq("id", taskId);
    await supabaseAdmin.from("discovery_plans").delete().eq("id", planId);
    await supabaseAdmin.from("scrape_jobs").delete().eq("id", scrapeJobId);
    await supabaseAdmin.from("leads").delete().eq("scrape_job_id", scrapeJobId);
    await supabaseAdmin.from("businesses").delete().eq("name", "Acme Test Coordination Lab");
    console.log("Cleanup complete.");
  }
}

runStageB()
  .then(() => {
    console.log("STAGE B VERIFICATION SUCCESS");
    process.exit(0);
  })
  .catch((err) => {
    console.error("STAGE B FAILED:", err);
    process.exit(1);
  });
