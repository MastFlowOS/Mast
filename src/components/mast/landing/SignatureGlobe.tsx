import { useEffect, useRef } from "react";
import { WORLD_DOTS, nearestHub, type LatLon } from "./worldDots";

type Phase = "rotate" | "settle" | "focus" | "release";

const DURATIONS: Record<Phase, number> = {
  rotate: 4600,
  settle: 1700,
  focus: 3600,
  release: 1500,
};
const CYCLE_MS = DURATIONS.rotate + DURATIONS.settle + DURATIONS.focus + DURATIONS.release;
const BASE_SPEED = 0.045; // radians / second, freely rotating
const TILT = 0.36; // radians, fixed axial tilt

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface Lit extends LatLon {
  x: number;
  y: number;
  z: number;
  d: number; // distance from view-center, radians-ish
}

export function SignatureGlobe({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
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

    const project = (lat: number, lon: number, scale: number, cx: number, cy: number, r: number) => {
      const phi = (lat * Math.PI) / 180;
      const lambda = (lon * Math.PI) / 180;
      const x = Math.cos(phi) * Math.sin(lambda - rotation);
      const y0 = Math.sin(phi);
      const z0 = Math.cos(phi) * Math.cos(lambda - rotation);
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

    const draw = (dt: number) => {
      if (!reduceMotion) elapsed += dt;
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;

      const cx = width / 2;
      const cy = height / 2;
      const r = Math.min(width, height) * 0.36;

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

      // Angular speed factor: full speed while rotating, ease to a stop, hold, ease back up.
      let speedFactor = 1;
      if (phase === "settle") speedFactor = 1 - easeInOutCubic(p);
      else if (phase === "focus") speedFactor = 0;
      else if (phase === "release") speedFactor = easeInOutCubic(p);
      if (!reduceMotion) rotation += BASE_SPEED * speedFactor * (dt / 1000);

      // Zoom: push in during settle + focus, ease back during release.
      let zoom = 1;
      if (phase === "settle") zoom = 1 + 0.32 * easeInOutCubic(p);
      else if (phase === "focus") zoom = 1.32;
      else if (phase === "release") zoom = 1 + 0.32 * (1 - easeInOutCubic(p));

      // Glow strength for lit cities / connections.
      let glow = 0;
      if (phase === "focus") glow = p < 0.2 ? p / 0.2 : p > 0.85 ? (1 - p) / 0.15 : 1;
      else if (phase === "release") glow = Math.max(0, 1 - easeInOutCubic(p) * 1.4);

      // ---- backdrop sphere shading (glass/metal desk-globe feel) ----
      const sphereR = r * zoom;
      const bg = ctx.createRadialGradient(
        cx - sphereR * 0.35, cy - sphereR * 0.4, sphereR * 0.1,
        cx, cy, sphereR * 1.05,
      );
      bg.addColorStop(0, "rgba(70, 82, 140, 0.35)");
      bg.addColorStop(0.55, "rgba(20, 24, 62, 0.55)");
      bg.addColorStop(1, "rgba(3, 4, 20, 0.05)");
      ctx.beginPath();
      ctx.arc(cx, cy, sphereR, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();

      // meridian ring (the "stand" cue of a desk globe) — behind the dots
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.34);
      ctx.beginPath();
      ctx.arc(0, 0, sphereR * 1.14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(201, 166, 107, 0.22)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();

      // ---- project + draw land dots ----
      const projected: Array<{ sx: number; sy: number; z: number; x: number; y: number; lat: number; lon: number }> = [];
      for (const d of WORLD_DOTS) {
        const pr = project(d.lat, d.lon, zoom, cx, cy, r);
        if (pr.z <= -0.02) continue;
        projected.push({ ...pr, lat: d.lat, lon: d.lon });
      }

      for (const d of projected) {
        const alpha = Math.max(0, Math.min(1, d.z)) * 0.85 + 0.08;
        ctx.beginPath();
        ctx.arc(d.sx, d.sy, 1.15, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(210, 218, 255, ${alpha * 0.55})`;
        ctx.fill();
      }

      // ---- pick "lit" cities near view-center during settle/focus/release ----
      let lit: Lit[] = [];
      let label = "";
      if (phase !== "rotate") {
        const withDist = projected
          .filter((d) => d.z > 0.55)
          .map((d) => ({ ...d, d: Math.hypot(d.x, d.y) }))
          .sort((a, b) => a.d - b.d);
        lit = withDist.slice(0, 6);
        if (lit[0]) {
          const hub = nearestHub(lit[0].lat, lit[0].lon);
          label = hub.name;
        }
      }

      if (lit.length && glow > 0.01) {
        for (const c of lit) {
          const pulse = 2.2 + Math.sin(elapsed / 260 + c.lat) * 0.6;
          ctx.beginPath();
          ctx.arc(c.sx, c.sy, pulse * 2.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(224, 184, 110, ${0.10 * glow})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(c.sx, c.sy, pulse, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(238, 205, 140, ${0.92 * glow})`;
          ctx.fill();
        }

        // A couple of elegant connection arcs between the lit cluster.
        const links = Math.min(3, lit.length - 1);
        for (let i = 0; i < links; i++) {
          const a = lit[i];
          const b = lit[(i + 1) % lit.length];
          const mx = (a.sx + b.sx) / 2;
          const my = (a.sy + b.sy) / 2 - r * 0.16;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.quadraticCurveTo(mx, my, b.sx, b.sy);
          ctx.strokeStyle = `rgba(216, 178, 106, ${0.55 * glow})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // front meridian arc gleam (subtle, sells the "metal ring" cue)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.34);
      ctx.beginPath();
      ctx.arc(0, 0, sphereR * 1.14, Math.PI * 0.08, Math.PI * 0.42);
      ctx.strokeStyle = "rgba(226, 194, 133, 0.35)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();

      if (labelRef.current) {
        labelRef.current.style.opacity = String(label ? glow * 0.9 : 0);
        if (label) labelRef.current.textContent = label;
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
      <div
        ref={labelRef}
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 translate-y-[calc(50%+1.1rem)] text-[10px] font-semibold tracking-[0.25em] uppercase text-[color:var(--landing-gold-bright,#e8c77e)] transition-opacity duration-500"
        style={{ opacity: 0 }}
      />
    </div>
  );
}
