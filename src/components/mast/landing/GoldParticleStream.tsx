import { useEffect, useRef } from "react";

/**
 * One continuous celestial gold current running from the top of the landing
 * page to the footer.
 *
 * ARCHITECTURE — document-space, not viewport-space:
 *
 * This is rendered as a normal, absolutely-positioned DOM layer *inside* the
 * page's content flow (`inset-0` on a `relative` ancestor whose height is the
 * page's own content height), split into a stack of tile <canvas> elements
 * each pinned to a fixed `top` offset in that document. There is no fixed
 * viewport overlay and no `screenY = documentY - scrollY` conversion anywhere
 * in this file. The browser's compositor scrolls these tiles exactly the way
 * it scrolls any other page content — for free, on the compositor thread,
 * with zero JavaScript involvement per scroll frame. A ResizeObserver on the
 * container (not a scroll listener) is the only thing that ever moves a
 * tile's `top`, and only when the page's actual content height changes.
 *
 * PERFORMANCE MODEL, PART 1 — bake once, animate almost nothing:
 *
 * Each tile's canvas bitmap is painted once and never redrawn — there is no
 * `requestAnimationFrame` loop in this file. The handful of particles that
 * should visibly shimmer (a small, page-wide-capped "highlight" subset) are
 * excluded from the bake and rendered as tiny DOM elements animated purely
 * by CSS `@keyframes` on the compositor thread.
 *
 * PERFORMANCE MODEL, PART 2 — never block first paint with the bake itself:
 *
 * Profiling showed that even with the RAF loop removed, baking the *entire*
 * document's ~25,000+ particles into canvas bitmaps synchronously on mount
 * was itself a single ~1.1–1.8 second main-thread task — long enough on its
 * own to badly delay LCP, because it ran before the browser had a chance to
 * paint the hero. So the bake is now:
 *
 *   - Split into small, bounded units of work (a tile's cluster cores, then
 *     batches of ~200 stars at a time, then that tile's small DOM highlight
 *     set) — no single unit takes more than a few milliseconds.
 *   - Scheduled with `requestIdleCallback` (falling back to `setTimeout` on
 *     engines without it), so it only runs when the browser has spare main-
 *     thread time — i.e. after the hero has already had its chance to paint.
 *   - Ordered so the tile(s) covering the current viewport are baked first;
 *     an IntersectionObserver promotes a tile's work to the front of the
 *     queue the moment it's about to scroll into view, so fast scrolling
 *     doesn't outrun the background bake.
 *   - Never scroll-driven: the IntersectionObserver only reprioritizes
 *     already-scheduled idle work: it does not add a scroll listener and
 *     does not compute anything from `scrollY`.
 *
 * The empty tile `<canvas>` elements themselves ARE created synchronously on
 * mount (cheap — no pixel work, and this layer's ancestor's height comes
 * from the page's own content, so their presence never affects layout or
 * causes a layout shift). Only the expensive part — generating the particle
 * population and painting it — is deferred and chunked.
 *
 * The visual model is unchanged: a chain of GLOBULAR CLUSTERS strung along a
 * wide, wavy spine — a blazing unresolved core, a dense resolved halo
 * falling off steeply, then feathered outliers. Clusters overlap along the
 * path, and a field population bridges the gaps, so the eye reads one thick,
 * clustered golden ribbon rather than a scattering of dots or a drawn line.
 * The one visible trade-off from the change above: the ribbon now fills in
 * tile-by-tile over the first idle moments after load, instead of appearing
 * fully-formed in the same frame as the rest of the page — a deliberate,
 * small, disclosed visual cost in exchange for a paintable hero.
 *
 * Every particle's position is fixed in document space (`u` = fraction down
 * the total page height, `lx`/`ly` = offset from the spine). Nothing here is
 * ever a function of scroll.
 */

type Star = {
  u: number; // position along the document [0,1] — fixed, never touched after creation
  lx: number; // lateral offset from the spine, in units of the ribbon half-width
  ly: number; // vertical offset within its cluster, in ribbon half-widths
  size: number; // core radius in px
  colorIdx: number;
  alpha: number;
  twSpeed: number;
  twPhase: number;
  driftAmp: number;
  driftFreq: number;
  driftPhase: number;
  glint: boolean;
  highlight: boolean; // small budgeted subset rendered as a CSS-animated DOM sparkle instead of being baked
};

type Cluster = {
  u: number;
  lx: number;
  radius: number; // in units of ribbon half-width
  coreAlpha: number;
  pulseSpeed: number;
  pulsePhase: number;
};

type Tile = {
  index: number;
  top: number; // document-space px — the tile's fixed offset; only rebuilds on real resize
  height: number;
  el: HTMLDivElement; // wrapper: holds the baked canvas + this tile's CSS-animated highlight elements
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  clusters: Cluster[];
  stars: Star[];
  baked: boolean;
};

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number };
type Job = (() => void) & { tileIndex?: number };

// Sampled from the reference cluster: ember amber → gold → champagne → white gold
const STAR_RGB: [number, number, number][] = [
  [255, 156, 54],
  [255, 190, 88],
  [255, 214, 132],
  [255, 238, 186],
  [255, 250, 226],
];

// CSS equivalents of the canvas sprite gradients above, used only for the
// small budgeted subset of particles that animate as DOM elements.
const STAR_GRADIENTS: string[] = STAR_RGB.map(
  ([r, g, b]) =>
    `radial-gradient(circle, rgba(255,250,236,1) 0%, rgba(${r},${g},${b},0.95) 13%, rgba(${r},${g},${b},0.38) 32%, rgba(${r},${Math.round(
      g * 0.82,
    )},${Math.round(b * 0.6)},0.1) 60%, rgba(${r},${Math.round(g * 0.7)},${Math.round(b * 0.5)},0) 100%)`,
);

const CORE_GRADIENT =
  "radial-gradient(circle, rgba(255,206,132,0.55) 0%, rgba(255,186,100,0.28) 18%, rgba(222,156,70,0.1) 45%, rgba(180,124,56,0) 100%)";

// Document-space tile height. Tall enough to keep the DOM/canvas count small,
// short enough that off-screen tiles are cheap to skip via IntersectionObserver.
const TILE_HEIGHT = 1100;

// Page-wide cap on how many particles ever animate. Everything else is baked
// into the static canvas bitmap once and never touched again.
const HIGHLIGHT_BUDGET_DESKTOP = 150;
const HIGHLIGHT_BUDGET_MOBILE = 70;

// Bounded work-unit sizes. Sized so a single job's own duration stays well
// under 50ms even at 6x CPU throttling (measured ~0.043ms/star to bake,
// ~0.0055ms/star to generate on the reference hardware used to tune this) —
// deliberately conservative because a single job can't be interrupted
// mid-execution once started, so its own worst-case duration is the real
// ceiling on task size, not just the scheduler's slice budget.
const STAR_BAKE_BATCH = 100;
const STAR_GENERATE_BATCH = 700;

const STYLE_ID = "mast-gold-particle-stream-styles";

function ensureStylesInjected() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.mast-gold-tile {
  position: absolute;
  left: 0;
  width: 100%;
  overflow: hidden;
  pointer-events: none;
}
.mast-gold-tile canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.mast-gold-sparkle,
.mast-gold-glow {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  will-change: opacity, transform;
  mix-blend-mode: screen;
  animation: mast-gold-twinkle var(--dur, 3s) ease-in-out infinite;
  animation-delay: var(--delay, 0s);
}
.mast-gold-glow {
  animation-name: mast-gold-pulse;
}
.mast-gold-sparkle::before,
.mast-gold-sparkle::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  background: rgba(255, 238, 190, 0.9);
  animation: mast-gold-glint var(--dur, 3s) ease-in-out infinite;
  animation-delay: var(--delay, 0s);
}
.mast-gold-sparkle::before {
  width: var(--glen, 10px);
  height: 1.2px;
  transform: translate(-50%, -50%);
}
.mast-gold-sparkle::after {
  width: 1.2px;
  height: var(--glen, 10px);
  transform: translate(-50%, -50%);
}
@keyframes mast-gold-twinkle {
  0%,
  100% {
    opacity: var(--op-a, 0.4);
    transform: translate(-50%, -50%) translate3d(0, 0, 0) scale(var(--sc-a, 0.85));
  }
  50% {
    opacity: var(--op-b, 0.9);
    transform: translate(-50%, -50%) translate3d(var(--dx, 2px), var(--dy, 0px), 0) scale(var(--sc-b, 1.15));
  }
}
@keyframes mast-gold-pulse {
  0%,
  100% {
    opacity: var(--op-a, 0.15);
    transform: translate(-50%, -50%) scale(var(--sc-a, 0.9));
  }
  50% {
    opacity: var(--op-b, 0.35);
    transform: translate(-50%, -50%) scale(var(--sc-b, 1.1));
  }
}
@keyframes mast-gold-glint {
  0%,
  100% {
    opacity: calc(var(--op-a, 0.4) * 0.34);
  }
  50% {
    opacity: calc(var(--op-b, 0.9) * 0.34);
  }
}
.mast-gold-paused *,
.mast-gold-tile--hidden * {
  animation-play-state: paused !important;
}
`;
  document.head.appendChild(style);
}

// requestIdleCallback isn't in every engine (notably Safari) — fall back to a
// short setTimeout with a synthetic deadline that still yields quickly.
function scheduleIdle(cb: (deadline: IdleDeadlineLike) => void, timeout: number): number {
  const w = window as typeof window & {
    requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    return w.requestIdleCallback(cb, { timeout });
  }
  const start = performance.now();
  return window.setTimeout(
    () => {
      cb({ didTimeout: true, timeRemaining: () => Math.max(0, 8 - (performance.now() - start)) });
    },
    Math.min(timeout, 32),
  );
}

function cancelIdle(id: number | null) {
  if (id == null) return;
  const w = window as typeof window & { cancelIdleCallback?: (id: number) => void };
  if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
  else window.clearTimeout(id);
}

export function GoldParticleStream() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensureStylesInjected();

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let active = true; // guards every deferred callback against running after unmount

    /* ── Spine: the same current, weaving through every section ─────────── */
    const WAYPOINTS: [number, number][] = [
      [0.0, 0.72],
      [0.05, 0.78], // enters from above, sweeps past the hero globe
      [0.12, 0.6],
      [0.19, 0.43], // Workflow
      [0.28, 0.33], // Relationship Data
      [0.37, 0.47],
      [0.46, 0.62], // Trusted By
      [0.55, 0.56],
      [0.64, 0.36], // Why MAST
      [0.73, 0.44], // Platform / Features
      [0.82, 0.6], // Pricing
      [0.9, 0.5],
      [0.96, 0.56], // Final CTA
      [1.0, 0.48], // dissolves into the footer
    ];

    const spineRaw = (u: number): number => {
      const c = Math.max(0, Math.min(1, u));
      const n = WAYPOINTS.length;
      let idx = 0;
      for (let i = 0; i < n - 1; i++) {
        if (c >= WAYPOINTS[i][0] && c <= WAYPOINTS[i + 1][0]) {
          idx = i;
          break;
        }
      }
      const p0 = WAYPOINTS[Math.max(0, idx - 1)];
      const p1 = WAYPOINTS[idx];
      const p2 = WAYPOINTS[Math.min(n - 1, idx + 1)];
      const p3 = WAYPOINTS[Math.min(n - 1, idx + 2)];
      const seg = p2[0] - p1[0] || 0.001;
      const t = (c - p1[0]) / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const v0 = (p2[1] - p0[1]) * 0.5;
      const v1 = (p3[1] - p1[1]) * 0.5;
      return (
        (2 * t3 - 3 * t2 + 1) * p1[1] +
        (t3 - 2 * t2 + t) * v0 +
        (-2 * t3 + 3 * t2) * p2[1] +
        (t3 - t2) * v1
      );
    };

    // Sampled once into a lookup table — evaluated for every particle during
    // the deferred bake, never per animation frame (there is no such loop).
    const LUT_N = 1024;
    const spineLut = new Float32Array(LUT_N + 1);
    for (let i = 0; i <= LUT_N; i++) spineLut[i] = spineRaw(i / LUT_N);
    const spineAt = (u: number): number => {
      const c = u <= 0 ? 0 : u >= 1 ? 1 : u;
      const f = c * LUT_N;
      const i = f | 0;
      const t = f - i;
      const a = spineLut[i];
      return a + (spineLut[Math.min(LUT_N, i + 1)] - a) * t;
    };

    // Serpentine displacement of the current. A pure function of u — it is part
    // of the artwork's shape, never of time or of scroll, so the ribbon keeps
    // the exact same silhouette at the exact same place on the page forever.
    const waveShape = (u: number) => Math.sin(u * 7.5) * 0.34 + Math.cos(u * 13.5) * 0.17;

    /* ── Deterministic PRNG so the current is identical on every load ───── */
    let seed = 90210;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const gauss = () => (rand() + rand() + rand() + rand() - 2) * 0.7;

    /* ── Pre-rendered star sprites (radial falloff) ─────────────────────── */
    const SPRITE = 48;
    const sprites: HTMLCanvasElement[] = STAR_RGB.map(([r, g, b]) => {
      const c = document.createElement("canvas");
      c.width = SPRITE;
      c.height = SPRITE;
      const sctx = c.getContext("2d")!;
      const half = SPRITE / 2;
      const grad = sctx.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0, `rgba(255,250,236,1)`);
      grad.addColorStop(0.13, `rgba(${r},${g},${b},0.95)`);
      grad.addColorStop(0.32, `rgba(${r},${g},${b},0.38)`);
      grad.addColorStop(0.6, `rgba(${r},${Math.round(g * 0.82)},${Math.round(b * 0.6)},0.1)`);
      grad.addColorStop(1, `rgba(${r},${Math.round(g * 0.7)},${Math.round(b * 0.5)},0)`);
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, SPRITE, SPRITE);
      return c;
    });

    // Soft unresolved-core bloom: the collective light of a cluster's centre
    const CORE = 160;
    const coreSprite = document.createElement("canvas");
    coreSprite.width = CORE;
    coreSprite.height = CORE;
    {
      const cctx = coreSprite.getContext("2d")!;
      const h = CORE / 2;
      const g = cctx.createRadialGradient(h, h, 0, h, h, h);
      g.addColorStop(0, "rgba(255,206,132,0.55)");
      g.addColorStop(0.18, "rgba(255,186,100,0.28)");
      g.addColorStop(0.45, "rgba(222,156,70,0.1)");
      g.addColorStop(1, "rgba(180,124,56,0)");
      cctx.fillStyle = g;
      cctx.fillRect(0, 0, CORE, CORE);
    }

    /* ── State rebuilt only when real layout changes occur ──────────────── */
    let pageWidth = 0;
    let docHeight = 0;
    let isMobile = false;
    let clusters: Cluster[] = [];
    let stars: Star[] = [];
    let tiles: Tile[] = [];
    let tileIO: IntersectionObserver | null = null; // pauses CSS animation for off-screen baked tiles
    let priorityIO: IntersectionObserver | null = null; // promotes a tile's idle jobs when it nears the viewport

    const halfWidth = () =>
      isMobile ? Math.min(110, pageWidth * 0.3) : Math.min(230, pageWidth * 0.16);

    /* ── Idle work queue — every expensive step (population generation,
       cluster/star baking, DOM highlight mounting) is a small bounded job
       pushed here and drained only when the browser is idle. ────────────── */
    let jobQueue: Job[] = [];
    let idleHandle: number | null = null;
    let idleTimer: number | null = null;

    // Small, fixed wall-clock budget per idle slice, checked with our own
    // performance.now() rather than trusted purely from the idle deadline.
    // This matters under CPU throttling: a throttled engine's real execution
    // time for a "small" batch can balloon well past what the idle deadline
    // API accounted for, so relying on `deadline.timeRemaining()` alone let
    // multiple batches get packed into a single >50ms browser task — exactly
    // the kind of task this scheduler exists to prevent. Capping on our own
    // clock, after every single job, closes that gap regardless of how the
    // deadline API is (mis)calibrated for the current throttling rate.
    const SLICE_BUDGET_MS = 8;

    const pump = (deadline: IdleDeadlineLike) => {
      idleHandle = null;
      if (!active) return;
      const sliceStart = performance.now();
      while (active && jobQueue.length) {
        const job = jobQueue.shift()!;
        job();
        const elapsed = performance.now() - sliceStart;
        if (elapsed >= SLICE_BUDGET_MS) break;
        const remaining = deadline.didTimeout
          ? SLICE_BUDGET_MS - elapsed
          : deadline.timeRemaining();
        if (remaining <= 1) break;
      }
      if (active && jobQueue.length) {
        idleHandle = scheduleIdle(pump, 400);
      }
    };

    const kickPump = () => {
      if (idleHandle != null || !active || jobQueue.length === 0) return;
      idleHandle = scheduleIdle(pump, 400);
    };

    // Moves every already-queued job belonging to `tileIndex` to the front of
    // the queue (preserving their relative order), so a tile about to scroll
    // into view gets baked before tiles further down the page.
    const promoteTile = (tileIndex: number) => {
      if (!jobQueue.some((j) => j.tileIndex === tileIndex)) return;
      const mine: Job[] = [];
      const rest: Job[] = [];
      for (const j of jobQueue) (j.tileIndex === tileIndex ? mine : rest).push(j);
      jobQueue = [...mine, ...rest];
    };

    /* ── Population generation — chunked into ~2,500-star batches so the
       whole document's population is never generated in a single task ──── */
    const generateParticles = (onDone: () => void) => {
      seed = 90210; // re-seeded so the current is identical every time it's (re)built

      const viewportRef = window.innerHeight || 800;
      const screens = Math.max(2, Math.min(16, docHeight / viewportRef));
      const CLUSTER_COUNT = Math.round((isMobile ? 6 : 9) * screens);

      clusters = [];
      for (let i = 0; i < CLUSTER_COUNT; i++) {
        const base = (i + 0.5) / CLUSTER_COUNT;
        clusters.push({
          u: Math.max(0.004, Math.min(0.996, base + (rand() - 0.5) * (0.6 / CLUSTER_COUNT))),
          lx: gauss() * 0.3,
          radius: 0.5 + rand() * 0.6,
          coreAlpha: 0.35 + rand() * 0.45,
          pulseSpeed: 0.00016 + rand() * 0.00022,
          pulsePhase: rand() * Math.PI * 2,
        });
      }

      const perCluster = isMobile ? 170 : 330;
      const fieldCount = Math.round((isMobile ? 700 : 1500) * screens);
      stars = [];

      const pushStar = (u: number, lx: number, ly: number, core: number) => {
        const bright = rand() > 0.965;
        const sz = bright ? 1.5 + rand() * 1.7 : 0.45 + rand() * 0.85 + core * 0.45;
        let colorIdx: number;
        const cr = rand();
        if (bright) colorIdx = cr > 0.55 ? 1 : cr > 0.2 ? 2 : 3;
        else if (core > 0.7) colorIdx = cr > 0.45 ? 3 : 4;
        else if (core > 0.35) colorIdx = cr > 0.5 ? 2 : 3;
        else colorIdx = cr > 0.45 ? 1 : 0;
        stars.push({
          u,
          lx,
          ly,
          size: sz,
          colorIdx,
          alpha: 0.16 + core * 0.44 + rand() * 0.2 + (bright ? 0.16 : 0),
          twSpeed: 0.0009 + rand() * 0.0026,
          twPhase: rand() * Math.PI * 2,
          driftAmp: 0.8 + rand() * 2.6,
          // driftFreq/driftPhase are no longer read directly (the DOM highlight
          // layer derives its drift timing from twSpeed/twPhase instead), but the
          // rand() calls are kept so the PRNG sequence — and therefore every
          // other particle's position/size/color — stays bit-identical to before.
          driftFreq: 0.00012 + rand() * 0.0003,
          driftPhase: rand() * Math.PI * 2,
          glint: bright && rand() > 0.45,
          highlight: false,
        });
      };

      // The generation order (cluster-by-cluster, then the field population)
      // must stay exactly as it was: splitting it across idle callbacks below
      // only pauses/resumes this same sequential PRNG consumption — it never
      // reorders it — so every particle's position/size/color is bit-identical
      // to a fully-synchronous generation.
      let clusterCursor = 0;
      let starsInClusterCursor = 0;
      let fieldCursor = 0;

      const genClusterBatch: Job = () => {
        let produced = 0;
        while (clusterCursor < clusters.length && produced < STAR_GENERATE_BATCH) {
          const cl = clusters[clusterCursor];
          while (starsInClusterCursor < perCluster && produced < STAR_GENERATE_BATCH) {
            const rad = Math.pow(rand(), 2.35);
            const ang = rand() * Math.PI * 2;
            const ex = Math.cos(ang) * rad * cl.radius;
            const ey = Math.sin(ang) * rad * cl.radius * 1.5;
            const core = 1 - Math.min(1, rad * 1.15);
            pushStar(cl.u, cl.lx + ex, ey, core);
            starsInClusterCursor++;
            produced++;
          }
          if (starsInClusterCursor >= perCluster) {
            clusterCursor++;
            starsInClusterCursor = 0;
          }
        }
        if (clusterCursor < clusters.length) {
          jobQueue.unshift(genClusterBatch);
        } else {
          jobQueue.unshift(genFieldBatch);
        }
      };

      const genFieldBatch: Job = () => {
        const end = Math.min(fieldCount, fieldCursor + STAR_GENERATE_BATCH);
        for (; fieldCursor < end; fieldCursor++) {
          const g = gauss();
          pushStar(rand(), g * 0.62, gauss() * 0.3, Math.max(0, 0.42 - Math.abs(g) * 0.3));
        }
        if (fieldCursor < fieldCount) {
          jobQueue.unshift(genFieldBatch);
        } else {
          assignHighlights();
          onDone();
        }
      };

      jobQueue.push(genClusterBatch);
      kickPump();
    };

    // Marks a small, page-wide-capped subset of the "glint" stars as
    // DOM-animated highlights. Every other star (the overwhelming majority)
    // stays a permanent, immovable part of the baked canvas bitmap.
    const assignHighlights = () => {
      for (const s of stars) s.highlight = false;
      if (reduceMotion) return; // static page: nothing animates, nothing needs a DOM element

      const glintIdx: number[] = [];
      for (let i = 0; i < stars.length; i++) {
        if (stars[i].glint) glintIdx.push(i);
      }
      if (glintIdx.length === 0) return;

      const budget = isMobile ? HIGHLIGHT_BUDGET_MOBILE : HIGHLIGHT_BUDGET_DESKTOP;
      const step = Math.max(1, Math.floor(glintIdx.length / budget));
      let picked = 0;
      for (let i = 0; i < glintIdx.length && picked < budget; i += step) {
        stars[glintIdx[i]].highlight = true;
        picked++;
      }
    };

    /* ── Mounts the CSS-animated highlight elements for a single tile. Their
       positions are computed once, here, and never touched again — all
       subsequent motion (twinkle, drift, pulse) is pure CSS on the
       compositor thread. ─────────────────────────────────────────────────── */
    const mountHighlights = (tile: Tile) => {
      if (reduceMotion) return;
      const w = pageWidth;
      const hw = halfWidth();
      const frag = document.createDocumentFragment();

      for (let i = 0; i < tile.clusters.length; i++) {
        const cl = tile.clusters[i];
        const sy = cl.u * docHeight - tile.top;
        const rpx = cl.radius * hw;
        if (sy < -rpx * 2 || sy > tile.height + rpx * 2) continue;
        const sx = spineAt(cl.u) * w + cl.lx * hw + waveShape(cl.u) * hw;
        const d = rpx * 1.9 * 0.85;
        const period = (2 * Math.PI) / cl.pulseSpeed; // ms — pulseSpeed is radians/ms

        const glow = document.createElement("div");
        glow.className = "mast-gold-glow";
        glow.style.left = `${sx.toFixed(1)}px`;
        glow.style.top = `${sy.toFixed(1)}px`;
        glow.style.width = `${d.toFixed(1)}px`;
        glow.style.height = `${d.toFixed(1)}px`;
        glow.style.background = CORE_GRADIENT;
        glow.style.setProperty("--dur", `${period.toFixed(0)}ms`);
        glow.style.setProperty(
          "--delay",
          `${(-(cl.pulsePhase / (2 * Math.PI)) * period).toFixed(0)}ms`,
        );
        glow.style.setProperty("--op-a", "0");
        glow.style.setProperty("--op-b", `${Math.min(0.4, cl.coreAlpha * 0.28).toFixed(2)}`);
        glow.style.setProperty("--sc-a", "0.9");
        glow.style.setProperty("--sc-b", "1.12");
        frag.appendChild(glow);
      }

      for (let i = 0; i < tile.stars.length; i++) {
        const p = tile.stars[i];
        if (!p.highlight) continue;

        const sy = p.u * docHeight - tile.top + p.ly * hw;
        if (sy < -30 || sy > tile.height + 30) continue;
        const sx = spineAt(p.u) * w + p.lx * hw + waveShape(p.u) * hw;
        if (sx < -40 || sx > w + 40) continue;

        let fade = 1;
        if (p.u < 0.015) fade = p.u / 0.015;
        else if (p.u > 0.985) fade = Math.max(0, (1 - p.u) / 0.015);
        const baseA = Math.min(0.95, p.alpha * fade);
        if (baseA <= 0.02) continue;

        const d = p.size * 5.6;
        const period = (2 * Math.PI) / p.twSpeed; // ms — twSpeed is radians/ms

        const sparkle = document.createElement("div");
        sparkle.className = "mast-gold-sparkle";
        sparkle.style.left = `${sx.toFixed(1)}px`;
        sparkle.style.top = `${sy.toFixed(1)}px`;
        sparkle.style.width = `${d.toFixed(1)}px`;
        sparkle.style.height = `${d.toFixed(1)}px`;
        sparkle.style.background = STAR_GRADIENTS[p.colorIdx];
        sparkle.style.setProperty("--dur", `${period.toFixed(0)}ms`);
        sparkle.style.setProperty(
          "--delay",
          `${(-(p.twPhase / (2 * Math.PI)) * period).toFixed(0)}ms`,
        );
        sparkle.style.setProperty("--op-a", `${(baseA * 0.78).toFixed(2)}`);
        sparkle.style.setProperty("--op-b", `${baseA.toFixed(2)}`);
        sparkle.style.setProperty("--sc-a", "0.82");
        sparkle.style.setProperty("--sc-b", "1.18");
        sparkle.style.setProperty("--dx", `${p.driftAmp.toFixed(1)}px`);
        sparkle.style.setProperty("--dy", "0px");
        sparkle.style.setProperty("--glen", `${(p.size * 6.5).toFixed(1)}px`);
        frag.appendChild(sparkle);
      }

      tile.el.appendChild(frag);
    };

    /* ── Baking a single tile, split into bounded jobs: cluster cores (cheap,
       one job), then ~200-star batches, then the DOM highlight mount. Canvas
       state (clip/composite mode) is only touched at the start/end of the
       whole sequence, not per batch. ─────────────────────────────────────── */
    const enqueueTileBakeJobs = (tile: Tile) => {
      const hw = halfWidth();
      let starCursor = 0;

      const initJob: Job = () => {
        tile.ctx.clearRect(0, 0, pageWidth, tile.height);
        tile.ctx.globalCompositeOperation = "lighter";
      };
      initJob.tileIndex = tile.index;

      const clustersJob: Job = () => {
        const w = pageWidth;
        for (let i = 0; i < tile.clusters.length; i++) {
          const cl = tile.clusters[i];
          const sy = cl.u * docHeight - tile.top;
          const rpx = cl.radius * hw;
          if (sy < -rpx * 2 || sy > tile.height + rpx * 2) continue;
          const sx = spineAt(cl.u) * w + cl.lx * hw + waveShape(cl.u) * hw;
          const d = rpx * 1.9;
          // Resting brightness (the pulse's midpoint) — the CSS glow overlay
          // layered on top adds the breathing motion back in, additively.
          tile.ctx.globalAlpha = Math.min(0.5, cl.coreAlpha * 0.5);
          tile.ctx.drawImage(coreSprite, sx - d / 2, sy - d / 2, d, d);
        }
      };
      clustersJob.tileIndex = tile.index;

      const starsBatchJob: Job = () => {
        const w = pageWidth;
        const end = Math.min(tile.stars.length, starCursor + STAR_BAKE_BATCH);
        for (; starCursor < end; starCursor++) {
          const p = tile.stars[starCursor];
          if (p.highlight) continue; // rendered as a DOM sparkle instead

          const sy = p.u * docHeight - tile.top + p.ly * hw;
          if (sy < -30 || sy > tile.height + 30) continue;
          const sx = spineAt(p.u) * w + p.lx * hw + waveShape(p.u) * hw;
          if (sx < -40 || sx > w + 40) continue;

          let fade = 1;
          if (p.u < 0.015) fade = p.u / 0.015;
          else if (p.u > 0.985) fade = Math.max(0, (1 - p.u) / 0.015);

          const a = Math.min(0.95, p.alpha * fade);
          if (a <= 0.012) continue;

          const d = p.size * 5.2;
          tile.ctx.globalAlpha = a;
          tile.ctx.drawImage(sprites[p.colorIdx], sx - d / 2, sy - d / 2, d, d);

          if (p.glint && a > 0.4) {
            const len = p.size * 6.5;
            tile.ctx.globalAlpha = a * 0.34;
            tile.ctx.strokeStyle = "rgba(255,238,190,1)";
            tile.ctx.lineWidth = 0.7;
            tile.ctx.beginPath();
            tile.ctx.moveTo(sx - len, sy);
            tile.ctx.lineTo(sx + len, sy);
            tile.ctx.moveTo(sx, sy - len);
            tile.ctx.lineTo(sx, sy + len);
            tile.ctx.stroke();
          }
        }
        if (starCursor < tile.stars.length) {
          jobQueue.unshift(starsBatchJob);
        } else {
          jobQueue.unshift(finishJob);
        }
      };
      starsBatchJob.tileIndex = tile.index;

      const finishJob: Job = () => {
        tile.ctx.globalAlpha = 1;
        tile.ctx.globalCompositeOperation = "source-over";
        mountHighlights(tile);
        tile.baked = true;
        if (tile.index === 0) {
          performance.mark("gold-stream-first-tile-baked");
          try {
            performance.measure(
              "gold-stream-first-tile",
              "gold-stream-schedule-start",
              "gold-stream-first-tile-baked",
            );
          } catch {
            // best-effort timing only
          }
        }
        if (tiles.length > 0 && tiles.every((t) => t.baked)) {
          performance.mark("gold-stream-full-bake-end");
          try {
            performance.measure(
              "gold-stream-full-bake",
              "gold-stream-schedule-start",
              "gold-stream-full-bake-end",
            );
          } catch {
            // best-effort timing only
          }
        }
      };
      finishJob.tileIndex = tile.index;

      jobQueue.push(initJob, clustersJob, starsBatchJob);
      kickPump();
    };

    /* ── Tiling: the document-space rendering surface. Tile shells (empty
       canvases, correctly positioned/sized) are created synchronously and
       immediately — this is cheap (no star data involved) and lets
       IntersectionObserver start tracking them right away. Assigning the
       population to tiles and baking are both deferred/chunked. ─────────── */
    const teardown = () => {
      active = false;
      cancelIdle(idleHandle);
      idleHandle = null;
      if (idleTimer != null) window.clearTimeout(idleTimer);
      jobQueue = [];
      tileIO?.disconnect();
      tileIO = null;
      priorityIO?.disconnect();
      priorityIO = null;
      for (const t of tiles) t.el.remove();
      tiles = [];
    };

    const buildTileShells = (onDone: () => void) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const count = Math.max(1, Math.ceil(docHeight / TILE_HEIGHT));

      tileIO = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const tile = tiles.find((t) => t.el === entry.target);
            if (tile) tile.el.classList.toggle("mast-gold-tile--hidden", !entry.isIntersecting);
          }
        },
        { rootMargin: "300px 0px" },
      );
      priorityIO = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const tile = tiles.find((t) => t.el === entry.target);
            if (tile && !tile.baked) promoteTile(tile.index);
          }
        },
        { rootMargin: "1000px 0px" },
      );

      // Allocating a tile's canvas backing store (its actual pixel buffer) is
      // real, measurable work — for a full-width, ~1100px-tall tile at up to
      // 1.5x device pixel ratio that's a multi-megapixel GPU-backed surface.
      // Creating all of them in one synchronous loop was itself large enough
      // to show up as a single long task under CPU throttling, so each
      // tile's shell is its own bounded job, same as everything else here.
      let shellCursor = 0;
      const shellJob: Job = () => {
        const i = shellCursor++;
        const top = i * TILE_HEIGHT;
        const h = Math.min(TILE_HEIGHT, docHeight - top);
        if (h > 0) {
          const el = document.createElement("div");
          el.className = "mast-gold-tile";
          el.style.top = `${top}px`;
          el.style.height = `${h}px`;

          const canvas = document.createElement("canvas");
          canvas.setAttribute("aria-hidden", "true");
          canvas.width = Math.max(1, Math.round(pageWidth * dpr));
          canvas.height = Math.max(1, Math.round(h * dpr));
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            el.appendChild(canvas);
            container.appendChild(el);

            const tile: Tile = {
              index: i,
              top,
              height: h,
              el,
              canvas,
              ctx,
              clusters: [],
              stars: [],
              baked: false,
            };
            tiles.push(tile);
            tileIO!.observe(el);
            priorityIO!.observe(el);
          }
        }
        if (shellCursor < count) {
          jobQueue.unshift(shellJob);
        } else {
          onDone();
        }
      };

      jobQueue.push(shellJob);
      kickPump();
    };

    // Assigns the population to tiles with a SINGLE chunked pass over `stars`
    // (checking only each star's own tile and its immediate neighbors, for
    // the margin overlap — never all tiles), instead of the O(tiles × stars)
    // cost of filtering the full array once per tile. Each batch is its own
    // bounded job, and a tile's bake jobs are only enqueued once its
    // population assignment is complete.
    const assignPopulationToTilesAndEnqueueBakes = () => {
      const hw = halfWidth();
      const margin = Math.max(220, hw * 2); // catches blooms/cores whose radius crosses a tile edge

      const clustersJob: Job = () => {
        for (const c of clusters) {
          const y = c.u * docHeight;
          const idx = Math.max(0, Math.min(tiles.length - 1, Math.floor(y / TILE_HEIGHT)));
          for (let ti = Math.max(0, idx - 1); ti <= Math.min(tiles.length - 1, idx + 1); ti++) {
            const tile = tiles[ti];
            const yMin = tile.top - margin - c.radius * hw;
            const yMax = tile.top + tile.height + margin + c.radius * hw;
            if (y >= yMin && y <= yMax) tile.clusters.push(c);
          }
        }
      };

      let starCursor = 0;
      const starsBatchJob: Job = () => {
        const end = Math.min(stars.length, starCursor + STAR_GENERATE_BATCH);
        for (; starCursor < end; starCursor++) {
          const p = stars[starCursor];
          const y = p.u * docHeight + p.ly * hw;
          const idx = Math.max(0, Math.min(tiles.length - 1, Math.floor(y / TILE_HEIGHT)));
          for (let ti = Math.max(0, idx - 1); ti <= Math.min(tiles.length - 1, idx + 1); ti++) {
            const tile = tiles[ti];
            if (y >= tile.top - margin && y <= tile.top + tile.height + margin) tile.stars.push(p);
          }
        }
        if (starCursor < stars.length) {
          jobQueue.unshift(starsBatchJob);
        } else {
          jobQueue.unshift(enqueueAllBakesJob);
        }
      };

      const enqueueAllBakesJob: Job = () => {
        for (const t of tiles) enqueueTileBakeJobs(t);
      };

      jobQueue.push(clustersJob, starsBatchJob);
      kickPump();
    };

    /* ── Full rebuild: only on first mount and on genuine layout changes.
       Population generation and tile baking are both deferred/chunked — this
       function only ever does cheap, synchronous setup. ─────────────────── */
    const rebuild = () => {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || 1;
      const mobile = w < 768;

      const sizeChanged = Math.abs(w - pageWidth) > 1 || Math.abs(h - docHeight) > 1;
      const densityTierChanged = mobile !== isMobile || stars.length === 0;

      if (!sizeChanged && !densityTierChanged && tiles.length > 0) return;

      // Cancel any in-flight deferred work from a previous build before
      // starting a new one (e.g. a resize arriving mid-bake).
      cancelIdle(idleHandle);
      idleHandle = null;
      jobQueue = [];
      tileIO?.disconnect();
      tileIO = null;
      priorityIO?.disconnect();
      priorityIO = null;
      for (const t of tiles) t.el.remove();
      tiles = [];

      pageWidth = w;
      docHeight = Math.max(1, h);
      isMobile = mobile;

      // Tile shells and population generation are independent of each other
      // (shells only need docHeight; generation only needs cluster/star
      // math) — kick off both, and only assign the population into tiles
      // once whichever finishes last is done. Both are chunked/deferred, so
      // neither blocks the other or the main thread synchronously.
      let shellsReady = false;
      let populationReady = !densityTierChanged; // already have stars/clusters if the tier didn't change
      const maybeAssign = () => {
        if (active && shellsReady && populationReady) assignPopulationToTilesAndEnqueueBakes();
      };

      buildTileShells(() => {
        shellsReady = true;
        maybeAssign();
      });

      if (densityTierChanged) {
        generateParticles(() => {
          populationReady = true;
          maybeAssign();
        });
      }
    };

    // Idle-scheduled the whole build so it runs AFTER the hero has had its
    // chance to paint, not synchronously during mount. A modest timeout
    // still guarantees it starts soon even under sustained main-thread load.
    performance.mark("gold-stream-schedule-start");
    idleHandle = scheduleIdle(() => {
      idleHandle = null;
      if (active) rebuild();
    }, 200);

    // ResizeObserver — NOT a scroll listener — is the only thing that can ever
    // move a tile. It fires on real layout changes (viewport resize, content
    // reflow, fonts/images loading), never on scroll.
    const ro = new ResizeObserver(() => {
      // Debounced onto idle time too, so a burst of resize events (e.g. a
      // mobile keyboard opening/closing) can't trigger a synchronous rebuild.
      if (idleTimer != null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        if (active) rebuild();
      }, 120);
    });
    ro.observe(container);

    // Pauses every CSS animation in this layer while the tab is backgrounded.
    const onVisibilityChange = () => {
      container.classList.toggle("mast-gold-paused", document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      teardown();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none select-none -z-10 overflow-hidden"
      aria-hidden="true"
    />
  );
}
