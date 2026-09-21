import { useEffect, useRef } from "react";

/**
 * GlobeCosmicParticles — reproduces the reference photo's signature environment:
 * 1. The sweeping spiral ribbon of glittering golden stardust and bokeh particles
 *    swirling around the globe and cascading down across the foreground.
 * 2. The etched astronomical / celestial astrolabe rings on the tabletop beneath the stand.
 */

interface Particle {
  t: number;          // Position along spline [0, 1]
  offset: number;     // Perpendicular drift from centerline
  speed: number;      // Progression speed
  size: number;       // Radius in px
  alpha: number;      // Base opacity
  pulsePhase: number; // Twinkle offset
  pulseSpeed: number; // Twinkle frequency
  color: string;      // Warm gold tint
  isBokeh: boolean;   // Larger out-of-focus bokeh disc
}

// Spline control points defining the cosmic ribbon in normalized [0, 1] coordinates
// flowing from top-left, wrapping behind the globe, sweeping around the left flank,
// and cascading across the foreground toward bottom-right.
const RIBBON_PATH: [number, number][] = [
  [0.18, -0.05],
  [0.22, 0.08],
  [0.34, 0.22],
  [0.46, 0.34],
  [0.38, 0.48],
  [0.24, 0.58],
  [0.32, 0.70],
  [0.55, 0.78],
  [0.76, 0.85],
  [0.96, 0.95],
  [1.08, 1.05],
];

// Evaluate Catmull-Rom or cubic bezier along points
function getSplinePoint(pts: [number, number][], t: number): [number, number] {
  const n = pts.length - 1;
  const p = Math.max(0, Math.min(1, t)) * n;
  const idx = Math.min(Math.floor(p), n - 1);
  const frac = p - idx;

  const p0 = pts[Math.max(0, idx - 1)];
  const p1 = pts[idx];
  const p2 = pts[Math.min(n, idx + 1)];
  const p3 = pts[Math.min(n, idx + 2)];

  // Catmull-Rom formula
  const t2 = frac * frac;
  const t3 = t2 * frac;

  const x =
    0.5 *
    (2 * p1[0] +
      (-p0[0] + p2[0]) * frac +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);

  const y =
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * frac +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);

  return [x, y];
}

export function GlobeCosmicParticles({
  className = "",
  layer = "both",
}: {
  className?: string;
  layer?: "behind" | "infront" | "both";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width || 500;
      height = rect.height || 680;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Generate ~140 particles along the ribbon
    const PARTICLE_COUNT = 150;
    const particles: Particle[] = [];

    const GOLD_PALETTE = [
      "rgba(255, 225, 140, ", // Pale luminous gold
      "rgba(245, 195, 95, ",  // Warm rich amber
      "rgba(230, 165, 60, ",  // Deep antique gold
      "rgba(255, 245, 200, ", // Hot white-gold highlight
    ];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const isBokeh = Math.random() < 0.14;
      particles.push({
        t: Math.random(),
        offset: (Math.random() - 0.5) * (isBokeh ? 70 : 45),
        speed: 0.008 + Math.random() * 0.016,
        size: isBokeh ? 8 + Math.random() * 16 : 0.8 + Math.random() * 2.6,
        alpha: isBokeh ? 0.08 + Math.random() * 0.16 : 0.35 + Math.random() * 0.65,
        pulsePhase: Math.random() * Math.PI * 2,
        pulseSpeed: 1.5 + Math.random() * 3.5,
        color: GOLD_PALETTE[Math.floor(Math.random() * GOLD_PALETTE.length)],
        isBokeh,
      });
    }

    let rafId = 0;
    let last = performance.now();

    const render = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      ctx.clearRect(0, 0, width, height);

      // 1. If this is the behind or both layer: Draw the celestial astrolabe coordinate floor
      if (layer === "behind" || layer === "both") {
        ctx.save();
        // Stand base is centered at x: 50% and y: ~88%
        const floorCX = width * 0.485;
        const floorCY = height * 0.875;
        const baseRadius = width * 0.35;

        ctx.translate(floorCX, floorCY);
        ctx.scale(1.0, 0.28); // 3D elliptical tabletop projection

        // Warm ambient light pool on the tabletop
        const tableGlow = ctx.createRadialGradient(0, 0, baseRadius * 0.2, 0, 0, baseRadius * 1.8);
        tableGlow.addColorStop(0, "rgba(215, 160, 65, 0.22)");
        tableGlow.addColorStop(0.4, "rgba(160, 110, 40, 0.09)");
        tableGlow.addColorStop(0.8, "rgba(90, 60, 20, 0.03)");
        tableGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = tableGlow;
        ctx.beginPath();
        ctx.arc(0, 0, baseRadius * 1.8, 0, Math.PI * 2);
        ctx.fill();

        // Concentric celestial/astronomical rings
        const ringFractions = [0.42, 0.62, 0.85, 1.05, 1.28, 1.55];
        ringFractions.forEach((rf, idx) => {
          ctx.beginPath();
          ctx.arc(0, 0, baseRadius * rf, 0, Math.PI * 2);
          const alpha = (0.16 - idx * 0.02) * (idx % 2 === 0 ? 1.3 : 0.8);
          ctx.strokeStyle = `rgba(225, 175, 85, ${alpha})`;
          ctx.lineWidth = idx === 3 ? 1.5 : 0.75;
          ctx.stroke();
        });

        // Radial coordinate tick marks
        const tickCount = 48;
        for (let j = 0; j < tickCount; j++) {
          const ang = (j / tickCount) * Math.PI * 2;
          const r1 = baseRadius * 1.05;
          const r2 = baseRadius * (j % 4 === 0 ? 1.2 : 1.12);
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
          ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2);
          ctx.strokeStyle = j % 4 === 0 ? "rgba(235, 185, 95, 0.22)" : "rgba(215, 165, 75, 0.1)";
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }

        ctx.restore();
      }

      // 2. Render stardust stream particles
      const timeSec = now * 0.001;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        if (!reduceMotion) {
          p.t += p.speed * dt;
          if (p.t > 1) p.t -= 1;
        }

        // Layer partition:
        // Particles with t between ~0.15 and ~0.45 pass behind the globe
        const isBehindGlobe = p.t >= 0.12 && p.t <= 0.48;
        if (layer === "behind" && !isBehindGlobe && p.t <= 0.6) continue;
        if (layer === "infront" && isBehindGlobe) continue;

        // Spline position
        const [splineX, splineY] = getSplinePoint(RIBBON_PATH, p.t);

        // Approximate normal for width drift
        const eps = 0.01;
        const [nx1, ny1] = getSplinePoint(RIBBON_PATH, Math.max(0, p.t - eps));
        const [nx2, ny2] = getSplinePoint(RIBBON_PATH, Math.min(1, p.t + eps));
        const dx = nx2 - nx1;
        const dy = ny2 - ny1;
        const len = Math.hypot(dx, dy) || 1;
        const normalX = -dy / len;
        const normalY = dx / len;

        // Ribbon expands and fans out toward the foreground
        const spreadScale = 1.0 + p.t * 1.5;
        const px = (splineX * width) + normalX * p.offset * spreadScale;
        const py = (splineY * height) + normalY * p.offset * spreadScale;

        // Twinkle modulation
        const twinkle = 0.75 + 0.25 * Math.sin(p.pulsePhase + timeSec * p.pulseSpeed);
        // Fade in/out smoothly at stream endpoints
        const edgeFade = Math.sin(p.t * Math.PI);
        const curAlpha = p.alpha * twinkle * edgeFade;

        if (curAlpha <= 0.005) continue;

        if (p.isBokeh) {
          // Soft glowing golden bokeh disc
          const grad = ctx.createRadialGradient(px, py, 0, px, py, p.size);
          grad.addColorStop(0, `${p.color}${curAlpha * 1.2})`);
          grad.addColorStop(0.35, `${p.color}${curAlpha * 0.8})`);
          grad.addColorStop(0.7, `${p.color}${curAlpha * 0.25})`);
          grad.addColorStop(1, `${p.color}0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, p.size, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Sharp glittering stardust point with tiny halo
          ctx.beginPath();
          ctx.arc(px, py, p.size * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = `${p.color}${curAlpha * 0.28})`;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(px, py, p.size, 0, Math.PI * 2);
          ctx.fillStyle = `${p.color}${curAlpha})`;
          ctx.fill();
        }
      }

      if (!reduceMotion) {
        rafId = requestAnimationFrame(render);
      }
    };

    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [layer]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 w-full h-full ${className}`}
      aria-hidden="true"
    />
  );
}
