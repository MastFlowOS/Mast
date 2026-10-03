/**
 * The Target Region card's map: a flat, 2D Mercator map of country shapes.
 *
 * This is NOT the hero globe and shares nothing visual with it. The sheet of
 * countries is what moves: when the selection changes the map glides (pan +
 * zoom) to the newly picked country, the selected countries light up, and it
 * settles there.
 *
 *   - Geometry is the same 110m Natural Earth atlas the rest of Discover uses,
 *     loaded on demand in its own chunk (this module is lazy-loaded).
 *   - What to highlight and which country is "the focus" comes from the shared
 *     scope resolver (resolveGlobeScope), so country / continent / Global
 *     tokens mean exactly what they mean everywhere else.
 *   - It only repaints while the camera is moving and on resize — no rAF loop
 *     at rest.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { geoGraticule10, geoPath } from "d3-geo";
import {
  buildGlobeWorld,
  resolveGlobeScope,
  type CountryFeature,
  type GlobeScope,
  type GlobeWorld,
} from "@/lib/geo/globeScope";
import {
  easeInOutCubic,
  flatProjection,
  flight,
  mainlandBounds,
  viewForSpec,
  type FitSpec,
  type FlatView,
} from "./flatMap";

const GRATICULE = geoGraticule10();
/** Antarctica (ISO numeric 010) only adds a slab of white at the bottom of a Mercator map. */
const ANTARCTICA = "010";

let worldPromise: Promise<GlobeWorld> | null = null;

function loadWorld(): Promise<GlobeWorld> {
  if (!worldPromise) {
    worldPromise = Promise.all([import("world-atlas/countries-110m.json"), import("topojson-client")]).then(
      ([atlas, topo]) => {
        const topology = atlas.default;
        const fc = topo.feature(topology, topology.objects.countries) as unknown as {
          features: CountryFeature[];
        };
        return buildGlobeWorld(fc.features.filter((f) => String(f.id) !== ANTARCTICA));
      },
    );
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

type Frame = {
  world: GlobeWorld;
  scope: GlobeScope;
  highlight: CountryFeature[];
  focus: CountryFeature | null;
  spec: FitSpec;
};

/** What the camera should frame for a resolved scope. */
function specForScope(scope: GlobeScope, world: GlobeWorld, highlight: CountryFeature[]): FitSpec {
  if (scope.kind === "none" || scope.kind === "global") return { kind: "world" };

  if (scope.kind === "country") {
    const focus = scope.focusId ? world.byId.get(scope.focusId) : undefined;
    if (focus) return mainlandBounds([focus]) ?? { kind: "world" };
    const p = scope.points.find((pt) => pt.focus);
    return p ? { kind: "point", lon: p.lon, lat: p.lat } : { kind: "world" };
  }

  // Continent: frame the mainlands of its countries.
  return mainlandBounds(highlight) ?? { kind: "world" };
}

function paint(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  dpr: number,
  view: FlatView,
  frame: Frame,
  moving: boolean,
) {
  const s = W / view.w; // px per projected unit
  const px = (n: number) => n / s; // a constant on-screen width, in projected units

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(s, s);
  ctx.translate(-view.cx, -view.cy);
  ctx.lineJoin = "round";

  const pathTo = geoPath(flatProjection, ctx);

  if (!moving) {
    ctx.beginPath();
    pathTo(GRATICULE);
    ctx.strokeStyle = "rgba(132,148,255,0.07)";
    ctx.lineWidth = px(0.6);
    ctx.stroke();
  }

  // Every country, one path.
  ctx.beginPath();
  for (const f of frame.world.features) pathTo(f);
  ctx.fillStyle = "rgba(70,86,205,0.20)";
  ctx.fill();
  ctx.strokeStyle = "rgba(150,165,255,0.34)";
  ctx.lineWidth = px(0.7);
  ctx.stroke();

  // Selected countries.
  if (frame.highlight.length > 0) {
    ctx.beginPath();
    for (const f of frame.highlight) pathTo(f);
    // A halo reads well around one or a few countries; around a whole continent it's mush.
    if (!moving && frame.highlight.length <= 6) {
      ctx.strokeStyle = "rgba(124,92,255,0.32)";
      ctx.lineWidth = px(5);
      ctx.stroke();
    }
    ctx.fillStyle = frame.highlight.length > 6 ? "rgba(122,96,255,0.42)" : "rgba(122,96,255,0.58)";
    ctx.fill();
    ctx.strokeStyle = "rgba(196,204,255,0.95)";
    ctx.lineWidth = px(1.1);
    ctx.stroke();
  }

  if (frame.focus) {
    ctx.beginPath();
    pathTo(frame.focus);
    ctx.fillStyle = "rgba(150,122,255,0.42)";
    ctx.fill();
    ctx.strokeStyle = "rgba(236,239,255,1)";
    ctx.lineWidth = px(1.5);
    ctx.stroke();
  }

  ctx.restore();

  // Countries too small for the atlas: a lit dot, constant on-screen size.
  // (Only when a country is the subject — under Global / a continent they'd be confetti.)
  const points = frame.scope.kind === "country" ? frame.scope.points : [];
  for (const p of points) {
    const xy = flatProjection([p.lon, p.lat]);
    if (!xy) continue;
    const x = (xy[0] - view.cx) * s + W / 2;
    const y = (xy[1] - view.cy) * s + H / 2;
    ctx.beginPath();
    ctx.arc(x, y, p.focus ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(124,92,255,0.34)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, p.focus ? 3.6 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(236,239,255,1)";
    ctx.fill();
  }
}

export default function TargetRegionMap({ regions }: { regions: readonly string[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const boxRef = useRef(box);
  boxRef.current = box;
  const [world, setWorld] = useState<GlobeWorld | null>(null);

  const viewRef = useRef<FlatView | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const rafRef = useRef<number | null>(null);

  const regionsKey = regions.join("|");
  const tokens = useMemo(() => (regionsKey ? regionsKey.split("|") : []), [regionsKey]);

  // Track the canvas's CSS size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch geometry once there is somewhere to draw it.
  useEffect(() => {
    if (box.w === 0 || world) return;
    let alive = true;
    loadWorld()
      .then((w) => alive && setWorld(w))
      .catch(() => {
        /* The card still works without the map. */
      });
    return () => {
      alive = false;
    };
  }, [box.w, world]);

  const draw = (view: FlatView, moving = false) => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    const { w, h } = boxRef.current;
    if (!canvas || !frame || w === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint(ctx, w, h, Math.min(window.devicePixelRatio || 1, 2), view, frame, moving);
  };

  // Size the backing store, then re-frame (no flight — it's a resize).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || box.w === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(box.w * dpr);
    canvas.height = Math.round(box.h * dpr);
    if (frameRef.current) {
      const v = viewForSpec(frameRef.current.spec, box.w / box.h);
      viewRef.current = v;
      draw(v);
    }
  }, [box.w, box.h]);

  // Selection changed (or geometry just arrived): glide there and settle.
  useEffect(() => {
    if (!world || boxRef.current.w === 0) return;

    const scope = resolveGlobeScope(tokens, world);
    const highlight = scope.highlightIds
      .map((id) => world.byId.get(id))
      .filter((f): f is CountryFeature => !!f);
    const spec = specForScope(scope, world, highlight);
    frameRef.current = {
      world,
      scope,
      highlight,
      focus: scope.focusId ? (world.byId.get(scope.focusId) ?? null) : null,
      spec,
    };

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    const to = viewForSpec(spec, boxRef.current.w / boxRef.current.h);
    const from = viewRef.current;

    // First paint, and reduced-motion users, snap instead of gliding.
    if (!from || prefersReducedMotion()) {
      viewRef.current = to;
      draw(to);
      return;
    }

    const f = flight(from, to);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / f.duration);
      const v = t >= 1 ? to : f.at(easeInOutCubic(t));
      viewRef.current = v;
      draw(v, t < 1);
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [world, tokens]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
    </div>
  );
}
