import type { EngineLead } from "../scraperBridge/pythonBridge.js";

/**
 * Priority 2/3 — Field-level confidence + source attribution.
 *
 * ROOT CAUSE this replaces: `businesses.confidence` was (and remains, for
 * the whole-record archiving decision — see confidenceModel.ts) a single
 * 0-100 number with no way to know, per field, where a value came from, how
 * it was verified, or when. The audit (Q2/A1) is explicit that this is the
 * single largest structural gap relative to the brief's Priorities 5/6.
 *
 * This module turns the raw per-field attribution the Python engine now
 * captures at extraction time (site_crawler.py's `field_sources`,
 * pipeline.py's `field_provenance`) into a scored, human-explainable trust
 * record per field — "Website — Verified, Confidence 100%, Source: Google
 * Business, Verified: Crawler" is literally `fieldTrust.website`.
 */

export type FieldMethod =
  | "google_maps"
  | "google_business"
  | "website_crawl"
  | "instagram_bio"
  | "schema_org"
  | "unknown";

export type FieldTrustEntry = {
  value: string | null;
  source: string; // a URL, or a label like "Google Business" / "Instagram Bio"
  method: FieldMethod;
  confidence: number; // 0-100
  verifiedAt: string; // ISO timestamp
};

export type FieldTrust = Record<string, FieldTrustEntry>;

/**
 * Base confidence per verification method — a product decision, kept as
 * named constants in one place (mirrors confidenceModel.ts's own pattern).
 * Google Maps/Business data is the highest-trust source (Google itself
 * verified the listing); a direct website crawl is next (we saw it live,
 * just now); Instagram bio text is the least structured/most likely to be
 * stale or informal.
 */
const METHOD_CONFIDENCE: Record<FieldMethod, number> = {
  google_business: 95,
  google_maps: 90,
  schema_org: 88,
  website_crawl: 80,
  instagram_bio: 65,
  unknown: 50,
};

function humanSource(method: FieldMethod, source: string): string {
  switch (method) {
    case "google_maps":
    case "google_business":
      return "Google Business";
    case "instagram_bio":
      return "Instagram Bio";
    case "schema_org":
      return "Schema.org";
    case "website_crawl": {
      // Turn a URL into a friendly page label — "Found on Contact Page"
      // per the brief's explicit frontend requirement, without guessing.
      const low = (source || "").toLowerCase();
      if (low.includes("/contact")) return "Contact Page";
      if (low.includes("/about")) return "About Page";
      if (low.includes("/book")) return "Booking Page";
      return "Website";
    }
    default:
      return source || "Unknown";
  }
}

/**
 * Builds the field_provenance record to store on `businesses` from a fresh
 * EngineLead. Every important contact/identity field gets an entry when we
 * have attribution for it; fields with no attribution are simply absent
 * (never a fabricated confident source).
 */
export function buildFieldTrust(lead: EngineLead): FieldTrust {
  const now = new Date().toISOString();
  const trust: FieldTrust = {};

  const rawProvenance = (lead.field_provenance as Record<string, { value?: unknown; source?: string; method?: string }>) || {};

  for (const [field, entry] of Object.entries(rawProvenance)) {
    if (!entry || entry.value == null || entry.value === "") continue;
    const method = (entry.method as FieldMethod) in METHOD_CONFIDENCE ? (entry.method as FieldMethod) : "unknown";
    trust[field] = {
      value: String(entry.value),
      source: humanSource(method, entry.source || ""),
      method,
      confidence: METHOD_CONFIDENCE[method],
      verifiedAt: now,
    };
  }

  return trust;
}

/**
 * Re-derives confidence for a single field after a verification job
 * re-checks it directly (verificationJob.ts) — same confidence table, just
 * invoked from the re-verify path instead of first discovery.
 */
export function fieldTrustEntry(value: string, method: FieldMethod, source: string): FieldTrustEntry {
  return {
    value,
    source: humanSource(method, source),
    method,
    confidence: METHOD_CONFIDENCE[method],
    verifiedAt: new Date().toISOString(),
  };
}
