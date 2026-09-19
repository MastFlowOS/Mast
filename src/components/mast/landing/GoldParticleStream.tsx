import { useEffect, useRef } from "react";

/**
 * One continuous celestial gold current running from the top of the landing
 * page to the footer.
 *
 * The visual model is a chain of GLOBULAR CLUSTERS strung along a wide, wavy
 * spine — exactly like the reference photograph: a blazing unresolved core,
 * a dense resolved halo falling off steeply, then feathered outliers. Clusters
 * overlap along the path, and a field population bridges the gaps, so the eye
 * reads one thick, clustered golden ribbon rather than a scattering of dots or
 * a drawn line. Every pixel of it comes from particles — the only non-particle
 * element is a faint unresolved core bloom per cluster, which is round and
 * secondary, never a stroke.
 */

type Star = {
  u: number; // position along the document [0,1]
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

// Sampled from the reference cluster: ember amber → gold → champagne → white gold
const STAR_RGB: [number, number, number][] = [
  [255, 156, 54],
  [255, 190, 88],
  [255, 214, 132],
  [255, 238, 186],
  [255, 250, 226],
];

export function GoldParticleStream() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let docHeight = 1;
    let pageWidth = 1;
    let scrollY = 0;
    let isVisible = true;
    let isTabActive = !document.hidden;

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

    const updateDimensions = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Document-space extents. Sampled on resize only — never on scroll — so
      // every particle keeps the same document coordinate for the whole session.
      pageWidth = document.documentElement.clientWidth || width;
      docHeight = Math.max(
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0,
        height * 4
      );
      scrollY = window.scrollY || window.pageYOffset || 0;
    };
    updateDimensions();

    const isMobile = width < 768;

    /* ── Cluster chain along the spine ──────────────────────────────────── */
    // Density is expressed per screen-height of document so the current keeps
    // the same thickness whether the page is four screens tall or twelve.
    const screens = Math.max(2, Math.min(16, docHeight / Math.max(1, height)));
    const CLUSTER_COUNT = Math.round((isMobile ? 6 : 9) * screens);
    const clusters: Cluster[] = [];
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

    /* ── Star population ────────────────────────────────────────────────── */
    const perCluster = isMobile ? 170 : 330;
    const fieldCount = Math.round((isMobile ? 700 : 1500) * screens);
    const stars: Star[] = [];

    const pushStar = (u: number, lx: number, ly: number, core: number) => {
      // core: 1 at the cluster centre → 0 at the fringe. Drives brightness,
      // colour temperature and how tightly the star packs.
      const bright = rand() > 0.965;
      const sz = bright
        ? 1.5 + rand() * 1.7
        : 0.45 + rand() * 0.85 + core * 0.45;
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
        // gentle ellipticity, elongated along the direction of the current
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

    const starCount = stars.length;

    const halfWidth = () => (isMobile ? Math.min(110, width * 0.3) : Math.min(230, width * 0.16));

    const onResize = () => updateDimensions();
    window.addEventListener("resize", onResize, { passive: true });
    const readScroll = () => {
      scrollY = window.scrollY || window.pageYOffset || 0;
    };
    // Kept only so the reduced-motion (non-rAF) path stays in step.
    window.addEventListener("scroll", readScroll, { passive: true });
    const onVis = () => {
      isTabActive = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver(([e]) => { isVisible = e.isIntersecting; }, { threshold: 0 });
    io.observe(canvas);

    const cleanup = () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", readScroll);
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
    };


    /* ── Drawing ────────────────────────────────────────────────────────── */
    const drawFrame = (now: number, animate: boolean) => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = "lighter";

      const hw = halfWidth();

      // 1. Unresolved cluster cores (round, soft, strictly secondary)
      for (let i = 0; i < clusters.length; i++) {
        const cl = clusters[i];
        const cu = cl.u;
        const sy = cu * docHeight - scrollY;
        const rpx = cl.radius * hw;
        if (sy < -rpx * 2 || sy > height + rpx * 2) continue;
        const sx = spineAt(cu) * pageWidth + cl.lx * hw + waveShape(cu) * hw;
        const pulse = animate ? 0.86 + Math.sin(now * cl.pulseSpeed + cl.pulsePhase) * 0.14 : 1;
        const d = rpx * 1.9;
        ctx.globalAlpha = Math.min(0.5, cl.coreAlpha * 0.5 * pulse);
        ctx.drawImage(coreSprite, sx - d / 2, sy - d / 2, d, d);
      }

      // 2. The particle population — this is what makes the ribbon read thick
      for (let i = 0; i < starCount; i++) {
        const p = stars[i];
        const pu = p.u;
        const sy = pu * docHeight - scrollY + p.ly * hw;
        if (sy < -30 || sy > height + 30) continue;

        const wobble = animate
          ? Math.sin(now * p.driftFreq + p.driftPhase) * p.driftAmp
          : 0;
        const sx = spineAt(pu) * pageWidth + p.lx * hw + waveShape(pu) * hw + wobble;
        if (sx < -40 || sx > width + 40) continue;

        let fade = 1;
        if (pu < 0.015) fade = pu / 0.015;
        else if (pu > 0.985) fade = Math.max(0, (1 - pu) / 0.015);

        const tw = animate ? 0.8 + Math.sin(now * p.twSpeed + p.twPhase) * 0.2 : 1;
        const a = Math.min(0.95, p.alpha * fade * tw);
        if (a <= 0.012) continue;

        const d = p.size * 5.2;
        ctx.globalAlpha = a;
        ctx.drawImage(sprites[p.colorIdx], sx - d / 2, sy - d / 2, d, d);

        // Diffraction glint on the handful of brightest members
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

    if (reduceMotion) {
      drawFrame(0, false);
      const onStaticScroll = () => drawFrame(0, false);
      window.addEventListener("scroll", onStaticScroll, { passive: true });
      window.addEventListener("resize", onStaticScroll, { passive: true });
      return () => {
        window.removeEventListener("scroll", onStaticScroll);
        window.removeEventListener("resize", onStaticScroll);
        cleanup();
      };
    }

    let rafId = 0;

    const render = (now: number) => {
      if (isVisible && isTabActive && width > 0 && height > 0) {
        // Sampled here rather than in a scroll handler: the projection is then
        // always built from the scroll offset of the frame being painted.
        readScroll();
        drawFrame(now, true);
      }
      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      cleanup();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 pointer-events-none select-none z-[1] overflow-hidden"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}
