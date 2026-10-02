/**
 * The planet itself: a 2D-canvas orthographic globe that flies to whatever
 * region(s) Discover has selected and lights them up.
 *
 * Performance model — this is deliberately a *still* globe:
 *   - It only redraws while the camera is moving (~1s after a selection
 *     change) and on resize. At rest there is no rAF loop and no per-frame
 *     work; the continuous motion on the page is the CSS orbit rings.
 *   - Geometry is the 110m Natural Earth atlas (~100KB), loaded on demand in
 *     its own chunk, only once the globe has a real on-screen size. This whole
 *     module is itself lazy-loaded by DiscoverGlobe, so the form is
 *     interactive before any of it arrives.
 *   - One path per layer (land / highlight), not one per country.
 *
 * Zoom is a lens: when k > 1 the projection is larger than the disk and the
 * canvas clips to the disk, so zooming in on a country pushes in on the
 * surface instead of growing the planet.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { geoGraticule10, geoOrthographic, geoPath, geoDistance } from "d3-geo";
import {
  DEFAULT_VIEW,
  buildGlobeWorld,
  durationForMove,
  isOutOfView,
  interpolateView,
  resolveGlobeScope,
  type CountryFeature,
  type GlobeScope,
  type GlobeView,
  type GlobeWorld,
} from "@/lib/geo/globeScope";

const GRATICULE = geoGraticule10();

let worldPromise: Promise<GlobeWorld> | null = null;

/** Loads + indexes the atlas once per page session. */
function loadWorld(): Promise<GlobeWorld> {
  if (!worldPromise) {
    worldPromise = Promise.all([import("world-atlas/countries-110m.json"), import("topojson-client")]).then(
      ([atlas, topo]) => {
        const topology = atlas.default;
        const fc = topo.feature(topology, topology.objects.countries) as unknown as {
          features: CountryFeature[];
        };
        return buildGlobeWorld(fc.features);
      },
    );
    // A failed fetch must not poison later mounts.
    worldPromise.catch(() => {
      worldPromise = null;
    });
  }
  return worldPromise;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type DrawState = {
  world: GlobeWorld;
  scope: GlobeScope;
  highlight: CountryFeature[];
  focusFeature: CountryFeature | null;
};

/**
 * `moving` draws a leaner frame (no graticule, no halo, coarser curve
 * resampling) while the camera is flying — details nobody can read at speed —
 * and the full-quality frame is drawn the moment it settles.
 */
function drawGlobe(
  ctx: CanvasRenderingContext2D,
  size: number,
  dpr: number,
  view: GlobeView,
  s: DrawState,
  moving: boolean,
) {
  const R = size / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.arc(R, R, R, 0, Math.PI * 2);
  ctx.clip();

  // Ocean: a lit sphere, brighter toward the upper-left light.
  const ocean = ctx.createRadialGradient(R * 0.72, R * 0.6, R * 0.05, R, R, R * 1.08);
  ocean.addColorStop(0, "#1d2670");
  ocean.addColorStop(0.5, "#0f1647");
  ocean.addColorStop(1, "#060a23");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, size, size);

  const projection = geoOrthographic()
    .clipAngle(90)
    .precision(moving ? 2.5 : 0.7)
    .translate([R, R])
    .scale(R * view.k)
    .rotate([-view.lon, -view.lat]);
  const path = geoPath(projection, ctx);

  ctx.lineJoin = "round";

  if (!moving) {
    ctx.beginPath();
    path(GRATICULE);
    ctx.strokeStyle = "rgba(132,148,255,0.09)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  ctx.beginPath();
  const { features, caps } = s.world;
  for (let i = 0; i < features.length; i++) {
    if (!isOutOfView(caps[i], view)) path(features[i]);
  }
  ctx.fillStyle = "rgba(96,108,238,0.17)";
  ctx.fill();
  if (!moving) {
    ctx.strokeStyle = "rgba(152,162,255,0.30)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  if (s.highlight.length > 0) {
    ctx.beginPath();
    for (const f of s.highlight) path(f);
    if (!moving) {
      ctx.strokeStyle = "rgba(124,92,255,0.30)"; // soft halo, no shadowBlur (too slow per frame)
      ctx.lineWidth = 7;
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(122,96,255,0.50)";
    ctx.fill();
    ctx.strokeStyle = "rgba(190,199,255,0.92)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  if (s.focusFeature) {
    ctx.beginPath();
    path(s.focusFeature);
    ctx.fillStyle = "rgba(160,132,255,0.5)";
    ctx.fill();
    ctx.strokeStyle = "rgba(232,236,255,0.98)";
    ctx.lineWidth = 1.7;
    ctx.stroke();
  }

  // Countries too small for the atlas: a lit point instead of a polygon.
  for (const p of s.scope.points) {
    if (geoDistance([view.lon, view.lat], [p.lon, p.lat]) >= Math.PI / 2) continue;
    const xy = projection([p.lon, p.lat]);
    if (!xy) continue;
    ctx.beginPath();
    ctx.arc(xy[0], xy[1], p.focus ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(124,92,255,0.30)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(xy[0], xy[1], p.focus ? 3.6 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,236,255,0.98)";
    ctx.fill();
  }

  ctx.restore();
}

export default function GlobeCanvas({ regions }: { regions: readonly string[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(0);
  const sizeRef = useRef(0);
  sizeRef.current = size;
  const [world, setWorld] = useState<GlobeWorld | null>(null);

  const viewRef = useRef<GlobeView>(DEFAULT_VIEW);
  const stateRef = useRef<DrawState | null>(null);
  const rafRef = useRef<number | null>(null);
  const hasDrawnRef = useRef(false);

  // The pin marks the focused country once the camera has arrived.
  const [pin, setPin] = useState<{ key: number; show: boolean }>({ key: 0, show: false });

  const regionsKey = regions.join("|");
  const tokens = useMemo(() => (regionsKey ? regionsKey.split("|") : []), [regionsKey]);

  // Track the globe's on-screen size (CSS px). No observer → size stays 0 and
  // nothing loads or draws (e.g. under jsdom).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setSize(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch geometry once there is something to draw it into.
  useEffect(() => {
    if (size === 0 || world) return;
    let alive = true;
    loadWorld()
      .then((w) => alive && setWorld(w))
      .catch(() => {
        /* The CSS sphere + orbits still render; the map layer is optional. */
      });
    return () => {
      alive = false;
    };
  }, [size, world]);

  // Reads size from a ref so a camera move already in flight keeps drawing at
  // the right scale if the globe is resized mid-flight.
  const paint = (view: GlobeView, moving = false) => {
    const canvas = canvasRef.current;
    const state = stateRef.current;
    const px = sizeRef.current;
    if (!canvas || !state || px === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawGlobe(ctx, px, Math.min(window.devicePixelRatio || 1, 2), view, state, moving);
  };

  // Size the backing store whenever the CSS size changes, then repaint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    if (stateRef.current) paint(viewRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // Selection changed (or geometry just arrived): fly there.
  useEffect(() => {
    if (!world || sizeRef.current === 0) return;

    const scope = resolveGlobeScope(tokens, world);
    const highlight = scope.highlightIds
      .map((id) => world.byId.get(id))
      .filter((f): f is CountryFeature => !!f);
    stateRef.current = {
      world,
      scope,
      highlight,
      focusFeature: scope.focusId ? (world.byId.get(scope.focusId) ?? null) : null,
    };

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    const from = viewRef.current;
    const to = scope.view;
    const wantsPin = scope.kind === "country";
    const arrive = () => setPin((p) => ({ key: p.key + 1, show: wantsPin }));

    // First paint, and reduced-motion users, snap instead of flying.
    if (!hasDrawnRef.current || prefersReducedMotion()) {
      hasDrawnRef.current = true;
      viewRef.current = to;
      paint(to);
      arrive();
      return;
    }

    setPin((p) => ({ ...p, show: false }));
    const duration = durationForMove(from, to);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const view = interpolateView(from, to, t);
      viewRef.current = view;
      paint(view, t < 1);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        arrive();
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, tokens]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 size-0 transition-opacity duration-500"
        style={{ opacity: pin.show ? 1 : 0 }}
      >
        {pin.show && <span key={pin.key} className="dg-pin-ring absolute -left-4 -top-4 size-8 rounded-full border border-white/70" />}
        <span className="absolute -left-[5px] -top-[5px] size-2.5 rounded-full bg-white shadow-[0_0_0_3px_rgba(124,92,255,0.45),0_0_16px_4px_rgba(150,130,255,0.7)]" />
      </div>
    </div>
  );
}
