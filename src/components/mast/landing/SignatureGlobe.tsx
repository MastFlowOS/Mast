import { useEffect, useRef } from "react";
import { WORLD_DOTS } from "./worldDots";

// Fixed Earth axial tilt: 23.44 degrees in radians
const TILT = 0.409;
// Cinematic slow planetary rotation (radians per second)
// ~4.5 minutes for a complete rotation — calm, hypnotic, dignified
const ROTATION_SPEED = 0.024;
// Visually substantial globe scale within the hero column
const SPHERE_FRACTION = 0.44;

// Directional celestial light vector (subtle lunar / solar grazing angle)
const LIGHT_X = -0.42;
const LIGHT_Y = 0.48;
const LIGHT_Z = 0.77;

export function SignatureGlobe({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let visible = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      { threshold: 0.05 }
    );
    io.observe(container);

    let running = true;
    const onVisChange = () => {
      running = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisChange);

    let rafId = 0;
    let last = performance.now();
    // Start angle angled toward Europe / Americas / Africa
    let rotation = 0.85;

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;

      if (!reduceMotion) {
        rotation += ROTATION_SPEED * (dt / 1000);
      }

      const cx = width / 2;
      const cy = height / 2;
      const r = Math.min(width, height) * SPHERE_FRACTION;

      // 1. Outer atmospheric limb scattering (subtle cool blue haze fading into deep space)
      // Realistic Rayleigh scattering: thin, faint, perfectly hugging the planetary horizon
      const atmoGlow = ctx.createRadialGradient(cx, cy, r * 0.94, cx, cy, r * 1.055);
      atmoGlow.addColorStop(0, "rgba(56, 96, 192, 0.14)");
      atmoGlow.addColorStop(0.35, "rgba(42, 78, 168, 0.09)");
      atmoGlow.addColorStop(0.7, "rgba(30, 58, 138, 0.03)");
      atmoGlow.addColorStop(1, "rgba(15, 23, 42, 0)");

      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.055, 0, Math.PI * 2);
      ctx.fillStyle = atmoGlow;
      ctx.fill();

      // 2. Base planetary ocean body (pitch-dark oceanic obsidian with subtle celestial curvature shading)
      // Preserves clean spherical boundary without generic neon glow
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();

      const oceanBg = ctx.createRadialGradient(
        cx - r * 0.28,
        cy - r * 0.32,
        r * 0.1,
        cx,
        cy,
        r * 1.02
      );
      oceanBg.addColorStop(0, "rgba(4, 9, 24, 0.96)");
      oceanBg.addColorStop(0.55, "rgba(2, 5, 16, 0.98)");
      oceanBg.addColorStop(0.92, "rgba(1, 3, 10, 1)");
      oceanBg.addColorStop(1, "rgba(0, 2, 7, 1)");

      ctx.fillStyle = oceanBg;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      // Inner limb atmospheric rim (thin twilight arc grazing the edge)
      const innerRim = ctx.createRadialGradient(cx, cy, r * 0.86, cx, cy, r);
      innerRim.addColorStop(0, "rgba(0, 0, 0, 0)");
      innerRim.addColorStop(0.8, "rgba(30, 58, 138, 0.08)");
      innerRim.addColorStop(1, "rgba(70, 110, 205, 0.22)");
      ctx.fillStyle = innerRim;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      // 3. Geographically accurate continental land dots with 3D directional lighting
      const dots = WORLD_DOTS;
      const dotCount = dots.length;

      const cosTilt = Math.cos(TILT);
      const sinTilt = Math.sin(TILT);

      for (let i = 0; i < dotCount; i++) {
        const d = dots[i];
        const phi = (d.lat * Math.PI) / 180;
        const lambda = (d.lon * Math.PI) / 180;

        // 3D Unit sphere coordinates
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        const theta = lambda - rotation;
        const cosTheta = Math.cos(theta);
        const sinTheta = Math.sin(theta);

        const x0 = cosPhi * sinTheta;
        const y0 = sinPhi;
        const z0 = cosPhi * cosTheta;

        // Apply axial tilt
        const x = x0;
        const y = y0 * cosTilt - z0 * sinTilt;
        const z = y0 * sinTilt + z0 * cosTilt;

        // Occlusion culling: strictly skip points on the reverse side of Earth
        if (z <= -0.01) continue;

        // Screen projection
        const sx = cx + x * r;
        const sy = cy - y * r;

        // Natural directional lighting calculation
        // Dot product with celestial light vector
        const dotLight = x * LIGHT_X + y * LIGHT_Y + z * LIGHT_Z;
        const sunFactor = Math.max(0, dotLight);

        // Curvature depth factor: dots slightly fade toward the silhouette horizon
        const zDepth = Math.max(0, Math.min(1, z));

        // Dimensionality & Night Visibility:
        // Continents remain recognizable in dark regions (base ambient 0.22),
        // catching delicate cool atmospheric sheen on the sunlit/grazing quadrant
        const luminosity = (0.22 + sunFactor * 0.48) * (0.75 + 0.25 * zDepth);

        // Fine, precise dots: non-oversized, scaled naturally with spherical depth
        const dotRadius = Math.max(0.7, 0.82 + 0.28 * zDepth);

        // Cool, quiet palette: pale silvery-blue in light, deep nocturnal slate in shadow
        // Completely free of gold or neon purple
        const rVal = Math.round(135 + sunFactor * 75);
        const gVal = Math.round(165 + sunFactor * 65);
        const bVal = Math.round(215 + sunFactor * 40);

        ctx.beginPath();
        ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, ${luminosity})`;
        ctx.fill();
      }

      ctx.restore();
    };

    const loop = (now: number) => {
      const dt = Math.min(now - last, 48);
      last = now;
      if (running && visible) draw(dt);
      rafId = requestAnimationFrame(loop);
    };

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  return (
    <div ref={containerRef} className={`relative select-none pointer-events-none ${className}`}>
      <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />
    </div>
  );
}
