/**
 * Constructs a high-resolution logo URL for a business website.
 * 
 * Uses the Mast high-resolution brand logo service (`/v1/discover/business-logo`),
 * which scrapes and caches real vector, high-DPI apple-touch-icon, and header brand assets.
 * Falls back to Google's 256px Favicon CDN if backend base URL is unavailable.
 */
export function getBusinessLogoUrl(websiteUrl?: string | null, size: number = 256): string | null {
  if (!websiteUrl || typeof websiteUrl !== "string") return null;
  const clean = websiteUrl.trim();
  if (!clean) return null;

  try {
    const withProto = clean.startsWith("http://") || clean.startsWith("https://") ? clean : `https://${clean}`;
    const parsed = new URL(withProto);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

    if (!host || host === "localhost" || host.endsWith(".test") || !host.includes(".")) {
      return null;
    }

    const apiEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : (process.env as Record<string, string | undefined>);
    const rawBase = (apiEnv?.VITE_API_BASE_URL || apiEnv?.VITE_API_URL || apiEnv?.VITE_BACKEND_URL) as string | undefined;
    const cleanBase = rawBase ? rawBase.trim().replace(/\/+$/, "") : "";

    if (cleanBase) {
      return `${cleanBase}/v1/discover/business-logo?url=${encodeURIComponent(withProto)}`;
    }

    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
  } catch {
    return null;
  }
}
