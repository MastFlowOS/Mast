import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const chromePath = fs.existsSync("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

console.log("Using browser:", chromePath);

const tempProfileDir = path.join(os.tmpdir(), `edge-cdp-${Date.now()}`);

const chromeProc = spawn(chromePath, [
  "--headless=new",
  "--remote-debugging-port=9223",
  `--user-data-dir=${tempProfileDir}`,
  "--window-size=1536,900",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "about:blank"
]);

async function run() {
  let pages = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9223/json/list");
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
  console.log("Connecting to page WebSocket:", pageWsUrl);
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

  const outputDir = path.resolve("./navbar-validation-screenshots");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const viewports = [
    { name: "desktop-1536px", width: 1536, height: 900, mobile: false },
    { name: "tablet-768px", width: 768, height: 1024, mobile: false },
    { name: "mobile-390px", width: 390, height: 844, mobile: true }
  ];

  const scrollPositions = [
    { label: "top-0px", y: 0 },
    { label: "scroll-100px", y: 100 },
    { label: "scroll-500px", y: 500 }
  ];

  console.log("Navigating to http://localhost:4173/ ...");
  await send("Page.navigate", { url: "http://localhost:4173/" });

  // Wait for initial render
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 400));
    const evalRes = await send("Runtime.evaluate", {
      expression: "document.querySelector('h1')?.innerText || ''"
    });
    if (evalRes?.result?.value) {
      console.log("App mounted:", evalRes.result.value.slice(0, 40));
      break;
    }
  }

  await new Promise(r => setTimeout(r, 2000));

  for (const vp of viewports) {
    console.log(`Setting viewport: ${vp.name} (${vp.width}x${vp.height})`);
    await send("Emulation.setDeviceMetricsOverride", {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.mobile
    });
    await new Promise(r => setTimeout(r, 600));

    for (const pos of scrollPositions) {
      console.log(`Scrolling to Y=${pos.y} on ${vp.name}`);
      await send("Runtime.evaluate", {
        expression: `window.scrollTo(0, ${pos.y}); window.dispatchEvent(new Event('scroll'));`
      });
      // Allow 700ms for smooth CSS transitions (duration-500) to settle
      await new Promise(r => setTimeout(r, 800));

      const filename = `nav-${vp.name}-${pos.label}.png`;
      const filepath = path.join(outputDir, filename);

      const screenshot = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 450), scale: 1 }
      });

      const buffer = Buffer.from(screenshot.data, "base64");
      fs.writeFileSync(filepath, buffer);
      console.log(`Saved screenshot: ${filename} (${buffer.length} bytes)`);
    }
  }

  console.log("All validation screenshots captured successfully!");
  ws.close();
  chromeProc.kill();
  process.exit(0);
}

run().catch(err => {
  console.error("Error during validation:", err);
  try { chromeProc.kill(); } catch {}
  process.exit(1);
});
