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
  // Non-profile paths seen in embeds / share widgets / static assets
  // (mirrors utils/parsing.py::_IG_NON_HANDLES). Deliberately limited to
  // paths that are never a business profile.
  "sharer",
  "embed",
  "static",
  "web",
  "developer",
  "developers",
  "nametag",
  "oembed",
  "emails",
  "session",
  "ajax",
  "graphql",
  "_u",
]);

// A handle is 2-30 chars of letters, digits, "_" and "." (it may start with
// a digit or underscore). Mirrors utils/parsing.py::is_valid_ig_handle.
const IG_HANDLE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]{1,29}$/;
// A real handle never looks like a file ("embed.js", "sharer.php").
const IG_FILELIKE_SUFFIX_RE =
  /\.(?:js|mjs|php|asp|aspx|html?|json|xml|css|png|jpe?g|gif|webp|svg|ico|txt|map|woff2?|ttf)$/i;

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
  while (/^(?:https?:\/\/|\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/?/i.test(text)) {
    text = text
      .replace(/^(?:https?:\/\/|\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/?/i, "")
      .trim();
  }

  while (/^https?:\/\//i.test(text)) {
    text = text.replace(/^https?:\/\//i, "").trim();
  }

  // Remove URL query params or hashes
  text = text.split(/[?#]/)[0].trim();

  // Strip leading @, slashes, or whitespace
  text = text
    .replace(/^[/@]+/, "")
    .replace(/\/+$/, "")
    .trim();

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

  // Validate character shape and length: 2-30 chars, alphanumeric + _ + .
  if (!IG_HANDLE_RE.test(segment)) {
    return null;
  }

  // Reject file-like names, trailing dots and consecutive dots.
  if (segment.endsWith(".") || segment.includes("..") || IG_FILELIKE_SUFFIX_RE.test(segment)) {
    return null;
  }

  return segment;
}

/**
 * Decides what (if anything) enrichment should write to `businesses.instagram`.
 *
 * Returns the canonical profile URL to persist, or null meaning "leave the
 * column untouched". An extracted value that is missing or not a real profile
 * (reserved path, numeric handle, junk) yields null, and so does an existing
 * valid value — enrichment only fills a gap, it never erases or replaces a
 * valid stored Instagram URL.
 */
export function resolveInstagramToPersist(
  existing: string | null | undefined,
  extracted: string | null | undefined,
): string | null {
  const next = normalizeInstagram(extracted);
  if (!next) return null;
  if (normalizeInstagram(existing)) return null;
  return next.profileUrl;
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
