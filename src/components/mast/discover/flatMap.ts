/**
 * Camera maths for the Target Region card's flat map.
 *
 * The map is a plain Mercator projection drawn once at a fixed base scale; the
 * "camera" is just which part of that flat sheet is on screen:
 *
 *   view = { cx, cy, w }  — centre of the visible window and its width, in
 *                           projected units (y grows downward, like canvas).
 *
 * Everything here is pure so it can be tested without a canvas.
 */
import { geoArea, geoCentroid, geoDistance, geoMercator, geoPath } from "d3-geo";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { CountryFeature } from "@/lib/geo/globeScope";

/** Projection scale. The whole world is 2π·BASE_SCALE units wide. */
export const BASE_SCALE = 1000;
export const WORLD_W = 2 * Math.PI * BASE_SCALE;

/** One shared projection; it is only ever used to turn lon/lat into flat units. */
export const flatProjection = geoMercator().scale(BASE_SCALE).translate([0, 0]).precision(0.5);
export const flatPath = geoPath(flatProjection);

export type FlatView = { cx: number; cy: number; w: number };

/** What the camera should frame, independent of the canvas shape. */
export type FitSpec =
  | { kind: "world" }
  | { kind: "bounds"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "point"; lon: number; lat: number };

/** Share of the frame's width / height a focused country's bounding box may fill.
 * Height is tighter: the label pill sits over the bottom of the map. */
const FILL_W = 0.6;
const FILL_H = 0.5;
/** Lift the country this fraction of the frame height, clear of the label pill. */
const LIFT = 0.13;
/** Never frame a window narrower than this many degrees of longitude. */
const MIN_SPAN_DEG = 11;
const MIN_W = (MIN_SPAN_DEG * Math.PI * BASE_SCALE) / 180;
/** Zoom for a point-only country (no polygon in the atlas). */
const POINT_W = (24 * Math.PI * BASE_SCALE) / 180;

/** The world, with Antarctica's emptiness and the far north trimmed off. */
const WORLD_CENTER_LAT = 12;

/** Polygons farther than this (degrees of arc) from the biggest one are
 * far-flung territories — Alaska, Hawaii, French Guiana, Chukotka — and are
 * left out when framing a country. Home islands (Japan's four, Indonesia's
 * chain, Great Britain + Ireland's neighbours) all sit well inside it. */
const OUTLYING_DEG = 35;
/** …and specks smaller than this share of the biggest polygon never matter. */
const SPECK_SHARE = 0.01;

/**
 * The part of a country to frame: its largest polygon plus every sizeable
 * polygon near it. "United States" frames the contiguous states (not a box
 * stretched to Hawaii); "Japan" frames Honshu *and* Hokkaido, Kyushu, Shikoku.
 */
export function mainland(f: CountryFeature): Feature<Polygon | MultiPolygon> {
  const g = f.geometry;
  if (g.type === "Polygon") return { type: "Feature", properties: {}, geometry: g };

  const parts = g.coordinates.map((coordinates) => {
    const poly: Polygon = { type: "Polygon", coordinates };
    return { coordinates, area: geoArea(poly), centroid: geoCentroid(poly) };
  });
  const main = parts.reduce((best, p) => (p.area > best.area ? p : best), parts[0]);
  const keep = parts.filter(
    (p) =>
      p === main ||
      (p.area >= main.area * SPECK_SHARE &&
        (geoDistance(p.centroid, main.centroid) * 180) / Math.PI <= OUTLYING_DEG),
  );
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: keep.map((p) => p.coordinates) },
  };
}

/** Flat-unit bounds of the mainlands of the given countries, or null. */
export function mainlandBounds(features: readonly CountryFeature[]): FitSpec | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const f of features) {
    const [[ax, ay], [bx, by]] = flatPath.bounds(mainland(f));
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx);
    y1 = Math.max(y1, by);
  }
  return x0 === Infinity ? null : { kind: "bounds", x0, y0, x1, y1 };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The camera that frames `spec` in a canvas of the given width ÷ height. */
export function viewForSpec(spec: FitSpec, aspect: number): FlatView {
  if (spec.kind === "world") {
    const [cx, cy] = flatProjection([0, WORLD_CENTER_LAT]) as [number, number];
    return { cx, cy, w: WORLD_W * 1.02 };
  }
  if (spec.kind === "point") {
    const [cx, cy] = flatProjection([spec.lon, spec.lat]) as [number, number];
    return { cx, cy, w: POINT_W };
  }
  const bw = Math.max(spec.x1 - spec.x0, 1e-6);
  const bh = Math.max(spec.y1 - spec.y0, 1e-6);
  // Wide enough for the box's width, and tall enough (w / aspect) for its height.
  const w = clamp(Math.max(bw / FILL_W, (bh / FILL_H) * aspect), MIN_W, WORLD_W * 1.02);
  // The camera centre sits a little below the country, so the country sits a little high.
  return { cx: (spec.x0 + spec.x1) / 2, cy: (spec.y0 + spec.y1) / 2 + (w / aspect) * LIFT, w };
}

// ── Camera flight ────────────────────────────────────────────────────────────

const RHO = Math.SQRT2;
const cosh = (x: number) => (Math.exp(x) + Math.exp(-x)) / 2;
const sinh = (x: number) => (Math.exp(x) - Math.exp(-x)) / 2;
const tanh = (x: number) => sinh(x) / cosh(x);

export type Flight = { at: (t: number) => FlatView; duration: number };

/**
 * Smooth pan-and-zoom between two views (van Wijk & Nuij, "Smooth and
 * efficient zooming and panning"): long hops pull back and come in again, short
 * hops just glide. t runs 0 → 1; easing is applied by the caller's clock.
 */
export function flight(from: FlatView, to: FlatView): Flight {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const d2 = dx * dx + dy * dy;
  const w0 = from.w;
  const w1 = to.w;

  if (d2 < 1e-6) {
    const S = Math.log(w1 / w0) / RHO;
    return {
      at: (t) => ({ cx: from.cx, cy: from.cy, w: w0 * Math.exp(RHO * t * S) }),
      duration: 550 + Math.min(Math.abs(S), 3) * 200,
    };
  }

  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO * RHO * d1);
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO * RHO * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;

  return {
    at: (t) => {
      const s = t * S;
      const u = (w0 / (RHO * RHO * d1)) * (cosh(r0) * tanh(RHO * s + r0) - sinh(r0));
      return { cx: from.cx + u * dx, cy: from.cy + u * dy, w: (w0 * cosh(r0)) / cosh(RHO * s + r0) };
    },
    duration: clamp(520 + Math.abs(S) * 330, 700, 1500),
  };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
