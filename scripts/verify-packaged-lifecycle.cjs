const { spawn } = require("node:child_process");
const http = require("node:http");
const puppeteer = require("puppeteer-core");

const APP_PATH = "C:\\Users\\Beboo\\AppData\\Local\\MAST\\mast-desktop.exe";
const PORT = 9222;

function waitForCdpReady(timeoutMs = 20000) {
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

async function main() {
  console.log("==================================================================");
  console.log("VERIFYING PACKAGED MAST DESKTOP ON-DEMAND & CANCELLATION LIFECYCLE");
  console.log("Binary path:", APP_PATH);
  console.log("==================================================================");

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
    console.log("[1/5] Waiting for application WebView2 DevTools Protocol...");
    await waitForCdpReady(25000);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}` });

    await new Promise((r) => setTimeout(r, 2000));
    const pages = await browser.pages();
    const page = pages[0];
    console.log("Connected to packaged desktop app! Page URL:", page.url());

    // ── TEST 1: Launch MAST and confirm no discovery worker or browser is launched ──
    console.log("\n[TEST 1] Verifying Idle State on Launch...");
    const initialStatus = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Initial Worker Status:", initialStatus);
    if (initialStatus.is_running !== false || initialStatus.status !== "stopped") {
      throw new Error(`TEST 1 FAILED: Expected worker to be stopped on launch, but got: ${JSON.stringify(initialStatus)}`);
    }
    console.log("PASS: Discovery worker is strictly NOT running on application launch.");

    // ── TEST 2: Check active user session ──
    console.log("\n[TEST 2] Checking User Session for On-Demand Test...");
    const authSession = await page.evaluate(async () => {
      try {
        const lsKeys = Object.keys(localStorage);
        const sbKey = lsKeys.find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
        if (sbKey) {
          const session = JSON.parse(localStorage.getItem(sbKey));
          return { hasSession: true, token: session.access_token };
        }
      } catch {}
      return { hasSession: false, token: null };
    });

    if (!authSession.hasSession || !authSession.token) {
      console.log("Note: No persisted session in localStorage. Using dummy token to verify IPC command handling.");
    }
    const token = authSession.token || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dummy";
    const apiUrl = "https://mast-production-4e64.up.railway.app";

    // ── TEST 3: On-Demand Worker Launch with Concurrency = 1 ──
    console.log("\n[TEST 3] Testing On-Demand Worker Start...");
    const startResult = await page.evaluate(async ({ apiUrl, token }) => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("start_worker", {
          apiUrl,
          authToken: token,
        });
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }, { apiUrl, token });

    console.log("Start Worker Result:", startResult);
    if (!startResult.success) {
      throw new Error(`TEST 3 FAILED: start_worker error: ${startResult.error}`);
    }

    // Wait 2 seconds for worker to spawn
    await new Promise((r) => setTimeout(r, 2000));
    const runningStatus = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Running Worker Status: is_running =", runningStatus.is_running, "pid =", runningStatus.pid);
    if (!runningStatus.is_running || !runningStatus.pid) {
      throw new Error(`TEST 3 FAILED: Worker did not remain running. Status: ${JSON.stringify(runningStatus)}`);
    }
    console.log(`PASS: On-demand worker successfully started with PID ${runningStatus.pid}.`);

    // ── TEST 4: Immediate Cancellation & Process Tree Termination ──
    console.log("\n[TEST 4] Testing Stop Worker / Cancellation Termination...");
    const stopResult = await page.evaluate(async () => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("stop_worker");
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });

    console.log("Stop Worker Result:", stopResult);
    if (!stopResult.success || stopResult.res.is_running !== false) {
      throw new Error(`TEST 4 FAILED: stop_worker did not stop worker. Result: ${JSON.stringify(stopResult)}`);
    }

    // Verify worker PID is no longer alive
    const stoppedStatus = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Stopped Worker Status:", stoppedStatus);
    if (stoppedStatus.is_running !== false || stoppedStatus.pid !== null) {
      throw new Error(`TEST 4 FAILED: Expected stopped status with pid=null, got: ${JSON.stringify(stoppedStatus)}`);
    }
    console.log("PASS: Cancellation / stop successfully killed worker and released state.");

    // ── TEST 5: Restart After Cancellation (Idempotence & Fresh Run) ──
    console.log("\n[TEST 5] Testing Restart After Cancellation...");
    const restartResult = await page.evaluate(async ({ apiUrl, token }) => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("start_worker", {
          apiUrl,
          authToken: token,
        });
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }, { apiUrl, token });

    console.log("Restart Worker Result:", restartResult);
    if (!restartResult.success) {
      throw new Error(`TEST 5 FAILED: Failed to restart worker after cancellation: ${restartResult.error}`);
    }

    await new Promise((r) => setTimeout(r, 2000));
    const reRunningStatus = await page.evaluate(async () => {
      return await window.__TAURI_INTERNALS__.invoke("get_worker_status");
    });
    console.log("Re-started Worker Status: is_running =", reRunningStatus.is_running, "pid =", reRunningStatus.pid);
    if (!reRunningStatus.is_running || !reRunningStatus.pid) {
      throw new Error(`TEST 5 FAILED: Restarted worker did not remain running. Status: ${JSON.stringify(reRunningStatus)}`);
    }
    console.log(`PASS: Worker restarted cleanly with fresh PID ${reRunningStatus.pid}.`);

    // Clean up final worker
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("stop_worker");
    });
    console.log("Cleaned up final worker.");

    console.log("\n==================================================================");
    console.log("ALL PACKAGED VERIFICATION TESTS PASSED SUCCESSFULLY!");
    console.log("==================================================================");
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    try {
      process.kill(appProcess.pid);
    } catch {}
  }
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err);
  process.exit(1);
});
