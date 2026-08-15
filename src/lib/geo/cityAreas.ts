/**
 * Curated city → area lists for Phase 3C-4C-B (geographic search rotation).
 *
 * WHY THIS EXISTS (see mast_architecture_audit.md's Phase 3C-4C-A audit):
 * Google Maps' `/maps/search/<query>` free-text endpoint resolves an
 * ambiguous city-only query (e.g. "Coffee Shop New York") to a single
 * starting result cluster, and scrolling only expands within that one
 * cluster. Nothing in this codebase has real lat/lng, bounding-box, or
 * neighborhood data for a city — `COUNTRIES[].majorCities` (./countries.ts)
 * is a plain string, and `businesses.lat/lng` is unpopulated dead capacity
 * (nothing writes to it — see RawPlace's discarded href camera-position
 * comment in maps_scraper.py). The audit concluded a lat/lng grid needs a
 * new dataset (geocoder or static coordinate table) this phase is
 * explicitly not allowed to invent, so the minimal, zero-new-integration
 * mechanism is a named sub-area qualifier appended to the SAME free-text
 * query mechanism already in production — "Coffee Shop in Brooklyn, New
 * York" instead of "Coffee Shop New York" — which Google Maps' own
 * geocoding resolves to a different, more specific starting cluster.
 *
 * This module is the ONLY new data this phase introduces. It mirrors
 * `COUNTRIES[].majorCities`'s own convention exactly: a small, hand-curated,
 * easy-to-extend static list — not a geocoding call, not a bounding box,
 * not a neighborhood API. Deliberately small (5-10 areas per city) and
 * deliberately incomplete: per the phase's own scope, only a handful of
 * `majorCities` entries get curated areas at all. A city with NO entry
 * here is not a bug — it is the signal (areaRotation.ts's
 * `hasCuratedAreas()`) that the city must keep using today's unqualified
 * single-cluster search, unchanged. Extend this list opportunistically as
 * usage data justifies more cities/areas (see audit §11's open question on
 * "how many areas per city is enough" — a product decision, not a code
 * one).
 */

/** Keyed by `${countryCode}:${city}`, matching planner.ts's own LocationStat key convention. */
const CITY_AREAS: Record<string, string[]> = {
  "US:New York": ["Manhattan", "Brooklyn", "Queens", "The Bronx", "Staten Island"],
  "US:Los Angeles": ["Downtown LA", "Hollywood", "Santa Monica", "Venice", "Koreatown", "Silver Lake"],
  "US:Chicago": ["The Loop", "Wicker Park", "Lincoln Park", "Logan Square", "Hyde Park"],
  "CA:Toronto": ["Downtown Toronto", "North York", "Scarborough", "Etobicoke", "The Beaches"],
  "CA:Vancouver": ["Downtown Vancouver", "Kitsilano", "Mount Pleasant", "Yaletown", "West End"],
  "GB:London": ["Camden", "Shoreditch", "Westminster", "Greenwich", "Kensington", "Islington"],
  "MX:Mexico City": ["Roma Norte", "Polanco", "Condesa", "Coyoacán", "Santa Fe"],
  "FR:Paris": ["Le Marais", "Montmartre", "Saint-Germain-des-Prés", "Belleville", "Bastille"],
};

export const DEFAULT_SUB_AREAS = ["Downtown", "North", "South", "East", "West", "Central"];

/**
 * Returns this city's curated area list, or `undefined` when none exists.
 * `undefined` (not an empty array) is the deliberate "no curated areas"
 * signal `areaRotation.ts`'s `hasCuratedAreas()` checks for — matching
 * `cityYieldFor()`'s own `undefined`-means-"no trustworthy data" convention
 * in planner.ts.
 */
export function getAreasForCity(countryCode: string, city: string): string[] | undefined {
  return CITY_AREAS[`${countryCode}:${city}`];
}

/**
 * Returns curated areas for the city if available, otherwise returns
 * standard geographic sub-areas so any Google Maps city task can
 * participate in the dynamic area worker pool.
 */
export function getAreasForCityOrDefault(countryCode: string, city: string): string[] {
  const curated = getAreasForCity(countryCode, city);
  return curated && curated.length > 0 ? curated : DEFAULT_SUB_AREAS;
}

