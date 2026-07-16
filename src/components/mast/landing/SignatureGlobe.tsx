import { useEffect, useRef } from "react";
import { WORLD_DOTS, TARGET_COUNTRIES } from "./worldDots";

type Phase = "rotate" | "settle" | "focus" | "release";

const DURATIONS: Record<Phase, number> = {
  rotate: 3400,
  settle: 1800,
  focus: 4200,
  release: 1600,
};
const CYCLE_MS = DURATIONS.rotate + DURATIONS.settle + DURATIONS.focus + DURATIONS.release;
const BASE_SPEED = 0.045; // radians / second, freely rotating — very slow
const TILT = 0.36; // radians, fixed axial tilt
const SPHERE_FRACTION = 0.42; // bigger, more visible base globe
const ZOOM_MAX = 1.2; // subtle — the globe itself barely grows
const PAN_STRENGTH = 0.92; // camera push toward the target country's latitude

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutBack(t: number) {
  const c1 = 1.5;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
// Deterministic 0..1 pseudo-random from an index, so dot pop-in order is
// stable across renders instead of reshuffling every mount.
function hash01(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function SignatureGlobe({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const subLabelRef = useRef<HTMLDivElement>(null);
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
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.05 });
    io.observe(container);

    let running = true;
    const onVisChange = () => { running = !document.hidden; };
    document.addEventListener("visibilitychange", onVisChange);

    let rafId = 0;
    let last = performance.now();
    let elapsed = 0;
    let rotation = 0.6;

    // Which country we're rotating toward, and the rotation bookkeeping
    // used to land exactly on it during the "settle" phase.
    const order = TARGET_COUNTRIES;
    let countryIdx = -1;
    let prevPhase: Phase | null = null;
    let rotationAtSettleStart = rotation;
    let targetRotation = rotation;

    // The country's own sparse 7–8 "opportunity" points double as the
    // nodes for the gold connection lines drawn between them.
    let connectionNodes: { lat: number; lon: number }[] = [];

    const project = (lat: number, lon: number, scale: number, cx: number, cy: number, r: number, rot: number) => {
      const phi = (lat * Math.PI) / 180;
      const lambda = (lon * Math.PI) / 180;
      const x = Math.cos(phi) * Math.sin(lambda - rot);
      const y0 = Math.sin(phi);
      const z0 = Math.cos(phi) * Math.cos(lambda - rot);
      const y = y0 * Math.cos(TILT) - z0 * Math.sin(TILT);
      const z = y0 * Math.sin(TILT) + z0 * Math.cos(TILT);
      return {
        sx: cx + x * r * scale,
        sy: cy - y * r * scale,
        z,
        x,
        y,
      };
    };

    // Unit-sphere "y" (before cx/cy/r scaling) — used to pan the camera
    // vertically toward a country's latitude instead of inflating the
    // whole sphere in place.
    const unitY = (lat: number, lon: number, rot: number) => {
      const phi = (lat * Math.PI) / 180;
      const lambda = (lon * Math.PI) / 180;
      const y0 = Math.sin(phi);
      const z0 = Math.cos(phi) * Math.cos(lambda - rot);
      return y0 * Math.cos(TILT) - z0 * Math.sin(TILT);
    };

    const draw = (dt: number) => {
      if (!reduceMotion) elapsed += dt;
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;

      const cx = width / 2;
      const cy = height / 2;
      const r = Math.min(width, height) * SPHERE_FRACTION;

      const t = reduceMotion ? 0 : elapsed % CYCLE_MS;
      let phase: Phase = "rotate";
      let p = 0;
      if (t < DURATIONS.rotate) {
        phase = "rotate"; p = t / DURATIONS.rotate;
      } else if (t < DURATIONS.rotate + DURATIONS.settle) {
        phase = "settle"; p = (t - DURATIONS.rotate) / DURATIONS.settle;
      } else if (t < DURATIONS.rotate + DURATIONS.settle + DURATIONS.focus) {
        phase = "focus"; p = (t - DURATIONS.rotate - DURATIONS.settle) / DURATIONS.focus;
      } else {
        phase = "release"; p = (t - DURATIONS.rotate - DURATIONS.settle - DURATIONS.focus) / DURATIONS.release;
      }

      // Phase transitions: pick the next country as we enter "rotate", and
      // lock in the exact rotation angle that centers it as we enter "settle".
      if (phase !== prevPhase) {
        if (phase === "rotate") {
          countryIdx = (countryIdx + 1) % order.length;
          connectionNodes = order[countryIdx]?.dots ?? [];
        }
        if (phase === "settle") {
          rotationAtSettleStart = rotation;
          const country = order[countryIdx] ?? order[0];
          const targetLambda = (country.lon * Math.PI) / 180;
          const delta = (((targetLambda - rotationAtSettleStart) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          targetRotation = rotationAtSettleStart + delta;
        }
        prevPhase = phase;
      }

      const country = order[countryIdx] ?? order[0];

      // Rotation: free-spin while rotating; precisely interpolate onto the
      // target country during settle; hold while focused; spin away on release.
      if (!reduceMotion) {
        if (phase === "rotate") {
          rotation += BASE_SPEED * (dt / 1000);
        } else if (phase === "settle") {
          rotation = rotationAtSettleStart + (targetRotation - rotationAtSettleStart) * easeInOutCubic(p);
        } else if (phase === "focus") {
          rotation = targetRotation;
        } else if (phase === "release") {
          rotation = targetRotation;
          rotation += BASE_SPEED * easeInOutCubic(p) * (dt / 1000);
        }
      }

      // Zoom: the globe itself only grows a little (ZOOM_MAX ~1.2) — the
      // "zoom in on a country" feeling instead comes from panning the
      // camera toward that country's latitude (see panDelta below).
      let zoom = 1;
      if (phase === "settle") zoom = 1 + (ZOOM_MAX - 1) * easeInOutCubic(p);
      else if (phase === "focus") zoom = ZOOM_MAX;
      else if (phase === "release") zoom = 1 + (ZOOM_MAX - 1) * (1 - easeInOutCubic(p));

      const panProgress = ZOOM_MAX > 1 ? Math.max(0, Math.min(1, (zoom - 1) / (ZOOM_MAX - 1))) : 0;
      const targetUnitY = country ? unitY(country.lat, country.lon, rotation) : 0;
      const panDelta = targetUnitY * r * zoom * panProgress * PAN_STRENGTH;
      const ecy = cy + panDelta; // effective vertical center used by every projection below

      // Glow / reveal strength for the country's opportunity dots + label.
      let glow = 0;
      if (phase === "settle") glow = Math.max(0, p - 0.55) / 0.45;
      else if (phase === "focus") glow = p < 0.1 ? p / 0.1 : p > 0.88 ? (1 - p) / 0.12 : 1;
      else if (phase === "release") glow = Math.max(0, 1 - easeInOutCubic(p) * 1.5);

      // ---- backdrop sphere shading — kept subtle/matte, not a glowing orb ----
      const sphereR = r * zoom;
      const bg = ctx.createRadialGradient(
        cx - sphereR * 0.35, ecy - sphereR * 0.4, sphereR * 0.1,
        cx, ecy, sphereR * 1.05,
      );
      bg.addColorStop(0, "rgba(58, 68, 116, 0.22)");
      bg.addColorStop(0.55, "rgba(16, 19, 48, 0.40)");
      bg.addColorStop(1, "rgba(3, 4, 20, 0.04)");
      ctx.beginPath();
      ctx.arc(cx, ecy, sphereR, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();

      // meridian ring (the "stand" cue of a desk globe) — behind the dots
      ctx.save();
      ctx.translate(cx, ecy);
      ctx.scale(1, 0.34);
      ctx.beginPath();
      ctx.arc(0, 0, sphereR * 1.14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(201, 166, 107, 0.16)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

      // ---- project + draw base land dots (quiet, unlit) ----
      for (const d of WORLD_DOTS) {
        const pr = project(d.lat, d.lon, zoom, cx, ecy, r, rotation);
        if (pr.z <= -0.02) continue;
        const alpha = Math.max(0, Math.min(1, pr.z)) * 0.65 + 0.05;
        ctx.beginPath();
        ctx.arc(pr.sx, pr.sy, 1.05, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(196, 204, 240, ${alpha * 0.4})`;
        ctx.fill();
      }

      // ---- gold outline of the target country — same hue as its
      // opportunity dots, traced in as we settle/focus on it ----
      if (glow > 0.03 && country?.outline?.length) {
        ctx.beginPath();
        let started = false;
        for (const v of country.outline) {
          const pr = project(v.lat, v.lon, zoom, cx, ecy, r, rotation);
          if (pr.z <= 0.02) { started = false; continue; }
          if (!started) { ctx.moveTo(pr.sx, pr.sy); started = true; }
          else ctx.lineTo(pr.sx, pr.sy);
        }
        ctx.strokeStyle = `rgba(238, 205, 140, ${glow * 0.85})`;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = "round";
        ctx.stroke();
      }

      // ---- the "discovery" moment: 7–8 gold opportunity dots blooming
      // across the target country as we settle into it ----
      if (glow > 0.005 && country) {
        const dots = country.dots;
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          const pr = project(d.lat, d.lon, zoom, cx, ecy, r, rotation);
          if (pr.z <= 0.05) continue;

          const dotDelay = (hash01(i + 1) * 0.55);
          const popRaw = phase === "release"
            ? 1
            : Math.max(0, Math.min(1, (p - dotDelay) / 0.35));
          if (popRaw <= 0) continue;
          const pop = easeOutBack(popRaw);
          const localAlpha = glow * Math.max(0, Math.min(1, popRaw * 1.4));
          if (localAlpha <= 0.01) continue;

          const rad = Math.max(0.15, 2.6 * pop);
          ctx.beginPath();
          ctx.arc(pr.sx, pr.sy, rad * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(224, 184, 110, ${0.1 * localAlpha})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(pr.sx, pr.sy, rad, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(238, 205, 140, ${0.95 * localAlpha})`;
          ctx.fill();
        }
      }

      // ---- subtle gold connection lines between opportunity nodes ----
      if (glow > 0.08 && connectionNodes.length > 1) {
        const pts = connectionNodes
          .map((d) => project(d.lat, d.lon, zoom, cx, ecy, r, rotation))
          .filter((pr) => pr.z > 0.05);
        const lineAlpha = glow * 0.4;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          if (!a || !b) continue;
          const mx = (a.sx + b.sx) / 2;
          const my = (a.sy + b.sy) / 2 - 14; // gentle arc lift
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.quadraticCurveTo(mx, my, b.sx, b.sy);
          ctx.strokeStyle = `rgba(232, 199, 126, ${lineAlpha})`;
          ctx.lineWidth = 0.9;
          ctx.stroke();

          // a small pulse of light traveling along the arc
          const travel = ((elapsed % 2200) / 2200 + i * 0.17) % 1;
          const tt = travel;
          const px = (1 - tt) * (1 - tt) * a.sx + 2 * (1 - tt) * tt * mx + tt * tt * b.sx;
          const py = (1 - tt) * (1 - tt) * a.sy + 2 * (1 - tt) * tt * my + tt * tt * b.sy;
          ctx.beginPath();
          ctx.arc(px, py, 1.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(246, 222, 170, ${lineAlpha * 1.8})`;
          ctx.fill();
        }
      }

      // front meridian arc gleam (subtle, sells the "metal ring" cue)
      ctx.save();
      ctx.translate(cx, ecy);
      ctx.scale(1, 0.34);
      ctx.beginPath();
      ctx.arc(0, 0, sphereR * 1.14, Math.PI * 0.08, Math.PI * 0.42);
      ctx.strokeStyle = "rgba(226, 194, 133, 0.22)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.restore();

      if (labelRef.current && subLabelRef.current) {
        const showLabel = phase === "focus" || (phase === "settle" && p > 0.7) || (phase === "release" && glow > 0.15);
        const labelOpacity = showLabel ? Math.max(glow, phase === "settle" ? (p - 0.7) / 0.3 : 0) : 0;
        labelRef.current.style.opacity = String(Math.max(0, Math.min(1, labelOpacity)) * 0.95);
        labelRef.current.textContent = country ? country.name : "";
        subLabelRef.current.style.opacity = String(Math.max(0, Math.min(1, labelOpacity)) * 0.7);
        subLabelRef.current.textContent = country ? `${country.dots.length} opportunities found` : "";
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
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 translate-y-[calc(50%+0.9rem)] flex flex-col items-center gap-1">
        <div
          ref={labelRef}
          className="text-[11px] font-bold tracking-[0.28em] uppercase text-[color:var(--landing-gold-bright,#e8c77e)] transition-opacity duration-300"
          style={{ opacity: 0 }}
        />
        <div
          ref={subLabelRef}
          className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground transition-opacity duration-300"
          style={{ opacity: 0 }}
        />
      </div>
    </div>
  );
}
