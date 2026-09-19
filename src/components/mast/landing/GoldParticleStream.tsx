import { useEffect, useRef } from "react";

type Particle = {
  u: number; // Normalized vertical position [0, 1] along document height
  lateralOffset: number; // Normalized lateral offset from stream spine [-1, 1]
  speed: number; // Downward drift speed along u
  wanderAmp: number; // Amplitude of organic lateral drift
  wanderFreq: number; // Frequency of lateral drift
  wanderPhase: number; // Phase offset
  size: number; // Particle radius in pixels
  baseAlpha: number; // Target opacity [0.12 - 0.42]
  twinkleSpeed: number; // Twinkle frequency
  twinklePhase: number; // Twinkle phase offset
  colorIdx: number; // Index into subtle warm gold palette
};

// Warm celestial gold palette: muted bronze to warm gold accents
const GOLD_PALETTE = [
  "rgba(185, 145, 75,", // Muted antique bronze
  "rgba(205, 168, 98,", // Warm gold dust
  "rgba(225, 195, 128,", // Soft champagne gold
  "rgba(245, 222, 155,", // Bright golden highlight
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
    let scrollY = 0;
    let isVisible = true;
    let isTabActive = !document.hidden;

    // Stream central spine path defined as (u, xPercent) waypoints across sections:
    // u=0.00: Top of page / Above Hero
    // u=0.07: Hero Globe zone
    // u=0.15: Workflow section
    // u=0.28: Product Showcase / Relationship Data
    // u=0.42: Trusted By section
    // u=0.55: Why MAST / Problem
    // u=0.70: Platform / Features
    // u=0.84: Pricing Preview
    // u=0.94: CTA Section
    // u=1.00: Footer dissolution
    const WAYPOINTS: [number, number][] = [
      [0.0, 0.72],
      [0.07, 0.74],
      [0.15, 0.54],
      [0.28, 0.36],
      [0.42, 0.50],
      [0.55, 0.64],
      [0.70, 0.40],
      [0.84, 0.52],
      [0.94, 0.48],
      [1.0, 0.50],
    ];

    // Smooth Catmull-Rom interpolation along spline waypoints
    const getSpineX = (u: number): number => {
      const clampedU = Math.max(0, Math.min(1, u));
      const n = WAYPOINTS.length;

      let idx = 0;
      for (let i = 0; i < n - 1; i++) {
        if (clampedU >= WAYPOINTS[i][0] && clampedU <= WAYPOINTS[i + 1][0]) {
          idx = i;
          break;
        }
      }

      const p0 = WAYPOINTS[Math.max(0, idx - 1)];
      const p1 = WAYPOINTS[idx];
      const p2 = WAYPOINTS[Math.min(n - 1, idx + 1)];
      const p3 = WAYPOINTS[Math.min(n - 1, idx + 2)];

      const segLen = p2[0] - p1[0] || 0.001;
      const t = (clampedU - p1[0]) / segLen;

      // Standard cubic Hermite / Catmull-Rom
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

    // Determine viewport & document geometry
    const updateDimensions = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      docHeight = Math.max(
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0,
        height * 4
      );
      scrollY = window.scrollY || window.pageYOffset || 0;
    };

    updateDimensions();

    const onResize = () => {
      updateDimensions();
    };
    window.addEventListener("resize", onResize, { passive: true });

    const onScroll = () => {
      scrollY = window.scrollY || window.pageYOffset || 0;
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const onVisibilityChange = () => {
      isTabActive = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Observer to pause if viewport is off-screen
    const io = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0 }
    );
    io.observe(canvas);

    // Initialize particles:
    // Scaled for performance: ~180 particles on desktop, ~75 on mobile
    const isMobile = width < 768;
    const particleCount = isMobile ? 75 : 185;

    // Pseudorandom seed generator for deterministic organic spread
    let seed = 91823;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const particles: Particle[] = [];
    for (let i = 0; i < particleCount; i++) {
      // Normal-like distribution for lateral offset: cluster near core, sparse at edges
      const r1 = rand() * 2 - 1;
      const r2 = rand() * 2 - 1;
      const lateralOffset = (r1 + r2) * 0.5;

      particles.push({
        u: rand(), // Spread along full document length
        lateralOffset,
        speed: 0.000028 + rand() * 0.000035,
        wanderAmp: 12 + rand() * 22,
        wanderFreq: 0.0006 + rand() * 0.0008,
        wanderPhase: rand() * Math.PI * 2,
        size: 0.7 + rand() * 1.1, // Delicate micro-particles 0.7px - 1.8px
        baseAlpha: 0.12 + rand() * 0.24,
        twinkleSpeed: 0.0012 + rand() * 0.002,
        twinklePhase: rand() * Math.PI * 2,
        colorIdx: Math.floor(rand() * GOLD_PALETTE.length),
      });
    }

    // Single static render for reduced motion users
    if (reduceMotion) {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < particleCount; i++) {
        const p = particles[i];
        const screenY = p.u * docHeight - scrollY;
        if (screenY < -20 || screenY > height + 20) continue;

        const spineX = getSpineX(p.u) * width;
        const screenX = spineX + p.lateralOffset * 85;

        ctx.beginPath();
        ctx.arc(screenX, screenY, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `${GOLD_PALETTE[p.colorIdx]}${p.baseAlpha})`;
        ctx.fill();
      }
      return () => {
        window.removeEventListener("resize", onResize);
        window.removeEventListener("scroll", onScroll);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        io.disconnect();
      };
    }

    let rafId = 0;
    let lastTime = performance.now();

    const render = (now: number) => {
      const dt = Math.min(now - lastTime, 64);
      lastTime = now;

      if (isVisible && isTabActive && width > 0 && height > 0) {
        ctx.clearRect(0, 0, width, height);

        // Slow organic wave undulation along the celestial stream
        const waveTime1 = now * 0.00035;
        const waveTime2 = now * 0.0002;

        const streamHalfWidth = isMobile ? 55 : 85;

        for (let i = 0; i < particleCount; i++) {
          const p = particles[i];

          // Advance downward progress along the page
          p.u += p.speed * (dt / 16.67);
          if (p.u > 1.0) {
            p.u -= 1.0;
          }

          // Compute screen position
          const screenY = p.u * docHeight - scrollY;

          // Frustum culling: skip particles outside viewport window
          if (screenY < -40 || screenY > height + 40) continue;

          // Base horizontal position from spline
          const baseNormX = getSpineX(p.u);

          // Subtle harmonic wave undulation
          const waveOffset =
            Math.sin(p.u * 9 + waveTime1) * 16 +
            Math.cos(p.u * 15 - waveTime2) * 10;

          // Individual organic wander
          const wanderOffset =
            Math.sin(now * p.wanderFreq + p.wanderPhase) * p.wanderAmp;

          // Combined screen X
          const screenX =
            baseNormX * width +
            p.lateralOffset * streamHalfWidth +
            waveOffset +
            wanderOffset;

          // Natural stream opacity modulation:
          // Gently fades at extreme top (u < 0.02) and bottom (u > 0.95)
          let edgeFade = 1.0;
          if (p.u < 0.03) edgeFade = p.u / 0.03;
          else if (p.u > 0.94) edgeFade = Math.max(0, (1.0 - p.u) / 0.06);

          // Gentle breathing/twinkle
          const twinkle =
            0.75 + Math.sin(now * p.twinkleSpeed + p.twinklePhase) * 0.25;

          // Proximity light enhancement near Hero Globe zone (u between 0.04 and 0.12)
          let heroProximityBoost = 1.0;
          if (p.u >= 0.04 && p.u <= 0.12) {
            const distFromHeroCenter = Math.abs(p.u - 0.08) / 0.04;
            heroProximityBoost = 1.0 + (1.0 - distFromHeroCenter) * 0.25;
          }

          const finalAlpha = Math.min(
            0.55,
            p.baseAlpha * edgeFade * twinkle * heroProximityBoost
          );

          if (finalAlpha <= 0.005) continue;

          // Soft ambient glow for slightly larger particles (size > 1.2px)
          if (p.size > 1.2 && finalAlpha > 0.2) {
            ctx.beginPath();
            ctx.arc(screenX, screenY, p.size * 2.2, 0, Math.PI * 2);
            ctx.fillStyle = `${GOLD_PALETTE[p.colorIdx]}${(finalAlpha * 0.18).toFixed(3)})`;
            ctx.fill();
          }

          // Main crisp particle core
          ctx.beginPath();
          ctx.arc(screenX, screenY, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `${GOLD_PALETTE[p.colorIdx]}${finalAlpha.toFixed(3)})`;
          ctx.fill();
        }
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      io.disconnect();
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
