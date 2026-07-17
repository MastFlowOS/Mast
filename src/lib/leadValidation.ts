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

const PLACEHOLDER_EMAIL_DOMAINS = new Set(["example.com", "example.org", "test.com", "domain.com", "email.com", "yourdomain.com"]);

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
  const [local, domain] = email.split("@");
  if (PLACEHOLDER_EMAIL_LOCAL_PARTS.has(local) || PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return false;
  return true;
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

export function isValidInstagram(value: string | null | undefined): boolean {
  const instagram = (value || "").trim();
  if (!instagram) return false;
  return /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?$/i.test(instagram);
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
    const [local, domain] = email.split("@");
    if (PLACEHOLDER_EMAIL_LOCAL_PARTS.has(local) || PLACEHOLDER_EMAIL_DOMAINS.has(domain)) {
      return { valid: false, reason: "placeholder_email" };
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
