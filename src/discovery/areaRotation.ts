/**
 * Phase 3C-4C-B — geographic search rotation (area-of-a-city selection).
 *
 * Companion to cityScheduling.ts, and deliberately following the exact same
 * split that module already established: pure, dependency-free selection
 * arithmetic lives here and is directly unit-testable with no
 * Postgres/env.ts required, while the one piece that genuinely needs
 * cross-process atomicity (claiming an area so two concurrent workers never
 * pick the same fresh one) is a single Postgres function
 * (`claim_discovery_area`, migrations/026) this module only calls, never
 * reimplements in JS. A JS-side "SELECT then UPDATE" would be race-prone
 * exactly the way migration 016's doc comment describes for
 * discovery_location_stats — see that migration's own reasoning.
 *
 * `selectAreaFromStats` mirrors `claim_discovery_area`'s SQL selection
 * order intentionally (never-searched first, then least-recently-searched,
 * then cooldown-window fallback) so the POLICY itself — not the atomicity —
 * is unit-testable in isolation. It is not called by the production claim
 * path (the SQL function is authoritative there); it exists so the
 * rotation policy has a fast, deterministic test surface independent of a
 * database, the same reason computeDispatchSlots() exists as pure
 * arithmetic beside the DB-backed dispatch it informs.
 */

export type AreaStat = {
  last_searched_at: string | null;
};

/** Default cooldown before a curated area becomes eligible for re-selection again. */
export const DEFAULT_AREA_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * A city participates in area rotation only when it has a curated area
 * list. Absence of curated data is itself the "treat as a small city, use
 * the existing unqualified search" signal (see cityAreas.ts's own doc
 * comment) — no separate classification flag is introduced.
 */
export function hasCuratedAreas(areas: string[] | undefined): areas is string[] {
  return Array.isArray(areas) && areas.length > 0;
}

/**
 * Deterministic, coverage-aware area selection — NOT randomization (see
 * this phase's own "This is NOT randomization" requirement).
 *
 * Policy, in priority order:
 *   1. Any area never searched before (`last_searched_at` null/missing)
 *      wins, in curated-list order, so a city's coverage always spreads to
 *      brand-new ground first.
 *   2. Otherwise the least-recently-searched area outside the cooldown
 *      window wins — oldest coverage gets refreshed before newer coverage.
 *   3. If every curated area is still inside the cooldown window, fall
 *      back to the single globally least-recently-searched area rather
 *      than stalling forever (requirement §4.4) — still deterministic,
 *      still coverage-aware (it is, by definition, the area that has gone
 *      longest without a fresh look).
 *
 * `areas` must be non-empty (callers gate on `hasCuratedAreas` first).
 */
export function selectAreaFromStats(
  areas: string[],
  statsByArea: Map<string, AreaStat>,
  nowMs: number,
  cooldownMs: number = DEFAULT_AREA_COOLDOWN_MS,
): string {
  if (areas.length === 0) {
    throw new Error("selectAreaFromStats requires a non-empty curated area list");
  }

  const neverSearched: string[] = [];
  const eligible: { area: string; lastSearchedMs: number }[] = [];
  const everySearched: { area: string; lastSearchedMs: number }[] = [];

  for (const area of areas) {
    const stat = statsByArea.get(area);
    if (!stat || !stat.last_searched_at) {
      neverSearched.push(area);
      continue;
    }
    const lastSearchedMs = Date.parse(stat.last_searched_at);
    everySearched.push({ area, lastSearchedMs });
    if (nowMs - lastSearchedMs >= cooldownMs) {
      eligible.push({ area, lastSearchedMs });
    }
  }

  if (neverSearched.length > 0) return neverSearched[0];

  if (eligible.length > 0) {
    eligible.sort((a, b) => a.lastSearchedMs - b.lastSearchedMs);
    return eligible[0].area;
  }

  // Fallback: every curated area is inside cooldown. Reuse the globally
  // least-recently-searched one instead of stalling (requirement §4.4).
  everySearched.sort((a, b) => a.lastSearchedMs - b.lastSearchedMs);
  return everySearched[0].area;
}

/**
 * Thin wrapper around the atomic `claim_discovery_area` Postgres function
 * (migrations/026). Returns the claimed area, or `undefined` when the city
 * has no curated areas (should not normally be called in that case — see
 * `hasCuratedAreas`) or the claim genuinely could not proceed.
 *
 * `db` is typed loosely (matches this codebase's existing `const db =
 * supabaseAdmin as any;` convention in planner.ts) so this module stays
 * free of a hard dependency on the Supabase client's generated types.
 */
export async function claimAreaForCity(
  db: any,
  params: {
    niche: string;
    countryCode: string;
    city: string;
    source: string;
    areas: string[];
    cooldownSeconds?: number;
  },
): Promise<string | undefined> {
  if (!hasCuratedAreas(params.areas)) return undefined;
  const { data, error } = await db.rpc("claim_discovery_area", {
    p_niche: params.niche,
    p_country_code: params.countryCode,
    p_city: params.city,
    p_source: params.source,
    p_areas: params.areas,
    p_cooldown_seconds: Math.round((params.cooldownSeconds ?? DEFAULT_AREA_COOLDOWN_MS / 1000)),
  });
  if (error) throw error;
  return (data as string | null) ?? undefined;
}

/**
 * Thin wrapper around `record_discovery_area_outcome` (migrations/026).
 * Mirrors recordTaskOutcome's own call to `record_discovery_location_outcome`
 * (discoveryPlanJob.ts) — area statistics are an additional dimension on
 * the SAME kind of counters, not a second, incompatible definition of
 * "productive" (see this phase's §7 requirement).
 */
export async function recordAreaOutcome(
  db: any,
  params: {
    niche: string;
    countryCode: string;
    city: string;
    area: string;
    source: string;
    discovered: number;
    accepted: number;
  },
): Promise<void> {
  const { error } = await db.rpc("record_discovery_area_outcome", {
    p_niche: params.niche,
    p_country_code: params.countryCode,
    p_city: params.city,
    p_area: params.area,
    p_source: params.source,
    p_discovered_delta: params.discovered,
    p_accepted_delta: params.accepted,
  });
  if (error) throw error;
}
