import fs from "node:fs";
import { URL } from "node:url";
import { validateImapHost } from "./inboxHostValidator.js";
import {
  inspectWebsiteSnapshot,
  normalizeWebsiteUrl,
  type WebsiteSnapshot,
} from "./leadInvestigate.js";

export interface WebsiteAuditResult {
  websiteUrl: string | null;
  screenshotDataUrl: string | null;
  screenshotAvailable: boolean;
  visualSummary: string;
  auditBullets: string[];
  uxFindings: string[];
  mode: "ai_vision" | "ai_text" | "verified_data";
  checkedAt: string;
  cached?: boolean;
}

const SCREENSHOT_TIMEOUT_MS = 9_000;

function detectBrowserExecutablePath(): string | null {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
          ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Captures a compressed 1280x800 homepage screenshot via puppeteer-core if a
 * local Chrome/Edge/Chromium binary is installed. Enforces SSRF host checks
 * before navigation and aborts private/local sub-navigations. Returns null
 * cleanly if headless browser capture is unavailable in the host environment.
 */
export async function captureWebsiteScreenshot(
  rawUrl: string | null | undefined,
  deps: { validateHost?: typeof validateImapHost } = {},
): Promise<string | null> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized) return null;

  const executablePath = detectBrowserExecutablePath();
  if (!executablePath) return null;

  const validateHost = deps.validateHost ?? validateImapHost;
  try {
    const parsed = new URL(normalized);
    await validateHost(parsed.hostname);
  } catch {
    return null;
  }

  let browser: any = null;
  try {
    const puppeteerMod: any = await import("puppeteer-core");
    const puppeteer = puppeteerMod.default ?? puppeteerMod;
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");

    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const reqUrl = req.url();
      if (req.isNavigationRequest()) {
        try {
          const u = new URL(reqUrl);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            void req.abort();
            return;
          }
          if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/i.test(u.hostname)) {
            void req.abort();
            return;
          }
        } catch {
          void req.abort();
          return;
        }
      }
      const resourceType = req.resourceType();
      if (resourceType === "media" || resourceType === "websocket") {
        void req.abort();
        return;
      }
      void req.continue();
    });

    await page.goto(normalized, {
      waitUntil: "domcontentloaded",
      timeout: SCREENSHOT_TIMEOUT_MS,
    });
    // Allow brief layout/font settle without delaying UX
    await new Promise((resolve) => setTimeout(resolve, 600));

    const b64 = await page.screenshot({
      type: "jpeg",
      quality: 68,
      encoding: "base64",
      fullPage: false,
    });

    if (typeof b64 === "string" && b64.length > 0) {
      return `data:image/jpeg;base64,${b64}`;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

export function deriveUxFindings(params: {
  businessName: string;
  websiteUrl: string | null;
  snapshot: WebsiteSnapshot;
  sslValid?: boolean | null;
  loadTimeMs?: number | null;
  websiteIsWeak?: boolean | null;
  reviewsCount?: number | null;
  reviewsRating?: number | null;
  hasInstagram?: boolean;
}): { uxFindings: string[]; auditBullets: string[]; visualSummary: string } {
  const {
    businessName,
    websiteUrl,
    snapshot,
    sslValid,
    loadTimeMs,
    websiteIsWeak,
    reviewsCount,
    reviewsRating,
    hasInstagram,
  } = params;

  const uxFindings: string[] = [];
  const auditBullets: string[] = [];

  if (!websiteUrl) {
    uxFindings.push("No official website listed on record.");
    auditBullets.push("No active business website is linked yet, making it harder for local searchers to check services and trust before calling.");
    if (reviewsCount && reviewsRating) {
      auditBullets.push(`Strong ${reviewsRating}★ reputation across ${reviewsCount} reviews isn't being showcased on a dedicated site yet.`);
    }
    if (!hasInstagram) {
      auditBullets.push("No Instagram profile is linked alongside their listing to build visual proof.");
    }
    return {
      uxFindings,
      auditBullets: auditBullets.slice(0, 5),
      visualSummary: `${businessName} currently has no official website on record, creating a clear opportunity for a clean conversion-focused homepage.`,
    };
  }

  if (sslValid === false || (snapshot.checked && !snapshot.https)) {
    uxFindings.push("Website is missing valid HTTPS/SSL encryption.");
    auditBullets.push("Site does not appear to enforce HTTPS/SSL cleanly, which triggers browser 'Not Secure' warnings for visitors.");
  }

  if (snapshot.checked && !snapshot.hasMobileViewport) {
    uxFindings.push("Missing mobile viewport meta tag on homepage.");
    auditBullets.push("Homepage is missing a mobile viewport configuration, which can cause cramped layouts and pinch-zooming on phones.");
  }

  if (loadTimeMs != null && loadTimeMs >= 3000) {
    uxFindings.push(`Stored page load time is ${(loadTimeMs / 1000).toFixed(1)}s.`);
    auditBullets.push(`Measured page load time is around ${(loadTimeMs / 1000).toFixed(1)}s, which risks losing mobile visitors before the page finishes loading.`);
  }

  if (snapshot.checked && snapshot.bookingTools.length === 0) {
    uxFindings.push("No online booking widget detected on homepage.");
    auditBullets.push(
      snapshot.hasContactForm
        ? "Homepage has a basic form but no instant online booking tool, adding friction for ready-to-book visitors."
        : "No online booking widget or clear inquiry form was detected on the homepage, making it harder to capture leads after hours.",
    );
  }

  if (snapshot.checked && snapshot.analyticsTools.length === 0) {
    uxFindings.push("No Google Analytics / Tag Manager or Meta Pixel detected.");
    auditBullets.push("No conversion tracking (Google Analytics or Meta Pixel) was detected, leaving ad and traffic ROI blind.");
  }

  if (snapshot.checked && !snapshot.metaDescription) {
    uxFindings.push("Missing homepage meta description tag.");
    auditBullets.push("Homepage is missing a meta description, reducing control over how the business appears in Google search results.");
  }

  if (snapshot.checked && snapshot.cmsOrTech.length > 0) {
    uxFindings.push(`Detected web platform: ${snapshot.cmsOrTech.join(", ")}.`);
  }

  if (!hasInstagram && snapshot.socialLinks.length === 0) {
    uxFindings.push("No social media links detected on homepage.");
    auditBullets.push("No active social profile links were found on the homepage to reinforce local credibility.");
  }

  if (websiteIsWeak && auditBullets.length < 2) {
    uxFindings.push("Flagged by MAST scoring engine as having website improvement opportunity.");
    auditBullets.push("Overall site structure signals room for a cleaner layout and clearer above-the-fold call to action.");
  }

  if (auditBullets.length === 0) {
    auditBullets.push("Homepage responded cleanly; focus outreach on conversion flow, clearer above-the-fold offer, or local SEO visibility.");
  }

  const summaryBits: string[] = [];
  if (snapshot.checked) {
    summaryBits.push(
      snapshot.cmsOrTech.length > 0
        ? `Inspected ${snapshot.finalUrl || websiteUrl} (${snapshot.cmsOrTech.join(", ")})`
        : `Inspected ${snapshot.finalUrl || websiteUrl}`,
    );
  } else {
    summaryBits.push(`Evaluated stored telemetry for ${websiteUrl}`);
  }
  if (uxFindings.length > 0) {
    summaryBits.push(`key gaps include ${uxFindings.slice(0, 2).join(" and ").toLowerCase()}`);
  }

  return {
    uxFindings,
    auditBullets: auditBullets.slice(0, 5),
    visualSummary: `${summaryBits.join("; ")}.`,
  };
}

export async function collectWebsiteAuditInputs(params: {
  businessName: string;
  websiteUrl: string | null;
  sslValid?: boolean | null;
  loadTimeMs?: number | null;
  websiteIsWeak?: boolean | null;
  reviewsCount?: number | null;
  reviewsRating?: number | null;
  hasInstagram?: boolean;
  skipScreenshot?: boolean;
  inspectFn?: typeof inspectWebsiteSnapshot;
  screenshotFn?: typeof captureWebsiteScreenshot;
}) {
  const inspectFn = params.inspectFn ?? inspectWebsiteSnapshot;
  const screenshotFn = params.screenshotFn ?? captureWebsiteScreenshot;

  const [snapshot, screenshotDataUrl] = await Promise.all([
    inspectFn(params.websiteUrl),
    params.skipScreenshot ? Promise.resolve(null) : screenshotFn(params.websiteUrl),
  ]);

  const deterministic = deriveUxFindings({
    businessName: params.businessName,
    websiteUrl: params.websiteUrl,
    snapshot,
    sslValid: params.sslValid,
    loadTimeMs: params.loadTimeMs,
    websiteIsWeak: params.websiteIsWeak,
    reviewsCount: params.reviewsCount,
    reviewsRating: params.reviewsRating,
    hasInstagram: params.hasInstagram,
  });

  return { snapshot, screenshotDataUrl, deterministic };
}
