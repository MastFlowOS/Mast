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

/** The sheet is tipped back in CSS perspective (top recedes) for depth. Tweak to taste. */
const TILT_DEG = 30;
const TILT_PERSPECTIVE = 640; // px; smaller = stronger perspective
const TILT_SCALE = 1.14; // compensates for the recession so the map still fills the card
const TILT_ORIGIN = "50% 64%";
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
    // A country is highlighted, not zoomed to: the world stays in view, just ~10% closer.
    const b = focus ? mainlandBounds([focus]) : null;
    if (b && b.kind === "bounds") return { kind: "focus", x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    const p = scope.points.find((pt) => pt.focus);
    const xy = p ? flatProjection([p.lon, p.lat]) : null;
    return xy ? { kind: "focus", x: xy[0], y: xy[1] } : { kind: "world" };
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
  const top = view.cy - H / (2 * s);
  const bottom = view.cy + H / (2 * s);

  if (!moving) {
    ctx.beginPath();
    pathTo(GRATICULE);
    ctx.strokeStyle = "rgba(110,130,255,0.10)";
    ctx.lineWidth = px(0.7);
    ctx.stroke();
  }

  const landPath = () => {
    ctx.beginPath();
    for (const f of frame.world.features) pathTo(f);
  };
  const highlightPath = () => {
    ctx.beginPath();
    for (const f of frame.highlight) pathTo(f);
  };

  // Soft contact shadow under the whole slab, so it floats above the grid.
  if (!moving) {
    ctx.save();
    ctx.translate(0, px(11));
    landPath();
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 18 * dpr;
    ctx.fillStyle = "rgba(2,4,18,1)";
    ctx.fill();
    ctx.restore();
  }

  // Thickness: the land stacked downward in darkening layers (an extruded slab).
  const depth = moving ? 4 : 9;
  for (let d = depth; d >= 1; d--) {
    ctx.save();
    ctx.translate(0, px(d));
    landPath();
    ctx.fillStyle = `rgb(${6 + (depth - d) * 1.2}, ${10 + (depth - d) * 1.6}, ${30 + (depth - d) * 3})`;
    ctx.fill();
    ctx.restore();
  }

  // Rim light: the land again, nudged up in a cool highlight, so only its upper edges show.
  ctx.save();
  ctx.translate(0, px(-1.3));
  landPath();
  ctx.fillStyle = "rgba(120,150,255,0.75)";
  ctx.fill();
  ctx.restore();

  // Top surface: navy, lighter toward the far edge, with thin borders.
  landPath();
  const land = ctx.createLinearGradient(0, top, 0, bottom);
  land.addColorStop(0, "rgb(34,52,120)");
  land.addColorStop(0.55, "rgb(18,28,76)");
  land.addColorStop(1, "rgb(12,18,52)");
  ctx.fillStyle = land;
  ctx.fill();
  ctx.strokeStyle = "rgba(98,122,240,0.38)";
  ctx.lineWidth = px(0.55);
  ctx.stroke();

  // Selected countries: raised violet body, glowing into the dark land around it.
  if (frame.highlight.length > 0) {
    const few = frame.highlight.length <= 6;
    const rise = few ? 6 : 3;

    // Violet glow halo on the surrounding land.
    if (few) {
      ctx.save();
      highlightPath();
      ctx.shadowColor = "rgba(124,92,255,0.95)";
      ctx.shadowBlur = (moving ? 16 : 34) * dpr;
      ctx.fillStyle = "rgba(112,84,255,0.55)";
      ctx.fill();
      ctx.restore();
    }

    // Its own thickness, raised above the land.
    for (let d = rise; d >= 1; d--) {
      ctx.save();
      ctx.translate(0, px(d - rise - 1));
      highlightPath();
      ctx.fillStyle = `rgb(${52 + (rise - d) * 5}, ${34 + (rise - d) * 3}, ${150 + (rise - d) * 8})`;
      ctx.fill();
      ctx.restore();
    }

    // Lit top face.
    ctx.save();
    ctx.translate(0, px(-rise - 1));
    highlightPath();
    const hi = ctx.createLinearGradient(0, top, 0, bottom);
    hi.addColorStop(0, few ? "rgb(150,118,255)" : "rgba(150,118,255,0.7)");
    hi.addColorStop(1, few ? "rgb(92,62,238)" : "rgba(92,62,238,0.7)");
    ctx.fillStyle = hi;
    ctx.fill();
    ctx.strokeStyle = "rgba(218,222,255,0.8)";
    ctx.lineWidth = px(0.8);
    ctx.stroke();
    ctx.restore();

    if (frame.focus) {
      ctx.save();
      ctx.translate(0, px(-rise - 1));
      ctx.beginPath();
      pathTo(frame.focus);
      ctx.fillStyle = "rgba(170,146,255,0.22)";
      ctx.fill();
      ctx.strokeStyle = "rgba(238,240,255,0.95)";
      ctx.lineWidth = px(1.1);
      ctx.stroke();
      ctx.restore();
    }
  } else if (frame.focus) {
    ctx.beginPath();
    pathTo(frame.focus);
    ctx.strokeStyle = "rgba(236,239,255,0.95)";
    ctx.lineWidth = px(1.2);
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
      // Layout size (not getBoundingClientRect): the sheet is CSS-tilted, which would skew a rect.
      setBox({ w: el.clientWidth, h: el.clientHeight });
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
    <div className="absolute inset-0">
      <div
        ref={wrapRef}
        className="absolute inset-0"
        style={{
          transform: `perspective(${TILT_PERSPECTIVE}px) rotateX(${TILT_DEG}deg) scale(${TILT_SCALE})`,
          transformOrigin: TILT_ORIGIN,
        }}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      </div>
    </div>
  );
}
