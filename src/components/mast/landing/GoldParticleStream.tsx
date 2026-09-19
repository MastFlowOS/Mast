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
 * PERFORMANCE MODEL — bake once, animate almost nothing:
 *
 * Earlier revisions of this component redrew every particle in every visible
 * tile on every animation frame via `requestAnimationFrame`, each redraw
 * issuing thousands of `drawImage` calls under `globalCompositeOperation =
 * "lighter"`. Profiling showed this was the dominant source of dropped
 * frames on the landing page (a majority of ~1,300+ dropped frames and the
 * worst single main-thread tasks in the trace).
 *
 * This revision keeps the exact same visual population and density, but
 * paints each tile's canvas bitmap exactly ONCE, at build time (mount or a
 * genuine layout change) — never again afterward. There is no
 * `requestAnimationFrame` loop in this file at all. The handful of particles
 * that should visibly shimmer (the "glint" highlights, capped to a small,
 * page-wide budget) are excluded from the static bake and instead rendered
 * as tiny absolutely-positioned DOM elements whose twinkle/drift is driven
 * entirely by CSS `@keyframes` (opacity + transform), which the browser runs
 * on the compositor thread with no per-frame JavaScript and no repainting of
 * the large tile bitmaps underneath. An IntersectionObserver pauses those
 * CSS animations (via `animation-play-state`) for tiles that are off-screen,
 * and a `visibilitychange` listener pauses all of them when the tab is
 * backgrounded.
 *
 * The visual model is unchanged: a chain of GLOBULAR CLUSTERS strung along a
 * wide, wavy spine — a blazing unresolved core, a dense resolved halo
 * falling off steeply, then feathered outliers. Clusters overlap along the
 * path, and a field population bridges the gaps, so the eye reads one thick,
 * clustered golden ribbon rather than a scattering of dots or a drawn line.
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
  top: number; // document-space px — the tile's fixed offset; only rebuilds on real resize
  height: number;
  el: HTMLDivElement; // wrapper: holds the baked canvas + this tile's CSS-animated highlight elements
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
};

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

export function GoldParticleStream() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensureStylesInjected();

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    // the one-time bake (and, for the highlight subset, once at build time
    // to compute a fixed anchor position — never per frame).
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
    let io: IntersectionObserver | null = null;

    const halfWidth = () =>
      isMobile ? Math.min(110, pageWidth * 0.3) : Math.min(230, pageWidth * 0.16);

    /* ── Population: regenerated only when the mobile/desktop density tier
       changes, never on every resize and never on scroll ─────────────────── */
    const generateParticles = () => {
      seed = 90210; // re-seeded so the current is identical every time it's (re)built

      // Density scales with how many screen-heights the document spans, so the
      // ribbon keeps the same visual thickness whether the page is short or long.
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

      for (const cl of clusters) {
        for (let i = 0; i < perCluster; i++) {
          // King-profile-ish radial sampling: a steep power law packs most of the
          // population into the blazing core and feathers the rest outward.
          const rad = Math.pow(rand(), 2.35);
          const ang = rand() * Math.PI * 2;
          const ex = Math.cos(ang) * rad * cl.radius;
          const ey = Math.sin(ang) * rad * cl.radius * 1.5;
          const core = 1 - Math.min(1, rad * 1.15);
          pushStar(cl.u, cl.lx + ex, ey, core);
        }
      }

      // Field population: bridges cluster to cluster so the current never breaks
      for (let i = 0; i < fieldCount; i++) {
        const g = gauss();
        pushStar(rand(), g * 0.62, gauss() * 0.3, Math.max(0, 0.42 - Math.abs(g) * 0.3));
      }

      assignHighlights();
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

    /* ── One-time bake: paints every cluster core (at its resting brightness)
       and every non-highlight star into this tile's bitmap exactly once.
       This canvas is never cleared or redrawn again after this call. ────── */
    const bakeTile = (
      ctx: CanvasRenderingContext2D,
      top: number,
      h: number,
      tClusters: Cluster[],
      tStars: Star[],
    ) => {
      const w = pageWidth;
      const hw = halfWidth();

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      for (let i = 0; i < tClusters.length; i++) {
        const cl = tClusters[i];
        const sy = cl.u * docHeight - top;
        const rpx = cl.radius * hw;
        if (sy < -rpx * 2 || sy > h + rpx * 2) continue;
        const sx = spineAt(cl.u) * w + cl.lx * hw + waveShape(cl.u) * hw;
        const d = rpx * 1.9;
        // Resting brightness (the pulse's midpoint) — the CSS glow overlay
        // layered on top adds the breathing motion back in, additively.
        ctx.globalAlpha = Math.min(0.5, cl.coreAlpha * 0.5);
        ctx.drawImage(coreSprite, sx - d / 2, sy - d / 2, d, d);
      }

      for (let i = 0; i < tStars.length; i++) {
        const p = tStars[i];
        if (p.highlight) continue; // rendered as a DOM sparkle instead

        const sy = p.u * docHeight - top + p.ly * hw;
        if (sy < -30 || sy > h + 30) continue;
        const sx = spineAt(p.u) * w + p.lx * hw + waveShape(p.u) * hw;
        if (sx < -40 || sx > w + 40) continue;

        let fade = 1;
        if (p.u < 0.015) fade = p.u / 0.015;
        else if (p.u > 0.985) fade = Math.max(0, (1 - p.u) / 0.015);

        const a = Math.min(0.95, p.alpha * fade);
        if (a <= 0.012) continue;

        const d = p.size * 5.2;
        ctx.globalAlpha = a;
        ctx.drawImage(sprites[p.colorIdx], sx - d / 2, sy - d / 2, d, d);

        if (p.glint && a > 0.4) {
          const len = p.size * 6.5;
          ctx.globalAlpha = a * 0.34;
          ctx.strokeStyle = "rgba(255,238,190,1)";
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(sx - len, sy);
          ctx.lineTo(sx + len, sy);
          ctx.moveTo(sx, sy - len);
          ctx.lineTo(sx, sy + len);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    /* ── Mounts the CSS-animated highlight elements for a single tile. Their
       positions are computed once, here, and never touched again — all
       subsequent motion (twinkle, drift, pulse) is pure CSS on the
       compositor thread. ─────────────────────────────────────────────────── */
    const mountHighlights = (
      tileEl: HTMLDivElement,
      top: number,
      h: number,
      tClusters: Cluster[],
      tStars: Star[],
    ) => {
      if (reduceMotion) return;
      const w = pageWidth;
      const hw = halfWidth();
      const frag = document.createDocumentFragment();

      for (let i = 0; i < tClusters.length; i++) {
        const cl = tClusters[i];
        const sy = cl.u * docHeight - top;
        const rpx = cl.radius * hw;
        if (sy < -rpx * 2 || sy > h + rpx * 2) continue;
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

      for (let i = 0; i < tStars.length; i++) {
        const p = tStars[i];
        if (!p.highlight) continue;

        const sy = p.u * docHeight - top + p.ly * hw;
        if (sy < -30 || sy > h + 30) continue;
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

      tileEl.appendChild(frag);
    };

    /* ── Tiling: the document-space rendering surface ───────────────────── */
    const teardownTiles = () => {
      io?.disconnect();
      io = null;
      for (const t of tiles) t.el.remove();
      tiles = [];
    };

    const buildTiles = () => {
      teardownTiles();
      if (pageWidth <= 0 || docHeight <= 0) return;

      const hw = halfWidth();
      const margin = Math.max(220, hw * 2); // catches blooms/cores whose radius crosses a tile edge
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const count = Math.max(1, Math.ceil(docHeight / TILE_HEIGHT));

      const frag = document.createDocumentFragment();

      for (let i = 0; i < count; i++) {
        const top = i * TILE_HEIGHT;
        const h = Math.min(TILE_HEIGHT, docHeight - top);
        if (h <= 0) continue;

        const el = document.createElement("div");
        el.className = "mast-gold-tile";
        el.style.top = `${top}px`;
        el.style.height = `${h}px`;

        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        canvas.width = Math.max(1, Math.round(pageWidth * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        el.appendChild(canvas);

        const yMin = top - margin;
        const yMax = top + h + margin;
        const tClusters = clusters.filter((c) => {
          const y = c.u * docHeight;
          return y >= yMin - c.radius * hw && y <= yMax + c.radius * hw;
        });
        const tStars = stars.filter((p) => {
          const y = p.u * docHeight + p.ly * hw;
          return y >= yMin && y <= yMax;
        });

        bakeTile(ctx, top, h, tClusters, tStars);
        mountHighlights(el, top, h, tClusters, tStars);

        frag.appendChild(el);
        tiles.push({ top, height: h, el, canvas, ctx });
      }

      container.appendChild(frag);

      // Pauses each tile's CSS animations while it's off-screen. This is the
      // only thing the IntersectionObserver drives now — there is no
      // per-frame drawing left for it to gate.
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const tile = tiles.find((t) => t.el === entry.target);
            if (tile) tile.el.classList.toggle("mast-gold-tile--hidden", !entry.isIntersecting);
          }
        },
        { rootMargin: "300px 0px" },
      );
      for (const t of tiles) io.observe(t.el);
    };

    /* ── Full rebuild: only on first mount and on genuine layout changes ─── */
    const rebuild = () => {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || 1;
      const mobile = w < 768;

      const sizeChanged = Math.abs(w - pageWidth) > 1 || Math.abs(h - docHeight) > 1;
      const densityTierChanged = mobile !== isMobile || stars.length === 0;

      if (!sizeChanged && !densityTierChanged && tiles.length > 0) return;

      pageWidth = w;
      docHeight = Math.max(1, h);
      isMobile = mobile;

      if (densityTierChanged) generateParticles();
      buildTiles();
    };

    rebuild();

    // ResizeObserver — NOT a scroll listener — is the only thing that can ever
    // move a tile. It fires on real layout changes (viewport resize, content
    // reflow, fonts/images loading), never on scroll.
    const ro = new ResizeObserver(() => rebuild());
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
      teardownTiles();
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
