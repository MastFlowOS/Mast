import { describe, it, expect } from "vitest";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import atlas from "world-atlas/countries-110m.json";
import { COUNTRIES } from "./countries";
import { GLOBE_POINT_FALLBACK, ISO_NUMERIC_BY_ALPHA2 } from "./isoNumeric";
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  buildGlobeWorld,
  durationForMove,
  isOutOfView,
  visibleAngle,
  interpolateView,
  resolveGlobeScope,
  shortestLonDelta,
  zoomForArea,
  type CountryFeature,
} from "./globeScope";

const topology = atlas as unknown as Topology;
const world = buildGlobeWorld(
  (feature(topology, topology.objects.countries) as unknown as { features: CountryFeature[] }).features,
);

describe("globe data coverage", () => {
  it("every supported country is either a polygon in the atlas or an explicit point fallback", () => {
    const orphans = COUNTRIES.filter((c) => {
      const id = ISO_NUMERIC_BY_ALPHA2[c.code];
      return !(id && world.byId.has(id)) && !GLOBE_POINT_FALLBACK[c.code];
    }).map((c) => c.name);
    expect(orphans).toEqual([]);
  });
});

describe("resolveGlobeScope", () => {
  it("nothing selected → default camera, nothing lit", () => {
    const s = resolveGlobeScope([], world);
    expect(s.kind).toBe("none");
    expect(s.highlightIds).toEqual([]);
    expect(s.view).toEqual(DEFAULT_VIEW);
  });

  it("a country is highlighted and the camera centres on its mainland and pushes in", () => {
    const s = resolveGlobeScope(["United States"], world);
    expect(s.kind).toBe("country");
    expect(s.highlightIds).toEqual(["840"]);
    expect(s.focusId).toBe("840");
    // Contiguous US, not dragged toward Alaska/Hawaii.
    expect(s.view.lon).toBeGreaterThan(-110);
    expect(s.view.lon).toBeLessThan(-90);
    expect(s.view.lat).toBeGreaterThan(34);
    expect(s.view.lat).toBeLessThan(45);
    expect(s.view.k).toBeGreaterThan(1.2);
  });

  it("smaller countries zoom in further than larger ones", () => {
    const ca = resolveGlobeScope(["Canada"], world).view.k;
    const us = resolveGlobeScope(["United States"], world).view.k;
    const uk = resolveGlobeScope(["United Kingdom"], world).view.k;
    const nl = resolveGlobeScope(["Netherlands"], world).view.k;
    expect(ca).toBeLessThanOrEqual(us);
    expect(uk).toBeGreaterThan(us);
    expect(nl).toBeGreaterThanOrEqual(uk);
    expect(nl).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it("the most recently selected token owns the camera; all are highlighted", () => {
    const s = resolveGlobeScope(["United States", "Germany"], world);
    expect(s.highlightIds.sort()).toEqual(["276", "840"]);
    expect(s.focusId).toBe("276");
    expect(s.view.lon).toBeGreaterThan(5);
    expect(s.view.lon).toBeLessThan(15);
  });

  it("a continent lights every supported country on it and frames the whole region", () => {
    const s = resolveGlobeScope(["Europe"], world);
    const europe = COUNTRIES.filter((c) => c.region === "Europe");
    expect(s.kind).toBe("continent");
    expect(s.view.k).toBe(1);
    expect(s.highlightIds.length + s.points.length).toBe(europe.length);
    expect(s.focusId).toBeNull();
    expect(s.view.lon).toBeGreaterThan(-5);
    expect(s.view.lon).toBeLessThan(35);
  });

  it("Global lights every supported country and rests on the default camera", () => {
    const s = resolveGlobeScope(["Global"], world);
    expect(s.kind).toBe("global");
    expect(s.highlightIds.length + s.points.length).toBe(COUNTRIES.length);
    expect(s.view).toEqual(DEFAULT_VIEW);
  });

  it("a country with no polygon (Singapore) becomes a focused point, not a missing highlight", () => {
    const s = resolveGlobeScope(["Singapore"], world);
    expect(s.highlightIds).toEqual([]);
    expect(s.points).toEqual([expect.objectContaining({ code: "SG", focus: true })]);
    expect(s.view.lon).toBeCloseTo(103.8, 0);
    expect(s.view.k).toBeGreaterThan(1);
  });

  it("ignores tokens that are neither Global, a continent, nor a supported country", () => {
    const s = resolveGlobeScope(["Atlantis"], world);
    expect(s.kind).toBe("none");
    expect(s.highlightIds).toEqual([]);
  });
});

describe("camera motion", () => {
  it("zoomForArea is clamped to [1, MAX_ZOOM]", () => {
    expect(zoomForArea(4 * Math.PI)).toBe(1);
    expect(zoomForArea(0)).toBe(MAX_ZOOM);
    expect(zoomForArea(1e-7)).toBe(MAX_ZOOM);
  });

  it("longitude takes the short way across the antimeridian", () => {
    expect(shortestLonDelta(170, -170)).toBe(20);
    expect(shortestLonDelta(-170, 170)).toBe(-20);
    expect(shortestLonDelta(10, 40)).toBe(30);
  });

  it("interpolation starts and ends exactly on the endpoints and never zooms out past the globe", () => {
    const a = { lon: -98, lat: 39, k: 1.6 };
    const b = { lon: 139, lat: 36, k: 2.5 };
    expect(interpolateView(a, b, 0)).toEqual(a);
    const end = interpolateView(a, b, 1);
    expect(end.lon).toBeCloseTo(b.lon, 6);
    expect(end.lat).toBeCloseTo(b.lat, 6);
    expect(end.k).toBeCloseTo(b.k, 6);
    for (let t = 0; t <= 1; t += 0.05) {
      expect(interpolateView(a, b, t).k).toBeGreaterThanOrEqual(1);
    }
  });

  it("a long hop dips the zoom mid-flight; a no-op hop does not", () => {
    const a = { lon: -98, lat: 39, k: 2 };
    const far = { lon: 139, lat: 36, k: 2 };
    expect(interpolateView(a, far, 0.5).k).toBeLessThan(2);
    expect(interpolateView(a, a, 0.5).k).toBeCloseTo(2, 6);
  });

  it("longer hops take longer, within bounds", () => {
    const a = { lon: 0, lat: 0, k: 1 };
    expect(durationForMove(a, a)).toBe(800);
    expect(durationForMove(a, { lon: 180, lat: 0, k: 1 })).toBeLessThanOrEqual(1700);
    expect(durationForMove(a, { lon: 90, lat: 0, k: 1 })).toBeGreaterThan(durationForMove(a, { lon: 10, lat: 0, k: 1 }));
  });
});

describe("view culling", () => {
  it("culls countries on the far side of the globe but never ones in view", () => {
    const view = { lon: -98, lat: 39, k: 1 };
    const idx = (id: string) => world.features.findIndex((f) => String(f.id) === id);
    expect(isOutOfView(world.caps[idx("840")], view)).toBe(false); // United States, centred
    expect(isOutOfView(world.caps[idx("036")], view)).toBe(true); // Australia, far side
    expect(world.caps).toHaveLength(world.features.length);
  });

  it("a zoomed lens sees a narrower patch, so more is culled", () => {
    expect(visibleAngle(1)).toBeCloseTo(Math.PI / 2, 6);
    expect(visibleAngle(2)).toBeLessThan(visibleAngle(1));
    const view = { lon: -98, lat: 39, k: 3 };
    const culled = world.caps.filter((c) => isOutOfView(c, view)).length;
    expect(culled).toBeGreaterThan(world.features.length * 0.8);
  });

  it("anything highlighted in the focused country is always inside its own lens", () => {
    for (const name of ["United States", "Canada", "Germany", "Japan", "Brazil", "Australia"]) {
      const s = resolveGlobeScope([name], world);
      const idx = world.features.findIndex((f) => String(f.id) === s.focusId);
      // The mainland the camera centres on must never be culled out of its own view.
      expect(isOutOfView(world.caps[idx], s.view)).toBe(false);
    }
  });
});
