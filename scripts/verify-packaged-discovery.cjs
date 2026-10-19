const { spawn } = require("node:child_process");
const http = require("node:http");
const puppeteer = require("puppeteer-core");

const APP_PATH = "C:\\Users\\Beboo\\AppData\\Local\\MAST\\mast-desktop.exe";
const PORT = 9222;

function waitForCdpReady(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http
        .get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", () => {
          retry();
        });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timeout waiting for WebView2 CDP on port " + PORT));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

async function run() {
  console.log("=== VERIFYING PACKAGED MAST DESKTOP DISCOVERY ===");
  console.log("Launching:", APP_PATH);

  const env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  });

  const appProcess = spawn(APP_PATH, [], {
    env,
    cwd: "C:\\Users\\Beboo\\AppData\\Local\\MAST",
    stdio: "ignore",
    detached: true,
  });

  let browser;
  try {
    console.log("Waiting for WebView2 DevTools Protocol on port", PORT);
    await waitForCdpReady(25000);
    console.log("CDP ready! Connecting via puppeteer-core...");

    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${PORT}`,
    });

    // Settle initial automatic navigation
    await new Promise((r) => setTimeout(r, 2000));

    const pages = await browser.pages();
    const page = pages[0];
    console.log("Connected! Page URL:", page.url());

    page.on("console", (msg) => {
      const text = msg.text();
      if (!text.includes("Download the React DevTools") && !text.includes("%c")) {
        console.log(`[WebView2 Console:${msg.type()}] ${text}`);
      }
    });

    // Navigate to /dashboard/leads if needed
    if (!page.url().includes("/dashboard/leads")) {
      console.log("Navigating to https://mast-flow.vercel.app/dashboard/leads...");
      try {
        await page.goto("https://mast-flow.vercel.app/dashboard/leads", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } catch (err) {
        console.warn("Navigation warning (continuing):", err.message);
      }
    }

    await new Promise((r) => setTimeout(r, 3000));
    console.log("Current page URL:", page.url());

    // ── STEP 1: Check Auth & Session ──────────────────────────────────────────
    console.log("\n[STEP 1] Checking User Session...");
    const authState = await page.evaluate(async () => {
      let token = null;
      let email = null;
      let userId = null;
      try {
        const lsKeys = Object.keys(localStorage);
        const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
        if (sbKey) {
          const session = JSON.parse(localStorage.getItem(sbKey));
          token = session?.access_token || null;
          email = session?.user?.email || null;
          userId = session?.user?.id || null;
        }
      } catch {}

      return {
        isAuthenticated: !!token,
        email,
        userId,
        hasTauri: typeof window.__TAURI_INTERNALS__ !== "undefined",
        tokenSnippet: token ? `${token.slice(0, 10)}...${token.slice(-5)}` : null,
      };
    });
    console.log("Auth State:", JSON.stringify(authState, null, 2));

    if (!authState.isAuthenticated) {
      throw new Error("No active user session in packaged app. User must be signed in.");
    }

    // ── STEP 2: Check / Start Desktop Worker ──────────────────────────────────
    console.log("\n[STEP 2] Verifying Desktop Worker Process...");
    const workerCheck = await page.evaluate(async () => {
      try {
        const status = await window.__TAURI_INTERNALS__.invoke("get_worker_status");
        return { success: true, status };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });
    console.log("Current Worker Status:", JSON.stringify(workerCheck, null, 2));

    if (!workerCheck.status?.is_running) {
      console.log("Starting desktop worker from UI session...");
      const startResult = await page.evaluate(async () => {
        try {
          // Use apiUrl configured for MAST backend
          const lsKeys = Object.keys(localStorage);
          const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
          const session = JSON.parse(localStorage.getItem(sbKey));
          const token = session.access_token;
          const apiUrl = "https://mast-production-4e64.up.railway.app";
          const res = await window.__TAURI_INTERNALS__.invoke("start_worker", {
            apiUrl,
            authToken: token,
          });
          return { success: true, res };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      });
      console.log("Start Worker Result:", JSON.stringify(startResult, null, 2));

      // Wait 3 seconds for worker warmup and Chromium check
      await new Promise((r) => setTimeout(r, 3000));
    }

    const postStartStatus = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Worker status after verification: is_running =", postStartStatus.is_running, "pid =", postStartStatus.pid);
    if (!postStartStatus.is_running) {
      throw new Error(`Worker failed to remain running: ${postStartStatus.last_error}`);
    }

    // ── STEP 3: Execute Discovery Run ─────────────────────────────────────────
    console.log("\n[STEP 3] Launching Live Discovery with execution_target='desktop'...");
    const discoveryLaunch = await page.evaluate(async () => {
      try {
        const lsKeys = Object.keys(localStorage);
        const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
        const session = JSON.parse(localStorage.getItem(sbKey));
        const token = session.access_token;
        const apiUrl = "https://mast-production-4e64.up.railway.app";

        // POST /v1/discover
        const payload = {
          quantity: 2,
          niche: "Bakery",
          region: "United States",
          method: "live",
          channels: ["website", "phone"],
          currencies: [],
          execution_target: "desktop",
        };

        const res = await fetch(`${apiUrl}/v1/discover`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        return { status: res.status, ok: res.ok, data };
      } catch (err) {
        return { status: 0, ok: false, error: String(err) };
      }
    });

    console.log("Discovery Launch Response:", JSON.stringify(discoveryLaunch, null, 2));
    if (!discoveryLaunch.ok || !discoveryLaunch.data?.jobId) {
      throw new Error(`Discovery launch failed: ${JSON.stringify(discoveryLaunch)}`);
    }

    const { jobId, planId } = discoveryLaunch.data;
    console.log(`\n[STEP 4] Tracking Discovery Run: Job ${jobId}, Plan ${planId}...`);

    // Poll the job, plan, tasks, and worker logs until completion or timeout (max 120s)
    const startTime = Date.now();
    let completed = false;
    let lastSummary = null;

    // Direct DB connection for ground truth
    const { createClient } = require("@supabase/supabase-js");
    const fs = require("fs");
    const envText = fs.readFileSync(".env", "utf8");
    const urlMatch = envText.match(/^SUPABASE_URL=(.*)$/m);
    const keyMatch = envText.match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/m);
    const sbAdmin = createClient(urlMatch[1].trim(), keyMatch[1].trim());

    while (Date.now() - startTime < 240000) {
      await new Promise((r) => setTimeout(r, 4000));

      const pollState = await page.evaluate(
        async ({ pId, jId }) => {
          let worker = null;
          try {
            worker = await window.__TAURI_INTERNALS__.invoke("get_worker_status");
          } catch {}

          return { worker };
        },
        { pId: planId, jId: jobId },
      );

      const workerLogs = pollState.worker?.recent_logs || [];
      const workerRunning = pollState.worker?.is_running;

      console.log(`[${Math.round((Date.now() - startTime) / 1000)}s] Worker running: ${workerRunning}, Recent log lines: ${workerLogs.length}`);
      if (workerLogs.length > 0) {
        const lastFew = workerLogs.slice(-2);
        for (const line of lastFew) {
          console.log(`  > ${line}`);
        }
      }

      const { data: jobRow } = await sbAdmin.from("scrape_jobs").select("*").eq("id", jobId).single();
      const { data: planRow } = await sbAdmin.from("discovery_plans").select("*").eq("id", planId).single();
      const { data: taskRows } = await sbAdmin.from("discovery_tasks").select("id, city, status, discovered_count, accepted_count, rejected_count, task_summary").eq("plan_id", planId);

      const delivered = planRow?.delivered_count ?? 0;
      const requested = planRow?.requested_count ?? 0;
      console.log(`  Job status: ${jobRow?.status}, Plan status: ${planRow?.status}, Delivered: ${delivered}/${requested}`);
      if (taskRows && taskRows.length > 0) {
        for (const t of taskRows) {
          console.log(`    Task ${t.city}: status=${t.status}, disc=${t.discovered_count}, acc=${t.accepted_count}, rej=${t.rejected_count}`);
        }
      }

      lastSummary = {
        job: jobRow,
        plan: planRow,
        tasks: taskRows,
        workerStatus: pollState.worker,
      };

      if (delivered >= requested || jobRow?.status === "completed" || jobRow?.status === "completed_partial" || jobRow?.status === "failed") {
        console.log(`\nRun resolved with terminal status: job=${jobRow?.status}, plan=${planRow?.status}, delivered=${delivered}/${requested}`);
        completed = true;
        break;
      }
    }

    if (!completed) {
      console.warn("Run reached observation window; logging current state...");
    }

    console.log("\n=== FINAL TEST REPORT ===");
    console.log("Job Status:", lastSummary?.job?.status);
    console.log("Plan Status:", lastSummary?.plan?.status);
    console.log("Delivered Count:", lastSummary?.plan?.delivered_count, "/", lastSummary?.plan?.requested_count);
    console.log("Tasks Breakdown:");
    for (const t of lastSummary?.tasks || []) {
      console.log(`- City: ${t.city}, Status: ${t.status}, Discovered: ${t.discovered_count}, Accepted: ${t.accepted_count}, Rejected: ${t.rejected_count}`);
      console.log("  Summary:", JSON.stringify(t.task_summary?.processed_batches, null, 2));
    }

    // Check newly delivered leads for user
    const { data: recentLeads } = await sbAdmin
      .from("leads")
      .select("id, business_name, city, website, phone, created_at")
      .eq("user_id", authState.userId)
      .order("created_at", { ascending: false })
      .limit(5);
    console.log("\nRecent Delivered Leads for User:", JSON.stringify(recentLeads, null, 2));

    console.log("\nRecent Worker Logs:");
    for (const log of lastSummary?.workerStatus?.recent_logs?.slice(-15) || []) {
      console.log(`  ${log}`);
    }

    browser.disconnect();
    return lastSummary;
  } catch (err) {
    console.error("Error during verification:", err);
    throw err;
  } finally {
    try {
      appProcess.kill();
    } catch {}
  }
}

run().then(
  () => process.exit(0),
  () => process.exit(1),
);
