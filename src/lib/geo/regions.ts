/**
 * Region → countries expansion, used by the discovery job orchestration
 * (src/jobs/discoverJob.ts, src/jobs/poolExpandJob.ts) so the Python engine
 * is NEVER asked to search a region literally (e.g. "Bakery in North
 * America"). The engine only ever receives one real country at a time (see
 * scraper/maps_scraper.py::search — `city` + `country`); this module is
 * where a user's region/currency selection turns into that list of
 * countries.
 *
 * Nothing about the Python scraper changes — it already just takes a
 * query/city/country and performs a normal search. All the new logic lives
 * here, in the orchestration layer, on top of the reusable country data in
 * ./countries.ts.
 */
import { COUNTRIES, REGION_NAMES, type CountryInfo, type IncomeTier, type RegionName } from "./countries.js";

/** Selecting a target currency should only prioritize countries whose
 * businesses are realistically able to pay in it — i.e. high/upper-middle
 * income economies. This is about the DISCOVERED BUSINESS's ability to pay,
 * not the country's actual local currency (see countries.ts docblock). */
export const CURRENCY_ELIGIBLE_TIERS: IncomeTier[] = ["high", "upper_middle"];

const GLOBAL_LABEL = "global";

/**
 * Splits a comma-joined region label (e.g. "North America, Europe", the
 * same join pattern the frontend already uses for niches — see
 * splitNicheQuery in ../niches.ts) back into individual region names.
 * Unlike splitNicheQuery, this never invents a fallback value: an empty
 * input resolves to an empty list, which resolveCountriesForSelection()
 * below treats as "nothing to search," not silently substitute a default.
 */
export function splitRegionQuery(regionField: string): string[] {
  return regionField
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

function isGlobalSelection(regionNames: string[]): boolean {
  return regionNames.some((r) => r.toLowerCase() === GLOBAL_LABEL);
}

/**
 * Expands the user's region selection (and, optionally, target currencies)
 * into the concrete list of countries the engine should iterate — this is
 * requirement #2/#4 of the Discover architecture fix: regions are never
 * searched literally, and a target currency narrows the country list to
 * economies where discovered businesses can realistically pay in it.
 *
 * - An empty selection resolves to no countries (nothing to search) — same
 *   no-silent-fallback approach as niche.
 * - "Global" expands to every known country, i.e. worldwide — and, per
 *   product spec, an explicit worldwide request is NOT narrowed by
 *   currency, since the user already opted into the broadest possible
 *   search.
 * - Otherwise, countries are pooled from every selected region (deduped by
 *   ISO code, since a country can only belong to one region here) and, if
 *   at least one currency was selected, filtered down to
 *   CURRENCY_ELIGIBLE_TIERS. If that filter would empty out a region
 *   entirely, that region's unfiltered countries are kept instead — a
 *   currency preference should narrow the search, never zero it out.
 */
export function resolveCountriesForSelection(
  regionField: string,
  opts: { currencies?: string[] } = {},
): CountryInfo[] {
  const regionNames = splitRegionQuery(regionField);
  if (regionNames.length === 0) return [];

  const global = isGlobalSelection(regionNames);

  const targetRegions: RegionName[] = global
    ? REGION_NAMES
    : (regionNames.filter((r) => REGION_NAMES.includes(r as RegionName)) as RegionName[]);

  const pool = COUNTRIES.filter((c) => targetRegions.includes(c.region));

  const hasCurrency = (opts.currencies?.length ?? 0) > 0;
  if (!hasCurrency || global) {
    return dedupeByCode(pool);
  }

  const filtered = pool.filter((c) => CURRENCY_ELIGIBLE_TIERS.includes(c.incomeTier));

  // Never let currency filtering zero out an entire selected region — keep
  // that region's unfiltered countries rather than searching nothing.
  const coveredRegions = new Set(filtered.map((c) => c.region));
  const backfill = pool.filter((c) => !coveredRegions.has(c.region));

  return dedupeByCode([...filtered, ...backfill]);
}

function dedupeByCode(countries: CountryInfo[]): CountryInfo[] {
  const seen = new Set<string>();
  const out: CountryInfo[] = [];
  for (const c of countries) {
    if (!seen.has(c.code)) {
      seen.add(c.code);
      out.push(c);
    }
  }
  return out;
}

/** One (country, real-city) pair to actually search — never the bare
 * country. See ROOT CAUSE FIX note on CountryRotation below. */
export interface CountrySearchTarget {
  country: CountryInfo;
  city: string;
}

/**
 * Tracks per-country exhaustion across search rounds and hands out the next
 * (country, city) target + a suggested chunk size, so a single country never
 * dominates a request (requirement #3): each round splits the remaining
 * quantity evenly across every still-active country, and a country that
 * reports genuine exhaustion (engine's onDone.exhausted) is dropped from
 * future rounds so the rotation naturally moves on to the next one.
 *
 * ROOT CAUSE FIX: this used to hand out bare `CountryInfo` objects, and the
 * caller (discoverJob.ts) took `country.name` — the country's own name,
 * e.g. "United States" — and passed it straight through as the engine's
 * `city` search field. Google Maps has no per-listing results feed for a
 * query scoped to an entire country; it tries to cluster/render a
 * nationwide result set with no natural cap, which is what was ballooning
 * the Playwright page's memory until Chromium's renderer OOM-crashed
 * ("Target crashed"). The rotation now hands out a real city from
 * `country.majorCities` instead, and only advances to the next city (via
 * `markCurrentSearchExhausted`) once the engine reports that city's search
 * space as genuinely exhausted — the whole country is only dropped once
 * every one of its cities has been exhausted this way.
 */
export class CountryRotation {
  private readonly countries: CountryInfo[];
  private readonly exhausted = new Set<string>();
  private readonly cityIndex = new Map<string, number>();

  constructor(countries: CountryInfo[]) {
    this.countries = countries;
  }

  get activeCount(): number {
    return this.countries.length - this.exhausted.size;
  }

  get isFullyExhausted(): boolean {
    return this.activeCount <= 0;
  }

  private citiesFor(country: CountryInfo): string[] {
    // Defensive fallback only — every entry in COUNTRIES ships with real
    // cities (see countries.ts). This must never fall back to
    // `country.name`, since that's exactly the bug being fixed here.
    return country.majorCities.length > 0 ? country.majorCities : [country.name];
  }

  private currentCity(country: CountryInfo): string {
    const cities = this.citiesFor(country);
    const idx = this.cityIndex.get(country.code) ?? 0;
    return cities[Math.min(idx, cities.length - 1)];
  }

  /**
   * Marks the CURRENT city for this country as exhausted (per the engine's
   * own onDone.exhausted signal for that city's search). Advances to the
   * next city in the country's list; only marks the whole country
   * exhausted once every one of its cities has reported exhaustion this
   * way — a single city (e.g. a small town with few listings) can no
   * longer prematurely drop an entire country from the rotation.
   */
  markCurrentSearchExhausted(country: CountryInfo): void {
    const cities = this.citiesFor(country);
    const nextIdx = (this.cityIndex.get(country.code) ?? 0) + 1;
    if (nextIdx >= cities.length) {
      this.exhausted.add(country.code);
    } else {
      this.cityIndex.set(country.code, nextIdx);
    }
  }

  /** One pass over every still-active country's CURRENT city, in stable
   * order. */
  *round(): IterableIterator<CountrySearchTarget> {
    for (const c of this.countries) {
      if (!this.exhausted.has(c.code)) {
        yield { country: c, city: this.currentCity(c) };
      }
    }
  }

  /** Even split of `remaining` across every still-active country, min 1. */
  chunkSize(remaining: number): number {
    const active = this.activeCount;
    if (active <= 0) return 0;
    return Math.max(Math.ceil(remaining / active), 1);
  }
}
