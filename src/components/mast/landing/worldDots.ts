// Stylised, low-fidelity world dot map used to render the signature globe.
// Coordinates are intentionally approximate — this is an art asset, not a
// mapping tool — but read clearly as continents once rotating on a sphere.

export type LatLon = { lat: number; lon: number };

type Poly = [number, number][]; // [lon, lat][]

const CONTINENTS: Poly[] = [
  // North America
  [
    [-165, 68], [-145, 70], [-120, 68], [-95, 68], [-75, 62], [-65, 50],
    [-60, 45], [-70, 40], [-75, 35], [-80, 26], [-97, 20], [-105, 16],
    [-92, 14], [-84, 9], [-79, 8], [-83, 22], [-97, 26], [-110, 31],
    [-117, 33], [-124, 40], [-124, 49], [-135, 58], [-165, 68],
  ],
  // South America
  [
    [-79, 8], [-77, 0], [-80, -5], [-81, -15], [-75, -20], [-70, -30],
    [-71, -40], [-68, -52], [-65, -55], [-58, -52], [-53, -34], [-48, -25],
    [-40, -10], [-48, 0], [-60, 5], [-70, 8], [-79, 8],
  ],
  // Europe
  [
    [-9, 43], [-9, 52], [-5, 58], [5, 62], [12, 66], [20, 70], [28, 70],
    [30, 60], [27, 52], [35, 45], [28, 41], [19, 40], [13, 38], [3, 43], [-9, 43],
  ],
  // Africa
  [
    [-17, 15], [-16, 21], [-10, 30], [0, 37], [10, 37], [20, 32], [32, 31],
    [34, 27], [43, 12], [51, 12], [45, 2], [40, -5], [35, -15], [33, -24],
    [27, -33], [18, -34], [12, -18], [10, -6], [9, 5], [-5, 5], [-17, 15],
  ],
  // Middle East
  [
    [34, 27], [48, 30], [56, 26], [60, 22], [52, 15], [43, 12], [36, 20], [34, 27],
  ],
  // Asia (broad)
  [
    [27, 70], [60, 70], [90, 72], [130, 72], [145, 60], [140, 45], [130, 35],
    [122, 30], [110, 18], [103, 6], [100, 2], [95, 15], [88, 22], [80, 20],
    [72, 20], [68, 25], [60, 30], [50, 40], [45, 45], [35, 48], [27, 55], [27, 70],
  ],
  // Australia
  [
    [113, -22], [122, -18], [130, -12], [136, -12], [142, -11], [145, -16],
    [153, -28], [150, -35], [140, -38], [135, -35], [131, -32], [122, -34],
    [114, -30], [113, -22],
  ],
];

// Small archipelagos / islands too small to rasterise reliably — listed directly.
const ISLAND_SCATTER: LatLon[] = [
  // Japan
  { lat: 43.5, lon: 142.5 }, { lat: 40.5, lon: 140.8 }, { lat: 37.5, lon: 139.5 },
  { lat: 35.6, lon: 139.8 }, { lat: 34.5, lon: 135.4 }, { lat: 33.5, lon: 131.5 },
  // UK & Ireland
  { lat: 53.5, lon: -2.5 }, { lat: 51.5, lon: -0.1 }, { lat: 55.9, lon: -3.2 },
  { lat: 53.3, lon: -6.3 }, { lat: 57.1, lon: -4.0 },
  // Indonesia / Philippines / SE Asia islands
  { lat: 3.6, lon: 98.7 }, { lat: -6.2, lon: 106.8 }, { lat: -7.5, lon: 110.4 },
  { lat: -8.4, lon: 115.2 }, { lat: 1.3, lon: 103.8 }, { lat: 14.6, lon: 121.0 },
  { lat: 10.3, lon: 123.9 }, { lat: -2.5, lon: 118.0 }, { lat: 0.8, lon: 127.4 },
  // Madagascar
  { lat: -18.9, lon: 47.5 }, { lat: -23.4, lon: 43.7 }, { lat: -15.7, lon: 46.3 },
  // New Zealand
  { lat: -41.3, lon: 174.8 }, { lat: -36.8, lon: 174.8 }, { lat: -45.0, lon: 170.5 },
  // Caribbean
  { lat: 18.5, lon: -70.0 }, { lat: 23.1, lon: -82.4 }, { lat: 18.0, lon: -76.8 },
];

export function pointInPolygon(lon: number, lat: number, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function generateLandDots(): LatLon[] {
  const dots: LatLon[] = [...ISLAND_SCATTER];
  const step = 2.4;
  for (let lat = -58; lat <= 76; lat += step) {
    for (let lon = -180; lon <= 180; lon += step) {
      for (const poly of CONTINENTS) {
        if (pointInPolygon(lon, lat, poly)) {
          const jitter = () => (Math.random() - 0.5) * step * 0.55;
          dots.push({ lat: lat + jitter(), lon: lon + jitter() });
          break;
        }
      }
    }
  }
  return dots;
}

export const WORLD_DOTS: LatLon[] = generateLandDots();

export const HUB_CITIES: (LatLon & { name: string })[] = [
  { name: "New York", lat: 40.7, lon: -74.0 },
  { name: "London", lat: 51.5, lon: -0.1 },
  { name: "Dubai", lat: 25.2, lon: 55.3 },
  { name: "Singapore", lat: 1.35, lon: 103.8 },
  { name: "São Paulo", lat: -23.5, lon: -46.6 },
  { name: "Sydney", lat: -33.9, lon: 151.2 },
  { name: "Tokyo", lat: 35.7, lon: 139.7 },
  { name: "Lagos", lat: 6.5, lon: 3.4 },
  { name: "Toronto", lat: 43.6, lon: -79.4 },
  { name: "Mumbai", lat: 19.1, lon: 72.9 },
];

// ---------------------------------------------------------------------------
// Target countries — the globe rotates through these and "zooms in" to
// reveal a dense field of gold opportunity dots scattered across the
// country's landmass. Outlines are intentionally low-fidelity (same art
// style as CONTINENTS above), just detailed enough to read as the country
// once dots are rasterised inside them.
// ---------------------------------------------------------------------------
const COUNTRY_POLYS: Record<string, Poly> = {
  Egypt: [
    [25, 31.5], [33.2, 31.7], [34.9, 29.9], [34.3, 27.9],
    [36.9, 22.0], [24.7, 22.0], [25, 31.5],
  ],
  "United States": [
    [-124.7, 48.4], [-123, 49], [-95, 49], [-83, 42.5], [-79, 43.5],
    [-71, 45], [-67, 45], [-70, 41], [-75, 38.5], [-77, 34], [-80, 26],
    [-82, 25], [-88, 30], [-94, 29.5], [-97, 26], [-100, 29], [-104, 29],
    [-106, 31.8], [-109, 31.3], [-114.7, 32.5], [-117, 32.5], [-122, 37],
    [-124, 40], [-124.7, 48.4],
  ],
  "United Kingdom": [
    [-5.5, 58.6], [-3, 58.6], [-1.7, 57.7], [-2, 55.8], [0.3, 52.9],
    [1.6, 51.4], [-0.9, 50.7], [-3, 50.2], [-5.6, 50], [-4.3, 51.2],
    [-5.3, 51.9], [-4.7, 52.9], [-4.2, 53.4], [-3, 54.5], [-5, 54.6],
    [-5.5, 55], [-5.5, 58.6],
  ],
  France: [
    [-1.8, 50.9], [1.6, 51], [3.1, 50.3], [4.2, 49.9], [7.6, 49.0],
    [7.6, 47.6], [6.7, 45.9], [7.0, 44.1], [7.5, 43.8], [6.5, 43.1],
    [4.5, 43.3], [3, 42.5], [-1.4, 43.3], [-1.7, 44.0], [-1.2, 46.2],
    [-2.0, 47.3], [-4.8, 48.6], [-1.8, 50.9],
  ],
  Canada: [
    [-141, 69.5], [-125, 55], [-130, 52], [-125, 49], [-95, 49],
    [-84, 46], [-79.5, 43.5], [-76, 44.5], [-70, 45], [-64, 46],
    [-60, 46.5], [-55, 47.5], [-53, 47], [-56, 52], [-65, 58],
    [-75, 62], [-85, 67], [-95, 68], [-110, 68], [-125, 69], [-141, 69.5],
  ],
  Australia: CONTINENTS[6],
};

function centroidOf(poly: Poly): LatLon {
  let sLat = 0;
  let sLon = 0;
  for (const [lon, lat] of poly) { sLat += lat; sLon += lon; }
  return { lat: sLat / poly.length, lon: sLon / poly.length };
}

function generateCountryDots(poly: Poly): LatLon[] {
  const dots: LatLon[] = [];
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of poly) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  // Adaptive grid step so a tiny country (UK) still gets a satisfying
  // scatter of dots, and a huge one (Canada) doesn't flood the canvas
  // with thousands of them.
  const area = Math.max(1, (maxLon - minLon) * (maxLat - minLat));
  const step = Math.min(1.7, Math.max(0.55, Math.sqrt(area / 210)));
  for (let lat = minLat; lat <= maxLat; lat += step) {
    for (let lon = minLon; lon <= maxLon; lon += step) {
      if (pointInPolygon(lon, lat, poly)) {
        const jitter = () => (Math.random() - 0.5) * step * 0.5;
        dots.push({ lat: lat + jitter(), lon: lon + jitter() });
      }
    }
  }
  return dots;
}

export type CountryTarget = {
  name: string;
  lat: number;
  lon: number;
  dots: LatLon[];
};

export const TARGET_COUNTRIES: CountryTarget[] = Object.entries(COUNTRY_POLYS).map(
  ([name, poly]) => {
    const c = centroidOf(poly);
    return { name, lat: c.lat, lon: c.lon, dots: generateCountryDots(poly) };
  },
);

export function nearestHub(lat: number, lon: number) {
  let best = HUB_CITIES[0];
  let bestD = Infinity;
  for (const hub of HUB_CITIES) {
    const dLat = hub.lat - lat;
    let dLon = hub.lon - lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = hub;
    }
  }
  return best;
}
