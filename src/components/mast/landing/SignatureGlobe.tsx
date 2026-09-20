import { useEffect, useRef, useState } from "react";
import { WORLD_DOTS } from "./worldDots";
import {
  FOCUS_COUNTRIES,
  DOT_COUNTRY_IDS,
  selectCycleOpportunities,
  type ActiveOpportunity,
} from "./focusCountries";

/**
 * PERF NOTE — per-dot trigonometry is precomputed once, not per frame.
 *
 * WORLD_DOTS is a fixed ~2,880-point dataset; each dot's latitude never
 * changes, so `cos(phi)`, `sin(phi)`, `cos(lambda)` and `sin(lambda)` are
 * frame-invariant and are computed exactly once here, at module load,
 * instead of being recomputed from `d.lat`/`d.lon` on every animation frame
 * (previously ~4 trig calls × 2,880 dots = ~11,500 `Math.cos`/`Math.sin`
 * calls every frame just to re-derive values that never change).
 *
 * The one thing that *does* change every frame is `rotation`. Rather than
 * calling `Math.cos`/`Math.sin` again for every dot's `theta = lambda -
 * rotation`, the per-dot rotated angle is derived algebraically from the
 * angle-difference identities:
 *   cos(lambda - rotation) = cos(lambda)cos(rotation) + sin(lambda)sin(rotation)
 *   sin(lambda - rotation) = sin(lambda)cos(rotation) - cos(lambda)sin(rotation)
 * `cos(rotation)`/`sin(rotation)` are computed exactly once per frame (not
 * per dot), and each dot's rotated position then costs 4 multiplies + 2
 * adds instead of 2 trig calls. This is an exact algebraic identity, not an
 * approximation — the rendered globe is pixel-identical to before, just far
 * cheaper to compute every frame.
 */
const WORLD_DOT_COUNT = WORLD_DOTS.length;
const WORLD_DOT_COS_PHI = new Float32Array(WORLD_DOT_COUNT);
const WORLD_DOT_SIN_PHI = new Float32Array(WORLD_DOT_COUNT); // == y0, rotation-invariant
const WORLD_DOT_COS_LAMBDA = new Float32Array(WORLD_DOT_COUNT);
const WORLD_DOT_SIN_LAMBDA = new Float32Array(WORLD_DOT_COUNT);
for (let i = 0; i < WORLD_DOT_COUNT; i++) {
  const d = WORLD_DOTS[i];
  const phi = (d.lat * Math.PI) / 180;
  const lambda = (d.lon * Math.PI) / 180;
  WORLD_DOT_COS_PHI[i] = Math.cos(phi);
  WORLD_DOT_SIN_PHI[i] = Math.sin(phi);
  WORLD_DOT_COS_LAMBDA[i] = Math.cos(lambda);
  WORLD_DOT_SIN_LAMBDA[i] = Math.sin(lambda);
}

// Fixed Earth axial tilt: 23.44 degrees in radians
const TILT = 0.409;
// Cinematic slow planetary rotation (radians per second) during free spin
const BASE_SPEED = 0.024;
// Visually substantial globe scale within the hero column.
const SPHERE_FRACTION = 0.32;
// Vertical seat of the sphere inside the hero column.
const CENTER_FRACTION = 0.43;
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
  const nameRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

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

    // Imperative CanvasGradient cache — avoids rebuilding gradients on every
    // animation frame when the geometry they depend on hasn't changed.
    // Each entry is invalidated independently based on the exact values used
    // to construct it, so cached gradients remain visually identical to
    // freshly-created ones; nothing here changes appearance.
    type GradientCacheEntry = { key: string; gradient: CanvasGradient };
    let atmoGlowCache: GradientCacheEntry | null = null;
    let oceanBgCache: GradientCacheEntry | null = null;
    let innerRimCache: GradientCacheEntry | null = null;
    let bodyShadeCache: GradientCacheEntry | null = null;
    let sheenCache: GradientCacheEntry | null = null;
    const invalidateGradientCaches = () => {
      atmoGlowCache = null;
      oceanBgCache = null;
      innerRimCache = null;
      bodyShadeCache = null;
      sheenCache = null;
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      width = rect.width || container.clientWidth || 360;
      height = rect.height || container.clientHeight || 360;
      setDimensions({ width, height });
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Canvas dimensions changed — cached gradients are keyed on geometry
      // derived from width/height, but invalidate explicitly to be safe.
      invalidateGradientCaches();
    };
    // `resize()` reads layout (getBoundingClientRect) and reallocates the
    // canvas backing store — real, measurable work, and not needed until we
    // actually draw. It moves into the same deferred idle start as the first
    // draw below, instead of running synchronously during mount.
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let visible = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      { threshold: 0.05 },
    );
    io.observe(container);

    let running = true;
    const onVisChange = () => {
      running = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisChange);

    let rafId = 0;
    let last = performance.now();
    // Initial orientation: angled toward Americas & Atlantic
    let rotation = 0.85;

    // Focus system bookkeeping (14 countries in sequential discovery cycle)
    let targetIdx = -1;
    let phase: Phase = "rotate";
    let phaseElapsed = 0;
    let rotationAtSettleStart = rotation;
    let targetRotation = rotation;

    // Organic discovery tracking: deterministic PRNG per focus cycle
    const countryCycles: number[] = new Array(FOCUS_COUNTRIES.length).fill(0);
    let activeOpportunities: ActiveOpportunity[] = [];
    const sessionSeed = Math.floor(Math.random() * 1000000);

    // Balanced discovery cadence: free spin -> smooth settle -> vivid opportunity hold -> clean release
    let rotateDuration = 4500;
    let focusDuration = 4200;
    const settleDuration = 2200;
    const releaseDuration = 1500;

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
      const cy = height * CENTER_FRACTION;
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
      const oceanBg = ctx.createRadialGradient(
        cx - r * 0.25,
        cy - r * 0.28,
        r * 0.12,
        cx,
        cy,
        r * 1.01,
      );
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

        // Country progression: 14 countries in sequential discovery loop
        if (phase === "rotate" && phaseElapsed >= rotateDuration) {
          phase = "settle";
          phaseElapsed = 0;
          targetIdx = (targetIdx + 1) % FOCUS_COUNTRIES.length;
          countryCycles[targetIdx]++;
          const target = FOCUS_COUNTRIES[targetIdx];
          // Deterministically select 5–15 organic opportunities from candidate pool for this cycle
          activeOpportunities = selectCycleOpportunities(
            target,
            countryCycles[targetIdx],
            sessionSeed,
          );
          rotationAtSettleStart = rotation;
          const targetLambda = (target.lon * Math.PI) / 180;
          const delta =
            (((targetLambda - rotationAtSettleStart) % (Math.PI * 2)) + Math.PI * 2) %
            (Math.PI * 2);
          targetRotation = rotationAtSettleStart + delta;
          const lastDotDelay =
            activeOpportunities.length > 0
              ? activeOpportunities[activeOpportunities.length - 1].delayMs
              : 2000;
          focusDuration = lastDotDelay + 3800;
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
          // Randomize subsequent free-spin duration subtly (10–14s)
          rotateDuration = 10000 + Math.random() * 4000;
        }

        // Rotation updates
        if (phase === "rotate") {
          rotation += BASE_SPEED * (dt / 1000);
        } else if (phase === "settle") {
          const p = Math.min(1, phaseElapsed / settleDuration);
          rotation =
            rotationAtSettleStart + (targetRotation - rotationAtSettleStart) * easeInOutCubic(p);
        } else if (phase === "focus") {
          rotation = targetRotation;
        } else if (phase === "release") {
          const p = Math.min(1, phaseElapsed / releaseDuration);
          rotation = targetRotation + BASE_SPEED * easeInOutCubic(p) * (phaseElapsed / 1000);
        }
      }

      const currentTarget = targetIdx >= 0 ? FOCUS_COUNTRIES[targetIdx] : null;

      // Stable physical globe: ZERO camera zoom/punch-in shifts.
      // Country base light smoothly transitions to gold during focus and back to nocturnal Earth
      let countryBaseGold = 0;

      if (phase === "settle") {
        const p = Math.min(1, phaseElapsed / settleDuration);
        const ep = easeInOutCubic(p);
        countryBaseGold = ep;
      } else if (phase === "focus") {
        countryBaseGold = 1.0;
      } else if (phase === "release") {
        const p = Math.min(1, phaseElapsed / releaseDuration);
        const ep = easeInOutCubic(p);
        countryBaseGold = Math.max(0, 1 - ep);
      }

      const cx = width / 2;
      const cy = height * CENTER_FRACTION;
      const r = Math.min(width, height) * SPHERE_FRACTION;
      // Fixed displayed size: no punch-in, no punch-out, no camera scaling
      const effectiveR = r;
      const effectiveCY = cy;

      // 1. Outer atmospheric limb scattering (Rayleigh haze hugging the outer edge)
      const envLimbBreath = 1 + Math.sin(currentNow * 0.00032) * 0.04;

      // Geometry-only key — shared by the two gradients whose color stops
      // never change (oceanBg, innerRim). During the "rotate" and "focus"
      // phases (the large majority of runtime) cx/effectiveCY/effectiveR are
      // frame-to-frame constant, so those gradients are reused as-is instead
      // of being rebuilt every animation frame.
      const geometryKey = `${cx}|${effectiveCY}|${effectiveR}`;
      // atmoGlow's color stops depend on envLimbBreath, which drifts every
      // frame (a slow continuous sine breathing effect), so it is included
      // in its cache key. This preserves the exact per-frame breathing
      // animation — atmoGlow will still be rebuilt whenever that value
      // actually changes, same as before.
      const atmoGlowKey = `${geometryKey}|${envLimbBreath}`;

      let atmoGlow: CanvasGradient;
      if (atmoGlowCache && atmoGlowCache.key === atmoGlowKey) {
        atmoGlow = atmoGlowCache.gradient;
      } else {
        atmoGlow = ctx.createRadialGradient(
          cx,
          effectiveCY,
          effectiveR * 0.94,
          cx,
          effectiveCY,
          effectiveR * 1.055,
        );
        atmoGlow.addColorStop(0, `rgba(48, 84, 176, ${0.1 * envLimbBreath})`);
        atmoGlow.addColorStop(0.35, `rgba(36, 68, 152, ${0.055 * envLimbBreath})`);
        atmoGlow.addColorStop(0.7, "rgba(26, 50, 124, 0.02)");
        atmoGlow.addColorStop(1, "rgba(15, 23, 42, 0)");
        atmoGlowCache = { key: atmoGlowKey, gradient: atmoGlow };
      }

      ctx.beginPath();
      ctx.arc(cx, effectiveCY, effectiveR * 1.055, 0, Math.PI * 2);
      ctx.fillStyle = atmoGlow;
      ctx.fill();

      // 2. Base planetary ocean body with enhanced 3D curvature visibility
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, effectiveCY, effectiveR, 0, Math.PI * 2);
      ctx.clip();

      let oceanBg: CanvasGradient;
      if (oceanBgCache && oceanBgCache.key === geometryKey) {
        oceanBg = oceanBgCache.gradient;
      } else {
        oceanBg = ctx.createRadialGradient(
          cx - effectiveR * 0.25,
          effectiveCY - effectiveR * 0.28,
          effectiveR * 0.12,
          cx,
          effectiveCY,
          effectiveR * 1.01,
        );
        oceanBg.addColorStop(0, "rgba(13, 32, 72, 0.98)");
        oceanBg.addColorStop(0.3, "rgba(8, 21, 52, 0.98)");
        oceanBg.addColorStop(0.62, "rgba(5, 13, 34, 0.99)");
        oceanBg.addColorStop(0.86, "rgba(3, 8, 22, 1)");
        oceanBg.addColorStop(1, "rgba(2, 5, 15, 1)");
        oceanBgCache = { key: geometryKey, gradient: oceanBg };
      }

      ctx.fillStyle = oceanBg;
      ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);

      // Complete 360-degree spherical horizon definition ring
      let innerRim: CanvasGradient;
      if (innerRimCache && innerRimCache.key === geometryKey) {
        innerRim = innerRimCache.gradient;
      } else {
        innerRim = ctx.createRadialGradient(
          cx,
          effectiveCY,
          effectiveR * 0.86,
          cx,
          effectiveCY,
          effectiveR,
        );
        innerRim.addColorStop(0, "rgba(0, 0, 0, 0)");
        innerRim.addColorStop(0.72, "rgba(30, 58, 128, 0.07)");
        innerRim.addColorStop(1, "rgba(58, 96, 182, 0.17)");
        innerRimCache = { key: geometryKey, gradient: innerRim };
      }
      ctx.fillStyle = innerRim;
      ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);

      const cosTilt = Math.cos(TILT);
      const sinTilt = Math.sin(TILT);

      // 3. Continental land dots: fine, nocturnal Earth dots
      // When a country is focused, its dots become visibly light gold (#c9a66b),
      // allowing the sovereign country silhouette to emerge authentically from the dotted Earth!
      const dotCount = WORLD_DOT_COUNT;

      // Rotation's cos/sin computed ONCE per frame (not once per dot — see the
      // perf note above the module-level trig caches at the top of this file).
      const cosR = Math.cos(rotation);
      const sinR = Math.sin(rotation);

      for (let i = 0; i < dotCount; i++) {
        // 3D Unit sphere coordinates — cosPhi/sinPhi/cosLambda/sinLambda are
        // precomputed (lat/lon never change); only cosTheta/sinTheta depend on
        // the current rotation, and are derived algebraically instead of via
        // fresh Math.cos/Math.sin calls per dot.
        const cosPhi = WORLD_DOT_COS_PHI[i];
        const cosLambda = WORLD_DOT_COS_LAMBDA[i];
        const sinLambda = WORLD_DOT_SIN_LAMBDA[i];
        const cosTheta = cosLambda * cosR + sinLambda * sinR;
        const sinTheta = sinLambda * cosR - cosLambda * sinR;

        const x0 = cosPhi * sinTheta;
        const y0 = WORLD_DOT_SIN_PHI[i];
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
        const luminosity = (0.24 + sunFactor * 0.48) * (0.76 + 0.24 * zDepth);
        const dotRadius = Math.max(0.7, 0.82 + 0.28 * zDepth);

        // Base nocturnal palette: pale silvery-blue in light, deep nocturnal slate in shadow
        const rVal = Math.round(135 + sunFactor * 75);
        const gVal = Math.round(165 + sunFactor * 65);
        const bVal = Math.round(215 + sunFactor * 40);

        // Check if dot belongs to the active focus country
        const isTargetCountry = currentTarget && targetIdx >= 0 && DOT_COUNTRY_IDS[i] === targetIdx;

        if (isTargetCountry && countryBaseGold > 0.001) {
          const tGold = countryBaseGold; // 1.0 (peak focus) -> 0.0 (end of release)

          // Continuous color interpolation from normal nocturnal Earth directly to full MAST gold #c9a66b:
          // releaseProgress = 0 (tGold = 1.0) -> full MAST gold #c9a66b (201, 166, 107)
          // releaseProgress = 0.5 (tGold = 0.5) -> soft desaturated pale gold / blue-gold midpoint
          // releaseProgress = 1.0 (tGold = 0.0) -> exact normal nocturnal Earth land color (rVal, gVal, bVal)
          const goldR = Math.round(rVal * (1 - tGold) + 201 * tGold);
          const goldG = Math.round(gVal * (1 - tGold) + 166 * tGold);
          const goldB = Math.round(bVal * (1 - tGold) + 107 * tGold);

          // Continuous luminance interpolation: NEVER dims to 0 or becomes transparent!
          // Country always maintains normal geographic visibility, smoothly transitioning between gold and nocturnal Earth
          const isSmallCountry = ["EGY", "FRA", "DEU", "JPN", "NZL"].includes(currentTarget.iso);
          const targetCountryLum = (isSmallCountry ? 0.6 : 0.52) + 0.1 * zDepth;
          const dotLum = luminosity * (1 - tGold) + targetCountryLum * tGold;

          // Continuous radius interpolation
          const targetCountryDotR = isSmallCountry
            ? Math.max(1.05, dotRadius * 1.3)
            : Math.max(0.85, dotRadius * 1.15);
          const curDotR = dotRadius * (1 - tGold) + targetCountryDotR * tGold;

          ctx.beginPath();
          ctx.arc(sx, sy, curDotR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${goldR}, ${goldG}, ${goldB}, ${dotLum})`;
          ctx.fill();
        } else {
          // Normal nocturnal continent point outside the focus country
          // Quietened slightly during active country focus; returns smoothly to full brightness as countryBaseGold drops to 0
          const nonTargetDim = 1 - 0.22 * countryBaseGold;
          const quietLum = luminosity * nonTargetDim;

          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, ${quietLum})`;
          ctx.fill();
        }
      }

      // 4. Sequential Opportunity Dots (The Main Focus: One-by-One Lead Discovery)
      // Level 3 in visual hierarchy: Unmistakably bright MAST gold, crisp core, visible halo & atmospheric bloom
      if (
        currentTarget &&
        activeOpportunities.length > 0 &&
        (phase === "focus" || phase === "release")
      ) {
        const opps = activeOpportunities;
        const oppCount = opps.length;

        // Screen-space responsive sizing with strict minimum clamps:
        // Ensures opportunity dots never shrink to invisibility on small countries or high DPR
        const scaleRef = Math.max(0.85, Math.min(1.3, effectiveR / 290));
        const baseCoreR = Math.max(2.4, Math.min(3.0, 2.65 * scaleRef));
        const baseHaloR = Math.max(5.5, Math.min(7.2, 6.2 * scaleRef));
        const baseBloomR = Math.max(9.5, Math.min(13.0, 11.2 * scaleRef));

        for (let k = 0; k < oppCount; k++) {
          const opp = opps[k];
          let alpha = 0;
          let scale = 0.45;
          let flashAmount = 0;

          if (phase === "focus") {
            const age = phaseElapsed - opp.delayMs;
            if (age >= 0) {
              // Smooth cubic ease-out entrance (~420ms)
              const enterProgress = Math.min(1, age / 420);
              const enterEase = 1 - Math.pow(1 - enterProgress, 3);
              scale = 0.45 + 0.55 * enterEase;
              alpha = enterEase;

              // Brief optical discovery flash (~220ms): subtle brightness bump & bloom expansion ("FOUND.")
              if (age < 220) {
                const fp = age / 220;
                flashAmount = Math.sin(fp * Math.PI);
              }
            }
          } else if (phase === "release") {
            // Opportunity dots fade out cleanly over the first ~1100ms of release
            const oppFadeDuration = Math.min(releaseDuration, 1100);
            const rp = Math.min(1, phaseElapsed / oppFadeDuration);
            alpha = Math.max(0, 1 - easeInOutCubic(rp));
            scale = 1.0;
            flashAmount = 0;
          }

          if (alpha <= 0.01) continue;

          // 3D sphere projection for opportunity point
          const oppPhi = (opp.lat * Math.PI) / 180;
          const oppLambda = (opp.lon * Math.PI) / 180;
          const oppTheta = oppLambda - rotation;
          const ox0 = Math.cos(oppPhi) * Math.sin(oppTheta);
          const oy0 = Math.sin(oppPhi);
          const oz0 = Math.cos(oppPhi) * Math.cos(oppTheta);

          const ox = ox0;
          const oy = oy0 * cosTilt - oz0 * sinTilt;
          const oz = oy0 * sinTilt + oz0 * cosTilt;

          // Strictly front hemisphere
          if (oz <= 0.01) continue;

          const osx = cx + ox * effectiveR;
          const osy = effectiveCY - oy * effectiveR;

          const curBloomR = baseBloomR * scale * (1 + 0.28 * flashAmount);
          const curHaloR = baseHaloR * scale * (1 + 0.16 * flashAmount);
          const curCoreR = baseCoreR * scale * (1 + 0.18 * flashAmount);

          // Layer 1: Atmospheric Warm Bloom #b58d45 (rgb: 181, 141, 69)
          ctx.beginPath();
          ctx.arc(osx, osy, curBloomR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(181, 141, 69, ${(0.22 + 0.12 * flashAmount) * alpha})`;
          ctx.fill();

          // Layer 2: Outer Soft Gold Halo #c9a66b (rgb: 201, 166, 107)
          ctx.beginPath();
          ctx.arc(osx, osy, curHaloR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(201, 166, 107, ${(0.45 + 0.15 * flashAmount) * alpha})`;
          ctx.fill();

          // Layer 3: Secondary Bright Gold Mid-Halo #e8c77e (rgb: 232, 199, 126)
          ctx.beginPath();
          ctx.arc(osx, osy, curHaloR * 0.62, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(232, 199, 126, ${(0.72 + 0.18 * flashAmount) * alpha})`;
          ctx.fill();

          // Layer 4: Primary Crisp Core #f3d27a (rgb: 243, 210, 122) — Visibly brighter than every land dot
          ctx.beginPath();
          ctx.arc(osx, osy, curCoreR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(243, 210, 122, ${0.98 * alpha})`;
          ctx.fill();

          // Layer 5: Discovery Flash Pinpoint (brief ~220ms optical gleam)
          if (flashAmount > 0.04) {
            ctx.beginPath();
            ctx.arc(osx, osy, curCoreR * 0.65, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 250, 235, ${0.85 * flashAmount * alpha})`;
            ctx.fill();
          }
        }
      }

      // 5. Physical light response, applied over the dotted surface so the map
      //    reads as printed ON the sphere rather than pasted in front of it.
      //    Lighting matches the cradle: key from the upper left, warm bronze
      //    bounce from the meridian band on the right.
      const shadeKey = `${geometryKey}|shade`;
      let bodyShade: CanvasGradient;
      if (bodyShadeCache && bodyShadeCache.key === shadeKey) {
        bodyShade = bodyShadeCache.gradient;
      } else {
        bodyShade = ctx.createRadialGradient(
          cx - effectiveR * 0.42,
          effectiveCY - effectiveR * 0.46,
          effectiveR * 0.1,
          cx - effectiveR * 0.18,
          effectiveCY - effectiveR * 0.16,
          effectiveR * 1.5,
        );
        bodyShade.addColorStop(0, "rgba(120, 168, 255, 0.07)");
        bodyShade.addColorStop(0.34, "rgba(10, 24, 58, 0)");
        bodyShade.addColorStop(0.72, "rgba(2, 5, 14, 0.3)");
        bodyShade.addColorStop(1, "rgba(1, 3, 9, 0.6)");
        bodyShadeCache = { key: shadeKey, gradient: bodyShade };
      }
      ctx.fillStyle = bodyShade;
      ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);

      // Restrained glass specular on the key side — a sheen, not a hotspot
      let sheen: CanvasGradient;
      if (sheenCache && sheenCache.key === shadeKey) {
        sheen = sheenCache.gradient;
      } else {
        sheen = ctx.createRadialGradient(
          cx - effectiveR * 0.46,
          effectiveCY - effectiveR * 0.5,
          0,
          cx - effectiveR * 0.46,
          effectiveCY - effectiveR * 0.5,
          effectiveR * 0.62,
        );
        sheen.addColorStop(0, "rgba(150, 192, 255, 0.09)");
        sheen.addColorStop(0.45, "rgba(96, 146, 226, 0.035)");
        sheen.addColorStop(1, "rgba(60, 100, 180, 0)");
        sheenCache = { key: shadeKey, gradient: sheen };
      }
      ctx.fillStyle = sheen;
      ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);

      ctx.restore();

      // Editorial country name + opportunity count confirmation
      if (currentTarget && nameRef.current && countRef.current) {
        const opps = activeOpportunities;
        const lastDotDelay = opps && opps.length > 0 ? opps[opps.length - 1].delayMs : 2000;
        const countRevealTime = lastDotDelay + 380;

        if (phase === "settle") {
          // Country name gently fades and slides in
          const np = Math.min(1, phaseElapsed / 650);
          const ne = easeInOutCubic(np);
          nameRef.current.style.opacity = String(ne);
          nameRef.current.style.transform = `translateY(${(6 * (1 - ne)).toFixed(1)}px)`;
          nameRef.current.textContent = currentTarget.name;
          countRef.current.style.opacity = "0";
          countRef.current.style.transform = "translateY(4px)";
        } else if (phase === "focus") {
          nameRef.current.style.opacity = "1";
          nameRef.current.style.transform = "translateY(0px)";
          nameRef.current.textContent = currentTarget.name;

          if (phaseElapsed < countRevealTime) {
            countRef.current.style.opacity = "0";
            countRef.current.style.transform = "translateY(4px)";
          } else {
            // Count smoothly slides in after the final dot appears
            const cp = Math.min(1, (phaseElapsed - countRevealTime) / 500);
            const ce = easeInOutCubic(cp);
            countRef.current.style.opacity = String(ce);
            countRef.current.style.transform = `translateY(${(4 * (1 - ce)).toFixed(1)}px)`;
            countRef.current.textContent = `${opps.length} OPPORTUNITIES FOUND`;
          }
        } else if (phase === "release") {
          const rp = Math.min(1, phaseElapsed / releaseDuration);
          const fe = 1 - easeInOutCubic(rp);
          nameRef.current.style.opacity = String(fe);
          countRef.current.style.opacity = String(fe);
        } else {
          nameRef.current.style.opacity = "0";
          countRef.current.style.opacity = "0";
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

    // The globe's first draw + continuous rotation are decorative — deferred
    // to the browser's idle time so they run AFTER the hero has had its
    // chance to paint, not synchronously during mount. A modest timeout still
    // guarantees the globe appears soon even under sustained main-thread load.
    // (requestIdleCallback isn't in every engine — Safari falls back to a
    // short setTimeout that still yields to paint first.)
    let deferredStartHandle: number | null = null;
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const scheduleStart =
      typeof w.requestIdleCallback === "function"
        ? (cb: () => void) => w.requestIdleCallback!(cb, { timeout: 200 })
        : (cb: () => void) => window.setTimeout(cb, 32);
    const cancelStart = (id: number) => {
      if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };

    deferredStartHandle = scheduleStart(() => {
      deferredStartHandle = null;
      // Immediate initial frame so Earth is visible as soon as it starts
      performance.mark("signature-globe-init-start");
      resize(); // sizes the canvas just before its first real draw
      try {
        draw(0, performance.now());
      } catch {
        drawFallback();
      }
      performance.mark("signature-globe-init-end");
      try {
        performance.measure(
          "signature-globe-init",
          "signature-globe-init-start",
          "signature-globe-init-end",
        );
      } catch {
        // performance.measure can throw if marks are missing (e.g. a fast
        // remount raced the marks) — timing is best-effort, not required.
      }

      if (!reduceMotion) {
        rafId = requestAnimationFrame(loop);
      }
    });

    return () => {
      if (deferredStartHandle != null) cancelStart(deferredStartHandle);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  const cx = dimensions.width / 2;
  const cy = dimensions.height * CENTER_FRACTION;
  const r = Math.min(dimensions.width, dimensions.height) * SPHERE_FRACTION;

  return (
    <div ref={containerRef} className={`relative select-none pointer-events-none ${className}`}>
      {/* 1. Digital globe canvas inside 10.5° axial tilt compositing wrapper */}
      <div
        className="w-full h-full relative"
        style={{
          transform: "rotate(10.5deg)",
          transformOrigin: `${cx}px ${cy}px`,
        }}
      >
        <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />
      </div>

      {/* 2. Editorial Country Discovery Indicator: Country Name + Opportunity Count (level and horizontal) */}
      <div className="pointer-events-none absolute left-1/2 bottom-0 -translate-x-1/2 flex flex-col items-center z-30">
        <div
          ref={labelRef}
          className="flex flex-col items-center gap-1 pointer-events-none text-center"
        >
          <div
            ref={nameRef}
            className="text-[11px] font-semibold tracking-[0.28em] uppercase text-[#e8c77e] drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)] transition-all duration-300 ease-out"
            style={{ opacity: 0, transform: "translateY(6px)" }}
          />
          <div
            ref={countRef}
            className="text-[9px] font-medium tracking-[0.22em] uppercase text-foreground/90 font-mono drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] transition-all duration-300 ease-out"
            style={{ opacity: 0, transform: "translateY(4px)" }}
          />
        </div>
      </div>
    </div>
  );
}
