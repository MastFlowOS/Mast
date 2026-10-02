/**
 * Turns Discover's selected region tokens (countries, continents, "Global")
 * into what the globe needs to draw: which countries to light up and where
 * the camera should look.
 *
 * Pure and framework-free so it is unit-testable. It reads the same
 * COUNTRIES data and token rules the server uses (see ./scope.ts), so the
 * globe can never highlight something the backend would not search.
 *
 * Camera model: a view is { lon, lat, k }. lon/lat is the point at the centre
 * of the globe; k is a zoom multiplier (1 = the whole hemisphere fits the
 * globe disk, higher = closer in). The most recently selected token is the
 * one the camera focuses on; every selected token is highlighted.
 */
import { geoArea, geoCentroid, geoDistance } from "d3-geo";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { COUNTRIES, REGION_NAMES, type CountryInfo, type RegionName } from "./countries";
import { GLOBE_POINT_FALLBACK, ISO_NUMERIC_BY_ALPHA2 } from "./isoNumeric";
import { GLOBAL_SCOPE } from "./scope";

export type CountryFeature = Feature<Polygon | MultiPolygon, { name?: string }> & {
  id?: string | number;
};

/** Spherical bounding cap of a feature: centre [lon, lat] and angular radius (radians). */
export type FeatureCap = { c: [number, number]; r: number };

export type GlobeWorld = {
  features: CountryFeature[];
  byId: Map<string, CountryFeature>;
  /** Parallel to `features`; lets the renderer skip countries that cannot be in view. */
  caps: FeatureCap[];
};

export type GlobeView = { lon: number; lat: number; k: number };

export type GlobePoint = { code: string; lon: number; lat: number; focus: boolean };

export type GlobeScope = {
  kind: "none" | "country" | "continent" | "global";
  /** Atlas feature ids (ISO numeric) to fill. */
  highlightIds: string[];
  /** The single focused country's feature id, drawn a little stronger. */
  focusId: string | null;
  /** Highlighted countries that are too small for the atlas: drawn as points. */
  points: GlobePoint[];
  view: GlobeView;
};

/** Resting camera when nothing specific is selected (or "Global"). */
export const DEFAULT_VIEW: GlobeView = { lon: -30, lat: 22, k: 1 };

/** Closest zoom the globe will push in to. */
export const MAX_ZOOM = 4.2;

/** Fraction of the globe radius the focused country's own radius should fill. */
const FIT_FRACTION = 0.42;

/** Zoom used for a focused point-only country (no polygon to size from). */
const POINT_ZOOM = 3.4;

function capOf(f: CountryFeature): FeatureCap {
  const c = geoCentroid(f) as [number, number];
  let r = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node) && typeof node[0] === "number") {
      r = Math.max(r, geoDistance(c, node as [number, number]));
    } else if (Array.isArray(node)) {
      for (const child of node) visit(child);
    }
  };
  visit(f.geometry.coordinates);
  return { c, r };
}

export function buildGlobeWorld(features: CountryFeature[]): GlobeWorld {
  const byId = new Map<string, CountryFeature>();
  for (const f of features) {
    if (f.id !== undefined && f.id !== null) byId.set(String(f.id), f);
  }
  return { features, byId, caps: features.map(capOf) };
}

/** Half-angle (radians) of the patch of globe visible at a given zoom. */
export function visibleAngle(k: number): number {
  return k <= 1 ? Math.PI / 2 : Math.asin(1 / k);
}

/** True when a feature's bounding cap lies wholly outside what the camera can see. */
export function isOutOfView(cap: FeatureCap, view: GlobeView): boolean {
  return geoDistance([view.lon, view.lat], cap.c) - cap.r > visibleAngle(view.k) + 0.02;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The largest polygon of a (multi)polygon — the mainland, not far-flung
 * territories — so focusing "United States" centres on the contiguous states
 * rather than a point dragged towards Alaska. */
function mainland(f: CountryFeature): Feature<Polygon> {
  const g = f.geometry;
  if (g.type === "Polygon") return { type: "Feature", properties: {}, geometry: g };
  let best = g.coordinates[0];
  let bestArea = -1;
  for (const coordinates of g.coordinates) {
    const a = geoArea({ type: "Polygon", coordinates });
    if (a > bestArea) {
      bestArea = a;
      best = coordinates;
    }
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: best } };
}

/** Zoom that makes a region of the given spherical area fill FIT_FRACTION of
 * the globe radius. Treats the area as a spherical cap of angular radius θ. */
export function zoomForArea(areaSr: number): number {
  // A region covering a hemisphere or more can never be "zoomed in on".
  if (areaSr >= 2 * Math.PI) return 1;
  const cosTheta = clamp(1 - areaSr / (2 * Math.PI), -1, 1);
  const sinTheta = Math.sin(Math.acos(cosTheta));
  if (sinTheta < 1e-6) return MAX_ZOOM;
  return clamp(FIT_FRACTION / sinTheta, 1, MAX_ZOOM);
}

function membersOf(token: string): CountryInfo[] {
  if (token === GLOBAL_SCOPE) return COUNTRIES;
  if ((REGION_NAMES as string[]).includes(token)) {
    return COUNTRIES.filter((c) => c.region === (token as RegionName));
  }
  const country = COUNTRIES.find((c) => c.name === token);
  return country ? [country] : [];
}

function kindOf(token: string): GlobeScope["kind"] {
  if (token === GLOBAL_SCOPE) return "global";
  if ((REGION_NAMES as string[]).includes(token)) return "continent";
  return COUNTRIES.some((c) => c.name === token) ? "country" : "none";
}

export function resolveGlobeScope(tokens: readonly string[], world: GlobeWorld): GlobeScope {
  const focusToken = tokens[tokens.length - 1];
  const kind = focusToken ? kindOf(focusToken) : "none";
  if (kind === "none") {
    return { kind, highlightIds: [], focusId: null, points: [], view: DEFAULT_VIEW };
  }

  const focusMembers = membersOf(focusToken);
  const focusCodes = new Set(focusMembers.map((c) => c.code));

  const ids = new Set<string>();
  const points: GlobePoint[] = [];
  const seenPoints = new Set<string>();

  for (const token of tokens) {
    for (const c of membersOf(token)) {
      const id = ISO_NUMERIC_BY_ALPHA2[c.code];
      if (id && world.byId.has(id)) {
        ids.add(id);
      } else if (GLOBE_POINT_FALLBACK[c.code] && !seenPoints.has(c.code)) {
        seenPoints.add(c.code);
        const [lon, lat] = GLOBE_POINT_FALLBACK[c.code];
        points.push({ code: c.code, lon, lat, focus: focusCodes.has(c.code) });
      }
    }
  }

  let view: GlobeView = DEFAULT_VIEW;
  let focusId: string | null = null;

  if (kind === "country") {
    const c = focusMembers[0];
    const id = ISO_NUMERIC_BY_ALPHA2[c.code];
    const feature = id ? world.byId.get(id) : undefined;
    if (feature) {
      focusId = id;
      const land = mainland(feature);
      const [lon, lat] = geoCentroid(land);
      view = { lon, lat, k: zoomForArea(geoArea(land)) };
    } else if (GLOBE_POINT_FALLBACK[c.code]) {
      const [lon, lat] = GLOBE_POINT_FALLBACK[c.code];
      view = { lon, lat, k: POINT_ZOOM };
    }
  } else if (kind === "continent") {
    const feats: CountryFeature[] = [];
    for (const c of focusMembers) {
      const id = ISO_NUMERIC_BY_ALPHA2[c.code];
      const f = id ? world.byId.get(id) : undefined;
      if (f) feats.push(f);
    }
    if (feats.length > 0) {
      const collection: FeatureCollection = { type: "FeatureCollection", features: feats };
      const [lon, lat] = geoCentroid(collection);
      view = { lon, lat, k: 1 };
    }
  }

  return { kind, highlightIds: [...ids], focusId, points, view };
}

/** Great-circle distance between two views' look-at points, in degrees. */
export function viewDistanceDeg(a: GlobeView, b: GlobeView): number {
  return (geoDistance([a.lon, a.lat], [b.lon, b.lat]) * 180) / Math.PI;
}

/** Signed longitude difference b − a taking the short way round, in (−180, 180]. */
export function shortestLonDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Wrap a longitude into (−180, 180]. */
export function wrapLon(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Camera position at progress t∈[0,1] between two views. Long hops briefly
 * pull back mid-flight (a small zoom dip) so the move reads as travel rather
 * than a slide; short hops just ease straight in.
 */
export function interpolateView(from: GlobeView, to: GlobeView, t: number): GlobeView {
  const e = easeInOutCubic(clamp(t, 0, 1));
  const travel = clamp(viewDistanceDeg(from, to) / 120, 0, 1);
  const dip = 1 - 0.28 * travel * Math.sin(Math.PI * clamp(t, 0, 1));
  const k = (from.k + (to.k - from.k) * e) * dip;
  return {
    lon: wrapLon(from.lon + shortestLonDelta(from.lon, to.lon) * e),
    lat: from.lat + (to.lat - from.lat) * e,
    k: Math.max(1, k),
  };
}

/** Animation length for a camera move: longer hops take longer, within limits. */
export function durationForMove(from: GlobeView, to: GlobeView): number {
  return clamp(800 + viewDistanceDeg(from, to) * 7, 800, 1700);
}
