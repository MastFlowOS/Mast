/**
 * ROOT CAUSE this fixes: scraped data was trusted unconditionally.
 * `discoverJob.ts` / `poolExpandJob.ts` called `deliverLead()` on every
 * engine result with no format/sanity checking. The Python engine already
 * has its own extraction-time blocklists (utils/parsing.py:
 * `_EMAIL_BLOCKLIST_PREFIXES`, `_PHONE_BLOCKLIST`) and dedup
 * (storage/dedup.py, plus `businesses.fingerprints` overlap in
 * deliverLead.ts) — this is a second, independent gate on the TS side, at
 * the point of delivery, so a lead can't reach a user's CRM with obviously
 * broken data regardless of which extraction path produced it.
 *
 * Checks performed (deliberately conservative — reject only what's
 * unambiguously bad, since a false rejection silently shrinks the pool):
 *   - email: well-formed address syntax, not a placeholder domain/local-part
 *   - phone: digit count in a plausible international range
 *   - website: syntactically a URL (http/https)
 *   - instagram: syntactically an instagram.com profile URL
 *   - name: must be present (an empty name is a broken extraction, not a
 *     real business)
 *
 * Global-pool duplicate detection and website-reachability are handled
 * upstream of this (fingerprint overlap in deliverLead.ts;
 * `site.reachable` in the Python pipeline's `_merge`, respectively) — this
 * module only covers format/placeholder validity, which is the one gate
 * that didn't exist anywhere yet.
 */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const PLACEHOLDER_EMAIL_LOCAL_PARTS = new Set([
  "test",
  "example",
  "someone",
  "user",
  "youremail",
  "your-email",
  "name",
  "firstname.lastname",
  "email",
]);

const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "test.com",
  "domain.com",
  "email.com",
  "yourdomain.com",
  // Parity with utils/parsing.py::_PLACEHOLDER_EMAIL_DOMAINS: platform /
  // vendor addresses that are never the business's own mailbox.
  "placeholder.com",
  "sentry.io",
  "wixpress.com",
  "godaddy.com",
  "squarespace.com",
  "shopify.com",
  "wix.com",
  "mailchimp.com",
  "klaviyo.com",
  "sendgrid.net",
  "constantcontact.com",
  "hubspot.com",
  "amazonaws.com",
  "cloudflare.com",
]);

// Automated / system mailbox prefixes (parity with
// utils/parsing.py::_EMAIL_BLOCKLIST_PREFIXES).
const BLOCKED_EMAIL_PREFIXES = [
  "noreply@",
  "no-reply@",
  "donotreply@",
  "do-not-reply@",
  "wordpress@",
  "example@",
  "sentry@",
  "mailer-daemon@",
  "privacy@",
  "legal@",
  "abuse@",
  "webmaster@",
  "postmaster@",
  "newsletter@",
  "unsubscribe@",
  "subscriptions@",
  "bounce@",
  "daemon@",
  "spam@",
  "phishing@",
  "security@",
  "test@",
  "demo@",
  "hostmaster@",
  "admin@wordpress",
];

// File-name suffixes that look like a TLD ("logo@2x.png").
const ASSET_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "tif",
  "tiff",
  "avif",
  "heic",
  "css",
  "js",
  "mjs",
  "map",
  "json",
  "xml",
  "html",
  "htm",
  "php",
  "asp",
  "aspx",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "webm",
  "mov",
  "avi",
  "wav",
  "pdf",
  "zip",
  "gz",
  "tar",
  "rar",
  "txt",
  "csv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "exe",
  "dmg",
  "apk",
  "wasm",
  "md",
  "yml",
  "yaml",
  "ts",
  "tsx",
  "jsx",
  "scss",
  "less",
]);

/**
 * Structural checks shared by isValidEmail() and validateLead(): placeholder
 * local-parts/domains, system mailboxes, asset-file "TLDs", retina ("2x")
 * labels and hash-like local parts. Mirrors utils/parsing.py::is_valid_email
 * so the Python engine and this gateway agree on what a real mailbox is.
 */
function emailRejectionReason(email: string): string | null {
  const at = email.indexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 50) return "invalid_email_format";
  if (PLACEHOLDER_EMAIL_LOCAL_PARTS.has(local)) return "placeholder_email";
  if (BLOCKED_EMAIL_PREFIXES.some((p) => email.startsWith(p))) return "placeholder_email";
  for (const d of PLACEHOLDER_EMAIL_DOMAINS) {
    if (domain === d || domain.endsWith("." + d)) return "placeholder_email";
  }
  const labels = domain.split(".");
  if (labels.some((l) => !l || l.startsWith("-") || l.endsWith("-"))) return "invalid_email_format";
  if (ASSET_TLDS.has(labels[labels.length - 1])) return "invalid_email_format";
  if (labels.some((l) => /^\d+x$/.test(l))) return "invalid_email_format";
  if (/^[0-9a-f]{24,}$/.test(local)) return "invalid_email_format";
  return null;
}

const PLACEHOLDER_PHONE_RE = /^(\d)\1+$/; // e.g. "0000000000", "1111111111"

export type LeadValidationCandidate = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  instagram?: string | null;
};

export type LeadValidationResult = { valid: true } | { valid: false; reason: string };

function digitsOnly(v: string): string {
  return v.replace(/\D/g, "");
}

/**
 * Per-field checks, factored out of validateLead() so callers that need to
 * validate ONE newly-observed field in isolation (e.g. enrichBusiness()
 * re-validating a just-crawled email/phone — see audit Broken #3) can drop
 * just that field on failure instead of failing an entire lead/business
 * that's otherwise fine. validateLead() below is just these applied
 * together, plus the whole-lead requirements (name, "has any channel").
 */
export function isValidEmail(value: string | null | undefined): boolean {
  const email = (value || "").trim().toLowerCase();
  if (!email) return false;
  if (!EMAIL_RE.test(email)) return false;
  return emailRejectionReason(email) === null;
}

export function isValidPhone(value: string | null | undefined): boolean {
  const phone = (value || "").trim();
  if (!phone) return false;
  const digits = digitsOnly(phone);
  if (digits.length < 7 || digits.length > 15 || PLACEHOLDER_PHONE_RE.test(digits)) return false;
  return true;
}

export function isValidWebsite(value: string | null | undefined): boolean {
  const website = (value || "").trim();
  if (!website) return false;
  return /^https?:\/\/[^\s]+\.[^\s]{2,}/i.test(website);
}

import { normalizeInstagram } from "./instagram.js";

export function isValidInstagram(value: string | null | undefined): boolean {
  return normalizeInstagram(value) !== null;
}

export function validateLead(lead: LeadValidationCandidate): LeadValidationResult {
  if (!lead.name || !lead.name.trim()) {
    return { valid: false, reason: "missing_name" };
  }

  const email = (lead.email || "").trim().toLowerCase();
  if (email) {
    if (!EMAIL_RE.test(email)) {
      return { valid: false, reason: "invalid_email_format" };
    }
    const reason = emailRejectionReason(email);
    if (reason) {
      return { valid: false, reason };
    }
  }

  const phone = (lead.phone || "").trim();
  if (phone && !isValidPhone(phone)) {
    return { valid: false, reason: "invalid_phone_format" };
  }

  const website = (lead.website || "").trim();
  if (website && !isValidWebsite(website)) {
    return { valid: false, reason: "invalid_website_format" };
  }

  const instagram = (lead.instagram || "").trim();
  if (instagram && !isValidInstagram(instagram)) {
    return { valid: false, reason: "invalid_instagram_format" };
  }

  // At least one usable contact/presence channel, or there's nothing an
  // outreach flow could ever do with this lead.
  if (!email && !phone && !website && !instagram) {
    return { valid: false, reason: "no_usable_channel" };
  }

  return { valid: true };
}

/**
 * Optional-channel sanitation. A malformed OPTIONAL contact value (a junk
 * email, a non-profile Instagram link, a bad phone) used to make
 * validateLead() reject the WHOLE lead even when the business had other
 * perfectly good channels. This drops each invalid contact field in place
 * (email/phone/instagram/website -> "" and the emails/phones arrays are
 * filtered to valid entries) so that:
 *   - an invalid value can never satisfy a requested channel
 *     (channelsSatisfied() sees it as missing), and
 *   - a lead is only rejected when it genuinely has no name or no usable
 *     channel left (validateLead's own whole-lead rules).
 * Valid values are never altered, and nothing is invented. Returns the
 * names of the fields that were dropped (for logging).
 */
export function sanitizeLeadContacts(lead: {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  instagram?: string | null;
  emails?: Array<string | { email: string }> | null;
  phones?: string[] | null;
}): string[] {
  const dropped: string[] = [];
  const email = (lead.email || "").trim();
  if (email && !isValidEmail(email)) {
    lead.email = "";
    dropped.push("email");
  }
  const phone = (lead.phone || "").trim();
  if (phone && !isValidPhone(phone)) {
    lead.phone = "";
    dropped.push("phone");
  }
  const website = (lead.website || "").trim();
  if (website && !isValidWebsite(website)) {
    lead.website = "";
    dropped.push("website");
  }
  const instagram = (lead.instagram || "").trim();
  if (instagram && !isValidInstagram(instagram)) {
    lead.instagram = "";
    dropped.push("instagram");
  }
  if (Array.isArray(lead.emails)) {
    lead.emails = lead.emails.filter((e) => isValidEmail(typeof e === "string" ? e : e?.email));
  }
  if (Array.isArray(lead.phones)) {
    lead.phones = lead.phones.filter((p) => isValidPhone(p));
  }
  return dropped;
}
