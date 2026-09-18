/**
 * ROOT CAUSE this fixes: the frontend's niche multi-select
 * (src/routes/dashboard.leads.tsx) joins every selected niche into a single
 * comma-separated string — `niches.join(", ")` — because the `/v1/discover`
 * request shape only has one `niche: string` field (unchanged here, per
 * scope). Everything downstream then treated that joined string as ONE
 * search term:
 *
 *   - The Python engine got `query="Bakery, Coffee"` and ran it as a single
 *     literal Google Maps search, i.e. effectively "Bakery AND Coffee"
 *     (in practice: neither, since no business is literally named/tagged
 *     that).
 *   - `pool_lookup()` (migrations/003_pool_lookup.sql) filtered with
 *     `b.niche ilike '%Bakery, Coffee%'`, which cannot match a business
 *     whose `niche` column is just `"Bakery"` or just `"Coffee"` — Instant
 *     Discovery would return near-nothing for any multi-niche search.
 *
 * The fix is orchestration-level, not a schema/API change: split the joined
 * string back into independent niches wherever it's consumed, and run one
 * search/lookup per niche, unioning the results (OR semantics) instead of
 * treating the whole string as one AND'd term.
 */
export function splitNicheQuery(niche: string): string[] {
  const parts = niche
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  // Niche selection is required at the API boundary (see
  // DiscoverRequestSchema in server/routes/discover.ts) — an empty result
  // here means something upstream failed to enforce that, not a case to
  // paper over with a fabricated "General" search.
  if (parts.length === 0) return [];

  // De-dupe case-insensitively while preserving first-seen casing/order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}

/**
 * DISCOVERY NICHE ATTRIBUTION
 *
 * The discovery REQUEST is the authority on which niche produced a lead.
 * The Python engine's result dicts (`_candidate_dict` on the live/discovery
 * path, `_opportunity_to_lead_dict` on the full pipeline) never carry a
 * `niche` key, so the Node side stamps the niche it asked for onto every
 * lead the engine returns. Nothing here infers a niche, lower-cases it, or
 * maps it onto the outreach categories (src/lib/outreach/niches/**) — the
 * exact string the user selected is what gets persisted.
 */

/** Trims; returns null for null/undefined/non-string/blank input. */
export function normalizeDiscoveryNiche(niche: unknown): string | null {
  if (typeof niche !== "string") return null;
  const trimmed = niche.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns the niche only when it is unambiguously ONE niche. A still-joined
 * multi-niche string ("Bakery, Coffee Shop") returns null: attributing it
 * to the first entry (or storing the joined string) would be a guess.
 */
export function singleDiscoveryNiche(niche: unknown): string | null {
  const normalized = normalizeDiscoveryNiche(niche);
  if (!normalized) return null;
  const parts = splitNicheQuery(normalized);
  return parts.length === 1 ? parts[0] : null;
}

/**
 * Stamps the requested single niche onto a copy of an engine lead. The
 * request wins over anything the engine emitted. With no single, real
 * requested niche the lead is returned untouched — never a fabricated one.
 */
export function attributeDiscoveryNiche<T extends { niche?: unknown }>(lead: T, requestedNiche: unknown): T {
  const niche = singleDiscoveryNiche(requestedNiche);
  if (!niche) return lead;
  return { ...lead, niche };
}

/**
 * The niche persisted on a `leads` row: the discovery attribution first,
 * then the business's own tag, then null. A business tag can be null or
 * belong to a different niche than the one this request selected, so it is
 * only ever a fallback.
 */
export function resolveLeadNiche(discoveryNiche: unknown, businessNiche: unknown): string | null {
  return normalizeDiscoveryNiche(discoveryNiche) ?? normalizeDiscoveryNiche(businessNiche) ?? null;
}
