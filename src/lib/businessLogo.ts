/**
 * Constructs a high-resolution logo/favicon URL for a business website using
 * Google's global Favicon / Brand CDN.
 * 
 * Works with zero backend latency, zero external API keys, and has 99.9% uptime.
 * Size 128px provides crisp high-DPI rendering for avatars up to 64x64px.
 */
export function getBusinessLogoUrl(websiteUrl?: string | null, size: number = 128): string | null {
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
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
  } catch {
    return null;
  }
}
