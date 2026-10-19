const { spawn } = require("node:child_process");
const http = require("node:http");
const puppeteer = require("puppeteer-core");

const APP_PATH = "C:\\Users\\Beboo\\AppData\\Local\\MAST\\mast-desktop.exe";
const PORT = 9222;

function waitForCdpReady(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      }).on("error", () => {
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
  console.log("=== VERIFYING PACKAGED MAST DESKTOP APP ===");
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

  try {
    console.log("Waiting for WebView2 DevTools Protocol on port", PORT);
    await waitForCdpReady(20000);
    console.log("CDP ready! Connecting via puppeteer-core...");

    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${PORT}`,
    });

    const pages = await browser.pages();
    const page = pages[0];
    console.log("Connected! Page title:", await page.title(), "URL:", page.url());

    // ── Test 1: get_worker_status on local origin ─────────────────────────────
    console.log("\n[TEST 1] Testing get_worker_status on local origin...");
    const localStatus = await page.evaluate(async () => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("get_worker_status");
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });
    console.log("Result on local origin:", JSON.stringify(localStatus, null, 2));

    // ── Test 2: get_desktop_info on local origin ──────────────────────────────
    console.log("\n[TEST 2] Testing get_desktop_info on local origin...");
    const localInfo = await page.evaluate(async () => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("get_desktop_info");
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });
    console.log("Result on local origin:", JSON.stringify(localInfo, null, 2));

    // ── Test 3: Navigate to remote origin and test worker commands ─────────────
    console.log("\n[TEST 3] Navigating to remote origin https://mast-flow.vercel.app/dashboard/leads ...");
    await page.goto("https://mast-flow.vercel.app/dashboard/leads", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    console.log("Current page URL:", page.url());

    // Wait a brief moment for React and bridge to attach
    await new Promise((r) => setTimeout(r, 2000));

    console.log("\n[TEST 4] Testing get_worker_status on remote origin...");
    const remoteStatus = await page.evaluate(async () => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("get_worker_status");
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });
    console.log("Result on remote origin:", JSON.stringify(remoteStatus, null, 2));

    console.log("\n[TEST 5] Testing get_desktop_info on remote origin...");
    const remoteInfo = await page.evaluate(async () => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("get_desktop_info");
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });
    console.log("Result on remote origin:", JSON.stringify(remoteInfo, null, 2));

    console.log("\n[TEST 6] Testing stop_worker on remote origin...");
    const remoteStop = await page.evaluate(async () => {
      try {
        const res = await window.__TAURI_INTERNALS__.invoke("stop_worker");
        return { success: true, res };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    });
    console.log("Result on remote origin:", JSON.stringify(remoteStop, null, 2));

    // ── Assertions ────────────────────────────────────────────────────────────
    let failed = false;
    if (!localStatus.success) {
      console.error("FAIL: local get_worker_status failed:", localStatus.error);
      failed = true;
    }
    if (!remoteStatus.success) {
      console.error("FAIL: remote get_worker_status failed:", remoteStatus.error);
      failed = true;
    }
    if (!remoteInfo.success) {
      console.error("FAIL: remote get_desktop_info failed:", remoteInfo.error);
      failed = true;
    }
    if (!remoteStop.success) {
      console.error("FAIL: remote stop_worker failed:", remoteStop.error);
      failed = true;
    }

    if (remoteStatus.error?.includes("not allowed by ACL") || localStatus.error?.includes("not allowed by ACL")) {
      console.error("FAIL: ACL permission error detected!");
      failed = true;
    }

    if (!failed) {
      console.log("\n=======================================================");
      console.log(">>> ALL TAURI PACKAGED APP TESTS PASSED SUCCESSFULLY! <<<");
      console.log("=======================================================\n");
    }

    browser.disconnect();
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error("Error during verification:", err);
    process.exit(1);
  } finally {
    try {
      appProcess.kill();
    } catch {}
  }
}

run();
