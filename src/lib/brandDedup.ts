import { normalizeInstagram } from "./instagram.js";

/**
 * Shared generic platforms, directory sites, and social networks that multiple
 * distinct independent businesses can link to as their "website".
 * These domains must NEVER be used for brand-level deduplication.
 */
const GENERIC_OR_SHARED_DOMAINS = new Set<string>([
  // Social media
  "facebook.com",
  "fb.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
  "pinterest.com",
  "threads.net",

  // Review & directory portals
  "yelp.com",
  "yelp.co.uk",
  "yelp.ca",
  "yelp.com.au",
  "tripadvisor.com",
  "yellowpages.com",
  "foursquare.com",
  "zomato.com",
  "trustpilot.com",
  "bbb.org",

  // Search & maps
  "google.com",
  "maps.google.com",
  "sites.google.com",
  "business.site",
  "apple.com",
  "bing.com",

  // Bio link aggregators
  "linktr.ee",
  "linktree.com",
  "bio.link",
  "beacons.ai",
  "carrd.co",

  // Generic ordering & booking aggregators
  "opentable.com",
  "resy.com",
  "toasttab.com",
  "singleplatform.com",
  "chownow.com",
  "clover.com",
  "menufy.com",
  "popmenu.com",
  "order.online",
  "square.site",
  "squareup.com",
  "grubhub.com",
  "doordash.com",
  "ubereats.com",
  "booksy.com",
  "vagaro.com",

  // Generic site builders without custom domain
  "wixsite.com",
  "weebly.com",
  "wordpress.com",
  "blogspot.com",
  "myshopify.com",
]);

/**
 * Normalizes a website URL to a clean root domain for brand-level deduplication.
 * Returns null if URL is empty, invalid, or belongs to a generic shared platform.
 */
export function normalizeBrandDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let url = raw.trim().toLowerCase();
  if (!url) return null;

  // Strip protocol
  url = url.replace(/^https?:\/\//i, "");
  // Strip www.
  url = url.replace(/^www\./i, "");
  // Extract hostname up to port, path, query, or hash
  url = url.split(/[/?:#]/)[0] ?? "";
  // Strip trailing dots/slashes
  url = url.replace(/[./]+$/, "");

  if (!url || !url.includes(".")) return null;

  // Check if this domain matches any generic shared platform
  for (const generic of GENERIC_OR_SHARED_DOMAINS) {
    if (url === generic || url.endsWith(`.${generic}`)) {
      return null;
    }
  }

  return url;
}

/**
 * Normalizes an Instagram string (URL, handle, or @handle) to a clean lowercase username.
 * Returns null if empty, invalid, or non-handle path (e.g. reels, explore).
 */
export function normalizeBrandInstagram(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const parsed = normalizeInstagram(raw);
  if (!parsed || !parsed.handle) return null;
  const handle = parsed.handle.trim().toLowerCase();
  return handle || null;
}

/**
 * Extracts normalized brand identifiers from business/lead records or fingerprint arrays.
 */
export function extractBrandFingerprints(biz: {
  website?: string | null;
  instagram?: string | null;
  fingerprints?: string[] | null;
}): { domain: string | null; instagram: string | null } {
  let domain: string | null = null;
  let instagram: string | null = null;

  if (Array.isArray(biz.fingerprints)) {
    for (const fp of biz.fingerprints) {
      if (typeof fp === "string") {
        if (!domain && fp.startsWith("web:")) {
          domain = normalizeBrandDomain(fp.slice("web:".length));
        } else if (!instagram && fp.startsWith("ig:")) {
          instagram = normalizeBrandInstagram(fp.slice("ig:".length));
        }
      }
    }
  }

  if (!domain && biz.website) {
    domain = normalizeBrandDomain(biz.website);
  }
  if (!instagram && biz.instagram) {
    instagram = normalizeBrandInstagram(biz.instagram);
  }

  return { domain, instagram };
}
