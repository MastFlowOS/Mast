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

  if (parts.length === 0) return [niche.trim() || "General"];

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
