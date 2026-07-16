/**
 * Reusable region → countries data.
 *
 * This is the single source of truth for "what countries live inside a
 * region", "how wealthy is this country's economy" (income tier), and
 * "which real, Maps-searchable cities live inside this country"
 * (majorCities). It is pure data — no scraping, no orchestration logic — so
 * it can be reused by the discovery job orchestration
 * (src/jobs/discoverJob.ts, src/jobs/poolExpandJob.ts) and by anything else
 * that needs to reason about regions/countries (analytics, future
 * filtering, etc).
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
 *
 * `majorCities` exists for ONE purpose too: giving the job orchestration
 * (src/jobs/discoverJob.ts's CountryRotation) a real, Maps-searchable place
 * name to put in the engine's `city` field. ROOT CAUSE FIX: this field did
 * not exist before — CountryRotation had nothing but `name` (the country's
 * own name, e.g. "United States") to hand the engine as `city`, so every
 * search was literally "<niche> in United States" / "in Canada" / "in
 * Mexico". Google Maps has no normal per-listing results feed for a
 * country-scale query; it instead tries to render/cluster a nationwide
 * result set with no natural cap, which is what was ballooning the
 * Playwright page's memory until Chromium's renderer OOM-killed itself
 * ("Target crashed"). Each country now lists its 3 largest
 * Maps-searchable cities; CountryRotation cycles through them one at a
 * time before ever marking the whole country exhausted.
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
  /** The country's largest Maps-searchable cities, most-populous first.
   * ALWAYS non-empty — this is what CountryRotation hands the engine as
   * `city`; `name` (the country itself) must never be used as a Maps
   * search location again. See module docblock. */
  majorCities: string[];
}

export const COUNTRIES: CountryInfo[] = [
  // ─── North America (incl. Central America + Caribbean) ─────────────────
  { code: "US", name: "United States", region: "North America", incomeTier: "high", majorCities: ["New York", "Los Angeles", "Chicago"] },
  { code: "CA", name: "Canada", region: "North America", incomeTier: "high", majorCities: ["Toronto", "Montreal", "Vancouver"] },
  { code: "MX", name: "Mexico", region: "North America", incomeTier: "upper_middle", majorCities: ["Mexico City", "Guadalajara", "Monterrey"] },
  { code: "BZ", name: "Belize", region: "North America", incomeTier: "upper_middle", majorCities: ["Belize City", "San Ignacio", "Belmopan"] },
  { code: "CR", name: "Costa Rica", region: "North America", incomeTier: "upper_middle", majorCities: ["San José", "Alajuela", "Heredia"] },
  { code: "SV", name: "El Salvador", region: "North America", incomeTier: "lower_middle", majorCities: ["San Salvador", "Santa Ana", "San Miguel"] },
  { code: "GT", name: "Guatemala", region: "North America", incomeTier: "upper_middle", majorCities: ["Guatemala City", "Mixco", "Villa Nueva"] },
  { code: "HN", name: "Honduras", region: "North America", incomeTier: "lower_middle", majorCities: ["Tegucigalpa", "San Pedro Sula", "Choloma"] },
  { code: "NI", name: "Nicaragua", region: "North America", incomeTier: "lower_middle", majorCities: ["Managua", "León", "Masaya"] },
  { code: "PA", name: "Panama", region: "North America", incomeTier: "high", majorCities: ["Panama City", "San Miguelito", "David"] },
  { code: "BS", name: "Bahamas", region: "North America", incomeTier: "high", majorCities: ["Nassau", "Freeport", "West End"] },
  { code: "BB", name: "Barbados", region: "North America", incomeTier: "high", majorCities: ["Bridgetown", "Speightstown", "Oistins"] },
  { code: "JM", name: "Jamaica", region: "North America", incomeTier: "upper_middle", majorCities: ["Kingston", "Montego Bay", "Spanish Town"] },
  { code: "TT", name: "Trinidad and Tobago", region: "North America", incomeTier: "high", majorCities: ["Port of Spain", "San Fernando", "Chaguanas"] },
  { code: "DO", name: "Dominican Republic", region: "North America", incomeTier: "upper_middle", majorCities: ["Santo Domingo", "Santiago", "Punta Cana"] },
  { code: "CU", name: "Cuba", region: "North America", incomeTier: "lower_middle", majorCities: ["Havana", "Santiago de Cuba", "Camagüey"] },
  { code: "HT", name: "Haiti", region: "North America", incomeTier: "low", majorCities: ["Port-au-Prince", "Cap-Haïtien", "Gonaïves"] },

  // ─── South America ───────────────────────────────────────────────────
  { code: "BR", name: "Brazil", region: "South America", incomeTier: "upper_middle", majorCities: ["São Paulo", "Rio de Janeiro", "Brasília"] },
  { code: "AR", name: "Argentina", region: "South America", incomeTier: "upper_middle", majorCities: ["Buenos Aires", "Córdoba", "Rosario"] },
  { code: "CL", name: "Chile", region: "South America", incomeTier: "high", majorCities: ["Santiago", "Valparaíso", "Concepción"] },
  { code: "CO", name: "Colombia", region: "South America", incomeTier: "upper_middle", majorCities: ["Bogotá", "Medellín", "Cali"] },
  { code: "PE", name: "Peru", region: "South America", incomeTier: "upper_middle", majorCities: ["Lima", "Arequipa", "Trujillo"] },
  { code: "EC", name: "Ecuador", region: "South America", incomeTier: "upper_middle", majorCities: ["Guayaquil", "Quito", "Cuenca"] },
  { code: "UY", name: "Uruguay", region: "South America", incomeTier: "high", majorCities: ["Montevideo", "Salto", "Punta del Este"] },
  { code: "PY", name: "Paraguay", region: "South America", incomeTier: "upper_middle", majorCities: ["Asunción", "Ciudad del Este", "Luque"] },
  { code: "BO", name: "Bolivia", region: "South America", incomeTier: "lower_middle", majorCities: ["Santa Cruz de la Sierra", "La Paz", "Cochabamba"] },
  { code: "VE", name: "Venezuela", region: "South America", incomeTier: "lower_middle", majorCities: ["Caracas", "Maracaibo", "Valencia"] },
  { code: "GY", name: "Guyana", region: "South America", incomeTier: "high", majorCities: ["Georgetown", "Linden", "New Amsterdam"] },
  { code: "SR", name: "Suriname", region: "South America", incomeTier: "upper_middle", majorCities: ["Paramaribo", "Lelydorp", "Nieuw Nickerie"] },

  // ─── Europe ───────────────────────────────────────────────────────────
  { code: "GB", name: "United Kingdom", region: "Europe", incomeTier: "high", majorCities: ["London", "Manchester", "Birmingham"] },
  { code: "DE", name: "Germany", region: "Europe", incomeTier: "high", majorCities: ["Berlin", "Munich", "Hamburg"] },
  { code: "FR", name: "France", region: "Europe", incomeTier: "high", majorCities: ["Paris", "Marseille", "Lyon"] },
  { code: "NL", name: "Netherlands", region: "Europe", incomeTier: "high", majorCities: ["Amsterdam", "Rotterdam", "The Hague"] },
  { code: "SE", name: "Sweden", region: "Europe", incomeTier: "high", majorCities: ["Stockholm", "Gothenburg", "Malmö"] },
  { code: "NO", name: "Norway", region: "Europe", incomeTier: "high", majorCities: ["Oslo", "Bergen", "Trondheim"] },
  { code: "DK", name: "Denmark", region: "Europe", incomeTier: "high", majorCities: ["Copenhagen", "Aarhus", "Odense"] },
  { code: "CH", name: "Switzerland", region: "Europe", incomeTier: "high", majorCities: ["Zurich", "Geneva", "Basel"] },
  { code: "IE", name: "Ireland", region: "Europe", incomeTier: "high", majorCities: ["Dublin", "Cork", "Limerick"] },
  { code: "BE", name: "Belgium", region: "Europe", incomeTier: "high", majorCities: ["Brussels", "Antwerp", "Ghent"] },
  { code: "AT", name: "Austria", region: "Europe", incomeTier: "high", majorCities: ["Vienna", "Graz", "Linz"] },
  { code: "FI", name: "Finland", region: "Europe", incomeTier: "high", majorCities: ["Helsinki", "Espoo", "Tampere"] },
  { code: "IS", name: "Iceland", region: "Europe", incomeTier: "high", majorCities: ["Reykjavík", "Kópavogur", "Akureyri"] },
  { code: "LU", name: "Luxembourg", region: "Europe", incomeTier: "high", majorCities: ["Luxembourg City", "Esch-sur-Alzette", "Differdange"] },
  { code: "IT", name: "Italy", region: "Europe", incomeTier: "high", majorCities: ["Rome", "Milan", "Naples"] },
  { code: "ES", name: "Spain", region: "Europe", incomeTier: "high", majorCities: ["Madrid", "Barcelona", "Valencia"] },
  { code: "PT", name: "Portugal", region: "Europe", incomeTier: "high", majorCities: ["Lisbon", "Porto", "Braga"] },
  { code: "GR", name: "Greece", region: "Europe", incomeTier: "high", majorCities: ["Athens", "Thessaloniki", "Patras"] },
  { code: "MT", name: "Malta", region: "Europe", incomeTier: "high", majorCities: ["Valletta", "Birkirkara", "Mosta"] },
  { code: "CY", name: "Cyprus", region: "Europe", incomeTier: "high", majorCities: ["Nicosia", "Limassol", "Larnaca"] },
  { code: "PL", name: "Poland", region: "Europe", incomeTier: "high", majorCities: ["Warsaw", "Kraków", "Łódź"] },
  { code: "CZ", name: "Czechia", region: "Europe", incomeTier: "high", majorCities: ["Prague", "Brno", "Ostrava"] },
  { code: "SK", name: "Slovakia", region: "Europe", incomeTier: "high", majorCities: ["Bratislava", "Košice", "Prešov"] },
  { code: "SI", name: "Slovenia", region: "Europe", incomeTier: "high", majorCities: ["Ljubljana", "Maribor", "Celje"] },
  { code: "EE", name: "Estonia", region: "Europe", incomeTier: "high", majorCities: ["Tallinn", "Tartu", "Narva"] },
  { code: "LV", name: "Latvia", region: "Europe", incomeTier: "high", majorCities: ["Riga", "Daugavpils", "Liepāja"] },
  { code: "LT", name: "Lithuania", region: "Europe", incomeTier: "high", majorCities: ["Vilnius", "Kaunas", "Klaipėda"] },
  { code: "HU", name: "Hungary", region: "Europe", incomeTier: "upper_middle", majorCities: ["Budapest", "Debrecen", "Szeged"] },
  { code: "RO", name: "Romania", region: "Europe", incomeTier: "upper_middle", majorCities: ["Bucharest", "Cluj-Napoca", "Timișoara"] },
  { code: "BG", name: "Bulgaria", region: "Europe", incomeTier: "upper_middle", majorCities: ["Sofia", "Plovdiv", "Varna"] },
  { code: "HR", name: "Croatia", region: "Europe", incomeTier: "high", majorCities: ["Zagreb", "Split", "Rijeka"] },
  { code: "RS", name: "Serbia", region: "Europe", incomeTier: "upper_middle", majorCities: ["Belgrade", "Novi Sad", "Niš"] },
  { code: "AL", name: "Albania", region: "Europe", incomeTier: "upper_middle", majorCities: ["Tirana", "Durrës", "Vlorë"] },
  { code: "BA", name: "Bosnia and Herzegovina", region: "Europe", incomeTier: "upper_middle", majorCities: ["Sarajevo", "Banja Luka", "Tuzla"] },
  { code: "MK", name: "North Macedonia", region: "Europe", incomeTier: "upper_middle", majorCities: ["Skopje", "Bitola", "Kumanovo"] },
  { code: "ME", name: "Montenegro", region: "Europe", incomeTier: "upper_middle", majorCities: ["Podgorica", "Nikšić", "Herceg Novi"] },
  { code: "MD", name: "Moldova", region: "Europe", incomeTier: "lower_middle", majorCities: ["Chișinău", "Tiraspol", "Bălți"] },
  { code: "UA", name: "Ukraine", region: "Europe", incomeTier: "lower_middle", majorCities: ["Kyiv", "Lviv", "Odesa"] },
  { code: "BY", name: "Belarus", region: "Europe", incomeTier: "upper_middle", majorCities: ["Minsk", "Gomel", "Mogilev"] },

  // ─── Asia ────────────────────────────────────────────────────────────
  { code: "JP", name: "Japan", region: "Asia", incomeTier: "high", majorCities: ["Tokyo", "Osaka", "Yokohama"] },
  { code: "KR", name: "South Korea", region: "Asia", incomeTier: "high", majorCities: ["Seoul", "Busan", "Incheon"] },
  { code: "SG", name: "Singapore", region: "Asia", incomeTier: "high", majorCities: ["Singapore", "Jurong East", "Tampines"] },
  { code: "AE", name: "United Arab Emirates", region: "Asia", incomeTier: "high", majorCities: ["Dubai", "Abu Dhabi", "Sharjah"] },
  { code: "QA", name: "Qatar", region: "Asia", incomeTier: "high", majorCities: ["Doha", "Al Rayyan", "Al Wakrah"] },
  { code: "SA", name: "Saudi Arabia", region: "Asia", incomeTier: "high", majorCities: ["Riyadh", "Jeddah", "Mecca"] },
  { code: "KW", name: "Kuwait", region: "Asia", incomeTier: "high", majorCities: ["Kuwait City", "Hawalli", "Salmiya"] },
  { code: "BH", name: "Bahrain", region: "Asia", incomeTier: "high", majorCities: ["Manama", "Riffa", "Muharraq"] },
  { code: "IL", name: "Israel", region: "Asia", incomeTier: "high", majorCities: ["Tel Aviv", "Jerusalem", "Haifa"] },
  { code: "TW", name: "Taiwan", region: "Asia", incomeTier: "high", majorCities: ["Taipei", "Kaohsiung", "Taichung"] },
  { code: "HK", name: "Hong Kong", region: "Asia", incomeTier: "high", majorCities: ["Hong Kong", "Kowloon", "Tsuen Wan"] },
  { code: "MY", name: "Malaysia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Kuala Lumpur", "George Town", "Johor Bahru"] },
  { code: "CN", name: "China", region: "Asia", incomeTier: "upper_middle", majorCities: ["Shanghai", "Beijing", "Shenzhen"] },
  { code: "TH", name: "Thailand", region: "Asia", incomeTier: "upper_middle", majorCities: ["Bangkok", "Chiang Mai", "Pattaya"] },
  { code: "TR", name: "Turkey", region: "Asia", incomeTier: "upper_middle", majorCities: ["Istanbul", "Ankara", "Izmir"] },
  { code: "KZ", name: "Kazakhstan", region: "Asia", incomeTier: "upper_middle", majorCities: ["Almaty", "Astana", "Shymkent"] },
  { code: "GE", name: "Georgia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Tbilisi", "Batumi", "Kutaisi"] },
  { code: "AM", name: "Armenia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Yerevan", "Gyumri", "Vanadzor"] },
  { code: "JO", name: "Jordan", region: "Asia", incomeTier: "upper_middle", majorCities: ["Amman", "Zarqa", "Irbid"] },
  { code: "LB", name: "Lebanon", region: "Asia", incomeTier: "lower_middle", majorCities: ["Beirut", "Tripoli", "Sidon"] },
  { code: "ID", name: "Indonesia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Jakarta", "Surabaya", "Bandung"] },
  { code: "VN", name: "Vietnam", region: "Asia", incomeTier: "lower_middle", majorCities: ["Ho Chi Minh City", "Hanoi", "Da Nang"] },
  { code: "PH", name: "Philippines", region: "Asia", incomeTier: "lower_middle", majorCities: ["Manila", "Quezon City", "Cebu City"] },
  { code: "IN", name: "India", region: "Asia", incomeTier: "lower_middle", majorCities: ["Mumbai", "Delhi", "Bangalore"] },
  { code: "PK", name: "Pakistan", region: "Asia", incomeTier: "lower_middle", majorCities: ["Karachi", "Lahore", "Islamabad"] },
  { code: "BD", name: "Bangladesh", region: "Asia", incomeTier: "lower_middle", majorCities: ["Dhaka", "Chittagong", "Khulna"] },
  { code: "LK", name: "Sri Lanka", region: "Asia", incomeTier: "lower_middle", majorCities: ["Colombo", "Kandy", "Galle"] },
  { code: "NP", name: "Nepal", region: "Asia", incomeTier: "low", majorCities: ["Kathmandu", "Pokhara", "Lalitpur"] },
  { code: "KH", name: "Cambodia", region: "Asia", incomeTier: "lower_middle", majorCities: ["Phnom Penh", "Siem Reap", "Battambang"] },
  { code: "MM", name: "Myanmar", region: "Asia", incomeTier: "low", majorCities: ["Yangon", "Mandalay", "Naypyidaw"] },
  { code: "AF", name: "Afghanistan", region: "Asia", incomeTier: "low", majorCities: ["Kabul", "Kandahar", "Herat"] },

  // ─── Africa ──────────────────────────────────────────────────────────
  { code: "ZA", name: "South Africa", region: "Africa", incomeTier: "upper_middle", majorCities: ["Johannesburg", "Cape Town", "Durban"] },
  { code: "EG", name: "Egypt", region: "Africa", incomeTier: "lower_middle", majorCities: ["Cairo", "Alexandria", "Giza"] },
  { code: "MA", name: "Morocco", region: "Africa", incomeTier: "lower_middle", majorCities: ["Casablanca", "Rabat", "Marrakesh"] },
  { code: "TN", name: "Tunisia", region: "Africa", incomeTier: "lower_middle", majorCities: ["Tunis", "Sfax", "Sousse"] },
  { code: "DZ", name: "Algeria", region: "Africa", incomeTier: "upper_middle", majorCities: ["Algiers", "Oran", "Constantine"] },
  { code: "NG", name: "Nigeria", region: "Africa", incomeTier: "lower_middle", majorCities: ["Lagos", "Abuja", "Kano"] },
  { code: "KE", name: "Kenya", region: "Africa", incomeTier: "lower_middle", majorCities: ["Nairobi", "Mombasa", "Kisumu"] },
  { code: "GH", name: "Ghana", region: "Africa", incomeTier: "lower_middle", majorCities: ["Accra", "Kumasi", "Tamale"] },
  { code: "SN", name: "Senegal", region: "Africa", incomeTier: "lower_middle", majorCities: ["Dakar", "Touba", "Thiès"] },
  { code: "CI", name: "Ivory Coast", region: "Africa", incomeTier: "lower_middle", majorCities: ["Abidjan", "Yamoussoukro", "Bouaké"] },
  { code: "TZ", name: "Tanzania", region: "Africa", incomeTier: "lower_middle", majorCities: ["Dar es Salaam", "Dodoma", "Mwanza"] },
  { code: "UG", name: "Uganda", region: "Africa", incomeTier: "low", majorCities: ["Kampala", "Gulu", "Lira"] },
  { code: "ET", name: "Ethiopia", region: "Africa", incomeTier: "low", majorCities: ["Addis Ababa", "Dire Dawa", "Mekelle"] },
  { code: "RW", name: "Rwanda", region: "Africa", incomeTier: "low", majorCities: ["Kigali", "Huye", "Musanze"] },
  { code: "BW", name: "Botswana", region: "Africa", incomeTier: "upper_middle", majorCities: ["Gaborone", "Francistown", "Molepolole"] },
  { code: "NA", name: "Namibia", region: "Africa", incomeTier: "upper_middle", majorCities: ["Windhoek", "Walvis Bay", "Swakopmund"] },
  { code: "MU", name: "Mauritius", region: "Africa", incomeTier: "high", majorCities: ["Port Louis", "Beau Bassin-Rose Hill", "Vacoas-Phoenix"] },
  { code: "SC", name: "Seychelles", region: "Africa", incomeTier: "high", majorCities: ["Victoria", "Anse Boileau", "Beau Vallon"] },
  { code: "ZM", name: "Zambia", region: "Africa", incomeTier: "lower_middle", majorCities: ["Lusaka", "Kitwe", "Ndola"] },
  { code: "ZW", name: "Zimbabwe", region: "Africa", incomeTier: "lower_middle", majorCities: ["Harare", "Bulawayo", "Chitungwiza"] },
  { code: "MZ", name: "Mozambique", region: "Africa", incomeTier: "low", majorCities: ["Maputo", "Matola", "Beira"] },
  { code: "CD", name: "DR Congo", region: "Africa", incomeTier: "low", majorCities: ["Kinshasa", "Lubumbashi", "Mbuji-Mayi"] },
  { code: "CM", name: "Cameroon", region: "Africa", incomeTier: "lower_middle", majorCities: ["Douala", "Yaoundé", "Garoua"] },

  // ─── Oceania ─────────────────────────────────────────────────────────
  { code: "AU", name: "Australia", region: "Oceania", incomeTier: "high", majorCities: ["Sydney", "Melbourne", "Brisbane"] },
  { code: "NZ", name: "New Zealand", region: "Oceania", incomeTier: "high", majorCities: ["Auckland", "Wellington", "Christchurch"] },
  { code: "FJ", name: "Fiji", region: "Oceania", incomeTier: "upper_middle", majorCities: ["Suva", "Nadi", "Lautoka"] },
  { code: "PG", name: "Papua New Guinea", region: "Oceania", incomeTier: "lower_middle", majorCities: ["Port Moresby", "Lae", "Mount Hagen"] },
  { code: "NC", name: "New Caledonia", region: "Oceania", incomeTier: "high", majorCities: ["Nouméa", "Mont-Dore", "Dumbéa"] },
  { code: "PF", name: "French Polynesia", region: "Oceania", incomeTier: "high", majorCities: ["Papeete", "Faaa", "Punaauia"] },
  { code: "WS", name: "Samoa", region: "Oceania", incomeTier: "upper_middle", majorCities: ["Apia", "Vaitele", "Faleula"] },
  { code: "TO", name: "Tonga", region: "Oceania", incomeTier: "upper_middle", majorCities: ["Nuku'alofa", "Neiafu", "Haveluloto"] },
  { code: "VU", name: "Vanuatu", region: "Oceania", incomeTier: "lower_middle", majorCities: ["Port Vila", "Luganville", "Norsup"] },
  { code: "SB", name: "Solomon Islands", region: "Oceania", incomeTier: "lower_middle", majorCities: ["Honiara", "Auki", "Gizo"] },
];

export function countriesInRegion(region: RegionName): CountryInfo[] {
  return COUNTRIES.filter((c) => c.region === region);
}
