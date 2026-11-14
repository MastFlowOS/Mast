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
 *
 * GEOGRAPHIC SCOPE, TERMINOLOGY: `region`/`country` is the user-facing
 * request scope — Global, a continent, or a country (see ./scope.ts for the
 * parser and resolveCountriesForSelection in ./regions.ts). `city` (`majorCities`) is an
 * INTERNAL discovery work unit only — it is never a product-level
 * geographic selector, has no request-schema field, and is not something a
 * caller picks. A single country-scoped request intentionally expands into
 * multiple internal city discovery_tasks (see planner.ts's
 * materializeDiscoveryPlan doc comment) that all share one plan-level
 * target — that fan-out is the intended distribution strategy, not scope
 * creep.
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
  {
    code: "US",
    name: "United States",
    region: "North America",
    incomeTier: "high",
    majorCities: [
      "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia",
      "San Antonio", "San Diego", "Dallas", "San Jose", "Austin", "Jacksonville",
      "Fort Worth", "Columbus", "Charlotte", "Indianapolis", "San Francisco",
      "Seattle", "Denver", "Washington", "Nashville", "Oklahoma City", "El Paso",
      "Boston", "Portland", "Las Vegas", "Detroit", "Memphis", "Louisville",
      "Baltimore", "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Sacramento",
      "Kansas City", "Atlanta", "Omaha", "Raleigh", "Miami", "Minneapolis",
      "Cleveland", "New Orleans", "Tampa", "Honolulu", "Anchorage", "Boise",
      "Salt Lake City", "Des Moines", "Little Rock", "Huntsville", "Charleston",
      "Providence", "Hartford", "Richmond", "Pittsburgh", "Cincinnati", "St. Louis",
      "Orlando", "Madison", "Fargo", "Sioux Falls", "Cheyenne", "Billings",
      "Burlington", "Concord", "Wilmington",
    ],
  },
  {
    code: "CA",
    name: "Canada",
    region: "North America",
    incomeTier: "high",
    majorCities: [
      "Toronto", "Montreal", "Vancouver", "Calgary", "Edmonton", "Ottawa",
      "Winnipeg", "Quebec City", "Hamilton", "Kitchener", "Kelowna", "Victoria",
      "Halifax", "Saskatoon", "Regina",
    ],
  },
  {
    code: "MX",
    name: "Mexico",
    region: "North America",
    incomeTier: "upper_middle",
    majorCities: [
      "Mexico City", "Guadalajara", "Monterrey", "Puebla", "Tijuana", "León",
      "Juárez", "Zapopan", "Mérida", "Querétaro", "San Luis Potosí",
      "Aguascalientes", "Cancún", "Oaxaca", "Playa del Carmen",
    ],
  },
  { code: "BZ", name: "Belize", region: "North America", incomeTier: "upper_middle", majorCities: ["Belize City", "San Ignacio", "Belmopan", "Orange Walk", "San Pedro"] },
  { code: "CR", name: "Costa Rica", region: "North America", incomeTier: "upper_middle", majorCities: ["San José", "Alajuela", "Heredia", "Cartago", "Liberia", "Limón", "Puntarenas"] },
  { code: "SV", name: "El Salvador", region: "North America", incomeTier: "lower_middle", majorCities: ["San Salvador", "Santa Ana", "San Miguel", "Soyapango", "Santa Tecla"] },
  { code: "GT", name: "Guatemala", region: "North America", incomeTier: "upper_middle", majorCities: ["Guatemala City", "Mixco", "Villa Nueva", "Quetzaltenango", "Antigua Guatemala", "Escuintla"] },
  { code: "HN", name: "Honduras", region: "North America", incomeTier: "lower_middle", majorCities: ["Tegucigalpa", "San Pedro Sula", "Choloma", "La Ceiba", "El Progreso"] },
  { code: "NI", name: "Nicaragua", region: "North America", incomeTier: "lower_middle", majorCities: ["Managua", "León", "Masaya", "Matagalpa", "Granada"] },
  { code: "PA", name: "Panama", region: "North America", incomeTier: "high", majorCities: ["Panama City", "San Miguelito", "David", "Colón", "Santiago", "Boquete"] },
  { code: "BS", name: "Bahamas", region: "North America", incomeTier: "high", majorCities: ["Nassau", "Freeport", "West End", "Marsh Harbour", "George Town"] },
  { code: "BB", name: "Barbados", region: "North America", incomeTier: "high", majorCities: ["Bridgetown", "Speightstown", "Oistins", "Holetown"] },
  { code: "JM", name: "Jamaica", region: "North America", incomeTier: "upper_middle", majorCities: ["Kingston", "Montego Bay", "Spanish Town", "Portmore", "Ocho Rios", "Mandeville"] },
  { code: "TT", name: "Trinidad and Tobago", region: "North America", incomeTier: "high", majorCities: ["Port of Spain", "San Fernando", "Chaguanas", "Arima", "Scarborough"] },
  { code: "DO", name: "Dominican Republic", region: "North America", incomeTier: "upper_middle", majorCities: ["Santo Domingo", "Santiago", "Punta Cana", "La Romana", "Puerto Plata", "San Pedro de Macorís"] },
  { code: "CU", name: "Cuba", region: "North America", incomeTier: "lower_middle", majorCities: ["Havana", "Santiago de Cuba", "Camagüey", "Holguín", "Santa Clara", "Matanzas"] },
  { code: "HT", name: "Haiti", region: "North America", incomeTier: "low", majorCities: ["Port-au-Prince", "Cap-Haïtien", "Gonaïves", "Les Cayes", "Jacmel"] },

  // ─── South America ───────────────────────────────────────────────────
  {
    code: "BR",
    name: "Brazil",
    region: "South America",
    incomeTier: "upper_middle",
    majorCities: [
      "São Paulo", "Rio de Janeiro", "Brasília", "Salvador", "Fortaleza",
      "Belo Horizonte", "Manaus", "Curitiba", "Recife", "Porto Alegre",
      "Goiânia", "Belém", "Florianópolis", "Campinas", "Vitória", "Natal",
    ],
  },
  {
    code: "AR",
    name: "Argentina",
    region: "South America",
    incomeTier: "upper_middle",
    majorCities: [
      "Buenos Aires", "Córdoba", "Rosario", "Mendoza", "La Plata",
      "San Miguel de Tucumán", "Mar del Plata", "Salta", "Santa Fe", "Bariloche",
    ],
  },
  { code: "CL", name: "Chile", region: "South America", incomeTier: "high", majorCities: ["Santiago", "Valparaíso", "Concepción", "Viña del Mar", "Antofagasta", "Temuco", "Puerto Montt", "La Serena"] },
  { code: "CO", name: "Colombia", region: "South America", incomeTier: "upper_middle", majorCities: ["Bogotá", "Medellín", "Cali", "Barranquilla", "Cartagena", "Bucaramanga", "Pereira", "Santa Marta"] },
  { code: "PE", name: "Peru", region: "South America", incomeTier: "upper_middle", majorCities: ["Lima", "Arequipa", "Trujillo", "Chiclayo", "Cusco", "Piura", "Iquitos"] },
  { code: "EC", name: "Ecuador", region: "South America", incomeTier: "upper_middle", majorCities: ["Guayaquil", "Quito", "Cuenca", "Santo Domingo", "Ambato", "Manta"] },
  { code: "UY", name: "Uruguay", region: "South America", incomeTier: "high", majorCities: ["Montevideo", "Salto", "Punta del Este", "Paysandú", "Maldonado"] },
  { code: "PY", name: "Paraguay", region: "South America", incomeTier: "upper_middle", majorCities: ["Asunción", "Ciudad del Este", "Luque", "San Lorenzo", "Encarnación"] },
  { code: "BO", name: "Bolivia", region: "South America", incomeTier: "lower_middle", majorCities: ["Santa Cruz de la Sierra", "La Paz", "Cochabamba", "Sucre", "Oruro", "Tarija"] },
  { code: "VE", name: "Venezuela", region: "South America", incomeTier: "lower_middle", majorCities: ["Caracas", "Maracaibo", "Valencia", "Barquisimeto", "Maracay", "Mérida"] },
  { code: "GY", name: "Guyana", region: "South America", incomeTier: "high", majorCities: ["Georgetown", "Linden", "New Amsterdam", "Anna Regina"] },
  { code: "SR", name: "Suriname", region: "South America", incomeTier: "upper_middle", majorCities: ["Paramaribo", "Lelydorp", "Nieuw Nickerie", "Moengo"] },

  // ─── Europe ───────────────────────────────────────────────────────────
  {
    code: "GB",
    name: "United Kingdom",
    region: "Europe",
    incomeTier: "high",
    majorCities: [
      "London", "Manchester", "Birmingham", "Leeds", "Glasgow", "Liverpool",
      "Bristol", "Edinburgh", "Sheffield", "Newcastle upon Tyne", "Nottingham",
      "Cardiff", "Belfast", "Brighton", "Cambridge", "Oxford", "Leicester", "Southampton",
    ],
  },
  {
    code: "DE",
    name: "Germany",
    region: "Europe",
    incomeTier: "high",
    majorCities: [
      "Berlin", "Munich", "Hamburg", "Cologne", "Frankfurt", "Stuttgart",
      "Düsseldorf", "Leipzig", "Dortmund", "Essen", "Bremen", "Dresden",
      "Hanover", "Nuremberg", "Duisburg", "Bochum", "Bonn", "Münster",
    ],
  },
  {
    code: "FR",
    name: "France",
    region: "Europe",
    incomeTier: "high",
    majorCities: [
      "Paris", "Marseille", "Lyon", "Toulouse", "Nice", "Nantes",
      "Montpellier", "Strasbourg", "Bordeaux", "Lille", "Rennes", "Reims",
      "Toulon", "Grenoble", "Dijon",
    ],
  },
  { code: "NL", name: "Netherlands", region: "Europe", incomeTier: "high", majorCities: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht", "Eindhoven", "Groningen", "Tilburg", "Almere", "Breda", "Haarlem"] },
  { code: "SE", name: "Sweden", region: "Europe", incomeTier: "high", majorCities: ["Stockholm", "Gothenburg", "Malmö", "Uppsala", "Västerås", "Örebro", "Linköping", "Helsingborg"] },
  { code: "NO", name: "Norway", region: "Europe", incomeTier: "high", majorCities: ["Oslo", "Bergen", "Trondheim", "Stavanger", "Drammen", "Tromsø", "Kristiansand"] },
  { code: "DK", name: "Denmark", region: "Europe", incomeTier: "high", majorCities: ["Copenhagen", "Aarhus", "Odense", "Aalborg", "Esbjerg", "Roskilde"] },
  { code: "CH", name: "Switzerland", region: "Europe", incomeTier: "high", majorCities: ["Zurich", "Geneva", "Basel", "Lausanne", "Bern", "Winterthur", "Lucerne", "St. Gallen"] },
  { code: "IE", name: "Ireland", region: "Europe", incomeTier: "high", majorCities: ["Dublin", "Cork", "Limerick", "Galway", "Waterford", "Kilkenny"] },
  { code: "BE", name: "Belgium", region: "Europe", incomeTier: "high", majorCities: ["Brussels", "Antwerp", "Ghent", "Charleroi", "Liège", "Bruges", "Namur", "Leuven"] },
  { code: "AT", name: "Austria", region: "Europe", incomeTier: "high", majorCities: ["Vienna", "Graz", "Linz", "Salzburg", "Innsbruck", "Klagenfurt"] },
  { code: "FI", name: "Finland", region: "Europe", incomeTier: "high", majorCities: ["Helsinki", "Espoo", "Tampere", "Vantaa", "Oulu", "Turku", "Jyväskylä"] },
  { code: "IS", name: "Iceland", region: "Europe", incomeTier: "high", majorCities: ["Reykjavík", "Kópavogur", "Akureyri", "Hafnarfjörður"] },
  { code: "LU", name: "Luxembourg", region: "Europe", incomeTier: "high", majorCities: ["Luxembourg City", "Esch-sur-Alzette", "Differdange", "Dudelange"] },
  {
    code: "IT",
    name: "Italy",
    region: "Europe",
    incomeTier: "high",
    majorCities: [
      "Rome", "Milan", "Naples", "Turin", "Palermo", "Genoa", "Bologna",
      "Florence", "Bari", "Catania", "Venice", "Verona", "Padua", "Trieste",
    ],
  },
  {
    code: "ES",
    name: "Spain",
    region: "Europe",
    incomeTier: "high",
    majorCities: [
      "Madrid", "Barcelona", "Valencia", "Seville", "Zaragoza", "Málaga",
      "Murcia", "Palma", "Las Palmas", "Bilbao", "Alicante", "Córdoba",
      "Valladolid", "Granada",
    ],
  },
  { code: "PT", name: "Portugal", region: "Europe", incomeTier: "high", majorCities: ["Lisbon", "Porto", "Braga", "Coimbra", "Funchal", "Setúbal", "Aveiro", "Faro"] },
  { code: "GR", name: "Greece", region: "Europe", incomeTier: "high", majorCities: ["Athens", "Thessaloniki", "Patras", "Heraklion", "Larissa", "Volos", "Rhodes"] },
  { code: "MT", name: "Malta", region: "Europe", incomeTier: "high", majorCities: ["Valletta", "Birkirkara", "Mosta", "Sliema", "St. Julian's"] },
  { code: "CY", name: "Cyprus", region: "Europe", incomeTier: "high", majorCities: ["Nicosia", "Limassol", "Larnaca", "Paphos", "Ayia Napa"] },
  { code: "PL", name: "Poland", region: "Europe", incomeTier: "high", majorCities: ["Warsaw", "Kraków", "Łódź", "Wrocław", "Poznań", "Gdańsk", "Szczecin", "Bydgoszcz", "Lublin", "Katowice"] },
  { code: "CZ", name: "Czechia", region: "Europe", incomeTier: "high", majorCities: ["Prague", "Brno", "Ostrava", "Plzeň", "Liberec", "Olomouc"] },
  { code: "SK", name: "Slovakia", region: "Europe", incomeTier: "high", majorCities: ["Bratislava", "Košice", "Prešov", "Žilina", "Nitra", "Banská Bystrica"] },
  { code: "SI", name: "Slovenia", region: "Europe", incomeTier: "high", majorCities: ["Ljubljana", "Maribor", "Celje", "Kranj", "Koper"] },
  { code: "EE", name: "Estonia", region: "Europe", incomeTier: "high", majorCities: ["Tallinn", "Tartu", "Narva", "Pärnu"] },
  { code: "LV", name: "Latvia", region: "Europe", incomeTier: "high", majorCities: ["Riga", "Daugavpils", "Liepāja", "Jelgava", "Jūrmala"] },
  { code: "LT", name: "Lithuania", region: "Europe", incomeTier: "high", majorCities: ["Vilnius", "Kaunas", "Klaipėda", "Šiauliai", "Panevėžys"] },
  { code: "HU", name: "Hungary", region: "Europe", incomeTier: "upper_middle", majorCities: ["Budapest", "Debrecen", "Szeged", "Miskolc", "Pécs", "Győr"] },
  { code: "RO", name: "Romania", region: "Europe", incomeTier: "upper_middle", majorCities: ["Bucharest", "Cluj-Napoca", "Timișoara", "Iași", "Constanța", "Brașov", "Sibiu"] },
  { code: "BG", name: "Bulgaria", region: "Europe", incomeTier: "upper_middle", majorCities: ["Sofia", "Plovdiv", "Varna", "Burgas", "Ruse", "Stara Zagora"] },
  { code: "HR", name: "Croatia", region: "Europe", incomeTier: "high", majorCities: ["Zagreb", "Split", "Rijeka", "Osijek", "Zadar", "Dubrovnik"] },
  { code: "RS", name: "Serbia", region: "Europe", incomeTier: "upper_middle", majorCities: ["Belgrade", "Novi Sad", "Niš", "Kragujevac", "Subotica"] },
  { code: "AL", name: "Albania", region: "Europe", incomeTier: "upper_middle", majorCities: ["Tirana", "Durrës", "Vlorë", "Shkodër", "Elbasan"] },
  { code: "BA", name: "Bosnia and Herzegovina", region: "Europe", incomeTier: "upper_middle", majorCities: ["Sarajevo", "Banja Luka", "Tuzla", "Zenica", "Mostar"] },
  { code: "MK", name: "North Macedonia", region: "Europe", incomeTier: "upper_middle", majorCities: ["Skopje", "Bitola", "Kumanovo", "Ohrid", "Tetovo"] },
  { code: "ME", name: "Montenegro", region: "Europe", incomeTier: "upper_middle", majorCities: ["Podgorica", "Nikšić", "Herceg Novi", "Budva", "Bar"] },
  { code: "MD", name: "Moldova", region: "Europe", incomeTier: "lower_middle", majorCities: ["Chișinău", "Tiraspol", "Bălți", "Cahul"] },
  { code: "UA", name: "Ukraine", region: "Europe", incomeTier: "lower_middle", majorCities: ["Kyiv", "Lviv", "Odesa", "Kharkiv", "Dnipro", "Zaporizhzhia", "Ivano-Frankivsk"] },
  { code: "BY", name: "Belarus", region: "Europe", incomeTier: "upper_middle", majorCities: ["Minsk", "Gomel", "Mogilev", "Vitebsk", "Grodno", "Brest"] },

  // ─── Asia ────────────────────────────────────────────────────────────
  {
    code: "JP",
    name: "Japan",
    region: "Asia",
    incomeTier: "high",
    majorCities: [
      "Tokyo", "Osaka", "Yokohama", "Nagoya", "Sapporo", "Fukuoka",
      "Kobe", "Kyoto", "Kawasaki", "Saitama", "Hiroshima", "Sendai",
    ],
  },
  { code: "KR", name: "South Korea", region: "Asia", incomeTier: "high", majorCities: ["Seoul", "Busan", "Incheon", "Daegu", "Daejeon", "Gwangju", "Suwon", "Ulsan", "Jeju"] },
  { code: "SG", name: "Singapore", region: "Asia", incomeTier: "high", majorCities: ["Singapore", "Jurong East", "Tampines", "Woodlands", "Orchard", "Marina Bay"] },
  { code: "AE", name: "United Arab Emirates", region: "Asia", incomeTier: "high", majorCities: ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Al Ain", "Ras Al Khaimah", "Fujairah"] },
  { code: "QA", name: "Qatar", region: "Asia", incomeTier: "high", majorCities: ["Doha", "Al Rayyan", "Al Wakrah", "Lusail", "Al Khor"] },
  { code: "SA", name: "Saudi Arabia", region: "Asia", incomeTier: "high", majorCities: ["Riyadh", "Jeddah", "Mecca", "Medina", "Dammam", "Khobar", "Abha", "Tabuk", "Taif"] },
  { code: "KW", name: "Kuwait", region: "Asia", incomeTier: "high", majorCities: ["Kuwait City", "Hawalli", "Salmiya", "Farwaniya", "Ahmadi"] },
  { code: "BH", name: "Bahrain", region: "Asia", incomeTier: "high", majorCities: ["Manama", "Riffa", "Muharraq", "Hamad Town", "Isa Town"] },
  { code: "PS", name: "Palestine", region: "Asia", incomeTier: "lower_middle", majorCities: ["Ramallah", "Nablus", "Hebron", "Bethlehem", "Jericho"] },
  { code: "TW", name: "Taiwan", region: "Asia", incomeTier: "high", majorCities: ["Taipei", "Kaohsiung", "Taichung", "Tainan", "New Taipei", "Hsinchu"] },
  { code: "HK", name: "Hong Kong", region: "Asia", incomeTier: "high", majorCities: ["Hong Kong", "Kowloon", "Tsuen Wan", "Sha Tin", "Causeway Bay"] },
  { code: "MY", name: "Malaysia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Kuala Lumpur", "George Town", "Johor Bahru", "Ipoh", "Petaling Jaya", "Shah Alam", "Kota Kinabalu", "Kuching"] },
  { code: "CN", name: "China", region: "Asia", incomeTier: "upper_middle", majorCities: ["Shanghai", "Beijing", "Shenzhen", "Guangzhou", "Chengdu", "Hangzhou", "Wuhan", "Xi'an", "Nanjing", "Suzhou", "Chongqing", "Tianjin"] },
  { code: "TH", name: "Thailand", region: "Asia", incomeTier: "upper_middle", majorCities: ["Bangkok", "Chiang Mai", "Pattaya", "Phuket", "Nonthaburi", "Hat Yai", "Khon Kaen", "Nakhon Ratchasima"] },
  { code: "TR", name: "Turkey", region: "Asia", incomeTier: "upper_middle", majorCities: ["Istanbul", "Ankara", "Izmir", "Bursa", "Antalya", "Adana", "Konya", "Gaziantep", "Mersin", "Eskişehir"] },
  { code: "KZ", name: "Kazakhstan", region: "Asia", incomeTier: "upper_middle", majorCities: ["Almaty", "Astana", "Shymkent", "Karaganda", "Aktobe"] },
  { code: "GE", name: "Georgia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Tbilisi", "Batumi", "Kutaisi", "Rustavi"] },
  { code: "AM", name: "Armenia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Yerevan", "Gyumri", "Vanadzor"] },
  { code: "JO", name: "Jordan", region: "Asia", incomeTier: "upper_middle", majorCities: ["Amman", "Zarqa", "Irbid", "Aqaba", "Madaba"] },
  { code: "LB", name: "Lebanon", region: "Asia", incomeTier: "lower_middle", majorCities: ["Beirut", "Tripoli", "Sidon", "Jounieh", "Byblos"] },
  { code: "ID", name: "Indonesia", region: "Asia", incomeTier: "upper_middle", majorCities: ["Jakarta", "Surabaya", "Bandung", "Medan", "Semarang", "Makassar", "Yogyakarta", "Denpasar", "Tangerang", "Bekasi"] },
  { code: "VN", name: "Vietnam", region: "Asia", incomeTier: "lower_middle", majorCities: ["Ho Chi Minh City", "Hanoi", "Da Nang", "Hai Phong", "Can Tho", "Nha Trang", "Hue"] },
  { code: "PH", name: "Philippines", region: "Asia", incomeTier: "lower_middle", majorCities: ["Manila", "Quezon City", "Cebu City", "Davao City", "Makati", "Taguig", "Iloilo City", "Baguio"] },
  {
    code: "IN",
    name: "India",
    region: "Asia",
    incomeTier: "lower_middle",
    majorCities: [
      "Mumbai", "Delhi", "Bangalore", "Hyderabad", "Ahmedabad", "Chennai",
      "Kolkata", "Pune", "Jaipur", "Surat", "Lucknow", "Kochi", "Chandigarh", "Indore",
    ],
  },
  { code: "PK", name: "Pakistan", region: "Asia", incomeTier: "lower_middle", majorCities: ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar"] },
  { code: "BD", name: "Bangladesh", region: "Asia", incomeTier: "lower_middle", majorCities: ["Dhaka", "Chittagong", "Khulna", "Rajshahi", "Sylhet"] },
  { code: "LK", name: "Sri Lanka", region: "Asia", incomeTier: "lower_middle", majorCities: ["Colombo", "Kandy", "Galle", "Negombo", "Jaffna"] },
  { code: "NP", name: "Nepal", region: "Asia", incomeTier: "low", majorCities: ["Kathmandu", "Pokhara", "Lalitpur", "Biratnagar"] },
  { code: "KH", name: "Cambodia", region: "Asia", incomeTier: "lower_middle", majorCities: ["Phnom Penh", "Siem Reap", "Battambang", "Sihanoukville"] },
  { code: "MM", name: "Myanmar", region: "Asia", incomeTier: "low", majorCities: ["Yangon", "Mandalay", "Naypyidaw", "Mawlamyine"] },
  { code: "AF", name: "Afghanistan", region: "Asia", incomeTier: "low", majorCities: ["Kabul", "Kandahar", "Herat", "Mazar-i-Sharif"] },

  // ─── Africa ──────────────────────────────────────────────────────────
  {
    code: "ZA",
    name: "South Africa",
    region: "Africa",
    incomeTier: "upper_middle",
    majorCities: [
      "Johannesburg", "Cape Town", "Durban", "Pretoria", "Gqeberha",
      "Bloemfontein", "Stellenbosch", "Pietermaritzburg", "East London",
      "Polokwane", "Nelspruit", "Kimberley",
    ],
  },
  {
    code: "EG",
    name: "Egypt",
    region: "Africa",
    incomeTier: "lower_middle",
    majorCities: [
      "Cairo", "Alexandria", "Giza", "Sharm El Sheikh", "Hurghada",
      "Luxor", "Aswan", "Mansoura", "Tanta", "Port Said", "Suez", "Ismailia",
    ],
  },
  { code: "MA", name: "Morocco", region: "Africa", incomeTier: "lower_middle", majorCities: ["Casablanca", "Rabat", "Marrakesh", "Fes", "Tangier", "Agadir", "Meknes", "Oujda"] },
  { code: "TN", name: "Tunisia", region: "Africa", incomeTier: "lower_middle", majorCities: ["Tunis", "Sfax", "Sousse", "Kairouan", "Bizerte", "Gabes"] },
  { code: "DZ", name: "Algeria", region: "Africa", incomeTier: "upper_middle", majorCities: ["Algiers", "Oran", "Constantine", "Annaba", "Blida", "Batna", "Setif"] },
  { code: "NG", name: "Nigeria", region: "Africa", incomeTier: "lower_middle", majorCities: ["Lagos", "Abuja", "Kano", "Ibadan", "Port Harcourt", "Benin City", "Kaduna", "Enugu"] },
  { code: "KE", name: "Kenya", region: "Africa", incomeTier: "lower_middle", majorCities: ["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret", "Thika"] },
  { code: "GH", name: "Ghana", region: "Africa", incomeTier: "lower_middle", majorCities: ["Accra", "Kumasi", "Tamale", "Takoradi", "Tema", "Cape Coast"] },
  { code: "SN", name: "Senegal", region: "Africa", incomeTier: "lower_middle", majorCities: ["Dakar", "Touba", "Thiès", "Saint-Louis", "Kaolack"] },
  { code: "CI", name: "Ivory Coast", region: "Africa", incomeTier: "lower_middle", majorCities: ["Abidjan", "Yamoussoukro", "Bouaké", "San-Pédro", "Daloa"] },
  { code: "TZ", name: "Tanzania", region: "Africa", incomeTier: "lower_middle", majorCities: ["Dar es Salaam", "Dodoma", "Mwanza", "Arusha", "Zanzibar City", "Mbeya"] },
  { code: "UG", name: "Uganda", region: "Africa", incomeTier: "low", majorCities: ["Kampala", "Gulu", "Lira", "Mbarara", "Jinja", "Entebbe"] },
  { code: "ET", name: "Ethiopia", region: "Africa", incomeTier: "low", majorCities: ["Addis Ababa", "Dire Dawa", "Mekelle", "Gondar", "Hawassa", "Adama"] },
  { code: "RW", name: "Rwanda", region: "Africa", incomeTier: "low", majorCities: ["Kigali", "Huye", "Musanze", "Rubavu"] },
  { code: "BW", name: "Botswana", region: "Africa", incomeTier: "upper_middle", majorCities: ["Gaborone", "Francistown", "Molepolole", "Maun"] },
  { code: "NA", name: "Namibia", region: "Africa", incomeTier: "upper_middle", majorCities: ["Windhoek", "Walvis Bay", "Swakopmund", "Oshakati"] },
  { code: "MU", name: "Mauritius", region: "Africa", incomeTier: "high", majorCities: ["Port Louis", "Beau Bassin-Rose Hill", "Vacoas-Phoenix", "Curepipe", "Grand Baie"] },
  { code: "SC", name: "Seychelles", region: "Africa", incomeTier: "high", majorCities: ["Victoria", "Anse Boileau", "Beau Vallon"] },
  { code: "ZM", name: "Zambia", region: "Africa", incomeTier: "lower_middle", majorCities: ["Lusaka", "Kitwe", "Ndola", "Livingstone", "Kabwe"] },
  { code: "ZW", name: "Zimbabwe", region: "Africa", incomeTier: "lower_middle", majorCities: ["Harare", "Bulawayo", "Chitungwiza", "Mutare", "Gweru"] },
  { code: "MZ", name: "Mozambique", region: "Africa", incomeTier: "low", majorCities: ["Maputo", "Matola", "Beira", "Nampula", "Chimoio"] },
  { code: "CD", name: "DR Congo", region: "Africa", incomeTier: "low", majorCities: ["Kinshasa", "Lubumbashi", "Mbuji-Mayi", "Kisangani", "Goma"] },
  { code: "CM", name: "Cameroon", region: "Africa", incomeTier: "lower_middle", majorCities: ["Douala", "Yaoundé", "Garoua", "Bamenda", "Bafoussam"] },

  // ─── Oceania ─────────────────────────────────────────────────────────
  {
    code: "AU",
    name: "Australia",
    region: "Oceania",
    incomeTier: "high",
    majorCities: [
      "Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Gold Coast",
      "Canberra", "Newcastle", "Hobart", "Darwin", "Cairns", "Geelong",
    ],
  },
  { code: "NZ", name: "New Zealand", region: "Oceania", incomeTier: "high", majorCities: ["Auckland", "Wellington", "Christchurch", "Hamilton", "Tauranga", "Dunedin", "Queenstown"] },
  { code: "FJ", name: "Fiji", region: "Oceania", incomeTier: "upper_middle", majorCities: ["Suva", "Nadi", "Lautoka", "Labasa"] },
  { code: "PG", name: "Papua New Guinea", region: "Oceania", incomeTier: "lower_middle", majorCities: ["Port Moresby", "Lae", "Mount Hagen", "Madang"] },
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
