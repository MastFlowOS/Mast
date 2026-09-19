import { useEffect, useRef } from "react";

type Particle = {
  u: number; // Position [0, 1] along document length
  lateral: number; // Normalized lateral offset from stream spine [-1, 1]
  speed: number; // Downward drift speed
  driftAmp: number; // Amplitude of organic oscillation
  driftFreq: number; // Frequency of organic oscillation
  driftPhase: number;
  size: number; // Radius in pixels
  baseAlpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  colorIdx: number;
};

// Rich warm gold celestial dust palette
const GOLD_COLORS = [
  "rgba(188, 142, 68,", // Muted antique bronze
  "rgba(212, 172, 92,", // Warm celestial gold
  "rgba(235, 202, 126,", // Soft glowing champagne gold
  "rgba(255, 235, 175,", // Bright specular dust highlight
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

    // Spline waypoints defining the continuous celestial current through all sections
    const WAYPOINTS: [number, number][] = [
      [0.0, 0.65],
      [0.07, 0.74], // Sweeps diagonally past and behind the Hero Globe
      [0.16, 0.53], // Curves into Workflow
      [0.28, 0.35], // Weaves behind Product Showcase / Relationship Data
      [0.42, 0.50], // Crosses through Trusted By
      [0.55, 0.64], // Sweeps through Why MAST / Problem
      [0.70, 0.39], // Weaves through Platform / Features
      [0.84, 0.52], // Crosses through Pricing Preview
      [0.94, 0.48], // Frames the CTA Box
      [1.0, 0.50], // Naturally dissolves into the Footer
    ];

    // Cubic Catmull-Rom spline interpolation along the stream path
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

    const onResize = () => updateDimensions();
    window.addEventListener("resize", onResize, { passive: true });

    const onScroll = () => {
      scrollY = window.scrollY || window.pageYOffset || 0;
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const onVisibilityChange = () => {
      isTabActive = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const io = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0 }
    );
    io.observe(canvas);

    // Dense celestial cluster calibration:
    // Yields ~300-400 active particles clustered in any viewport, forming a thick ribbon
    const isMobile = width < 768;
    const particleCount = isMobile ? 650 : 1550;

    let seed = 48291;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const particles: Particle[] = [];
    for (let i = 0; i < particleCount; i++) {
      // Cubic distribution: creates a thick, dense golden core with soft feathered edges
      const rVal = rand() * 2 - 1;
      const lateral = rVal * rVal * rVal * 0.75 + (rand() * 2 - 1) * 0.25;

      // Particles closer to the core have higher opacity and warmer gold hues
      const distFromCore = Math.abs(lateral);
      const coreFactor = 1 - Math.min(1, distFromCore);

      particles.push({
        u: rand(),
        lateral,
        speed: 0.00003 + rand() * 0.000038,
        driftAmp: 8 + rand() * 18,
        driftFreq: 0.0008 + rand() * 0.001,
        driftPhase: rand() * Math.PI * 2,
        size: 0.7 + rand() * 0.9 + (rand() > 0.88 ? 0.6 : 0),
        baseAlpha: 0.16 + coreFactor * 0.38 + rand() * 0.12,
        twinkleSpeed: 0.0014 + rand() * 0.0022,
        twinklePhase: rand() * Math.PI * 2,
        colorIdx: coreFactor > 0.65 ? (rand() > 0.5 ? 2 : 3) : (rand() > 0.5 ? 1 : 0),
      });
    }

    if (reduceMotion) {
      ctx.clearRect(0, 0, width, height);
      const streamHalfWidth = isMobile ? 70 : 120;
      for (let i = 0; i < particleCount; i++) {
        const p = particles[i];
        const screenY = p.u * docHeight - scrollY;
        if (screenY < -30 || screenY > height + 30) continue;

        const spineX = getSpineX(p.u) * width;
        const screenX = spineX + p.lateral * streamHalfWidth;

        ctx.beginPath();
        ctx.arc(screenX, screenY, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `${GOLD_COLORS[p.colorIdx]}${p.baseAlpha.toFixed(2)})`;
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
        const waveTime1 = now * 0.00032;
        const waveTime2 = now * 0.00018;
        const streamHalfWidth = isMobile ? 75 : 125;

        for (let i = 0; i < particleCount; i++) {
          const p = particles[i];

          // Advance downward drift
          p.u += p.speed * (dt / 16.67);
          if (p.u > 1.0) p.u -= 1.0;

          const screenY = p.u * docHeight - scrollY;

          // Frustum culling: render only particles in visible viewport
          if (screenY < -40 || screenY > height + 40) continue;

          // Spline position
          const baseNormX = getSpineX(p.u);

          // Harmonic wave undulation
          const waveOffset =
            Math.sin(p.u * 8 + waveTime1) * 22 +
            Math.cos(p.u * 14 - waveTime2) * 14;

          // Individual organic micro-wander
          const driftOffset =
            Math.sin(now * p.driftFreq + p.driftPhase) * p.driftAmp;

          const screenX =
            baseNormX * width +
            p.lateral * streamHalfWidth +
            waveOffset +
            driftOffset;

          // Soft edge fade at very top and bottom of the page
          let edgeFade = 1.0;
          if (p.u < 0.02) edgeFade = p.u / 0.02;
          else if (p.u > 0.95) edgeFade = Math.max(0, (1.0 - p.u) / 0.05);

          // Subtle twinkle
          const twinkle =
            0.78 + Math.sin(now * p.twinkleSpeed + p.twinklePhase) * 0.22;

          // Proximity boost near Hero Globe zone (u between 0.03 and 0.12)
          let heroBoost = 1.0;
          if (p.u >= 0.03 && p.u <= 0.12) {
            const dist = Math.abs(p.u - 0.075) / 0.045;
            heroBoost = 1.0 + (1.0 - Math.min(1, dist)) * 0.22;
          }

          const finalAlpha = Math.min(
            0.65,
            p.baseAlpha * edgeFade * twinkle * heroBoost
          );

          if (finalAlpha <= 0.01) continue;

          // Crisp particle core
          ctx.beginPath();
          ctx.arc(screenX, screenY, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `${GOLD_COLORS[p.colorIdx]}${finalAlpha.toFixed(3)})`;
          ctx.fill();

          // Soft delicate bloom for larger highlight particles
          if (p.size > 1.4 && finalAlpha > 0.25) {
            ctx.beginPath();
            ctx.arc(screenX, screenY, p.size * 2.2, 0, Math.PI * 2);
            ctx.fillStyle = `${GOLD_COLORS[p.colorIdx]}${(finalAlpha * 0.2).toFixed(3)})`;
            ctx.fill();
          }
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
