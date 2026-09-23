import { spawn } from "child_process";
import fs from "fs";
import os from "os";

const chromePath = fs.existsSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

console.log("Using browser:", chromePath);

const tempProfileDir = `${os.tmpdir()}/edge-cdp-${Date.now()}`;

const chromeProc = spawn(chromePath, [
  "--headless=new",
  "--remote-debugging-port=9222",
  `--user-data-dir=${tempProfileDir}`,
  "--window-size=1440,900",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "about:blank"
]);

async function run() {
  let pages = null;
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/list");
      pages = await res.json();
      if (pages && pages.length > 0 && pages[0].webSocketDebuggerUrl) {
        break;
      }
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!pages || !pages[0]?.webSocketDebuggerUrl) {
    throw new Error("Could not find page target in browser CDP");
  }

  const pageWsUrl = pages[0].webSocketDebuggerUrl;
  console.log("Connecting directly to page WebSocket:", pageWsUrl);
  const ws = new WebSocket(pageWsUrl);

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      console.error("PAGE EXCEPTION:", JSON.stringify(msg.params.exceptionDetails));
    } else if (msg.method === "Runtime.consoleAPICalled") {
      console.log("PAGE CONSOLE:", msg.params.args.map(a => a.value || a.description).join(" "));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    }
  };

  console.log("Navigating to http://localhost:5173/ ...");
  await send("Page.navigate", { url: "http://localhost:5173/" });

  console.log("Polling for app render...");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const evalRes = await send("Runtime.evaluate", {
        expression: "document.querySelector('h1')?.innerText || document.body.innerText.slice(0, 100)"
      });
      const val = evalRes?.result?.value;
      console.log(`Poll ${i+1}:`, val ? `Text found: "${val.slice(0, 60)}..."` : "Empty");
      if (val && val.length > 5) {
        break;
      }
    } catch (e) {
      console.log("Eval error:", e.message);
    }
  }

  // Extra wait for images to paint
  console.log("Waiting 3s for images and layout to settle...");
  await new Promise(r => setTimeout(r, 3000));

  console.log("Capturing screenshot...");
  const screenshot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 }
  });

  const buffer = Buffer.from(screenshot.data, "base64");
  fs.writeFileSync("landing_page_screenshot.png", buffer);
  console.log("Saved landing_page_screenshot.png (", buffer.length, "bytes)");

  ws.close();
  chromeProc.kill();
  process.exit(0);
}

run().catch(err => {
  console.error("Error:", err);
  chromeProc.kill();
  process.exit(1);
});
