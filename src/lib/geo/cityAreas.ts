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
  // United States — keep highest-yield commercial hubs first
  "US:New York": [
    "Chelsea", "Williamsburg", "East Village", "West Village", "Flatiron", "Lower East Side",
    "Tribeca", "Greenwich Village", "SoHo", "Brooklyn", "Manhattan", "Midtown",
    "Upper East Side", "Upper West Side", "Financial District", "NoHo", "Nolita",
    "DUMBO", "Park Slope", "Bushwick", "Greenpoint", "Hell's Kitchen", "Harlem", "Long Island City",
  ],
  "US:Los Angeles": [
    "West Hollywood", "Pasadena", "Hollywood", "Culver City", "Santa Monica", "Silver Lake",
    "Downtown LA", "Venice", "Koreatown", "Echo Park", "Los Feliz", "Arts District",
    "Beverly Hills", "Brentwood", "Studio City", "Highland Park", "Sawtelle", "Marina del Rey",
    "Sherman Oaks", "Glendale", "Burbank", "Long Beach",
  ],
  "US:Chicago": [
    "West Loop", "Wicker Park", "Fulton Market", "Lincoln Park", "Logan Square", "River North",
    "Hyde Park", "The Loop", "Lakeview", "Bucktown", "Old Town", "Streeterville",
    "Ukrainian Village", "Pilsen", "Andersonville", "Roscoe Village", "South Loop", "Evanston",
  ],
  "US:Seattle": [
    "Capitol Hill", "Ballard", "Fremont", "Queen Anne", "Downtown Seattle", "Belltown",
    "South Lake Union", "Wallingford", "University District", "Columbia City", "West Seattle",
    "Green Lake", "Pioneer Square", "Georgetown",
  ],
  "US:Austin": [
    "South Congress", "Downtown Austin", "East Austin", "Clarksville", "Mueller",
    "Zilker", "Barton Hills", "North Loop", "Hyde Park", "Rainey Street", "South Lamar",
    "West Campus", "Domain",
  ],
  "US:Miami": [
    "Wynwood", "Brickell", "South Beach", "Little Havana", "Coconut Grove",
    "Coral Gables", "Design District", "Midtown Miami", "Edgewater", "Downtown Miami",
    "Little River", "Key Biscayne", "Aventura",
  ],
  "US:San Francisco": [
    "Mission District", "SoMa", "Hayes Valley", "Marina", "North Beach",
    "Nob Hill", "Pacific Heights", "Castro", "Haight-Ashbury", "Inner Sunset",
    "Outer Sunset", "Financial District", "Dogpatch", "Potrero Hill", "Chinatown",
  ],
  "US:Denver": [
    "RiNo", "LoDo", "Capitol Hill", "Highlands", "Baker",
    "Cherry Creek", "Wash Park", "Five Points", "Sunnyside", "Berkeley",
    "South Broadway", "Uptown", "Golden Triangle",
  ],
  "US:Boston": [
    "Back Bay", "North End", "Cambridge", "South End", "Beacon Hill",
    "Seaport", "Fenway", "Somerville", "Brookline", "Jamaica Plain",
    "Charlestown", "Downtown Crossing", "Allston",
  ],
  "US:Houston": [
    "Montrose", "The Heights", "Midtown Houston", "Downtown Houston", "River Oaks",
    "Rice Village", "East Downtown", "Washington Corridor", "Upper Kirby", "Galleria",
    "Memorial", "Museum District", "Westchase",
  ],
  "US:Dallas": [
    "Uptown Dallas", "Deep Ellum", "Bishop Arts District", "Downtown Dallas", "Oak Lawn",
    "Knox-Henderson", "Lower Greenville", "Design District", "Trinity Groves", "Lakewood",
    "Highland Park", "Preston Hollow",
  ],
  "US:Phoenix": [
    "Downtown Phoenix", "Roosevelt Row", "Arcadia", "Biltmore", "Scottsdale Old Town",
    "Tempe", "Midtown Phoenix", "Uptown Phoenix", "CenPho", "Camelback East",
    "Gilbert", "Chandler",
  ],
  "US:Philadelphia": [
    "Center City", "Rittenhouse Square", "Fishtown", "Old City", "Northern Liberties",
    "Passyunk Square", "University City", "Fairmount", "Graduate Hospital", "Manayunk",
    "Chestnut Hill", "Queen Village",
  ],
  "US:San Diego": [
    "North Park", "Gaslamp Quarter", "Little Italy", "La Jolla", "Pacific Beach",
    "Hillcrest", "South Park", "Ocean Beach", "Normal Heights", "Encinitas",
    "East Village", "University Heights",
  ],
  "US:San Antonio": [
    "Pearl District", "Downtown San Antonio", "Southtown", "King William", "Alamo Heights",
    "Monte Vista", "Stone Oak", "Olmos Park", "The Rim", "Broadway Corridor",
  ],
  "US:San Jose": [
    "Downtown San Jose", "Santana Row", "Willow Glen", "Japantown", "Rose Garden",
    "Campbell", "Silver Creek", "Alum Rock", "Berryessa", "Almaden Valley",
  ],
  "US:Atlanta": [
    "Midtown Atlanta", "Inman Park", "Old Fourth Ward", "Virginia-Highland", "Buckhead",
    "West Midtown", "Little Five Points", "Decatur", "Poncey-Highland", "Grant Park",
    "East Atlanta Village", "Downtown Atlanta",
  ],
  "US:Portland": [
    "Pearl District", "Hawthorne", "Division", "Alberta Arts", "Downtown Portland",
    "Nob Hill", "Mississippi Avenue", "Sellwood", "St. Johns", "Buckman",
    "Laurelhurst", "Fremont",
  ],
  "US:Nashville": [
    "12 South", "East Nashville", "The Gulch", "Germantown", "Hillsboro Village",
    "Downtown Nashville", "Sylvan Park", "Berry Hill", "Wedgewood-Houston", "Green Hills",
    "Midtown Nashville",
  ],
  "US:Washington": [
    "Georgetown", "Dupont Circle", "Adams Morgan", "U Street", "Logan Circle",
    "Capitol Hill", "Shaw", "Navy Yard", "14th Street", "Foggy Bottom",
    "Columbia Heights", "Penn Quarter",
  ],
  "US:Minneapolis": [
    "North Loop", "Uptown", "Northeast Minneapolis", "Downtown Minneapolis", "Linden Hills",
    "Dinkytown", "Powderhorn", "St. Anthony Main", "Seward", "Lyn-Lake",
  ],
  "US:New Orleans": [
    "French Quarter", "Marigny", "Bywater", "Garden District", "Uptown",
    "Warehouse District", "CBD", "Mid-City", "Tremé", "Carrollton",
  ],
  "US:Detroit": [
    "Midtown Detroit", "Corktown", "Downtown Detroit", "Eastern Market", "West Village",
    "Ferndale", "Royal Oak", "New Center", "Greektown", "Woodbridge",
  ],
  "US:Las Vegas": [
    "Arts District", "Downtown Las Vegas", "Summerlin", "Henderson", "Spring Valley",
    "Chinatown", "Fremont East", "Green Valley", "The Strip", "Silverado Ranch",
  ],
  "US:Orlando": [
    "Winter Park", "Downtown Orlando", "Mills 50", "Thornton Park", "Ivanhoe Village",
    "College Park", "Audubon Park", "Milk District", "Baldwin Park", "Lake Nona",
  ],
  "US:Tampa": [
    "Hyde Park", "Ybor City", "Seminole Heights", "Downtown Tampa", "Channelside",
    "SoHo Tampa", "Westshore", "Davis Islands", "Water Street", "Carrollwood",
  ],
  "US:Charlotte": [
    "South End", "NoDa", "Plaza Midwood", "Uptown Charlotte", "Dilworth",
    "Myers Park", "Elizabeth", "Wesley Heights", "Montford", "Ballantyne",
  ],
  "US:Salt Lake City": [
    "Downtown Salt Lake City", "Sugar House", "9th and 9th", "The Avenues", "Central Ninth",
    "Marmalade", "Liberty Wells", "Foothill", "Millcreek", "Holladay",
  ],
  "US:Pittsburgh": [
    "Lawrenceville", "Strip District", "Shadyside", "Squirrel Hill", "Downtown Pittsburgh",
    "South Side", "Bloomfield", "Oakland", "Mount Washington", "North Shore",
  ],
  "US:Columbus": [
    "Short North", "German Village", "Downtown Columbus", "Clintonville", "Grandview",
    "Italian Village", "Franklinton", "Olde Towne East", "University District", "Bexley",
  ],
  "US:Raleigh": [
    "Downtown Raleigh", "North Hills", "Glenwood South", "Five Points", "Oakwood",
    "Warehouse District", "Cameron Village", "Boylan Heights", "Brier Creek", "Cary",
  ],
  "US:Indianapolis": [
    "Fountain Square", "Mass Ave", "Broad Ripple", "Downtown Indianapolis", "Irvington",
    "Carmel", "Bottleworks", "Meridian-Kessler", "SoBro", "Fletcher Place",
  ],
  "US:Kansas City": [
    "Crossroads", "Westport", "Country Club Plaza", "River Market", "Downtown Kansas City",
    "Brookside", "Waldo", "18th and Vine", "Westside", "Crown Center",
  ],
  "US:St. Louis": [
    "Central West End", "Soulard", "The Grove", "Tower Grove", "Downtown St. Louis",
    "Lafayette Square", "Delmar Loop", "Clayton", "Maplewood", "Benton Park",
  ],
  "US:Milwaukee": [
    "Historic Third Ward", "East Side", "Walker's Point", "Bay View", "Downtown Milwaukee",
    "Riverwest", "Brady Street", "Wauwatosa", "Shorewood", "Brewers Hill",
  ],
  "US:Baltimore": [
    "Fells Point", "Canton", "Federal Hill", "Mount Vernon", "Hampden",
    "Inner Harbor", "Remington", "Charles Village", "Station North", "Locust Point",
  ],
  "US:Sacramento": [
    "Midtown Sacramento", "Downtown Sacramento", "East Sacramento", "Oak Park", "Land Park",
    "R Street Corridor", "Curtis Park", "Tahoe Park", "Natomas", "Arden-Arcade",
  ],

  // Canada
  "CA:Toronto": [
    "Downtown Toronto", "Queen West", "Kensington Market", "Yorkville", "Liberty Village",
    "Distillery District", "Leslieville", "The Annex", "North York", "Scarborough",
    "Etobicoke", "The Beaches", "Roncesvalles", "King West",
  ],
  "CA:Vancouver": [
    "Downtown Vancouver", "Gastown", "Kitsilano", "Mount Pleasant", "Yaletown",
    "West End", "Commercial Drive", "Coal Harbour", "Main Street", "North Vancouver",
  ],
  "CA:Montreal": [
    "Plateau-Mont-Royal", "Mile End", "Old Montreal", "Downtown Montreal", "Griffintown",
    "Little Italy", "Westmount", "Verdun", "Outremont", "Rosemont",
  ],
  "CA:Calgary": [
    "Downtown Calgary", "17th Avenue", "Kensington", "Inglewood", "Mission",
    "Bridgeland", "Beltline", "Marda Loop", "Eau Claire", "Sunalta",
  ],
  "CA:Ottawa": [
    "ByWard Market", "Downtown Ottawa", "The Glebe", "Hintonburg", "Westboro",
    "Centretown", "Little Italy", "Sandy Hill", "New Edinburgh", "Old Ottawa South",
  ],

  // United Kingdom
  "GB:London": [
    "Camden", "Shoreditch", "Westminster", "Soho", "Covent Garden", "Islington",
    "Notting Hill", "Hackney", "Brixton", "Greenwich", "Kensington", "Chelsea",
    "Marylebone", "Clerkenwell", "Fitzrovia", "Peckham", "Dalston", "Canary Wharf",
  ],
  "GB:Manchester": [
    "Northern Quarter", "Ancoats", "Deansgate", "Spinningfields", "Didsbury",
    "Chorlton", "Salford Quays", "Castlefield", "Fallowfield", "Oxford Road",
  ],
  "GB:Birmingham": [
    "Jewellery Quarter", "Digbeth", "City Centre", "Moseley", "Edgbaston",
    "Harborne", "Brindleyplace", "Kings Heath", "Colmore Row", "Sutton Coldfield",
  ],
  "GB:Edinburgh": [
    "Old Town", "New Town", "Stockbridge", "Leith", "Morningside",
    "Bruntsfield", "West End", "Marchmont", "Portobello", "Dean Village",
  ],

  // Europe
  "DE:Berlin": [
    "Mitte", "Kreuzberg", "Prenzlauer Berg", "Neukölln", "Friedrichshain",
    "Charlottenburg", "Schöneberg", "Wedding", "Moabit", "Tempelhof",
  ],
  "DE:Munich": [
    "Altstadt", "Schwabing", "Maxvorstadt", "Glockenbachviertel", "Haidhausen",
    "Neuhausen", "Bogenhausen", "Sendling", "Westend", "Au",
  ],
  "DE:Hamburg": [
    "Sternschanze", "St. Pauli", "Eimsbüttel", "Altona", "Ottensen",
    "HafenCity", "Neustadt", "Winterhude", "Eppendorf", "Karolinenviertel",
  ],
  "DE:Frankfurt": [
    "Innenstadt", "Sachsenhausen", "Nordend", "Bornheim", "Westend",
    "Bockenheim", "Bahnhofsviertel", "Ostend", "Berger Straße", "Europaviertel",
  ],
  "DE:Cologne": [
    "Belgisches Viertel", "Ehrenfeld", "Innenstadt", "Südstadt", "Nippes",
    "Agnesviertel", "Deutz", "Lindenthal", "Zülpicher Viertel", "Kwartier Latäng",
  ],
  "FR:Paris": [
    "Le Marais", "Montmartre", "Saint-Germain-des-Prés", "Belleville", "Bastille",
    "Canal Saint-Martin", "Latin Quarter", "Pigalle", "Opéra", "Oberkampf",
    "Batignolles", "République", "Châtelet",
  ],
  "FR:Lyon": [
    "Presqu'île", "Vieux Lyon", "Croix-Rousse", "Part-Dieu", "Confluence",
    "Guillotière", "Brotteaux", "Monplaisir", "Vaise", "Jean Macé",
  ],
  "ES:Madrid": [
    "Malasaña", "Chueca", "Salamanca", "Sol", "La Latina",
    "Lavapiés", "Chamberí", "Retiro", "Justicia", "Argüelles",
  ],
  "ES:Barcelona": [
    "Eixample", "El Born", "Gothic Quarter", "Gràcia", "Raval",
    "Poblenou", "Barceloneta", "Sant Antoni", "Sarrià", "Sants",
  ],
  "IT:Milan": [
    "Brera", "Navigli", "Porta Nuova", "Centro Storico", "Isola",
    "Porta Romana", "Porta Venezia", "Garibaldi", "Tortona", "Città Studi",
  ],
  "IT:Rome": [
    "Trastevere", "Centro Storico", "Monti", "Prati", "Testaccio",
    "Pigneto", "San Lorenzo", "Flaminio", "Ostiense", "Parioli",
  ],
  "NL:Amsterdam": [
    "Jordaan", "De Pijp", "Centrum", "Oud-West", "Amsterdam-Noord",
    "Oost", "Zuid", "Canal Ring", "NDSM", "Westerpark",
  ],

  // Latin America
  "MX:Mexico City": [
    "Roma Norte", "Polanco", "Condesa", "Coyoacán", "Santa Fe",
    "Juárez", "Centro Histórico", "Del Valle", "Nápoles", "Reforma",
  ],
  "BR:São Paulo": [
    "Pinheiros", "Vila Madalena", "Jardins", "Itaim Bibi", "Paulista",
    "Moema", "Vila Mariana", "Higienópolis", "Centro", "Perdizes",
  ],
  "BR:Rio de Janeiro": [
    "Copacabana", "Ipanema", "Leblon", "Botafogo", "Lapa",
    "Centro", "Santa Teresa", "Barra da Tijuca", "Flamengo", "Tijuca",
  ],
  "AR:Buenos Aires": [
    "Palermo", "Recoleta", "San Telmo", "Puerto Madero", "Belgrano",
    "Villa Crespo", "Microcentro", "Colegiales", "Caballito", "Núñez",
  ],

  // Middle East & Africa
  "EG:Cairo": [
    "Zamalek", "Maadi", "New Cairo", "Heliopolis", "Downtown Cairo",
    "Nasr City", "Garden City", "Mohandessin", "Dokki", "Fifth Settlement",
  ],
  "EG:Alexandria": [
    "Smouha", "Gleem", "Stanley", "San Stefano", "Roushdy",
    "Kafr Abdo", "Sidi Gaber", "Miami", "Montaza", "Bahary",
  ],
  "ZA:Johannesburg": [
    "Sandton", "Rosebank", "Melville", "Maboneng", "Parkhurst",
    "Braamfontein", "Greenside", "Bryanston", "Fourways", "Linden",
  ],
  "ZA:Cape Town": [
    "City Bowl", "Sea Point", "Green Point", "Woodstock", "Observatory",
    "Gardens", "Camps Bay", "Claremont", "Newlands", "Waterfront",
  ],
  "AE:Dubai": [
    "Downtown Dubai", "Dubai Marina", "JLT", "Business Bay", "DIFC",
    "Jumeirah", "Al Quoz", "City Walk", "Deira", "JBR",
  ],
  "SA:Riyadh": [
    "Olaya", "Al Malqa", "Al Nakheel", "Diplomatic Quarter", "Al Murabba",
    "Hittin", "Al Yasmin", "Al Sulimaniyah", "King Abdullah Financial District", "Al Rawdah",
  ],

  // Asia & Oceania
  "JP:Tokyo": [
    "Shibuya", "Shinjuku", "Ginza", "Harajuku", "Omotesando",
    "Daikanyama", "Nakameguro", "Roppongi", "Shimokitazawa", "Kichijoji",
  ],
  "KR:Seoul": [
    "Gangnam", "Hongdae", "Itaewon", "Seongsu", "Myeongdong",
    "Jongno", "Yeonnam-dong", "Hannam-dong", "Apgujeong", "Samcheong-dong",
  ],
  "SG:Singapore": [
    "Tiong Bahru", "Orchard", "Marina Bay", "Tanjong Pagar", "Bugis",
    "Katong", "Holland Village", "Chinatown", "Clarke Quay", "Novena",
  ],
  "AU:Sydney": [
    "Surry Hills", "CBD", "Newtown", "Bondi", "Paddington",
    "Manly", "Fitzroy", "Chippendale", "Marrickville", "Darlinghurst",
  ],
  "AU:Melbourne": [
    "Fitzroy", "CBD", "Collingwood", "South Yarra", "St Kilda",
    "Brunswick", "Carlton", "Richmond", "Prahran", "Southbank",
  ],
  "TR:Istanbul": [
    "Beyoğlu", "Karaköy", "Kadıköy", "Moda", "Nişantaşı",
    "Beşiktaş", "Bebek", "Cihangir", "Galata", "Ortaköy",
  ],
  "IN:Mumbai": [
    "Bandra", "Colaba", "Lower Parel", "Andheri West", "Juhu",
    "Fort", "Worli", "Kala Ghoda", "Powai", "Khar",
  ],
  "IN:Bangalore": [
    "Indiranagar", "Koramangala", "MG Road", "HSR Layout", "Whitefield",
    "Jayanagar", "Sadashivanagar", "Church Street", "JP Nagar", "Malleshwaram",
  ],
  "TH:Bangkok": [
    "Sukhumvit", "Thonglor", "Ekkamai", "Ari", "Silom",
    "Siam", "Sathorn", "Phrom Phong", "Old Town", "Asok",
  ],
};

export const DEFAULT_SUB_AREAS = [
  "Downtown", "City Center", "Central", "Midtown",
  "North", "South", "East", "West",
  "Old Town", "Financial District", "Business District", "Arts District",
  "University District", "Uptown", "West End", "East Side",
];

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

