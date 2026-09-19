/**
 * Geographic SCOPE model for discovery requests.
 *
 * The discovery request's `region` string is a comma-separated list of scope
 * tokens. Each token is exactly one of:
 *
 *   - "Global"                       → every supported country
 *   - a continent (REGION_NAMES)     → every supported country on it
 *   - a country (COUNTRIES[].name)   → exactly that country, nothing else
 *
 * This module is the single parser for that string. It is pure (no env, no
 * DB) so the server, the API pre-flight and the Discover UI all share one
 * definition. A country is NEVER widened to its continent here or anywhere
 * downstream: a "Canada" token resolves to Canada only.
 */
import { COUNTRIES, REGION_NAMES, type CountryInfo, type RegionName } from "./countries.js";

export const GLOBAL_SCOPE = "Global";

/** The only continent a plan without `regionalSearch` may search. Kept
 * identical to the pre-existing server gate (discover.ts), now extended to
 * the countries that sit inside it. */
export const LOCAL_SEARCH_REGION: RegionName = "North America";

export type ParsedGeoScope = {
  /** Canonical, de-duplicated tokens in request order. */
  tokens: string[];
  global: boolean;
  continents: RegionName[];
  countries: CountryInfo[];
  /** Tokens that are none of Global / continent / country. */
  invalid: string[];
};

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

const CONTINENT_BY_NORM = new Map<string, RegionName>(REGION_NAMES.map((r) => [norm(r), r]));
const COUNTRY_BY_NORM = new Map<string, CountryInfo>(COUNTRIES.map((c) => [norm(c.name), c]));
const COUNTRY_BY_CODE = new Map<string, CountryInfo>(COUNTRIES.map((c) => [c.code.toUpperCase(), c]));

export function findCountryByName(name: string): CountryInfo | undefined {
  return COUNTRY_BY_NORM.get(norm(name));
}

/** ISO-3166 alpha-2 code for a code OR a country name; null if unknown.
 * Never guesses. */
export function countryCodeFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  const byCode = v.length === 2 ? COUNTRY_BY_CODE.get(v.toUpperCase()) : undefined;
  if (byCode) return byCode.code;
  return COUNTRY_BY_NORM.get(norm(v))?.code ?? null;
}

export function parseGeoScope(regionField: string): ParsedGeoScope {
  const out: ParsedGeoScope = { tokens: [], global: false, continents: [], countries: [], invalid: [] };
  const seen = new Set<string>();
  for (const raw of (regionField ?? "").split(",")) {
    const key = norm(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (key === norm(GLOBAL_SCOPE)) {
      out.global = true;
      out.tokens.push(GLOBAL_SCOPE);
      continue;
    }
    const continent = CONTINENT_BY_NORM.get(key);
    if (continent) {
      out.continents.push(continent);
      out.tokens.push(continent);
      continue;
    }
    const country = COUNTRY_BY_NORM.get(key);
    if (country) {
      out.countries.push(country);
      out.tokens.push(country.name);
      continue;
    }
    out.invalid.push(raw.trim());
  }
  return out;
}

/** Canonical wire form: known tokens only, canonical spelling, de-duped. */
export function formatGeoScope(scope: ParsedGeoScope): string {
  return scope.tokens.join(", ");
}

/** True when every token is inside the plan-free "local" region. Global and
 * any other continent/country require `regionalSearch`. */
export function isLocalGeoScope(scope: ParsedGeoScope): boolean {
  if (scope.tokens.length === 0 || scope.global || scope.invalid.length > 0) return false;
  return (
    scope.continents.every((c) => c === LOCAL_SEARCH_REGION) &&
    scope.countries.every((c) => c.region === LOCAL_SEARCH_REGION)
  );
}

/** Single-token convenience for UI lock indicators. */
export function isLocalGeoToken(token: string): boolean {
  return isLocalGeoScope(parseGeoScope(token));
}

export type RegionValidation =
  | { ok: true; region: string; scope: ParsedGeoScope }
  | { ok: false; code: "invalid_region" | "region_restricted"; message: string };

/**
 * The one validation used by the route AND the client pre-flight, so they
 * cannot drift. Unknown tokens are rejected (never silently dropped or
 * widened); plans without regionalSearch are limited to the local region.
 */
export function validateDiscoveryRegion(regionField: string, opts: { regionalSearch: boolean }): RegionValidation {
  const scope = parseGeoScope(regionField);
  if (scope.tokens.length === 0 && scope.invalid.length === 0) {
    return { ok: false, code: "invalid_region", message: "Select at least one country or region." };
  }
  if (scope.invalid.length > 0) {
    return {
      ok: false,
      code: "invalid_region",
      message: `Unsupported location: ${scope.invalid.join(", ")}. Choose a supported country or region.`,
    };
  }
  if (!opts.regionalSearch && !isLocalGeoScope(scope)) {
    return {
      ok: false,
      code: "region_restricted",
      message: "Your plan supports local search only (North America). Upgrade to search other countries and regions.",
    };
  }
  return { ok: true, region: formatGeoScope(scope), scope };
}

/**
 * Stamps the ISO country a lead was discovered in. The REQUESTED country
 * (the one the provider was actually asked to search) wins; the engine's own
 * `country` echo is the fallback. Unknown → left unset, never guessed.
 */
export function attributeDiscoveryCountry<T extends { country?: unknown; country_code?: unknown }>(
  lead: T,
  requestedCountry: unknown,
): T & { country_code?: string } {
  const code = countryCodeFrom(requestedCountry) ?? countryCodeFrom(lead.country);
  return (code ? { ...lead, country_code: code } : lead) as T & { country_code?: string };
}
