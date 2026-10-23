/**
 * Rediscovery contact merge.
 *
 * ROOT CAUSE this fixes: when a business was rediscovered, deliverLead()'s
 * update path refreshed only `emails` / `phones` (replacing them wholesale)
 * and never touched the singular `email` / `phone` / `instagram` / `website`
 * columns. Because the delivered lead row is built from those singular
 * columns (toLeadRow), contact information found on a later crawl was
 * silently discarded, and a richer earlier `emails` list could be replaced
 * by a poorer one.
 *
 * Rules (all pure — no I/O — so they are unit-testable):
 *  - Fill-only for singular fields: a stored valid value is NEVER replaced;
 *    a missing or INVALID stored value (e.g. a legacy `logo@2x.png`) is
 *    replaced by a newly found valid one.
 *  - Array fields are MERGED and de-duplicated (existing order first), never
 *    replaced, and only valid entries are kept.
 *  - Empty / invalid incoming values never overwrite anything.
 */

import { resolveInstagramToPersist } from "../lib/instagram.js";
import { isValidEmail, isValidPhone, isValidWebsite } from "../lib/leadValidation.js";

export type ExistingContacts = {
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  emails?: unknown;
  phones?: unknown;
};

export type IncomingContacts = {
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  emails?: Array<string | { email: string }> | null;
  phones?: string[] | null;
};

/** Last 10 digits (the whole number if shorter): one number written two ways is one key. */
export function phoneDedupKey(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Stored/engine arrays hold bare strings or `{ email, role }` objects; pull the strings out of either. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
    else if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { email?: unknown }).email === "string"
    ) {
      out.push((entry as { email: string }).email);
    }
  }
  return out;
}

export function mergeEmailLists(...lists: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of asStringArray(list)) {
      const email = raw.trim().toLowerCase();
      if (!email || seen.has(email) || !isValidEmail(email)) continue;
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

export function mergePhoneLists(...lists: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of asStringArray(list)) {
      const phone = raw.trim();
      if (!phone || !isValidPhone(phone)) continue;
      const key = phoneDedupKey(phone);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(phone);
    }
  }
  return out;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The column updates a rediscovery should apply for contact data. Returns
 * ONLY the keys that actually change, so an unchanged business is not
 * rewritten.
 */
export function buildContactUpdate(
  existing: ExistingContacts,
  incoming: IncomingContacts,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};

  // --- arrays: merge, never replace -------------------------------------
  const existingEmails = asStringArray(existing.emails);
  const existingPhones = asStringArray(existing.phones);
  const mergedEmails = mergeEmailLists(
    existingEmails,
    incoming.emails,
    incoming.email ? [incoming.email] : [],
  );
  const mergedPhones = mergePhoneLists(
    existingPhones,
    incoming.phones,
    incoming.phone ? [incoming.phone] : [],
  );
  if (mergedEmails.length > 0 && !sameList(mergedEmails, existingEmails))
    update.emails = mergedEmails;
  if (mergedPhones.length > 0 && !sameList(mergedPhones, existingPhones))
    update.phones = mergedPhones;

  // --- singular fields: fill-only (a missing/invalid stored value is replaced) ---
  if (!isValidEmail(existing.email)) {
    const next = isValidEmail(incoming.email)
      ? incoming.email!.trim().toLowerCase()
      : mergedEmails[0];
    if (next) update.email = next;
  }
  if (!isValidPhone(existing.phone)) {
    const next = isValidPhone(incoming.phone) ? incoming.phone!.trim() : mergedPhones[0];
    if (next) update.phone = next;
  }
  const instagram = resolveInstagramToPersist(existing.instagram, incoming.instagram);
  if (instagram) update.instagram = instagram;
  if (!isValidWebsite(existing.website) && isValidWebsite(incoming.website)) {
    update.website = incoming.website!.trim();
  }
  if (!(existing.facebook || "").trim() && (incoming.facebook || "").trim()) {
    update.facebook = incoming.facebook!.trim();
  }

  return update;
}
