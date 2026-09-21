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
 * WORLD_DOTS is a fixed ~5,500-point dataset; each dot's latitude never
 * changes, so `cos(phi)`, `sin(phi)`, `cos(lambda)` and `sin(lambda)` are
 * frame-invariant and are computed exactly once here, at module load,
 * instead of being recomputed from `d.lat`/`d.lon` on every animation frame
 * (previously ~4 trig calls × 5,500 dots = ~22,000 `Math.cos`/`Math.sin`
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

// Precomputed city / metropolitan density index (0: rural, 1: mid-urban, 2: major metro/coastline)
// Aligns with the illuminated urban constellations seen in the reference photograph
const WORLD_DOT_CITY_LEVEL = new Uint8Array(WORLD_DOT_COUNT);
for (let i = 0; i < WORLD_DOT_COUNT; i++) {
  const d = WORLD_DOTS[i];
  const lat = d.lat;
  const lon = d.lon;
  const isUSMegalopolis = lat >= 26 && lat <= 48 && lon >= -92 && lon <= -68;
  const isUSWestCoast = lat >= 30 && lat <= 50 && lon >= -124 && lon <= -114;
  const isCentralAm = lat >= 12 && lat <= 24 && lon >= -102 && lon <= -80;
  const isSAmCoastal =
    (lat >= -36 && lat <= -18 && lon >= -52 && lon <= -38) ||
    (lat >= -5 && lat <= 12 && lon >= -78 && lon <= -64);
  const isEurope = lat >= 36 && lat <= 58 && lon >= -9 && lon <= 26;
  const isEastAsia = lat >= 20 && lat <= 42 && lon >= 110 && lon <= 142;

  if (isUSMegalopolis || isEurope || isSAmCoastal) {
    WORLD_DOT_CITY_LEVEL[i] = 2;
  } else if (isUSWestCoast || isCentralAm || isEastAsia) {
    WORLD_DOT_CITY_LEVEL[i] = 1;
  }
}

// Fixed Earth axial tilt: 23.44 degrees in radians
const TILT = 0.409;
// Cinematic slow planetary rotation (radians per second) during free spin
const BASE_SPEED = 0.024;
// Visually substantial globe scale within the hero column.
// Exported so GlobeStand can derive its container geometry from the exact
// same values instead of mirroring them.
export const SPHERE_FRACTION = 0.32;
// Vertical seat of the sphere inside the hero column.
export const CENTER_FRACTION = 0.43;
// Polar axis tilt in degrees matching the stand's 21.5° brass semi-meridian
export const DEFAULT_AXIS_TILT_DEG = 21.5;
const PAN_STRENGTH = 0.35;

// Key light for the matte navy body, in camera space (x right, y up, z toward
// the viewer). Fitted to the reference photograph: warm celestial illumination
// lands on the upper-right hemisphere (Europe, North-East Atlantic).
const BODY_LIGHT_X = 0.58;
const BODY_LIGHT_Y = 0.42;
const BODY_LIGHT_Z = 0.69;

// Ocean colour as a function of n·L (piecewise linear), fitted to the
// reference: near-black in the shadowed lower left, a low navy plateau across
// the body, and a tight blue lift where the light lands.
const BODY_PROFILE_L = [-0.2, 0, 0.2, 0.4, 0.55, 0.7, 0.8, 0.9, 1.0];
const BODY_PROFILE_R = [0.3, 0.4, 0.4, 0.6, 1.0, 1.2, 1.4, 1.8, 3.0];
const BODY_PROFILE_G = [1.5, 2.0, 3.0, 4.5, 6.0, 7.5, 9.5, 15, 28];
const BODY_PROFILE_B = [4, 5.5, 8, 11, 13.5, 16, 20, 29, 55];
const sampleProfile = (table: number[], l: number) => {
  if (l <= BODY_PROFILE_L[0]) return table[0];
  const last = BODY_PROFILE_L.length - 1;
  if (l >= BODY_PROFILE_L[last]) return table[last];
  let j = 0;
  while (l > BODY_PROFILE_L[j + 1]) j++;
  const t = (l - BODY_PROFILE_L[j]) / (BODY_PROFILE_L[j + 1] - BODY_PROFILE_L[j]);
  return table[j] + (table[j + 1] - table[j]) * t;
};

// Land is a perforated shell with light shining through: every dot is a small
// self-lit pinhole with a warm halo. Core radius as a fraction of the sphere
// radius, and the sprite (core + halo) as a multiple of the core radius.
const DOT_CORE_FRACTION = 0.0048;
const DOT_MIN_CORE_PX = 0.8;
const DOT_SPRITE_SCALE = 2.35;
const DOT_SPRITE_HALF_PX = 32;
const DOT_SPRITE_TINTS = 6;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Pre-renders the matte navy sphere body once (per size) as an offscreen
 * bitmap: per-pixel Lambert shading from BODY_LIGHT, warm golden specular sheen
 * matching the reference's celestial bounce on the upper right, a faint cool limb
 * light, and a fine deterministic speckle.
 */
function createBodyShade(
  radiusCss: number,
  dpr: number,
  axisTiltDeg: number,
): { canvas: HTMLCanvasElement; sizeCss: number } | null {
  const rd = radiusCss * dpr;
  const size = Math.ceil(rd * 2) + 2;
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const octx = off.getContext("2d");
  if (!octx) return null;
  const img = octx.createImageData(size, size);
  const data = img.data;

  const a = (axisTiltDeg * Math.PI) / 180;
  const lx = BODY_LIGHT_X * Math.cos(a) - BODY_LIGHT_Y * Math.sin(a);
  const ly = BODY_LIGHT_X * Math.sin(a) + BODY_LIGHT_Y * Math.cos(a);
  const lz = BODY_LIGHT_Z;
  const half = size / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = px + 0.5 - half;
      const dy = py + 0.5 - half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const coverage = clamp01(rd - d + 0.5);
      if (coverage <= 0) continue;

      const nx = dx / rd;
      const ny = -dy / rd;
      const nr2 = nx * nx + ny * ny;
      const nz = nr2 >= 1 ? 0 : Math.sqrt(1 - nr2);
      const lambert = Math.max(0, nx * lx + ny * ly + nz * lz);
      const lSigned = nx * lx + ny * ly + nz * lz;

      // Warm golden specular sheen on upper-right ocean from celestial stardust
      const goldSheen = Math.pow(lambert, 2.4);

      // Cool limb light, present all the way round and a touch stronger on
      // the lit side.
      const rimT = smoothstep(0.94, 1, Math.min(1, d / rd));
      const rim = Math.pow(rimT, 1.3) * (0.75 + 0.25 * lambert);

      // Deterministic speckle (no per-frame or per-load randomness).
      let h = (px * 374761393 + py * 668265263) | 0;
      h = (h ^ (h >>> 13)) * 1274126177;
      h = h ^ (h >>> 16);
      const n = ((h & 1023) / 1023 - 0.5) * 2;

      const i = (py * size + px) * 4;
      data[i] = Math.max(
        0,
        Math.min(255, sampleProfile(BODY_PROFILE_R, lSigned) + 14 * rim + 38 * goldSheen + n * 0.5),
      );
      data[i + 1] = Math.max(
        0,
        Math.min(255, sampleProfile(BODY_PROFILE_G, lSigned) + 26 * rim + 24 * goldSheen + n * 1.0),
      );
      data[i + 2] = Math.max(
        0,
        Math.min(255, sampleProfile(BODY_PROFILE_B, lSigned) + 40 * rim + 8 * goldSheen + n * 1.8),
      );
      data[i + 3] = Math.round(coverage * 255);
    }
  }
  octx.putImageData(img, 0, 0);
  return { canvas: off, sizeCss: size / dpr };
}

/**
 * Pre-renders the land-dot sprite in a few tints. Face-on dots are a hot
 * luminous gold core in a glowing amber halo; toward the limb they warm to deep
 * amber, matching the reference photograph's golden illuminated continents.
 */
function createDotSprites(): HTMLCanvasElement[] {
  const sprites: HTMLCanvasElement[] = [];
  const size = DOT_SPRITE_HALF_PX * 2;
  for (let k = 0; k < DOT_SPRITE_TINTS; k++) {
    const t = k / (DOT_SPRITE_TINTS - 1);
    const core = [255, Math.round(mix(236, 202, t)), Math.round(mix(182, 115, t))];
    const mid = [248, Math.round(mix(196, 156, t)), Math.round(mix(108, 48, t))];
    const halo = [236, Math.round(mix(162, 118, t)), Math.round(mix(54, 18, t))];
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    if (!g) continue;
    const grad = g.createRadialGradient(
      DOT_SPRITE_HALF_PX,
      DOT_SPRITE_HALF_PX,
      0,
      DOT_SPRITE_HALF_PX,
      DOT_SPRITE_HALF_PX,
      DOT_SPRITE_HALF_PX,
    );
    grad.addColorStop(0, `rgba(${core[0]}, ${core[1]}, ${core[2]}, 1)`);
    grad.addColorStop(0.38, `rgba(${core[0]}, ${core[1]}, ${core[2]}, 1)`);
    grad.addColorStop(0.55, `rgba(${mid[0]}, ${mid[1]}, ${mid[2]}, 0.58)`);
    grad.addColorStop(0.74, `rgba(${halo[0]}, ${halo[1]}, ${halo[2]}, 0.22)`);
    grad.addColorStop(0.9, `rgba(${halo[0]}, ${halo[1]}, ${halo[2]}, 0.05)`);
    grad.addColorStop(1, `rgba(${halo[0]}, ${halo[1]}, ${halo[2]}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    sprites.push(c);
  }
  return sprites;
}

type Phase = "rotate" | "settle" | "focus" | "release";

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function SignatureGlobe({
  className = "",
  axisTiltDeg = DEFAULT_AXIS_TILT_DEG,
}: {
  className?: string;
  axisTiltDeg?: number;
}) {
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

    // The sphere body is pre-rendered once per size (see createBodyShade) and
    // the dot sprites once per mount, so frames only blit and stamp.
    type BodyShadeEntry = { key: string; canvas: HTMLCanvasElement; sizeCss: number };
    let bodyShadeCache: BodyShadeEntry | null = null;
    const dotSprites = createDotSprites();
    const invalidateGradientCaches = () => {
      bodyShadeCache = null;
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

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "rgb(3, 10, 24)";
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
    };

    const draw = (dt: number, timeMs?: number) => {
      ctx.clearRect(0, 0, width, height);
      if (width === 0 || height === 0) return;

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

      // 1. Matte navy sphere body: pre-rendered per size (Lambert shading, faint
      //    cool limb light, fine speckle). No outer glow — the silhouette is a
      //    crisp edge against the page, like the physical object it mimics.
      const shadeKey = `${effectiveR}|${dpr}`;
      if (!bodyShadeCache || bodyShadeCache.key !== shadeKey) {
        const built = createBodyShade(effectiveR, dpr, axisTiltDeg);
        bodyShadeCache = built ? { key: shadeKey, ...built } : null;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, effectiveCY, effectiveR, 0, Math.PI * 2);
      ctx.clip();

      if (bodyShadeCache) {
        ctx.drawImage(
          bodyShadeCache.canvas,
          cx - bodyShadeCache.sizeCss / 2,
          effectiveCY - bodyShadeCache.sizeCss / 2,
          bodyShadeCache.sizeCss,
          bodyShadeCache.sizeCss,
        );
      } else {
        ctx.fillStyle = "rgb(3, 10, 24)";
        ctx.fillRect(cx - effectiveR, effectiveCY - effectiveR, effectiveR * 2, effectiveR * 2);
      }

      const cosTilt = Math.cos(TILT);
      const sinTilt = Math.sin(TILT);

      // Pole contact occlusion — soft shadow where the brass pivot cups grip the ball
      const northPoleX = cx + effectiveR * 0.3665;
      const northPoleY = effectiveCY - effectiveR * 0.9304;
      const southPoleX = cx - effectiveR * 0.3665;
      const southPoleY = effectiveCY + effectiveR * 0.9304;

      const poleOccRadius = effectiveR * 0.095;
      const drawPoleOcclusion = (px: number, py: number) => {
        const occGrad = ctx.createRadialGradient(px, py, 0, px, py, poleOccRadius);
        occGrad.addColorStop(0, "rgba(0, 0, 0, 0.65)");
        occGrad.addColorStop(0.5, "rgba(0, 0, 0, 0.25)");
        occGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = occGrad;
        ctx.beginPath();
        ctx.arc(px, py, poleOccRadius, 0, Math.PI * 2);
        ctx.fill();
      };
      drawPoleOcclusion(northPoleX, northPoleY);
      drawPoleOcclusion(southPoleX, southPoleY);

      // 2. Land: evenly spaced (relaxed, non-lattice) self-lit pinholes.
      //    Each dot is a pre-rendered sprite (cream core, amber halo) stamped
      //    with its radial axis squashed by the surface's foreshortening, so
      //    rows compress into thin glowing lines toward the limb.
      //    When a country is focused its dots crossfade to MAST gold (#c9a66b).
      const dotCount = WORLD_DOT_COUNT;

      // Rotation's cos/sin computed ONCE per frame (not once per dot — see the
      // perf note above the module-level trig caches at the top of this file).
      const cosR = Math.cos(rotation);
      const sinR = Math.sin(rotation);

      const rho = Math.max(DOT_MIN_CORE_PX, effectiveR * DOT_CORE_FRACTION);
      const spriteK = (rho * DOT_SPRITE_SCALE) / DOT_SPRITE_HALF_PX;
      const dotRadius = rho * 1.15;

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

        const zDepth = Math.max(0, Math.min(1, z));

        // Foreshortening: squash along the radial (limb-ward) direction.
        const rad = Math.sqrt(x * x + y * y);
        const ux = rad > 1e-4 ? x / rad : 1;
        const uy = rad > 1e-4 ? -y / rad : 0;
        const squash = Math.max(0.09, zDepth);

        // Self-lit dots stay bright and only ease off toward the limb.
        const dotAlpha = 0.6 + 0.28 * Math.min(1, zDepth / 0.6);
        const tint = Math.round(
          (1 - Math.min(1, zDepth / 0.55)) * (DOT_SPRITE_TINTS - 1),
        );

        // Check if dot belongs to the active focus country
        const isTargetCountry = currentTarget && targetIdx >= 0 && DOT_COUNTRY_IDS[i] === targetIdx;
        const tGold = isTargetCountry ? countryBaseGold : 0;

        // Non-focus dots quieten while a country is focused and return to full
        // brightness as countryBaseGold drops back to 0.
        const spriteAlpha = isTargetCountry
          ? dotAlpha * (1 - 0.5 * tGold)
          : dotAlpha * (1 - 0.42 * countryBaseGold);

        // Metropolitan / city light boost matching orbital night lights in the reference
        const cityLevel = WORLD_DOT_CITY_LEVEL[i];
        let finalSpriteK = spriteK;
        let baseSpriteAlpha = spriteAlpha;
        if (cityLevel === 2) {
          finalSpriteK = spriteK * 1.34;
          baseSpriteAlpha = Math.min(1, spriteAlpha * 1.35);
        } else if (cityLevel === 1) {
          finalSpriteK = spriteK * 1.18;
          baseSpriteAlpha = Math.min(1, spriteAlpha * 1.2);
        }

        const sprite = dotSprites[tint];
        if (sprite && baseSpriteAlpha > 0.004) {
          ctx.globalAlpha = baseSpriteAlpha;
          ctx.setTransform(
            dpr * ux * squash * finalSpriteK,
            dpr * uy * squash * finalSpriteK,
            dpr * -uy * finalSpriteK,
            dpr * ux * finalSpriteK,
            dpr * sx,
            dpr * sy,
          );
          ctx.drawImage(sprite, -DOT_SPRITE_HALF_PX, -DOT_SPRITE_HALF_PX);

          // Extra luminous pinpoint for metropolitan city clusters
          if (cityLevel > 0 && zDepth > 0.25) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.beginPath();
            ctx.arc(sx, sy, dotRadius * (cityLevel === 2 ? 0.72 : 0.55), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 250, 235, ${0.85 * baseSpriteAlpha})`;
            ctx.fill();
          }
        }

        if (isTargetCountry && tGold > 0.001) {
          // Continuous crossfade from the lit pinhole to full MAST gold #c9a66b
          // (201, 166, 107): tGold 1.0 (peak focus) -> 0.0 (end of release).
          const isSmallCountry = ["EGY", "FRA", "DEU", "JPN", "NZL"].includes(currentTarget.iso);
          const targetCountryLum = (isSmallCountry ? 0.88 : 0.82) + 0.1 * zDepth;
          const targetCountryDotR = isSmallCountry
            ? Math.max(1.05, dotRadius * 1.3)
            : Math.max(0.85, dotRadius * 1.15);
          const curDotR = dotRadius * (1 - tGold) + targetCountryDotR * tGold;

          ctx.globalAlpha = 1;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.beginPath();
          ctx.arc(sx, sy, curDotR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(201, 166, 107, ${targetCountryLum * tGold})`;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
      {/* 1. Digital globe canvas inside the axial-lean compositing wrapper */}
      <div
        className="w-full h-full relative"
        style={{
          transform: `rotate(${axisTiltDeg}deg)`,
          transformOrigin: `${cx}px ${cy}px`,
        }}
      >
        <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />
      </div>

      {/* 2. Editorial Country Discovery Indicator: Country Name + Opportunity Count (level and horizontal) */}
      <div className="pointer-events-none absolute left-1/2 bottom-0 -translate-x-1/2 flex flex-col items-center z-30 whitespace-nowrap">
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
