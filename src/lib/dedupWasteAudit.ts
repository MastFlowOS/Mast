/**
 * Phase 3C-4A — Early Dedup Audit instrumentation (observability only).
 *
 * This module answers one question with real production data: by the time
 * the persistent cross-request dedup check (deliverLead.ts::
 * findExistingBusiness, comparing against businesses.fingerprints in
 * Supabase) finally runs, has website/Instagram/contact enrichment already
 * completed for this lead?
 *
 * It does NOT decide anything, does NOT change what gets written, and does
 * NOT move the dedup check earlier. It is called from
 * upsertBusinessFromEngineLead() immediately after findExistingBusiness()
 * resolves, purely to log one structured line per lead.
 *
 * Enrichment-completion proxy, and its known limitation:
 * ------------------------------------------------------
 * EngineLead carries no explicit "WebsiteWorker/InstagramWorker/
 * ContactWorker ran" flag — only the resulting fields (website, instagram,
 * email/phone/emails/phones). Per the Python engine's own docs (see
 * engine/execution_driver.py::build_seven_stage_pipeline and
 * service.py::run_query's non-discovery_only branch), those three workers
 * run unconditionally for every candidate that reaches Merge on the live
 * production path — so in practice these flags are expected to read `true`
 * for effectively every lead this function ever sees. A `false` reading
 * here would therefore itself be a signal worth investigating (e.g. a
 * legitimate business with no website at all vs. a worker that never ran).
 * This is a presence proxy, not a direct stage-completion signal — the
 * engine does not currently expose the latter to Node.
 */

export type DedupWasteLogFields = {
  scrapeJobId: string | null;
  pipelineId: string | null;
  mapsPlaceId: string | null;
  fingerprints: string[];
  existingBusiness: boolean;
  websiteEnrichmentCompleted: boolean;
  instagramEnrichmentCompleted: boolean;
  contactEnrichmentCompleted: boolean;
};

/** Pulls the Maps place identity out of the fingerprint set the engine
 * already computed (storage/dedup.py fingerprints_for), rather than
 * re-deriving it from a raw maps_link URL — see that module's `place:` /
 * `map:` key formats. Prefers `place:` (a real Google place id) over the
 * looser `map:` (cleaned URL) fallback. */
export function extractMapsPlaceId(fingerprints: string[]): string | null {
  const place = fingerprints.find((f) => f.startsWith("place:"));
  if (place) return place.slice("place:".length);
  const map = fingerprints.find((f) => f.startsWith("map:"));
  if (map) return map.slice("map:".length);
  return null;
}

export function buildDedupWasteLogFields(args: {
  scrapeJobId?: string | null;
  pipelineId?: string | null;
  fingerprints: string[];
  existingBusiness: boolean;
  website?: string | null;
  instagram?: string | null;
  email?: string | null;
  phone?: string | null;
  emails?: { email: string; role: string }[];
  phones?: string[];
}): DedupWasteLogFields {
  return {
    scrapeJobId: args.scrapeJobId ?? null,
    pipelineId: args.pipelineId ?? null,
    mapsPlaceId: extractMapsPlaceId(args.fingerprints),
    fingerprints: args.fingerprints,
    existingBusiness: args.existingBusiness,
    websiteEnrichmentCompleted: Boolean(args.website),
    instagramEnrichmentCompleted: Boolean(args.instagram),
    contactEnrichmentCompleted:
      Boolean(args.email) || Boolean(args.phone) || Boolean(args.emails?.length) || Boolean(args.phones?.length),
  };
}

/** One structured stdout line per final Node duplicate decision. Mirrors
 * pipelineTrace.ts's `[pipeline][<id>] ...` convention so both can be
 * grepped/correlated by pipelineId. Never throws — a logging failure must
 * never affect the delivery it's observing. */
export function logDedupWasteDecision(fields: DedupWasteLogFields): void {
  try {
    console.log(`[dedup-waste-audit][${fields.pipelineId ?? "unknown"}] DEDUP_DECISION ${JSON.stringify(fields)}`);
  } catch {
    // observability must never break delivery
  }
}
