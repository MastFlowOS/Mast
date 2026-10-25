/**
 * Authoritative city geographic metadata & administrative boundary mappings.
 *
 * Provides deterministic state/subdivision and OpenStreetMap boundary relation
 * context for discovery work units (cities). Used by street-inventory initialization
 * and boundary verification to disambiguate cities with identical or common names
 * (e.g. Chicago IL vs Chicago KS/WI; New York City vs New York State) without
 * relying on ambiguous global name scans.
 */

export interface CityGeographicContext {
  countryCode: string;
  city: string;
  subdivision: string;
  iso3166_2: string;
  osmRelationId?: number;
  adminLevel?: number;
}

export const CITY_GEOGRAPHIC_CONTEXT: Record<string, CityGeographicContext> = {
  // United States
  "US:Chicago": {
    countryCode: "US",
    city: "Chicago",
    subdivision: "IL",
    iso3166_2: "US-IL",
    osmRelationId: 122604,
    adminLevel: 8,
  },
  "US:New York": {
    countryCode: "US",
    city: "New York",
    subdivision: "NY",
    iso3166_2: "US-NY",
    osmRelationId: 175905,
    adminLevel: 8,
  },
  "US:Los Angeles": {
    countryCode: "US",
    city: "Los Angeles",
    subdivision: "CA",
    iso3166_2: "US-CA",
    osmRelationId: 207359,
    adminLevel: 8,
  },
  "US:Houston": {
    countryCode: "US",
    city: "Houston",
    subdivision: "TX",
    iso3166_2: "US-TX",
    osmRelationId: 2688911,
    adminLevel: 8,
  },
  "US:Phoenix": {
    countryCode: "US",
    city: "Phoenix",
    subdivision: "AZ",
    iso3166_2: "US-AZ",
    osmRelationId: 111838,
    adminLevel: 8,
  },
  "US:Philadelphia": {
    countryCode: "US",
    city: "Philadelphia",
    subdivision: "PA",
    iso3166_2: "US-PA",
    osmRelationId: 188022,
    adminLevel: 8,
  },

  // Canada
  "CA:Toronto": {
    countryCode: "CA",
    city: "Toronto",
    subdivision: "ON",
    iso3166_2: "CA-ON",
    osmRelationId: 3235142,
    adminLevel: 8,
  },
  "CA:Montreal": {
    countryCode: "CA",
    city: "Montreal",
    subdivision: "QC",
    iso3166_2: "CA-QC",
    osmRelationId: 1634158,
    adminLevel: 8,
  },
  "CA:Vancouver": {
    countryCode: "CA",
    city: "Vancouver",
    subdivision: "BC",
    iso3166_2: "CA-BC",
    osmRelationId: 1852574,
    adminLevel: 8,
  },

  // United Kingdom
  "GB:London": {
    countryCode: "GB",
    city: "London",
    subdivision: "ENG",
    iso3166_2: "GB-ENG",
    osmRelationId: 65606,
    adminLevel: 8,
  },
  "GB:Manchester": {
    countryCode: "GB",
    city: "Manchester",
    subdivision: "ENG",
    iso3166_2: "GB-ENG",
    osmRelationId: 133282,
    adminLevel: 8,
  },
  "GB:Birmingham": {
    countryCode: "GB",
    city: "Birmingham",
    subdivision: "ENG",
    iso3166_2: "GB-ENG",
    osmRelationId: 147576,
    adminLevel: 8,
  },

  // France
  "FR:Paris": {
    countryCode: "FR",
    city: "Paris",
    subdivision: "IDF",
    iso3166_2: "FR-IDF",
    osmRelationId: 7444,
    adminLevel: 8,
  },

  // Germany
  "DE:Berlin": {
    countryCode: "DE",
    city: "Berlin",
    subdivision: "BE",
    iso3166_2: "DE-BE",
    osmRelationId: 62422,
    adminLevel: 4,
  },
  "DE:Munich": {
    countryCode: "DE",
    city: "Munich",
    subdivision: "BY",
    iso3166_2: "DE-BY",
    osmRelationId: 62428,
    adminLevel: 6,
  },
  "DE:Hamburg": {
    countryCode: "DE",
    city: "Hamburg",
    subdivision: "HH",
    iso3166_2: "DE-HH",
    osmRelationId: 62782,
    adminLevel: 4,
  },

  // Australia
  "AU:Sydney": {
    countryCode: "AU",
    city: "Sydney",
    subdivision: "NSW",
    iso3166_2: "AU-NSW",
    osmRelationId: 5750005,
    adminLevel: 7,
  },
  "AU:Melbourne": {
    countryCode: "AU",
    city: "Melbourne",
    subdivision: "VIC",
    iso3166_2: "AU-VIC",
    osmRelationId: 4290001,
    adminLevel: 7,
  },
  "AU:Brisbane": {
    countryCode: "AU",
    city: "Brisbane",
    subdivision: "QLD",
    iso3166_2: "AU-QLD",
    osmRelationId: 2315822,
    adminLevel: 7,
  },
};

/**
 * Returns the authoritative geographic context for a (countryCode, city) pair,
 * or undefined if none is registered.
 */
export function getCityGeographicContext(
  countryCode: string | undefined,
  city: string | undefined,
): CityGeographicContext | undefined {
  if (!countryCode || !city) return undefined;
  const key = `${countryCode.trim().toUpperCase()}:${city.trim()}`;
  return CITY_GEOGRAPHIC_CONTEXT[key];
}

/**
 * Returns the short ISO 3166-2 subdivision code (e.g. "IL", "NY", "CA", "ON")
 * for a (countryCode, city) pair.
 */
export function resolveCitySubdivision(
  countryCode: string | undefined,
  city: string | undefined,
): string | undefined {
  return getCityGeographicContext(countryCode, city)?.subdivision;
}

/**
 * Returns the canonical OSM relation ID (e.g. 122604 for Chicago)
 * for a (countryCode, city) pair.
 */
export function resolveCityOsmRelationId(
  countryCode: string | undefined,
  city: string | undefined,
): number | undefined {
  return getCityGeographicContext(countryCode, city)?.osmRelationId;
}
