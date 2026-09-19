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
 * The visual model is a chain of GLOBULAR CLUSTERS strung along a wide, wavy
 * spine — exactly like the reference photograph: a blazing unresolved core,
 * a dense resolved halo falling off steeply, then feathered outliers. Clusters
 * overlap along the path, and a field population bridges the gaps, so the eye
 * reads one thick, clustered golden ribbon rather than a scattering of dots or
 * a drawn line. Every pixel of it comes from particles — the only non-particle
 * element is a faint unresolved core bloom per cluster, which is round and
 * secondary, never a stroke.
 *
 * Every particle's position is fixed in document space (`u` = fraction down
 * the total page height, `lx`/`ly` = offset from the spine). Nothing here is
 * ever a function of scroll. The only animation is a few px of local shimmer
 * per particle — never enough to alter the ribbon's silhouette — and it runs
 * only for the handful of tiles currently intersecting the viewport.
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
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  stars: Star[]; // this tile's slice of the population (± overflow margin)
  clusters: Cluster[];
  visible: boolean; // driven by IntersectionObserver — pauses rendering, never repositions
};

// Sampled from the reference cluster: ember amber → gold → champagne → white gold
const STAR_RGB: [number, number, number][] = [
  [255, 156, 54],
  [255, 190, 88],
  [255, 214, 132],
  [255, 238, 186],
  [255, 250, 226],
];

// Document-space tile height. Tall enough to keep the DOM/canvas count small,
// short enough that off-screen tiles are cheap to skip via IntersectionObserver.
const TILE_HEIGHT = 1100;

export function GoldParticleStream() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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

    // Sampled once into a lookup table — evaluated for every visible particle
    // on every frame, so the raw spline is far too expensive to call directly.
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
    let isTabActive = !document.hidden;

    const halfWidth = () => (isMobile ? Math.min(110, pageWidth * 0.3) : Math.min(230, pageWidth * 0.16));

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
          driftFreq: 0.00012 + rand() * 0.0003,
          driftPhase: rand() * Math.PI * 2,
          glint: bright && rand() > 0.45,
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
    };

    /* ── Tiling: the document-space rendering surface ───────────────────── */
    const teardownTiles = () => {
      io?.disconnect();
      io = null;
      for (const t of tiles) t.canvas.remove();
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

        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        canvas.style.position = "absolute";
        canvas.style.left = "0";
        canvas.style.top = `${top}px`;
        canvas.style.width = `${pageWidth}px`;
        canvas.style.height = `${h}px`;
        canvas.style.display = "block";
        canvas.width = Math.max(1, Math.round(pageWidth * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        frag.appendChild(canvas);

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

        tiles.push({ top, height: h, canvas, ctx, stars: tStars, clusters: tClusters, visible: true });
      }

      container.appendChild(frag);

      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const tile = tiles.find((t) => t.canvas === entry.target);
            if (tile) tile.visible = entry.isIntersecting;
          }
        },
        { rootMargin: "300px 0px" }
      );
      for (const t of tiles) io.observe(t.canvas);
    };

    /* ── Drawing a single tile in its own local (tile-relative) space ───── */
    const drawTile = (tile: Tile, now: number, animate: boolean) => {
      const ctx = tile.ctx;
      const w = pageWidth;
      const h = tile.height;
      const hw = halfWidth();

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      for (let i = 0; i < tile.clusters.length; i++) {
        const cl = tile.clusters[i];
        const sy = cl.u * docHeight - tile.top;
        const rpx = cl.radius * hw;
        if (sy < -rpx * 2 || sy > h + rpx * 2) continue;
        const sx = spineAt(cl.u) * w + cl.lx * hw + waveShape(cl.u) * hw;
        const pulse = animate ? 0.86 + Math.sin(now * cl.pulseSpeed + cl.pulsePhase) * 0.14 : 1;
        const d = rpx * 1.9;
        ctx.globalAlpha = Math.min(0.5, cl.coreAlpha * 0.5 * pulse);
        ctx.drawImage(coreSprite, sx - d / 2, sy - d / 2, d, d);
      }

      for (let i = 0; i < tile.stars.length; i++) {
        const p = tile.stars[i];
        const sy = p.u * docHeight - tile.top + p.ly * hw;
        if (sy < -30 || sy > h + 30) continue;

        const wobble = animate ? Math.sin(now * p.driftFreq + p.driftPhase) * p.driftAmp : 0;
        const sx = spineAt(p.u) * w + p.lx * hw + waveShape(p.u) * hw + wobble;
        if (sx < -40 || sx > w + 40) continue;

        let fade = 1;
        if (p.u < 0.015) fade = p.u / 0.015;
        else if (p.u > 0.985) fade = Math.max(0, (1 - p.u) / 0.015);

        const tw = animate ? 0.8 + Math.sin(now * p.twSpeed + p.twPhase) * 0.2 : 1;
        const a = Math.min(0.95, p.alpha * fade * tw);
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

    const drawAllStatic = () => {
      for (const t of tiles) drawTile(t, 0, false);
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
      if (reduceMotion) drawAllStatic();
    };

    rebuild();

    // ResizeObserver — NOT a scroll listener — is the only thing that can ever
    // move a tile. It fires on real layout changes (viewport resize, content
    // reflow, fonts/images loading), never on scroll.
    const ro = new ResizeObserver(() => rebuild());
    ro.observe(container);

    const onVisibilityChange = () => {
      isTabActive = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    let rafId = 0;
    const render = (now: number) => {
      if (isTabActive) {
        for (const t of tiles) {
          if (t.visible) drawTile(t, now, true);
        }
      }
      rafId = requestAnimationFrame(render);
    };

    if (!reduceMotion) {
      rafId = requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(rafId);
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
