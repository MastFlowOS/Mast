import { useEffect, useRef } from "react";
import { WORLD_DOTS } from "./worldDots";

// Fixed Earth axial tilt: 23.44 degrees in radians
const TILT = 0.409;
// Cinematic slow planetary rotation (radians per second) during free spin
const BASE_SPEED = 0.024;
// Visually substantial globe scale within the hero column
const SPHERE_FRACTION = 0.44;
// Planetary zoom during focus: gentle, subtle push
const ZOOM_MAX = 1.065;
const PAN_STRENGTH = 0.35;

// Directional celestial light vector (subtle lunar / solar grazing angle)
const LIGHT_X = -0.42;
const LIGHT_Y = 0.48;
const LIGHT_Z = 0.77;

type FocusTarget = {
  name: string;
  lat: number;
  lon: number;
  radiusDeg: number;
};

const FOCUS_TARGETS: FocusTarget[] = [
  { name: "North America", lat: 38, lon: -97, radiusDeg: 28 },
  { name: "Western Europe", lat: 48, lon: 12, radiusDeg: 20 },
  { name: "East Asia", lat: 34, lon: 132, radiusDeg: 22 },
  { name: "Middle East", lat: 26, lon: 50, radiusDeg: 18 },
  { name: "Asia-Pacific", lat: -26, lon: 135, radiusDeg: 24 },
];

type Phase = "rotate" | "settle" | "focus" | "release";

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Deterministic pseudo-random helper for clustering city night lights
function hash01(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function SignatureGlobe({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

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
    // Initial orientation: strong, recognizable continental composition on load
    // Angled toward the Atlantic / Western Europe / Africa / Eastern Americas
    let rotation = 0.85;

    // Focus system bookkeeping
    let targetIdx = -1;
    let phase: Phase = "rotate";
    let phaseElapsed = 0;
    let rotationAtSettleStart = rotation;
    let targetRotation = rotation;

    // Subtle randomized durations per cycle so animation does not feel rigid
    let rotateDuration = 6800;
    let focusDuration = 4200;
    const settleDuration = 2200;
    const releaseDuration = 1800;

    const unitY = (lat: number, lon: number, rot: number) => {
      const phi = (lat * Math.PI) / 180;
      const lambda = (lon * Math.PI) / 180;
      const y0 = Math.sin(phi);
      const z0 = Math.cos(phi) * Math.cos(lambda - rot);
      return y0 * Math.cos(TILT) - z0 * Math.sin(TILT);
    };

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;

      if (!reduceMotion) {
        phaseElapsed += dt;

        // Phase progression with randomized durations
        if (phase === "rotate" && phaseElapsed >= rotateDuration) {
          phase = "settle";
          phaseElapsed = 0;
          targetIdx = (targetIdx + 1) % FOCUS_TARGETS.length;
          rotationAtSettleStart = rotation;
          const target = FOCUS_TARGETS[targetIdx];
          const targetLambda = (target.lon * Math.PI) / 180;
          const delta = (((targetLambda - rotationAtSettleStart) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          targetRotation = rotationAtSettleStart + delta;
        } else if (phase === "settle" && phaseElapsed >= settleDuration) {
          phase = "focus";
          phaseElapsed = 0;
          rotation = targetRotation;
        } else if (phase === "focus" && phaseElapsed >= focusDuration) {
          phase = "release";
          phaseElapsed = 0;
        } else if (phase === "release" && phaseElapsed >= releaseDuration) {
          phase = "rotate";
          phaseElapsed = 0;
          // Randomize next cycle lengths subtly
          rotateDuration = 6000 + Math.random() * 1800;
          focusDuration = 3600 + Math.random() * 1200;
        }

        // Rotation updates
        if (phase === "rotate") {
          rotation += BASE_SPEED * (dt / 1000);
        } else if (phase === "settle") {
          const p = Math.min(1, phaseElapsed / settleDuration);
          rotation = rotationAtSettleStart + (targetRotation - rotationAtSettleStart) * easeInOutCubic(p);
        } else if (phase === "focus") {
          rotation = targetRotation;
        } else if (phase === "release") {
          const p = Math.min(1, phaseElapsed / releaseDuration);
          rotation = targetRotation + BASE_SPEED * easeInOutCubic(p) * (phaseElapsed / 1000);
        }
      }

      // Smooth zoom and pan interpolation
      let zoom = 1.0;
      let focusGlow = 0;

      if (phase === "settle") {
        const p = Math.min(1, phaseElapsed / settleDuration);
        const ep = easeInOutCubic(p);
        zoom = 1.0 + (ZOOM_MAX - 1.0) * ep;
        focusGlow = Math.max(0, (p - 0.35) / 0.65);
      } else if (phase === "focus") {
        zoom = ZOOM_MAX;
        focusGlow = 1.0;
      } else if (phase === "release") {
        const p = Math.min(1, phaseElapsed / releaseDuration);
        const ep = easeInOutCubic(p);
        zoom = 1.0 + (ZOOM_MAX - 1.0) * (1 - ep);
        focusGlow = Math.max(0, 1 - ep * 1.3);
      }

      const currentTarget = targetIdx >= 0 ? FOCUS_TARGETS[targetIdx] : null;
      const targetUY = currentTarget ? unitY(currentTarget.lat, currentTarget.lon, rotation) : 0;
      const panProgress = (zoom - 1.0) / (ZOOM_MAX - 1.0 || 1);

      const cx = width / 2;
      const cy = height / 2;
      const r = Math.min(width, height) * SPHERE_FRACTION;
      const effectiveR = r * zoom;
      const effectiveCY = cy + targetUY * r * panProgress * PAN_STRENGTH;

      // 1. Outer atmospheric limb scattering (Rayleigh haze hugging the outer edge)
      const atmoGlow = ctx.createRadialGradient(cx, effectiveCY, effectiveR * 0.94, cx, effectiveCY, effectiveR * 1.055);
      atmoGlow.addColorStop(0, "rgba(56, 96, 192, 0.16)");
      atmoGlow.addColorStop(0.35, "rgba(42, 78, 168, 0.09)");
      atmoGlow.addColorStop(0.7, "rgba(30, 58, 138, 0.03)");
      atmoGlow.addColorStop(1, "rgba(15, 23, 42, 0)");

      ctx.beginPath();
      ctx.arc(cx, effectiveCY, effectiveR * 1.055, 0, Math.PI * 2);
      ctx.fillStyle = atmoGlow;
      ctx.fill();

      // 2. Base planetary ocean body with enhanced 3D curvature visibility
      // Desired progression: Deep black -> barely visible midnight-blue planetary body -> subtle atmospheric edge
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, effectiveCY, effectiveR, 0, Math.PI * 2);
      ctx.clip();

      const oceanBg = ctx.createRadialGradient(
        cx - effectiveR * 0.25,
        effectiveCY - effectiveR * 0.28,
        effectiveR * 0.12,
        cx,
        effectiveCY,
        effectiveR * 1.01
      );
      // Perceptible midnight-blue ocean body that remains distinct from space across all 360 degrees
      oceanBg.addColorStop(0, "rgba(8, 22, 54, 0.98)");
      oceanBg.addColorStop(0.42, "rgba(6, 16, 42, 0.98)");
      oceanBg.addColorStop(0.82, "rgba(4, 11, 28, 0.99)");
      oceanBg.addColorStop(1, "rgba(3, 8, 22, 1)");

      ctx.fillStyle = oceanBg;
      ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);

      // Complete 360-degree spherical horizon definition ring
      const innerRim = ctx.createRadialGradient(cx, effectiveCY, effectiveR * 0.86, cx, effectiveCY, effectiveR);
      innerRim.addColorStop(0, "rgba(0, 0, 0, 0)");
      innerRim.addColorStop(0.72, "rgba(36, 68, 148, 0.10)");
      innerRim.addColorStop(1, "rgba(68, 112, 210, 0.26)");
      ctx.fillStyle = innerRim;
      ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);

      // 3. Continental land dots with natural 3D lighting + irregular civilization night light clusters
      const dots = WORLD_DOTS;
      const dotCount = dots.length;

      const cosTilt = Math.cos(TILT);
      const sinTilt = Math.sin(TILT);

      const targetLatRad = currentTarget ? (currentTarget.lat * Math.PI) / 180 : 0;
      const targetLonRad = currentTarget ? (currentTarget.lon * Math.PI) / 180 : 0;
      const maxDistRad = currentTarget ? (currentTarget.radiusDeg * Math.PI) / 180 : 1;

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
        const sx = cx + x * effectiveR;
        const sy = effectiveCY - y * effectiveR;

        // Natural directional lighting calculation
        const dotLight = x * LIGHT_X + y * LIGHT_Y + z * LIGHT_Z;
        const sunFactor = Math.max(0, dotLight);
        const zDepth = Math.max(0, Math.min(1, z));

        // Base planetary land luminosity: visible even in darkest shadow
        let luminosity = (0.24 + sunFactor * 0.48) * (0.76 + 0.24 * zDepth);
        let dotRadius = Math.max(0.7, 0.82 + 0.28 * zDepth);

        // Palette: pale silvery-blue in light, deep nocturnal slate in shadow
        let rVal = Math.round(135 + sunFactor * 75);
        let gVal = Math.round(165 + sunFactor * 65);
        let bVal = Math.round(215 + sunFactor * 40);

        // Check if point falls within the focused geographic region
        let isCivilizationLight = false;
        let lightIntensity = 0;

        if (focusGlow > 0.01 && currentTarget) {
          // Great-circle angular distance
          const cosDist = Math.sin(phi) * Math.sin(targetLatRad) + Math.cos(phi) * Math.cos(targetLatRad) * Math.cos(lambda - targetLonRad);
          const dist = Math.acos(Math.max(-1, Math.min(1, cosDist)));

          if (dist < maxDistRad) {
            // Irregular clustering: only selected population nodes catch night lights
            const clusterHash = hash01(Math.round((d.lat + 90) * 43 + (d.lon + 180) * 89));
            if (clusterHash > 0.58) {
              const prox = 1 - dist / maxDistRad;
              const densityFactor = (clusterHash - 0.58) / 0.42;
              lightIntensity = Math.pow(prox, 1.2) * densityFactor * focusGlow;
              if (lightIntensity > 0.02) {
                isCivilizationLight = true;
              }
            }
          }
        }

        if (isCivilizationLight) {
          // Delicate starlight bloom around civilization cluster node
          const bloomAlpha = lightIntensity * 0.35;
          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(185, 215, 255, ${bloomAlpha})`;
          ctx.fill();

          // Crisp tiny warm-pale city light core
          const coreAlpha = Math.min(1, luminosity + lightIntensity * 0.75);
          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius * 1.15, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(252, 250, 242, ${coreAlpha})`;
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, ${luminosity})`;
          ctx.fill();
        }
      }

      ctx.restore();

      // Minimal editorial region label: appears only during focus state and fades afterward
      if (labelRef.current) {
        if (focusGlow > 0.04 && currentTarget) {
          labelRef.current.style.opacity = String(Math.min(1, focusGlow * 0.85));
          labelRef.current.textContent = currentTarget.name;
        } else {
          labelRef.current.style.opacity = "0";
        }
      }
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
      {/* Minimal editorial region indicator — clean, quiet typography, zero HUD/dashboard styling */}
      <div className="pointer-events-none absolute left-1/2 bottom-2 -translate-x-1/2 flex flex-col items-center">
        <div
          ref={labelRef}
          className="text-[10px] font-semibold tracking-[0.28em] uppercase text-foreground/75 transition-opacity duration-500 text-center"
          style={{ opacity: 0 }}
        />
      </div>
    </div>
  );
}
