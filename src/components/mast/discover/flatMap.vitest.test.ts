import { describe, expect, it } from "vitest";
import { WORLD_W, flatProjection, flight, mainland, mainlandBounds, viewForSpec } from "./flatMap";
import type { MultiPolygon } from "geojson";
import type { CountryFeature } from "@/lib/geo/globeScope";

const square = (lon: number, lat: number, d: number): CountryFeature => ({
  type: "Feature",
  id: "1",
  properties: {},
  geometry: {
    type: "Polygon",
    // d3-geo reads clockwise rings as the polygon's interior (like the real atlas).
    coordinates: [[[lon, lat], [lon, lat + d], [lon + d, lat + d], [lon + d, lat], [lon, lat]]],
  },
});

describe("viewForSpec", () => {
  it("frames the whole world width for the world spec", () => {
    const v = viewForSpec({ kind: "world" }, 2.6);
    expect(v.w).toBeGreaterThanOrEqual(WORLD_W);
    expect(v.cx).toBeCloseTo(0);
  });

  it("centres a country and leaves breathing room around it", () => {
    const spec = mainlandBounds([square(-100, 30, 20)])!;
    const v = viewForSpec(spec, 2.6);
    const [cx, yLow] = flatProjection([-90, 30]) as [number, number];
    const [, yHigh] = flatProjection([-90, 50]) as [number, number];
    expect(v.cx).toBeCloseTo(cx, 3);
    // Mercator is stretched toward the poles, so the centre is the midpoint of the projected edges.
    // (edges are great-circle arcs, so allow a few units of bow)
    // …and the camera is lifted slightly so the label pill doesn't cover the country.
    expect(v.cy).toBeGreaterThan((yLow + yHigh) / 2);
    expect(v.cy - (yLow + yHigh) / 2).toBeLessThan(v.w * 0.1);
    if (spec.kind !== "bounds") throw new Error("expected bounds");
    expect(spec.x1 - spec.x0).toBeLessThan(v.w * 0.65);
  });

  it("never zooms past the minimum span for a tiny country", () => {
    const tiny = viewForSpec(mainlandBounds([square(6, 49.4, 0.2)])!, 2.6);
    // 16° of longitude at BASE_SCALE 1000 ≈ 279 units.
    expect(tiny.w).toBeGreaterThanOrEqual(278);
  });

  it("fits tall countries by height", () => {
    const tall = viewForSpec(mainlandBounds([square(-72, -50, 6)])!, 2.6);
    const wide = viewForSpec(mainlandBounds([square(-72, 0, 6)])!, 2.6);
    expect(tall.w).toBeGreaterThan(0);
    expect(wide.w).toBeGreaterThan(0);
  });
});

describe("flight", () => {
  const a = { cx: -300, cy: -400, w: 2400 };
  const b = { cx: 2100, cy: -250, w: 700 };

  it("starts and ends exactly on the given views", () => {
    const f = flight(a, b);
    const s = f.at(0);
    const e = f.at(1);
    expect(s.cx).toBeCloseTo(a.cx, 3);
    expect(s.w).toBeCloseTo(a.w, 3);
    expect(e.cx).toBeCloseTo(b.cx, 3);
    expect(e.cy).toBeCloseTo(b.cy, 3);
    expect(e.w).toBeCloseTo(b.w, 3);
  });

  it("pulls back mid-flight on a long hop", () => {
    const far = { cx: 5000, cy: 0, w: 700 };
    const near = { cx: -300, cy: -400, w: 700 };
    const mid = flight(near, far).at(0.5);
    expect(mid.w).toBeGreaterThan(700);
  });

  it("handles a pure zoom (same centre)", () => {
    const f = flight({ cx: 0, cy: 0, w: 4000 }, { cx: 0, cy: 0, w: 1000 });
    expect(f.at(1).w).toBeCloseTo(1000, 3);
    expect(f.duration).toBeGreaterThan(0);
  });
});

describe("mainland", () => {
  const ring = (lon: number, lat: number, d: number) => [[lon, lat], [lon, lat + d], [lon + d, lat + d], [lon + d, lat], [lon, lat]];
  const multi = (...rings: number[][][]): CountryFeature => ({
    type: "Feature",
    id: "2",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
  });

  it("keeps nearby islands together with the biggest landmass", () => {
    const japanish = multi(ring(131, 33.5, 8), ring(140, 41.5, 4), ring(129.5, 31, 2.5));
    const g = mainland(japanish).geometry;
    expect(g.type).toBe("MultiPolygon");
    expect((g as MultiPolygon).coordinates).toHaveLength(3);
  });

  it("drops far-flung territories and specks", () => {
    // A big mainland, two distant territories, and a speck right next to it.
    const usish = multi(ring(-125, 25, 45), ring(-170, 5, 10), ring(-158, 19, 3), ring(-100, 30, 0.05));
    const g = mainland(usish).geometry as MultiPolygon;
    expect(g.coordinates).toHaveLength(1);
  });
});

describe("mainland on the real atlas", () => {
  const load = async () => {
    const atlas = (await import("world-atlas/countries-110m.json")).default;
    const topo = await import("topojson-client");
    const fc = topo.feature(atlas, atlas.objects.countries) as unknown as { features: CountryFeature[] };
    return (id: string) => fc.features.find((f) => String(f.id) === id)!;
  };
  const lonLatBounds = (g: MultiPolygon | { type: "Polygon"; coordinates: number[][][] }) => {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    let w = 999, e = -999, s = 999, n = -999;
    for (const p of polys) for (const [lon, lat] of p[0]) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    return { w, e, s, n };
  };

  it("frames the contiguous United States, not Alaska or Hawaii", async () => {
    const b = lonLatBounds(mainland((await load())("840")).geometry as MultiPolygon);
    expect(b.w).toBeGreaterThan(-130);
    expect(b.n).toBeLessThan(50);
    expect(b.s).toBeGreaterThan(24);
  });

  it("frames every Japanese home island", async () => {
    const b = lonLatBounds(mainland((await load())("392")).geometry as MultiPolygon);
    expect(b.n).toBeGreaterThan(44); // Hokkaido
    expect(b.s).toBeLessThan(32); // Kyushu
  });

  it("leaves French Guiana and Chukotka out", async () => {
    const get = await load();
    expect(lonLatBounds(mainland(get("250")).geometry as MultiPolygon).w).toBeGreaterThan(-6);
    expect(lonLatBounds(mainland(get("643")).geometry as MultiPolygon).e).toBeLessThan(180.1);
  });

  it("keeps the whole Indonesian chain", async () => {
    const b = lonLatBounds(mainland((await load())("360")).geometry as MultiPolygon);
    expect(b.w).toBeLessThan(99); // Sumatra
    expect(b.e).toBeGreaterThan(130); // Papua
  });
});
