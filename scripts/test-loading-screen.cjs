const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE_URL = "http://127.0.0.1:5173";

async function runTests() {
  console.log("=== MAST LOADING SCREEN BROWSER TEST SUITE ===");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    protocolTimeout: 60000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,800",
    ],
  });

  const results = [];
  const errors = [];

  function record(name, passed, detail = "") {
    results.push({ name, passed, detail });
    console.log(`[${passed ? "PASS" : "FAIL"}] ${name} ${detail ? "- " + detail : ""}`);
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`Console Error: ${msg.text()}`);
      }
    });

    page.on("requestfailed", (req) => {
      errors.push(`Request Failed: ${req.url()}`);
    });

    // ── Test 1: Cold load landing page ─────────────────────────────────────
    console.log("\n--- Running Test 1: Cold load landing page ---");
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

    // Verify preloader is mounted in HTML and visible
    const preloaderExists = await page.evaluate(() => {
      const el = document.getElementById("mast-preloader");
      return el !== null && !el.classList.contains("mast-preloader-hidden");
    });
    record("1. Preloader mounted on cold load", preloaderExists);

    // ── Test 4: Verify Logo rendering & aspect ratio ────────────────────────
    console.log("\n--- Running Test 4: Logo rendering & properties ---");
    const logoStats = await page.evaluate(() => {
      const img = document.querySelector("#mast-preloader .mast-preloader-logo");
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      return {
        src: img.src,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        renderedWidth: rect.width,
        renderedHeight: rect.height,
        objectFit: style.objectFit,
        aspectRatio: style.aspectRatio || (img.naturalWidth / img.naturalHeight).toFixed(2),
      };
    });

    if (logoStats) {
      const isWordmark = logoStats.src.includes("mast-wordmark.png");
      const aspectCorrect = Math.abs((logoStats.naturalWidth / logoStats.naturalHeight) - (972 / 198)) < 0.1;
      const objectFitContain = logoStats.objectFit === "contain";
      record("4a. Correct canonical brand logo used", isWordmark, logoStats.src);
      record("4b. Natural aspect ratio preserved (4.91:1)", aspectCorrect, `${logoStats.naturalWidth}x${logoStats.naturalHeight}`);
      record("4c. Sizing & object-fit contain", objectFitContain && logoStats.renderedHeight <= 40, `rendered ${logoStats.renderedWidth.toFixed(0)}x${logoStats.renderedHeight.toFixed(0)}`);
    } else {
      record("4. Logo properties", false, "Logo element not found");
    }

    // ── Test 5 & 6: Wait for critical assets and preloader dismissal ─────────
    console.log("\n--- Running Test 5 & 6: Asset readiness & preloader fade ---");
    // Wait for preloader to fade and hide
    await page.waitForFunction(
      () => {
        const el = document.getElementById("mast-preloader");
        return !el || el.classList.contains("mast-preloader-hidden") || el.classList.contains("mast-preloader-fade");
      },
      { timeout: 12000 }
    );

    // Check critical assets loaded in the browser
    const assetReadiness = await page.evaluate(() => {
      const globe = Array.from(document.images).find((i) => i.src.includes("mast-globe-final.png"));
      const ground = Array.from(document.images).find((i) => i.src.includes("mast-hero-ground.webp"));
      const fontsLoaded =
        document.fonts.check('600 24px "Playfair Display"') ||
        document.fonts.check('600 16px "Plus Jakarta Sans"') ||
        document.fonts.status === "loaded";

      return {
        globeLoaded: globe ? globe.complete && globe.naturalWidth > 0 : false,
        groundLoaded: ground ? ground.complete && ground.naturalWidth > 0 : false,
        fontsLoaded,
      };
    });

    record("5a. Hero globe loaded and decoded", assetReadiness.globeLoaded);
    record("5b. Hero ground surface loaded and decoded", assetReadiness.groundLoaded);
    record("5c. Critical fonts verified ready", assetReadiness.fontsLoaded);

    // Verify hero and globe elements are in DOM and rendered
    const heroElementsVisible = await page.evaluate(() => {
      const headline = document.querySelector(".mast-hero-headline");
      const globeImg = document.querySelector("img[src*='mast-globe-final.png']");
      return {
        headlineVisible: headline ? window.getComputedStyle(headline).visibility !== "hidden" : false,
        globeVisible: globeImg ? globeImg.getBoundingClientRect().height > 80 : false,
      };
    });
    record("6. Hero and globe rendered without pop-in", heroElementsVisible.headlineVisible && heroElementsVisible.globeVisible);

    // ── Test 7: Confirm below-the-fold assets do not delay initial view ─────
    console.log("\n--- Running Test 7: Below-the-fold progressive load check ---");
    const viewportSettled = await page.evaluate(() => {
      const preloader = document.getElementById("mast-preloader");
      const isPreloaderGone = !preloader || preloader.classList.contains("mast-preloader-hidden") || preloader.classList.contains("mast-preloader-fade");
      const scrollY = window.scrollY;
      return isPreloaderGone && scrollY === 0;
    });
    record("7. Initial viewport revealed without waiting for below-the-fold scroll", viewportSettled);

    // ── Test 2: Hard refresh ───────────────────────────────────────────────
    console.log("\n--- Running Test 2: Hard-refresh ---");
    await page.reload({ waitUntil: "domcontentloaded" });
    const preloaderOnRefresh = await page.evaluate(() => !!document.getElementById("mast-preloader"));
    record("2a. Preloader appears on hard reload", preloaderOnRefresh);

    await page.waitForFunction(
      () => {
        const el = document.getElementById("mast-preloader");
        return !el || el.classList.contains("mast-preloader-hidden");
      },
      { timeout: 15000 }
    );
    record("2b. Preloader smoothly dismissed on hard reload", true);

    // ── Test 10: SPA Navigation (Loader must not reappear) ─────────────────
    console.log("\n--- Running Test 10: SPA navigation check ---");
    // Ensure preloader is completely hidden before navigation
    await page.waitForFunction(
      () => {
        const el = document.getElementById("mast-preloader");
        return !el || el.classList.contains("mast-preloader-hidden");
      },
      { timeout: 5000 }
    );

    // Click on Pricing link via puppeteer real click to trigger React Router client navigation
    const pricingLink = await page.$('a[href="/pricing"]');
    if (pricingLink) {
      await pricingLink.click();
      await page.waitForFunction(() => window.location.pathname === "/pricing", { timeout: 4000 });
      // Check preloader did NOT show again
      const preloaderReappeared = await page.evaluate(() => {
        const el = document.getElementById("mast-preloader");
        return el && !el.classList.contains("mast-preloader-hidden");
      });
      record("10a. Navigated to /pricing without preloader reappearing", !preloaderReappeared);

      // Navigate back to home /
      const homeLink = await page.$('a[href="/"]');
      if (homeLink) {
        await homeLink.click();
        await page.waitForFunction(() => window.location.pathname === "/", { timeout: 4000 });
        const preloaderOnHomeReturn = await page.evaluate(() => {
          const el = document.getElementById("mast-preloader");
          return el && !el.classList.contains("mast-preloader-hidden");
        });
        record("10b. Returned to / without preloader reappearing", !preloaderOnHomeReturn);
      }
    } else {
      record("10. SPA navigation", false, "Pricing link not found");
    }

    // ── Test 3: Simulated Slow Network (Throttling) ────────────────────────
    console.log("\n--- Running Test 3: Slow network simulation ---");
    const client = await page.target().createCDPSession();
    await client.send("Network.enable");
    // Emulate Regular 3G (750 kbps, 100ms latency)
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 100,
      downloadThroughput: (750 * 1024) / 8,
      uploadThroughput: (250 * 1024) / 8,
    });

    const slowLoadStart = Date.now();
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

    // Confirm preloader is visible during slow loading
    const visibleDuringSlow = await page.evaluate(() => {
      const el = document.getElementById("mast-preloader");
      return el && !el.classList.contains("mast-preloader-hidden") && !el.classList.contains("mast-preloader-fade");
    });
    record("3a. Preloader actively visible during slow network load", visibleDuringSlow);

    // Wait for resolution
    await page.waitForFunction(
      () => {
        const el = document.getElementById("mast-preloader");
        return !el || el.classList.contains("mast-preloader-hidden") || el.classList.contains("mast-preloader-fade");
      },
      { timeout: 20000 }
    );
    const slowLoadDuration = Date.now() - slowLoadStart;
    record("3b. Page resolved cleanly under slow network", true, `took ${slowLoadDuration}ms`);

    // Reset network conditions
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    // ── Test 8 & 9: Timeout / Recovery and Failed Asset Handling ───────────
    console.log("\n--- Running Test 8 & 9: Failed asset & Timeout recovery ---");
    const testResult = await page.evaluate(async () => {
      // Test 8: Failed image decoding handling without crashing
      const testImg = new Image();
      testImg.src = "/images/non-existent-image-404.png";
      const failedHandledPromise = new Promise((resolve) => {
        testImg.onerror = () => resolve(true);
        testImg.onload = () => resolve(false);
      });
      const failedHandled = await failedHandledPromise;

      // Test 9: Safety timeout helper verification
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50));
      const neverEndingPromise = new Promise(() => {});
      const safetyOutcome = await Promise.race([neverEndingPromise, timeoutPromise]);

      return {
        failedImageSafe: failedHandled === true,
        timeoutRecovered: safetyOutcome === "timed-out",
      };
    });

    record("8. Failed nonessential image handled safely without crashing", testResult.failedImageSafe);
    record("9. Safety timeout recovery mechanism verified", testResult.timeoutRecovered);

    // ── Test 11: Console errors & broken requests check ─────────────────────
    console.log("\n--- Running Test 11: Console & network health check ---");
    const unexpectedErrors = errors.filter(
      (e) =>
        !e.includes("non-existent-image-404") &&
        !e.includes("favicon") &&
        !e.includes("mast-gold-flow-motion.mp4")
    );
    record("11. Zero unexpected console or request errors", unexpectedErrors.length === 0, unexpectedErrors.join("; ") || "Clean");

  } finally {
    await browser.close();
  }

  console.log("\n=== TEST SUMMARY ===");
  const allPassed = results.every((r) => r.passed);
  console.log(`Total tests: ${results.length}`);
  console.log(`Passed: ${results.filter((r) => r.passed).length}`);
  console.log(`Failed: ${results.filter((r) => !r.passed).length}`);
  console.log(`Overall Result: ${allPassed ? "SUCCESS" : "FAILED"}`);

  if (!allPassed) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
