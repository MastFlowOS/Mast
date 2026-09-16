import { WORLD_DOTS } from "./worldDots";

export type FocusTarget = {
  name: string;
  lat: number;
  lon: number;
  radiusDeg: number;
};

export const FOCUS_TARGETS: FocusTarget[] = [
  // Centroids calibrated so the entire territory is directly facing the viewer (z > 0.65, 0% behind limb)
  { name: "Western Europe", lat: 48, lon: 4, radiusDeg: 22 },
  { name: "North America", lat: 38, lon: -97, radiusDeg: 30 },
  { name: "East Asia", lat: 33, lon: 125, radiusDeg: 24 },
  { name: "Middle East", lat: 26, lon: 46, radiusDeg: 20 },
  { name: "Asia-Pacific", lat: -20, lon: 135, radiusDeg: 26 },
];

// Explicit geographic boundaries for each region
// Tested against Natural Earth 110m dot dataset to ensure true-to-life continental silhouettes
function inWesternEurope(lat: number, lon: number): boolean {
  if (lat < 36 || lat > 71) return false;
  // Exclude North African coast
  if (lat < 37 && lon > -5 && lon < 10) return false;
  // Western limit: Portugal (-9.5), Spain (-9), Ireland (-10.5), UK (-7), Iceland (-24 to -13 at lat 63-66)
  if (lon < -10.5 && !(lat >= 63 && lat <= 66 && lon >= -24 && lon <= -13)) return false;
  // Eastern limits: exclude Balkans/Greece, Poland/Ukraine, Russia
  if (lat < 47 && lon > 18.5) return false; // Italy up to 18.5
  if (lat >= 47 && lat <= 55 && lon > 15.5) return false; // Germany/Austria up to 15.5
  if (lat > 55 && lon > 25.5) return false; // Scandinavia up to 25.5
  return true;
}

function inNorthAmerica(lat: number, lon: number): boolean {
  if (lat < 14 || lat > 72) return false;
  if (lon < -170 || lon > -52) return false;
  if (lat > 58 && lon > -52) return false; // Exclude Greenland
  if (lat < 18 && lon > -88) return false; // Exclude Central America south of Mexico
  if (lat < 24 && lon > -80) return false; // Exclude Caribbean islands far east
  return true;
}

function inEastAsia(lat: number, lon: number): boolean {
  // Japan, South Korea, North Korea, Taiwan, Eastern & Coastal China
  if (lat < 18 || lat > 46) return false;
  if (lon < 105 || lon > 146) return false;
  // Exclude Southeast Asia
  if (lat < 21 && lon < 116) return false;
  return true;
}

function inMiddleEast(lat: number, lon: number): boolean {
  // Arabian Peninsula, Levant, Iraq, Turkey, Iran, Egypt
  if (lat < 12 || lat > 42) return false;
  if (lon < 26 || lon > 63) return false;
  if (lat < 22 && lon < 35) return false; // Exclude Sudan/Ethiopia
  if (lat > 37 && lon < 26) return false; // Exclude Greece
  if (lat > 40 && lon > 46) return false; // Exclude Central Asia
  return true;
}

function inAsiaPacific(lat: number, lon: number): boolean {
  // Australia, New Zealand, Indonesia, Malaysia, Singapore, Philippines, PNG
  if (lat < -48 || lat > 20) return false;
  if (lon < 95 || lon > 178) return false;
  if (lat > 7 && lon < 108) return false; // Exclude mainland SE Asia
  if (lat > 19) return false; // Exclude Taiwan / southern China
  return true;
}

type CityNode = { lat: number; lon: number; weight: number };

// Real metropolitan and civilization hubs per focus region
const REGION_CITIES: CityNode[][] = [
  // 0: Western Europe
  [
    { lat: 51.5, lon: -0.1, weight: 1.0 }, // London / SE England
    { lat: 48.8, lon: 2.3, weight: 1.0 }, // Paris / Île-de-France
    { lat: 40.4, lon: -3.7, weight: 0.9 }, // Madrid
    { lat: 52.5, lon: 13.4, weight: 0.9 }, // Berlin
    { lat: 41.9, lon: 12.5, weight: 0.9 }, // Rome
    { lat: 52.4, lon: 4.9, weight: 0.95 }, // Amsterdam / Randstad
    { lat: 50.8, lon: 4.3, weight: 0.9 }, // Brussels
    { lat: 51.2, lon: 6.8, weight: 0.95 }, // Rhine-Ruhr
    { lat: 50.1, lon: 8.7, weight: 0.9 }, // Frankfurt
    { lat: 45.5, lon: 9.2, weight: 0.9 }, // Milan / Po Valley
    { lat: 41.4, lon: 2.2, weight: 0.85 }, // Barcelona
    { lat: 53.3, lon: -6.3, weight: 0.8 }, // Dublin
    { lat: 48.1, lon: 11.6, weight: 0.85 }, // Munich
    { lat: 47.4, lon: 8.5, weight: 0.8 }, // Zurich
    { lat: 48.2, lon: 16.4, weight: 0.85 }, // Vienna
    { lat: 38.7, lon: -9.1, weight: 0.85 }, // Lisbon
    { lat: 55.7, lon: 12.6, weight: 0.8 }, // Copenhagen
    { lat: 59.3, lon: 18.1, weight: 0.8 }, // Stockholm
  ],
  // 1: North America
  [
    { lat: 40.7, lon: -74.0, weight: 1.0 }, // New York
    { lat: 34.0, lon: -118.2, weight: 0.95 }, // Los Angeles
    { lat: 41.9, lon: -87.6, weight: 0.9 }, // Chicago
    { lat: 43.7, lon: -79.4, weight: 0.85 }, // Toronto
    { lat: 45.5, lon: -73.6, weight: 0.8 }, // Montreal
    { lat: 37.8, lon: -122.4, weight: 0.9 }, // SF Bay Area
    { lat: 29.8, lon: -95.4, weight: 0.85 }, // Houston
    { lat: 32.8, lon: -96.8, weight: 0.85 }, // Dallas
    { lat: 19.4, lon: -99.1, weight: 0.95 }, // Mexico City
    { lat: 47.6, lon: -122.3, weight: 0.8 }, // Seattle
    { lat: 25.8, lon: -80.2, weight: 0.85 }, // Miami
    { lat: 33.7, lon: -84.4, weight: 0.8 }, // Atlanta
    { lat: 38.9, lon: -77.0, weight: 0.9 }, // Washington DC
    { lat: 39.9, lon: -75.2, weight: 0.85 }, // Philadelphia
    { lat: 42.4, lon: -71.1, weight: 0.85 }, // Boston
    { lat: 20.7, lon: -103.3, weight: 0.75 }, // Guadalajara
    { lat: 25.7, lon: -100.3, weight: 0.75 }, // Monterrey
  ],
  // 2: East Asia
  [
    { lat: 35.7, lon: 139.7, weight: 1.0 }, // Tokyo / Kanto
    { lat: 34.7, lon: 135.5, weight: 0.95 }, // Osaka / Kansai
    { lat: 37.6, lon: 127.0, weight: 1.0 }, // Seoul
    { lat: 31.2, lon: 121.5, weight: 1.0 }, // Shanghai
    { lat: 39.9, lon: 116.4, weight: 1.0 }, // Beijing
    { lat: 25.0, lon: 121.5, weight: 0.9 }, // Taipei
    { lat: 22.3, lon: 114.2, weight: 1.0 }, // Hong Kong / Shenzhen
    { lat: 23.1, lon: 113.3, weight: 0.95 }, // Guangzhou
    { lat: 30.6, lon: 104.1, weight: 0.85 }, // Chengdu
    { lat: 30.3, lon: 120.2, weight: 0.85 }, // Hangzhou
    { lat: 32.1, lon: 118.8, weight: 0.85 }, // Nanjing
    { lat: 35.2, lon: 129.0, weight: 0.85 }, // Busan
  ],
  // 3: Middle East
  [
    { lat: 25.2, lon: 55.3, weight: 1.0 }, // Dubai
    { lat: 24.5, lon: 54.4, weight: 0.9 }, // Abu Dhabi
    { lat: 24.7, lon: 46.7, weight: 0.95 }, // Riyadh
    { lat: 41.0, lon: 28.9, weight: 1.0 }, // Istanbul
    { lat: 39.9, lon: 32.9, weight: 0.85 }, // Ankara
    { lat: 30.0, lon: 31.2, weight: 1.0 }, // Cairo
    { lat: 32.1, lon: 34.8, weight: 0.9 }, // Tel Aviv
    { lat: 35.7, lon: 51.4, weight: 0.95 }, // Tehran
    { lat: 25.3, lon: 51.5, weight: 0.9 }, // Doha
    { lat: 21.5, lon: 39.2, weight: 0.85 }, // Jeddah
    { lat: 33.3, lon: 44.4, weight: 0.85 }, // Baghdad
    { lat: 29.4, lon: 48.0, weight: 0.85 }, // Kuwait City
  ],
  // 4: Asia-Pacific
  [
    { lat: -33.9, lon: 151.2, weight: 1.0 }, // Sydney
    { lat: -37.8, lon: 144.9, weight: 0.95 }, // Melbourne
    { lat: -27.5, lon: 153.0, weight: 0.85 }, // Brisbane
    { lat: -36.8, lon: 174.8, weight: 0.85 }, // Auckland
    { lat: -41.3, lon: 174.8, weight: 0.8 }, // Wellington
    { lat: 1.3, lon: 103.8, weight: 1.0 }, // Singapore
    { lat: -6.2, lon: 106.8, weight: 1.0 }, // Jakarta
    { lat: 14.6, lon: 121.0, weight: 0.95 }, // Manila
    { lat: 3.1, lon: 101.7, weight: 0.9 }, // Kuala Lumpur
    { lat: -31.9, lon: 115.9, weight: 0.8 }, // Perth
    { lat: -34.9, lon: 138.6, weight: 0.75 }, // Adelaide
  ],
];

function greatCircleDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const cosD = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.acos(Math.max(-1, Math.min(1, cosD))) * (180 / Math.PI);
}

function calculateCityDensity(lat: number, lon: number, regionId: number): number {
  if (regionId < 0 || regionId >= REGION_CITIES.length) return 0;
  const cities = REGION_CITIES[regionId];
  let maxDensity = 0;
  // Proximity cutoff radius of ~4.8 degrees (~530km) creates natural metro halos
  for (let i = 0; i < cities.length; i++) {
    const c = cities[i];
    const distDeg = greatCircleDist(lat, lon, c.lat, c.lon);
    if (distDeg < 4.8) {
      const proximity = 1 - distDeg / 4.8;
      const d = proximity * c.weight;
      if (d > maxDensity) maxDensity = d;
    }
  }
  return Math.min(1, maxDensity);
}

// Precompute once at module initialization time (zero per-frame overhead, zero garbage collection)
const count = WORLD_DOTS.length;
export const DOT_REGIONS = new Int8Array(count);
export const DOT_DENSITIES = new Float32Array(count);

for (let i = 0; i < count; i++) {
  const d = WORLD_DOTS[i];
  let reg = -1;
  if (inWesternEurope(d.lat, d.lon)) reg = 0;
  else if (inNorthAmerica(d.lat, d.lon)) reg = 1;
  else if (inEastAsia(d.lat, d.lon)) reg = 2;
  else if (inMiddleEast(d.lat, d.lon)) reg = 3;
  else if (inAsiaPacific(d.lat, d.lon)) reg = 4;

  DOT_REGIONS[i] = reg;
  DOT_DENSITIES[i] = reg >= 0 ? calculateCityDensity(d.lat, d.lon, reg) : 0;
}
