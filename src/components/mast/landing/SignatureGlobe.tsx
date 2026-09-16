import { useEffect, useRef } from "react";
import { WORLD_DOTS } from "./worldDots";
import { FOCUS_COUNTRIES, DOT_COUNTRY_IDS } from "./focusCountries";

// Fixed Earth axial tilt: 23.44 degrees in radians
const TILT = 0.409;
// Cinematic slow planetary rotation (radians per second) during free spin
const BASE_SPEED = 0.024;
// Visually substantial globe scale within the hero column
const SPHERE_FRACTION = 0.44;
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
    // Initial orientation: angled toward Americas & Atlantic
    let rotation = 0.85;

    // Focus system bookkeeping (14 countries in sequential discovery cycle)
    let targetIdx = -1;
    let phase: Phase = "rotate";
    let phaseElapsed = 0;
    let rotationAtSettleStart = rotation;
    let targetRotation = rotation;

    // Balanced discovery cadence: free spin -> smooth settle -> vivid opportunity hold -> clean release
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

        // Country progression: 14 countries in sequential discovery loop
        if (phase === "rotate" && phaseElapsed >= rotateDuration) {
          phase = "settle";
          phaseElapsed = 0;
          targetIdx = (targetIdx + 1) % FOCUS_COUNTRIES.length;
          rotationAtSettleStart = rotation;
          const target = FOCUS_COUNTRIES[targetIdx];
          const targetLambda = (target.lon * Math.PI) / 180;
          const delta = (((targetLambda - rotationAtSettleStart) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          targetRotation = rotationAtSettleStart + delta;
          const opps = target.opportunityPoints;
          const lastDotDelay = opps && opps.length > 0 ? opps[opps.length - 1].delayMs : 2000;
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
          rotation = rotationAtSettleStart + (targetRotation - rotationAtSettleStart) * easeInOutCubic(p);
        } else if (phase === "focus") {
          rotation = targetRotation;
        } else if (phase === "release") {
          const p = Math.min(1, phaseElapsed / releaseDuration);
          rotation = targetRotation + BASE_SPEED * easeInOutCubic(p) * (phaseElapsed / 1000);
        }
      }

      const currentTarget = targetIdx >= 0 ? FOCUS_COUNTRIES[targetIdx] : null;
      const targetZoom = currentTarget ? currentTarget.zoom : 1.08;

      // Country base light and smooth zoom interpolation
      let zoom = 1.0;
      let countryBaseGold = 0;

      if (phase === "settle") {
        const p = Math.min(1, phaseElapsed / settleDuration);
        const ep = easeInOutCubic(p);
        zoom = 1.0 + (targetZoom - 1.0) * ep;
        // Country base light gently shifts from cool blue -> soft light gold (0% -> 70%)
        countryBaseGold = ep * 0.70;
      } else if (phase === "focus") {
        zoom = targetZoom;
        countryBaseGold = 0.70 + 0.30 * Math.min(1, phaseElapsed / 800);
      } else if (phase === "release") {
        const p = Math.min(1, phaseElapsed / releaseDuration);
        const ep = easeInOutCubic(p);
        zoom = 1.0 + (targetZoom - 1.0) * (1 - ep);
        countryBaseGold = Math.max(0, 0.70 * (1 - ep));
      }

      const targetUY = currentTarget ? unitY(currentTarget.lat, currentTarget.lon, rotation) : 0;
      const panProgress = (zoom - 1.0) / (targetZoom - 1.0 || 1);

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

      // Subtle atmospheric search aura cradling the country landmass
      if (countryBaseGold > 0.01 && currentTarget) {
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
          const countryRad = effectiveR * 0.35;
          const countryBloom = ctx.createRadialGradient(tsx, tsy, 0, tsx, tsy, countryRad);
          countryBloom.addColorStop(0, `rgba(201, 166, 107, ${0.06 * countryBaseGold * Math.min(1, tz * 1.2)})`);
          countryBloom.addColorStop(0.6, `rgba(181, 141, 69, ${0.02 * countryBaseGold * Math.min(1, tz * 1.2)})`);
          countryBloom.addColorStop(1, "rgba(181, 141, 69, 0)");
          ctx.fillStyle = countryBloom;
          ctx.beginPath();
          ctx.arc(tsx, tsy, countryRad, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 3. Continental land dots: fine, nocturnal Earth dots
      // Country under search receives subtle light gold (#c9a66b) at restrained luminance
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

        // Check if dot belongs to the active focus country
        const isTargetCountry = currentTarget && targetIdx >= 0 && DOT_COUNTRY_IDS[i] === targetIdx;

        if (isTargetCountry && countryBaseGold > 0.01) {
          // Subtle light gold #c9a66b (rgb: 201, 166, 107) at restrained luminance
          // Keeps existing fine Earth dots — NOT a solid gold map or dense field
          const goldR = Math.round(rVal + (201 - rVal) * countryBaseGold * 0.70);
          const goldG = Math.round(gVal + (166 - gVal) * countryBaseGold * 0.70);
          const goldB = Math.round(bVal + (107 - bVal) * countryBaseGold * 0.70);
          // Slightly restrain base luminance during discovery so bright opportunity dots pop unmistakably
          const maxBaseLum = phase === "focus" ? 0.38 : 0.44;
          const goldLum = Math.min(maxBaseLum, luminosity * (0.88 + 0.12 * countryBaseGold));

          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${goldR}, ${goldG}, ${goldB}, ${goldLum})`;
          ctx.fill();
        } else {
          // Normal nocturnal continent point outside the focus country
          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${rVal}, ${gVal}, ${bVal}, ${luminosity})`;
          ctx.fill();
        }
      }

      // 4. Sequential Opportunity Dots (The Main Focus: One-by-One Lead Discovery)
      // Level 3 in visual hierarchy: Unmistakably bright MAST gold, crisp core, visible halo & atmospheric bloom
      if (currentTarget && currentTarget.opportunityPoints && (phase === "focus" || phase === "release")) {
        const opps = currentTarget.opportunityPoints;
        const oppCount = opps.length;

        // Screen-space responsive sizing with strict minimum clamps:
        // Ensures opportunity dots never shrink to invisibility on small countries or high DPR
        const scaleRef = Math.max(0.85, Math.min(1.30, effectiveR / 290));
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
            const rp = Math.min(1, phaseElapsed / releaseDuration);
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

      ctx.restore();

      // Editorial country name + opportunity count confirmation
      if (currentTarget && nameRef.current && countRef.current) {
        const opps = currentTarget.opportunityPoints;
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
            countRef.current.textContent = `${currentTarget.opportunityPoints.length} OPPORTUNITIES FOUND`;
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
      {/* Editorial Country Discovery Indicator: Country Name + Opportunity Count */}
      <div className="pointer-events-none absolute left-1/2 bottom-2 -translate-x-1/2 flex flex-col items-center">
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
