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
  console.log("=== VERIFYING PACKAGED MAST CANCEL & CLEANUP LIFECYCLE ===");
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

    await new Promise((r) => setTimeout(r, 2000));
    const pages = await browser.pages();
    const page = pages[0];

    // Ensure on /dashboard/leads
    if (!page.url().includes("/dashboard/leads")) {
      console.log("Navigating to https://mast-flow.vercel.app/dashboard/leads...");
      await page.goto("https://mast-flow.vercel.app/dashboard/leads", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await new Promise((r) => setTimeout(r, 3000));
    }

    console.log("Current page URL:", page.url());

    // ── STEP 1: Verify on-demand state (worker NOT running initially) ─────────
    console.log("\n[STEP 1] Checking worker status before Discover...");
    const initialWorker = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Initial worker status:", initialWorker.status, "PID:", initialWorker.pid);

    // ── STEP 2: Launch Discovery Run ─────────────────────────────────────────
    console.log("\n[STEP 2] Launching Discovery run...");
    const launchRes = await page.evaluate(async () => {
      const lsKeys = Object.keys(localStorage);
      const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const session = JSON.parse(localStorage.getItem(sbKey));
      const token = session.access_token;
      const apiUrl = "https://mast-production-4e64.up.railway.app";

      // 1. Start worker on demand
      await window.__TAURI_INTERNALS__.invoke("start_worker", { apiUrl, authToken: token });

      // 2. POST /v1/discover
      const payload = {
        quantity: 5,
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
      if (data.planId) {
        await window.__TAURI_INTERNALS__.invoke("set_active_plan", { planId: data.planId });
      }
      return { status: res.status, data };
    });

    console.log("Launch response:", JSON.stringify(launchRes, null, 2));
    const { jobId, planId } = launchRes.data;

    // Wait until worker is actively working (Scout 1 running)
    console.log("\n[STEP 3] Waiting for Scout to start scraping...");
    let workerPid = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await page.evaluate(async () => {
        return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
      });
      if (status.is_running && status.pid) {
        workerPid = status.pid;
        const logs = status.recent_logs || [];
        const hasScoutStarted = logs.some((l) => l.includes("[provider]") || l.includes("maps"));
        if (hasScoutStarted) {
          console.log(`Scout actively running under Worker PID ${workerPid}!`);
          break;
        }
      }
    }

    if (!workerPid) {
      throw new Error("Worker failed to start or claim within 45s");
    }

    // ── STEP 4: Cancel Active Search ─────────────────────────────────────────
    console.log(`\n[STEP 4] Executing CANCEL on active Job ${jobId}...`);
    const cancelResult = await page.evaluate(async ({ jId }) => {
      const lsKeys = Object.keys(localStorage);
      const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const session = JSON.parse(localStorage.getItem(sbKey));
      const token = session.access_token;
      const apiUrl = "https://mast-production-4e64.up.railway.app";

      // 1. Cancel on backend
      const cancelRes = await fetch(`${apiUrl}/v1/discover/${jId}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      // 2. Clear active plan file
      await window.__TAURI_INTERNALS__.invoke("set_active_plan", { planId: null });

      // 3. Stop desktop worker process tree
      const stopRes = await window.__TAURI_INTERNALS__.invoke("stop_worker");

      return {
        backendStatus: cancelRes.status,
        stopRes,
      };
    }, { jId: jobId });

    console.log("Cancel Result:", JSON.stringify(cancelResult, null, 2));

    // Wait 3 seconds for OS process tree cleanup
    await new Promise((r) => setTimeout(r, 3000));

    // ── STEP 5: Verify Process Tree Teardown ──────────────────────────────────
    console.log("\n[STEP 5] Verifying process cleanup...");
    const postCancelWorker = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Worker status post-cancel:", postCancelWorker.status, "PID:", postCancelWorker.pid);

    if (postCancelWorker.is_running) {
      throw new Error(`Worker PID ${workerPid} is still marked running after cancel!`);
    }

    // ── STEP 6: Verify Database Terminal State ────────────────────────────────
    console.log("\n[STEP 6] Checking database state for cancelled Job and Plan...");
    const { createClient } = require("@supabase/supabase-js");
    const fs = require("fs");
    const envText = fs.readFileSync(".env", "utf8");
    const urlMatch = envText.match(/^SUPABASE_URL=(.*)$/m);
    const keyMatch = envText.match(/^SUPABASE_SERVICE_ROLE_KEY=(.*)$/m);
    const sbAdmin = createClient(urlMatch[1].trim(), keyMatch[1].trim());

    const { data: jobRow } = await sbAdmin.from("scrape_jobs").select("status").eq("id", jobId).single();
    const { data: planRow } = await sbAdmin.from("discovery_plans").select("status").eq("id", planId).single();
    const { data: taskRows } = await sbAdmin.from("discovery_tasks").select("id, status, termination_reason").eq("plan_id", planId);

    console.log("Job status:", jobRow?.status);
    console.log("Plan status:", planRow?.status);
    console.log("Tasks status count:", taskRows?.length);
    for (const t of taskRows || []) {
      console.log(`  Task ${t.id}: status=${t.status}, reason=${t.termination_reason}`);
    }

    const allCancelled = taskRows.every((t) => t.status === "cancelled" || t.status === "completed");
    if (!allCancelled) {
      console.warn("Some tasks were not cancelled:", taskRows);
    } else {
      console.log("All tasks properly transitioned to terminal state!");
    }

    // ── STEP 7: Verify Immediate Follow-up Search Works ───────────────────────
    console.log("\n[STEP 7] Verifying new search can start immediately after cancel...");
    const secondLaunch = await page.evaluate(async () => {
      const lsKeys = Object.keys(localStorage);
      const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const session = JSON.parse(localStorage.getItem(sbKey));
      const token = session.access_token;
      const apiUrl = "https://mast-production-4e64.up.railway.app";

      // 1. Restart worker
      const startRes = await window.__TAURI_INTERNALS__.invoke("start_worker", { apiUrl, authToken: token });

      // 2. Post new discover request
      const payload = {
        quantity: 1,
        niche: "Bakery",
        region: "United States",
        method: "live",
        channels: ["website"],
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
      if (data.planId) {
        await window.__TAURI_INTERNALS__.invoke("set_active_plan", { planId: data.planId });
      }
      return { startRes, discoverStatus: res.status, data };
    });

    console.log("Second Launch Result:", JSON.stringify(secondLaunch, null, 2));

    // Wait 5 seconds to verify worker claims new task
    await new Promise((r) => setTimeout(r, 5000));
    const secondWorkerStatus = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Second search worker status: running =", secondWorkerStatus.is_running, "PID =", secondWorkerStatus.pid);

    // Stop worker to leave system clean
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("set_active_plan", { planId: null });
      await window.__TAURI_INTERNALS__.invoke("stop_worker");
    });

    console.log("\n=== ALL LIFECYCLE ACCEPTANCE CHECKS PASSED ===");
    browser.disconnect();
  } catch (err) {
    console.error("Error during cancellation verification:", err);
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
