import { URL } from "node:url";

export interface LogoCacheEntry {
  logoUrl: string;
  expiresAt: number;
}

const LOGO_CACHE = new Map<string, LogoCacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 5000;

function isPrivateIpOrHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".test") ||
    lower.endsWith(".internal")
  ) {
    return true;
  }
  // IPv4 checks
  if (/^127\./.test(lower) || /^10\./.test(lower) || /^192\.168\./.test(lower) || /^169\.254\./.test(lower)) {
    return true;
  }
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower)) {
    return true;
  }
  // IPv6 checks
  if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) {
    return true;
  }
  return false;
}

/**
 * Extracts the highest-resolution official business logo from raw HTML.
 */
export function extractLogoFromHtml(html: string, baseUrl: string): string | null {
  if (!html || typeof html !== "string") return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  function cleanAndResolve(rawUrl: string): string {
    let resolved = rawUrl.trim();
    if (resolved.startsWith("//")) {
      resolved = `${base.protocol}${resolved}`;
    } else {
      try {
        resolved = new URL(resolved, base.origin).href;
      } catch {
        // Keep rawUrl if resolution fails
      }
    }

    // GoDaddy / wsimg: strip downsizing parameter to get master high-res original
    if (resolved.includes("wsimg.com") && resolved.includes("/:/rs=")) {
      resolved = resolved.replace(/\/:.*$/, "");
    }

    // Shopify: remove thumbnail modifiers (_small, _medium, _compact, _thumb)
    if (resolved.includes("cdn.shopify.com")) {
      resolved = resolved.replace(/_(small|medium|compact|thumb|pico)(\.[a-z0-9]+)(\?.*)?$/i, "$2$3");
    }

    // Squarespace: upgrade low-width query format to 1500w for ultra sharpness
    if (resolved.includes("squarespace-cdn.com") || resolved.includes("static1.squarespace.com")) {
      if (/format=\d+w/i.test(resolved)) {
        resolved = resolved.replace(/format=\d+w/i, "format=1500w");
      }
    }

    return resolved;
  }

  // 1. Header logo images (often the crisp master SVG or PNG brand logo)
  const headerMatch = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i);
  if (headerMatch) {
    const headerHtml = headerMatch[1];
    const imgMatches = Array.from(headerHtml.matchAll(/<img\b[^>]+src=["']([^"']+)["'][^>]*>/gi));
    for (const match of imgMatches) {
      const fullImgTag = match[0];
      const src = match[1];
      if (/logo|brand/i.test(fullImgTag) || /logo|brand/i.test(src)) {
        return cleanAndResolve(src);
      }
    }

    const homeLinkImg = headerHtml.match(
      /<a\b[^>]+href=["'](?:\/|https?:\/\/[^"']*)["'][^>]*>\s*<img\b[^>]+src=["']([^"']+)["']/i,
    );
    if (homeLinkImg && homeLinkImg[1]) {
      return cleanAndResolve(homeLinkImg[1]);
    }
  }

  // 2. Look for any <img> with class, id, or alt containing "logo" or "brand"
  const logoImgMatches = Array.from(
    html.matchAll(/<img\b[^>]*\b(?:class|id|alt)=["'][^"']*\b(?:logo|brand)\b[^"']*["'][^>]*\bsrc=["']([^"']+)["']/gi),
  );
  if (logoImgMatches.length > 0 && logoImgMatches[0][1]) {
    return cleanAndResolve(logoImgMatches[0][1]);
  }

  const logoImgMatches2 = Array.from(
    html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\b(?:class|id|alt)=["'][^"']*\b(?:logo|brand)\b[^"']*["']/gi),
  );
  if (logoImgMatches2.length > 0 && logoImgMatches2[0][1]) {
    return cleanAndResolve(logoImgMatches2[0][1]);
  }

  // 3. Apple touch icon (almost universally 180x180 or 512x512 square high-DPI logo)
  const appleTouchMatch =
    html.match(/<link\b[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<link\b[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon(?:-precomposed)?["']/i);
  if (appleTouchMatch && appleTouchMatch[1]) {
    return cleanAndResolve(appleTouchMatch[1]);
  }

  // 4. Schema.org JSON-LD Organization logo
  const jsonLdMatches = Array.from(html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  for (const jsonLd of jsonLdMatches) {
    try {
      const parsed = JSON.parse(jsonLd[1]);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.logo === "string") return cleanAndResolve(parsed.logo);
        if (parsed.logo?.url && typeof parsed.logo.url === "string") return cleanAndResolve(parsed.logo.url);
        if (Array.isArray(parsed["@graph"])) {
          for (const item of parsed["@graph"]) {
            if (typeof item?.logo === "string") return cleanAndResolve(item.logo);
            if (item?.logo?.url && typeof item.logo.url === "string") return cleanAndResolve(item.logo.url);
          }
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 5. OpenGraph image (og:image) - high-res brand banner / logo
  const ogMatch =
    html.match(/<meta\b[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta\b[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch && ogMatch[1]) {
    return cleanAndResolve(ogMatch[1]);
  }

  return null;
}

/**
 * Resolves a high-resolution logo for a business URL.
 * Checks memory cache first (0ms), then attempts lightweight scraping,
 * falling back to Google Favicon 256px on failure.
 */
export async function resolveBusinessLogo(targetUrl: string): Promise<string> {
  const clean = targetUrl.trim();
  const withProto = clean.startsWith("http://") || clean.startsWith("https://") ? clean : `https://${clean}`;

  let parsed: URL;
  try {
    parsed = new URL(withProto);
  } catch {
    return `https://www.google.com/s2/favicons?domain=example.com&sz=256`;
  }

  const hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const fallbackFavicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=256`;

  if (!hostname || isPrivateIpOrHost(hostname) || !hostname.includes(".")) {
    return fallbackFavicon;
  }

  // Check cache
  const cached = LOGO_CACHE.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.logoUrl;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(parsed.href, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      // Read first 512KB of HTML
      const reader = res.body?.getReader();
      let html = "";
      if (reader) {
        const decoder = new TextDecoder();
        let bytesRead = 0;
        const maxBytes = 512 * 1024;
        while (bytesRead < maxBytes) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          html += decoder.decode(value, { stream: true });
          bytesRead += value.byteLength;
        }
        reader.cancel().catch(() => {});
      } else {
        html = await res.text();
      }

      const extracted = extractLogoFromHtml(html, parsed.href);
      if (extracted) {
        if (LOGO_CACHE.size >= MAX_CACHE_SIZE) {
          const firstKey = LOGO_CACHE.keys().next().value;
          if (firstKey) LOGO_CACHE.delete(firstKey);
        }
        LOGO_CACHE.set(hostname, {
          logoUrl: extracted,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return extracted;
      }
    }
  } catch {
    // Silently fall back to Google Favicon
  }

  // Cache fallback for 1 hour so we don't spam failed domains repeatedly
  LOGO_CACHE.set(hostname, {
    logoUrl: fallbackFavicon,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  return fallbackFavicon;
}
