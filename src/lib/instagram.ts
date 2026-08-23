/**
 * src/lib/instagram.ts
 *
 * Canonical Instagram URL and Handle normalization helper.
 * Aligned with Python backend validation rules (utils/parsing.py).
 */

export interface NormalizedInstagram {
  handle: string;
  profileUrl: string;
  dmUrl: string;
}

const IG_NON_HANDLES = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "explore",
  "stories",
  "accounts",
  "about",
  "directory",
  "legal",
  "privacy",
  "press",
  "help",
  "api",
  "oauth",
  "challenge",
  "login",
  "signup",
  "direct",
  "instagram",
]);

const IG_HANDLE_RE = /^[A-Za-z][A-Za-z0-9_.]{1,29}$/;

/**
 * Extracts and validates a canonical Instagram handle from any raw input format:
 * - bare handle: "recessgrove"
 * - @handle: "@recessgrove"
 * - full URL: "https://instagram.com/recessgrove" or "https://www.instagram.com/recessgrove/"
 * - malformed double URL: "https://www.instagram.com/https://www.instagram.com/recessgrove/"
 *
 * Returns the lowercase handle string, or null if the input is invalid/reserved.
 */
export function extractInstagramHandle(raw?: string | null): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;

  // Strip wrapping quotes
  text = text.replace(/^["']+|["']+$/g, "").trim();

  // Strip leading and duplicated protocol/domain prefixes
  while (/^https?:\/\/(?:www\.)?instagram\.com\/?/i.test(text)) {
    text = text.replace(/^https?:\/\/(?:www\.)?instagram\.com\/?/i, "").trim();
  }

  while (/^https?:\/\//i.test(text)) {
    text = text.replace(/^https?:\/\//i, "").trim();
  }

  // Remove URL query params or hashes
  text = text.split(/[?#]/)[0].trim();

  // Strip leading @, slashes, or whitespace
  text = text.replace(/^[/@]+/, "").replace(/\/+$/, "").trim();

  // Take the primary path segment
  const segment = text.split("/")[0].trim().toLowerCase();
  if (!segment) return null;

  // Reject numeric-only handles
  if (/^\d+$/.test(segment)) {
    return null;
  }

  // Reject non-handle/reserved paths
  if (IG_NON_HANDLES.has(segment)) {
    return null;
  }

  // Validate character shape and length: starts with a letter, 2-30 chars, alphanumeric + _ + .
  if (!IG_HANDLE_RE.test(segment)) {
    return null;
  }

  return segment;
}

/**
 * Normalizes any Instagram handle or URL into canonical { handle, profileUrl, dmUrl }.
 * Returns null if the input cannot produce a valid Instagram handle.
 */
export function normalizeInstagram(input?: string | null): NormalizedInstagram | null {
  const handle = extractInstagramHandle(input);
  if (!handle) return null;

  return {
    handle,
    profileUrl: `https://www.instagram.com/${handle}/`,
    dmUrl: `https://ig.me/m/${handle}`,
  };
}
