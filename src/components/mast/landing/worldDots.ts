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

function pointInPolygon(lon: number, lat: number, poly: Poly): boolean {
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
