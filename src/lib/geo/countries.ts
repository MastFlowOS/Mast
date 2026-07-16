/**
 * Reusable region → countries data.
 *
 * This is the single source of truth for "what countries live inside a
 * region" and "how wealthy is this country's economy" (income tier). It is
 * pure data — no scraping, no orchestration logic — so it can be reused by
 * the discovery job orchestration (src/jobs/discoverJob.ts,
 * src/jobs/poolExpandJob.ts) and by anything else that needs to reason about
 * regions/countries (analytics, future filtering, etc).
 *
 * Adding, removing, or re-tiering a country is a one-line data change here —
 * nothing in the scraper or the job orchestration should ever hardcode a
 * country list of its own. See ./regions.ts for the query helpers built on
 * top of this data.
 *
 * `incomeTier` is a coarse approximation of World Bank income
 * classifications (high / upper-middle / lower-middle / low). It exists
 * for ONE purpose: letting a selected target currency (see ./regions.ts's
 * CURRENCY_ELIGIBLE_TIERS) prioritize countries where discovered businesses
 * are realistically able to pay in that currency — NOT to classify a
 * business's own local currency.
 */

export type IncomeTier = "high" | "upper_middle" | "lower_middle" | "low";

export type RegionName =
  | "North America"
  | "South America"
  | "Europe"
  | "Asia"
  | "Africa"
  | "Oceania";

export const REGION_NAMES: RegionName[] = [
  "North America",
  "South America",
  "Europe",
  "Asia",
  "Africa",
  "Oceania",
];

export interface CountryInfo {
  /** ISO 3166-1 alpha-2 code */
  code: string;
  name: string;
  region: RegionName;
  incomeTier: IncomeTier;
}

export const COUNTRIES: CountryInfo[] = [
  // ─── North America (incl. Central America + Caribbean) ─────────────────
  { code: "US", name: "United States", region: "North America", incomeTier: "high" },
  { code: "CA", name: "Canada", region: "North America", incomeTier: "high" },
  { code: "MX", name: "Mexico", region: "North America", incomeTier: "upper_middle" },
  { code: "BZ", name: "Belize", region: "North America", incomeTier: "upper_middle" },
  { code: "CR", name: "Costa Rica", region: "North America", incomeTier: "upper_middle" },
  { code: "SV", name: "El Salvador", region: "North America", incomeTier: "lower_middle" },
  { code: "GT", name: "Guatemala", region: "North America", incomeTier: "upper_middle" },
  { code: "HN", name: "Honduras", region: "North America", incomeTier: "lower_middle" },
  { code: "NI", name: "Nicaragua", region: "North America", incomeTier: "lower_middle" },
  { code: "PA", name: "Panama", region: "North America", incomeTier: "high" },
  { code: "BS", name: "Bahamas", region: "North America", incomeTier: "high" },
  { code: "BB", name: "Barbados", region: "North America", incomeTier: "high" },
  { code: "JM", name: "Jamaica", region: "North America", incomeTier: "upper_middle" },
  { code: "TT", name: "Trinidad and Tobago", region: "North America", incomeTier: "high" },
  { code: "DO", name: "Dominican Republic", region: "North America", incomeTier: "upper_middle" },
  { code: "CU", name: "Cuba", region: "North America", incomeTier: "lower_middle" },
  { code: "HT", name: "Haiti", region: "North America", incomeTier: "low" },

  // ─── South America ───────────────────────────────────────────────────
  { code: "BR", name: "Brazil", region: "South America", incomeTier: "upper_middle" },
  { code: "AR", name: "Argentina", region: "South America", incomeTier: "upper_middle" },
  { code: "CL", name: "Chile", region: "South America", incomeTier: "high" },
  { code: "CO", name: "Colombia", region: "South America", incomeTier: "upper_middle" },
  { code: "PE", name: "Peru", region: "South America", incomeTier: "upper_middle" },
  { code: "EC", name: "Ecuador", region: "South America", incomeTier: "upper_middle" },
  { code: "UY", name: "Uruguay", region: "South America", incomeTier: "high" },
  { code: "PY", name: "Paraguay", region: "South America", incomeTier: "upper_middle" },
  { code: "BO", name: "Bolivia", region: "South America", incomeTier: "lower_middle" },
  { code: "VE", name: "Venezuela", region: "South America", incomeTier: "lower_middle" },
  { code: "GY", name: "Guyana", region: "South America", incomeTier: "high" },
  { code: "SR", name: "Suriname", region: "South America", incomeTier: "upper_middle" },

  // ─── Europe ───────────────────────────────────────────────────────────
  { code: "GB", name: "United Kingdom", region: "Europe", incomeTier: "high" },
  { code: "DE", name: "Germany", region: "Europe", incomeTier: "high" },
  { code: "FR", name: "France", region: "Europe", incomeTier: "high" },
  { code: "NL", name: "Netherlands", region: "Europe", incomeTier: "high" },
  { code: "SE", name: "Sweden", region: "Europe", incomeTier: "high" },
  { code: "NO", name: "Norway", region: "Europe", incomeTier: "high" },
  { code: "DK", name: "Denmark", region: "Europe", incomeTier: "high" },
  { code: "CH", name: "Switzerland", region: "Europe", incomeTier: "high" },
  { code: "IE", name: "Ireland", region: "Europe", incomeTier: "high" },
  { code: "BE", name: "Belgium", region: "Europe", incomeTier: "high" },
  { code: "AT", name: "Austria", region: "Europe", incomeTier: "high" },
  { code: "FI", name: "Finland", region: "Europe", incomeTier: "high" },
  { code: "IS", name: "Iceland", region: "Europe", incomeTier: "high" },
  { code: "LU", name: "Luxembourg", region: "Europe", incomeTier: "high" },
  { code: "IT", name: "Italy", region: "Europe", incomeTier: "high" },
  { code: "ES", name: "Spain", region: "Europe", incomeTier: "high" },
  { code: "PT", name: "Portugal", region: "Europe", incomeTier: "high" },
  { code: "GR", name: "Greece", region: "Europe", incomeTier: "high" },
  { code: "MT", name: "Malta", region: "Europe", incomeTier: "high" },
  { code: "CY", name: "Cyprus", region: "Europe", incomeTier: "high" },
  { code: "PL", name: "Poland", region: "Europe", incomeTier: "high" },
  { code: "CZ", name: "Czechia", region: "Europe", incomeTier: "high" },
  { code: "SK", name: "Slovakia", region: "Europe", incomeTier: "high" },
  { code: "SI", name: "Slovenia", region: "Europe", incomeTier: "high" },
  { code: "EE", name: "Estonia", region: "Europe", incomeTier: "high" },
  { code: "LV", name: "Latvia", region: "Europe", incomeTier: "high" },
  { code: "LT", name: "Lithuania", region: "Europe", incomeTier: "high" },
  { code: "HU", name: "Hungary", region: "Europe", incomeTier: "upper_middle" },
  { code: "RO", name: "Romania", region: "Europe", incomeTier: "upper_middle" },
  { code: "BG", name: "Bulgaria", region: "Europe", incomeTier: "upper_middle" },
  { code: "HR", name: "Croatia", region: "Europe", incomeTier: "high" },
  { code: "RS", name: "Serbia", region: "Europe", incomeTier: "upper_middle" },
  { code: "AL", name: "Albania", region: "Europe", incomeTier: "upper_middle" },
  { code: "BA", name: "Bosnia and Herzegovina", region: "Europe", incomeTier: "upper_middle" },
  { code: "MK", name: "North Macedonia", region: "Europe", incomeTier: "upper_middle" },
  { code: "ME", name: "Montenegro", region: "Europe", incomeTier: "upper_middle" },
  { code: "MD", name: "Moldova", region: "Europe", incomeTier: "lower_middle" },
  { code: "UA", name: "Ukraine", region: "Europe", incomeTier: "lower_middle" },
  { code: "BY", name: "Belarus", region: "Europe", incomeTier: "upper_middle" },

  // ─── Asia ────────────────────────────────────────────────────────────
  { code: "JP", name: "Japan", region: "Asia", incomeTier: "high" },
  { code: "KR", name: "South Korea", region: "Asia", incomeTier: "high" },
  { code: "SG", name: "Singapore", region: "Asia", incomeTier: "high" },
  { code: "AE", name: "United Arab Emirates", region: "Asia", incomeTier: "high" },
  { code: "QA", name: "Qatar", region: "Asia", incomeTier: "high" },
  { code: "SA", name: "Saudi Arabia", region: "Asia", incomeTier: "high" },
  { code: "KW", name: "Kuwait", region: "Asia", incomeTier: "high" },
  { code: "BH", name: "Bahrain", region: "Asia", incomeTier: "high" },
  { code: "IL", name: "Israel", region: "Asia", incomeTier: "high" },
  { code: "TW", name: "Taiwan", region: "Asia", incomeTier: "high" },
  { code: "HK", name: "Hong Kong", region: "Asia", incomeTier: "high" },
  { code: "MY", name: "Malaysia", region: "Asia", incomeTier: "upper_middle" },
  { code: "CN", name: "China", region: "Asia", incomeTier: "upper_middle" },
  { code: "TH", name: "Thailand", region: "Asia", incomeTier: "upper_middle" },
  { code: "TR", name: "Turkey", region: "Asia", incomeTier: "upper_middle" },
  { code: "KZ", name: "Kazakhstan", region: "Asia", incomeTier: "upper_middle" },
  { code: "GE", name: "Georgia", region: "Asia", incomeTier: "upper_middle" },
  { code: "AM", name: "Armenia", region: "Asia", incomeTier: "upper_middle" },
  { code: "JO", name: "Jordan", region: "Asia", incomeTier: "upper_middle" },
  { code: "LB", name: "Lebanon", region: "Asia", incomeTier: "lower_middle" },
  { code: "ID", name: "Indonesia", region: "Asia", incomeTier: "upper_middle" },
  { code: "VN", name: "Vietnam", region: "Asia", incomeTier: "lower_middle" },
  { code: "PH", name: "Philippines", region: "Asia", incomeTier: "lower_middle" },
  { code: "IN", name: "India", region: "Asia", incomeTier: "lower_middle" },
  { code: "PK", name: "Pakistan", region: "Asia", incomeTier: "lower_middle" },
  { code: "BD", name: "Bangladesh", region: "Asia", incomeTier: "lower_middle" },
  { code: "LK", name: "Sri Lanka", region: "Asia", incomeTier: "lower_middle" },
  { code: "NP", name: "Nepal", region: "Asia", incomeTier: "low" },
  { code: "KH", name: "Cambodia", region: "Asia", incomeTier: "lower_middle" },
  { code: "MM", name: "Myanmar", region: "Asia", incomeTier: "low" },
  { code: "AF", name: "Afghanistan", region: "Asia", incomeTier: "low" },

  // ─── Africa ──────────────────────────────────────────────────────────
  { code: "ZA", name: "South Africa", region: "Africa", incomeTier: "upper_middle" },
  { code: "EG", name: "Egypt", region: "Africa", incomeTier: "lower_middle" },
  { code: "MA", name: "Morocco", region: "Africa", incomeTier: "lower_middle" },
  { code: "TN", name: "Tunisia", region: "Africa", incomeTier: "lower_middle" },
  { code: "DZ", name: "Algeria", region: "Africa", incomeTier: "upper_middle" },
  { code: "NG", name: "Nigeria", region: "Africa", incomeTier: "lower_middle" },
  { code: "KE", name: "Kenya", region: "Africa", incomeTier: "lower_middle" },
  { code: "GH", name: "Ghana", region: "Africa", incomeTier: "lower_middle" },
  { code: "SN", name: "Senegal", region: "Africa", incomeTier: "lower_middle" },
  { code: "CI", name: "Ivory Coast", region: "Africa", incomeTier: "lower_middle" },
  { code: "TZ", name: "Tanzania", region: "Africa", incomeTier: "lower_middle" },
  { code: "UG", name: "Uganda", region: "Africa", incomeTier: "low" },
  { code: "ET", name: "Ethiopia", region: "Africa", incomeTier: "low" },
  { code: "RW", name: "Rwanda", region: "Africa", incomeTier: "low" },
  { code: "BW", name: "Botswana", region: "Africa", incomeTier: "upper_middle" },
  { code: "NA", name: "Namibia", region: "Africa", incomeTier: "upper_middle" },
  { code: "MU", name: "Mauritius", region: "Africa", incomeTier: "high" },
  { code: "SC", name: "Seychelles", region: "Africa", incomeTier: "high" },
  { code: "ZM", name: "Zambia", region: "Africa", incomeTier: "lower_middle" },
  { code: "ZW", name: "Zimbabwe", region: "Africa", incomeTier: "lower_middle" },
  { code: "MZ", name: "Mozambique", region: "Africa", incomeTier: "low" },
  { code: "CD", name: "DR Congo", region: "Africa", incomeTier: "low" },
  { code: "CM", name: "Cameroon", region: "Africa", incomeTier: "lower_middle" },

  // ─── Oceania ─────────────────────────────────────────────────────────
  { code: "AU", name: "Australia", region: "Oceania", incomeTier: "high" },
  { code: "NZ", name: "New Zealand", region: "Oceania", incomeTier: "high" },
  { code: "FJ", name: "Fiji", region: "Oceania", incomeTier: "upper_middle" },
  { code: "PG", name: "Papua New Guinea", region: "Oceania", incomeTier: "lower_middle" },
  { code: "NC", name: "New Caledonia", region: "Oceania", incomeTier: "high" },
  { code: "PF", name: "French Polynesia", region: "Oceania", incomeTier: "high" },
  { code: "WS", name: "Samoa", region: "Oceania", incomeTier: "upper_middle" },
  { code: "TO", name: "Tonga", region: "Oceania", incomeTier: "upper_middle" },
  { code: "VU", name: "Vanuatu", region: "Oceania", incomeTier: "lower_middle" },
  { code: "SB", name: "Solomon Islands", region: "Oceania", incomeTier: "lower_middle" },
];

export function countriesInRegion(region: RegionName): CountryInfo[] {
  return COUNTRIES.filter((c) => c.region === region);
}
