import { isDesktopApp, openDesktopChromePopup } from "@/lib/desktop";

export interface ExternalPopupResult {
  opened: boolean;
  mode: "desktop_chrome_popup" | "browser_popup" | "blocked" | "invalid";
  url: string | null;
}

export function normalizeExternalHttpUrl(raw?: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (/^(javascript|data|vbscript|file|mailto|tel):/i.test(trimmed)) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildGmailComposeUrl(params: {
  to: string;
  subject?: string;
  body?: string;
}): string {
  const qs = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: params.to.trim(),
  });
  if (params.subject) qs.set("su", params.subject);
  if (params.body) qs.set("body", params.body);
  return `https://mail.google.com/mail/?${qs.toString()}`;
}

export function buildMailtoUrl(params: {
  to: string;
  subject?: string;
  body?: string;
}): string {
  const qs = new URLSearchParams();
  if (params.subject) qs.set("subject", params.subject);
  if (params.body) qs.set("body", params.body);
  const query = qs.toString();
  return `mailto:${params.to.trim()}${query ? `?${query}` : ""}`;
}

/**
 * Opens an external URL:
 * - Inside the Tauri desktop app: launches Google Chrome `--app=<url>` popup window
 *   using the user's normal signed-in Chrome profile (fallback to OS default browser).
 * - On the website: opens a normal browser tab synchronously on click.
 */
export function openExternalPopup(rawUrl: string): ExternalPopupResult {
  const url = normalizeExternalHttpUrl(rawUrl);
  if (!url) {
    return { opened: false, mode: "invalid", url: null };
  }

  if (isDesktopApp()) {
    void openDesktopChromePopup(url).then((ok) => {
      if (!ok && typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    });
    return { opened: true, mode: "desktop_chrome_popup", url };
  }

  if (typeof window === "undefined") {
    return { opened: false, mode: "blocked", url };
  }

  const tab = window.open(url, "_blank", "noopener,noreferrer");
  if (!tab || tab.closed || typeof tab.closed === "undefined") {
    return { opened: false, mode: "blocked", url };
  }

  return { opened: true, mode: "browser_popup", url };
}

export function openGmailComposePopup(params: {
  to: string;
  subject?: string;
  body?: string;
}): ExternalPopupResult {
  return openExternalPopup(buildGmailComposeUrl(params));
}
