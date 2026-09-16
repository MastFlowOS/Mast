import { useEffect, useRef } from "react";
import { WORLD_DOTS } from "./worldDots";
import { FOCUS_TARGETS, DOT_REGIONS, DOT_DENSITIES } from "./focusRegions";

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

type Phase = "rotate" | "settle" | "focus" | "release";

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
      width = rect.width || container.clientWidth || 360;
      height = rect.height || container.clientHeight || 360;
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
    // Angled toward the Atlantic / Western Europe / Eastern Americas
    let rotation = 0.85;

    // Focus system bookkeeping
    let targetIdx = -1;
    let phase: Phase = "rotate";
    let phaseElapsed = 0;
    let rotationAtSettleStart = rotation;
    let targetRotation = rotation;

    // Balanced durations: smooth free spin -> gentle settle -> vivid focus -> clean release
    let rotateDuration = 4500;
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

    const drawFallback = () => {
      if (width === 0 || height === 0) return;
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const r = Math.min(width, height) * SPHERE_FRACTION;
      
      const atmoGlow = ctx.createRadialGradient(cx, cy, r * 0.94, cx, cy, r * 1.055);
      atmoGlow.addColorStop(0, "rgba(56, 96, 192, 0.16)");
      atmoGlow.addColorStop(0.35, "rgba(42, 78, 168, 0.09)");
      atmoGlow.addColorStop(1, "rgba(15, 23, 42, 0)");
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.055, 0, Math.PI * 2);
      ctx.fillStyle = atmoGlow;
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      const oceanBg = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.28, r * 0.12, cx, cy, r * 1.01);
      oceanBg.addColorStop(0, "rgba(8, 22, 54, 0.98)");
      oceanBg.addColorStop(0.42, "rgba(6, 16, 42, 0.98)");
      oceanBg.addColorStop(0.82, "rgba(4, 11, 28, 0.99)");
      oceanBg.addColorStop(1, "rgba(3, 8, 22, 1)");
      ctx.fillStyle = oceanBg;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    };

    const draw = (dt: number, timeMs?: number) => {
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;
      const currentNow = timeMs ?? performance.now();

      if (!reduceMotion) {
        phaseElapsed += dt;

        // Phase progression with calibrated durations
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
          // Randomize subsequent cycle lengths subtly
          rotateDuration = 5500 + Math.random() * 1500;
          focusDuration = 4000 + Math.random() * 800;
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

      // Smooth zoom and layered MAST gold illumination interpolation
      let zoom = 1.0;
      let goldProgress = 0;

      if (phase === "settle") {
        const p = Math.min(1, phaseElapsed / settleDuration);
        const ep = easeInOutCubic(p);
        zoom = 1.0 + (ZOOM_MAX - 1.0) * ep;
        // Phasing requirement: settle transitions 0% -> 70% gold
        goldProgress = ep * 0.70;
      } else if (phase === "focus") {
        zoom = ZOOM_MAX;
        const p = Math.min(1, phaseElapsed / focusDuration);
        // Phasing requirement: focus transitions 70% -> 100% peak gold
        const ramp = Math.min(1, p / 0.35);
        goldProgress = 0.70 + 0.30 * easeInOutCubic(ramp);
      } else if (phase === "release") {
        const p = Math.min(1, phaseElapsed / releaseDuration);
        const ep = easeInOutCubic(p);
        zoom = 1.0 + (ZOOM_MAX - 1.0) * (1 - ep);
        // Phasing requirement: release transitions 100% -> 0% back to nocturnal cool palette
        goldProgress = Math.max(0, 1.0 - ep);
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
      const envLimbBreath = 1 + Math.sin(currentNow * 0.00032) * 0.04;
      const atmoGlow = ctx.createRadialGradient(cx, effectiveCY, effectiveR * 0.94, cx, effectiveCY, effectiveR * 1.055);
      atmoGlow.addColorStop(0, `rgba(56, 96, 192, ${0.16 * envLimbBreath})`);
      atmoGlow.addColorStop(0.35, `rgba(42, 78, 168, ${0.09 * envLimbBreath})`);
      atmoGlow.addColorStop(0.7, "rgba(30, 58, 138, 0.03)");
      atmoGlow.addColorStop(1, "rgba(15, 23, 42, 0)");

      ctx.beginPath();
      ctx.arc(cx, effectiveCY, effectiveR * 1.055, 0, Math.PI * 2);
      ctx.fillStyle = atmoGlow;
      ctx.fill();

      // 2. Base planetary ocean body with enhanced 3D curvature visibility
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

      const cosTilt = Math.cos(TILT);
      const sinTilt = Math.sin(TILT);

      // Layer 3: Subtle territory ambient gold radiance (cradling the focused landmass)
      if (goldProgress > 0.01 && currentTarget) {
        const tPhi = (currentTarget.lat * Math.PI) / 180;
        const tLambda = (currentTarget.lon * Math.PI) / 180;
        const tTheta = tLambda - rotation;
        const tx0 = Math.cos(tPhi) * Math.sin(tTheta);
        const ty0 = Math.sin(tPhi);
        const tz0 = Math.cos(tPhi) * Math.cos(tTheta);
        const tx = tx0;
        const ty = ty0 * cosTilt - tz0 * sinTilt;
        const tz = ty0 * sinTilt + tz0 * cosTilt;
        if (tz > 0.1) {
          const tsx = cx + tx * effectiveR;
          const tsy = effectiveCY - ty * effectiveR;
          const regionRad = effectiveR * 0.42;
          const regionBloom = ctx.createRadialGradient(tsx, tsy, 0, tsx, tsy, regionRad);
          regionBloom.addColorStop(0, `rgba(201, 166, 107, ${0.075 * goldProgress * Math.min(1, tz * 1.2)})`);
          regionBloom.addColorStop(0.55, `rgba(181, 141, 69, ${0.03 * goldProgress * Math.min(1, tz * 1.2)})`);
          regionBloom.addColorStop(1, "rgba(181, 141, 69, 0)");
          ctx.fillStyle = regionBloom;
          ctx.beginPath();
          ctx.arc(tsx, tsy, regionRad, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 3. Continental land dots with natural 3D lighting + geographically accurate gold illumination
      const dots = WORLD_DOTS;
      const dotCount = dots.length;

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

        // Base nocturnal palette: pale silvery-blue in light, deep nocturnal slate in shadow
        let rVal = Math.round(135 + sunFactor * 75);
        let gVal = Math.round(165 + sunFactor * 65);
        let bVal = Math.round(215 + sunFactor * 40);

        // Check if dot belongs to the active focus region
        const isTargetRegion = currentTarget && targetIdx >= 0 && DOT_REGIONS[i] === targetIdx;
        const cityDensity = isTargetRegion ? DOT_DENSITIES[i] : 0;

        if (isTargetRegion && goldProgress > 0.01) {
          // Layer 1: Geographically accurate continental gold landmass tint
          // MAST Brand Gold #c9a66b (rgb: 201, 166, 107)
          const goldR = Math.round(rVal + (201 - rVal) * goldProgress);
          const goldG = Math.round(gVal + (166 - gVal) * goldProgress);
          const goldB = Math.round(bVal + (107 - bVal) * goldProgress);
          const goldLum = Math.min(1, luminosity * (1 + 0.42 * goldProgress));
          const goldRadius = dotRadius * (1 + 0.14 * goldProgress);

          if (cityDensity > 0.06 && goldProgress > 0.03) {
            // Layer 2: Real population & metropolitan civilization nodes
            if (cityDensity >= 0.38) {
              // Major metropolitan hub (Tier 1: London, Paris, Madrid, Berlin, Rome, Amsterdam, Milan, etc.)
              // Outer bloom: MAST Deep Gold #b58d45 (rgb: 181, 141, 69)
              ctx.beginPath();
              ctx.arc(sx, sy, goldRadius * 3.4, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(181, 141, 69, ${0.24 * cityDensity * goldProgress})`;
              ctx.fill();

              // Middle halo: MAST Brand Gold #c9a66b (rgb: 201, 166, 107)
              ctx.beginPath();
              ctx.arc(sx, sy, goldRadius * 2.1, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(201, 166, 107, ${0.62 * cityDensity * goldProgress})`;
              ctx.fill();

              // Brilliant core: MAST Highlight Gold #e8c77e (rgb: 232, 199, 126)
              ctx.beginPath();
              ctx.arc(sx, sy, goldRadius * 1.35, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(232, 199, 126, ${0.96 * goldProgress})`;
              ctx.fill();
            } else {
              // Urban corridor / secondary cluster (Tier 2)
              // Secondary halo: MAST Brand Gold #c9a66b
              ctx.beginPath();
              ctx.arc(sx, sy, goldRadius * 1.85, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(201, 166, 107, ${0.46 * cityDensity * goldProgress})`;
              ctx.fill();

              // Core: MAST Highlight Gold #e8c77e
              ctx.beginPath();
              ctx.arc(sx, sy, goldRadius * 1.15, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(232, 199, 126, ${0.88 * goldProgress})`;
              ctx.fill();
            }
          } else {
            // Rural / topography dots defining the unmistakable landmass shape
            ctx.beginPath();
            ctx.arc(sx, sy, goldRadius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${goldR}, ${goldG}, ${goldB}, ${goldLum})`;
            ctx.fill();
          }
        } else {
          // Normal nocturnal continent point outside the focus region
          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, ${luminosity})`;
          ctx.fill();
        }
      }

      ctx.restore();

      // Minimal editorial region label: appears only during focus state and fades afterward
      if (labelRef.current) {
        if (goldProgress > 0.04 && currentTarget) {
          labelRef.current.style.opacity = String(Math.min(1, goldProgress * 0.9));
          labelRef.current.textContent = currentTarget.name;
        } else {
          labelRef.current.style.opacity = "0";
        }
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(now - last, 48);
      last = now;
      if (running && visible) {
        try {
          draw(dt, now);
        } catch (err) {
          console.error("SignatureGlobe error:", err);
          drawFallback();
        }
      }
      rafId = requestAnimationFrame(loop);
    };

    // Immediate initial frame so Earth is visible on first render
    try {
      draw(0, performance.now());
    } catch {
      drawFallback();
    }

    if (!reduceMotion) {
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
          className="text-[10px] font-medium tracking-[0.28em] uppercase text-[#e8c77e]/85 transition-opacity duration-500 text-center drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]"
          style={{ opacity: 0 }}
        />
      </div>
    </div>
  );
}
