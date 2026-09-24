import { useMemo } from "react";
import { HAZE_STYLE } from "./atmosphereHaze";

type Star = {
  id: number;
  x: number;
  y: number;
  size: number;
  opacity: number;
  type: "drift-a" | "drift-b" | "breathe" | "twinkle";
  duration: number;
  delay: number;
  // Only used for "breathe"/"twinkle" — per-star opacity floor/peaks fed to the
  // keyframes as CSS vars, so each star's brightness range can differ from the
  // site-wide default baked into the keyframes.
  opMin?: number;
  opMid1?: number;
  opMax?: number;
  opMid2?: number;
};

export type SectionAtmosphereVariant =
  | "hero"
  | "solutions"
  | "features"
  | "platform"
  | "customers"
  | "cta"
  | "footer"
  | "pricingHero"
  | "pricingMid"
  | "pricingLower";

// ─── Star rendering: grouped layers (Phase 1B) ───────────────────────────────
// Previously every star was its own absolutely-positioned <div> with its own
// CSS animation (210 animated nodes on the landing page, 324 on Pricing), which
// meant hundreds of independent style invalidations every frame. The star
// *generators* below are unchanged (same seeds → same positions, sizes and
// brightness); only how the result is drawn changed:
//
//   • Non-pulsing stars ("drift", ~65%) are painted once, into a single static
//     layer: one element whose background is a small data-URI SVG.
//   • Pulsing stars are bucketed into a few groups (3 breathe + 2 twinkle per
//     field). Each group is ONE element with ONE opacity keyframe animation
//     (compositor-only). Per-star peak brightness is baked into each circle's
//     fill-opacity; the group animates between that peak and a floor ratio.
//
// No JS timers, no RAF, no scroll listeners: it is generated once (useMemo)
// and animated purely by CSS. Per-star scale pulsing (≤±0.25px) and the 5px
// drift are intentionally not reproduced — they are below what is visible.
const STAR_FILL = "#e8f0fe";
const BREATHE_GROUPS = 3;
const TWINKLE_GROUPS = 2;

type StarGroup = {
  url: string;
  duration: number;
  delay: number;
  /** opacity at the trough, as a fraction of the group's peak (1) */
  lo: number;
  mid1?: number;
  mid2?: number;
  /** opacity when animations are disabled (prefers-reduced-motion) */
  base: number;
};

type StarLayers = {
  staticUrl: string | null;
  breathe: StarGroup[];
  twinkle: StarGroup[];
};

type StarDot = {
  x: number;
  y: number;
  size: number;
  alpha: number;
  /** Optional per-dot colour (defaults to the site-wide STAR_FILL). */
  fill?: string;
  /**
   * Optional soft halo, as a multiple of the dot's own radius. The halo is a
   * radial-gradient disc (fill-opacity = `haloAlpha`), drawn under the core.
   * With `alpha: 0` the dot is a halo only — used for out-of-focus bokeh.
   */
  halo?: number;
  haloAlpha?: number;
  /** Halo colour family. Defaults to "cool" (the site star tint). */
  haloTone?: "cool" | "warm";
};

// Same fallbacks the old keyframes used when a star carried no --star-op-* vars.
const BREATHE_DEFAULTS = { min: 0.12, max: 0.5 };
const TWINKLE_DEFAULTS = { min: 0.15, mid1: 0.35, max: 0.7, mid2: 0.38 };

// Shared halo falloff: a smooth, near-gaussian ramp (no visible disc edge).
const HALO_DEFS = (id: string, rgb: string) =>
  `<radialGradient id='${id}'>` +
  [
    [0, 1],
    [0.22, 0.62],
    [0.45, 0.28],
    [0.7, 0.08],
    [1, 0],
  ]
    .map(([o, a]) => `<stop offset='${o}' stop-color='${rgb}' stop-opacity='${a}'/>`)
    .join("") +
  `</radialGradient>`;

function starsToUrl(dots: StarDot[], compact = false): string {
  // Halo gradients are only emitted when a dot asks for one, so layers made of
  // plain dots (every pre-4A star layer) serialise exactly as before.
  const cool = dots.some((d) => d.halo && d.haloTone !== "warm");
  const warm = dots.some((d) => d.halo && d.haloTone === "warm");
  const defs =
    cool || warm
      ? `<defs>${cool ? HALO_DEFS("hc", STAR_FILL) : ""}${warm ? HALO_DEFS("hw", "#f2c887") : ""}</defs>`
      : "";
  const circles = dots
    .map((d) => {
      const r = d.size / 2;
      // cx/cy are % of the layer box, r is px; translate(r r) reproduces the old
      // "left/top = x%/y% of the star's top-left corner" placement exactly.
      // `compact` (hero star layer only): 1-decimal %, and no translate(r r) nudge
      // (<= 1.5px, invisible on random stars). Keeps a ~550-dot layer to ~60 KB.
      const at = compact
        ? `cx='${d.x.toFixed(1)}%' cy='${d.y.toFixed(1)}%'`
        : `cx='${d.x.toFixed(2)}%' cy='${d.y.toFixed(2)}%'`;
      const tr = compact ? "" : `transform='translate(${r.toFixed(2)} ${r.toFixed(2)})'`;
      const tone = d.fill ?? STAR_FILL;
      const halo = d.halo
        ? `<circle ${at} r='${(r * d.halo).toFixed(2)}' ${tr} fill='url(#${d.haloTone === "warm" ? "hw" : "hc"})' fill-opacity='${(d.haloAlpha ?? 0.1).toFixed(3)}'/>`
        : "";
      const core =
        d.alpha > 0
          ? `<circle ${at} r='${r.toFixed(2)}' ${tr} fill='${tone}' fill-opacity='${d.alpha.toFixed(compact ? 2 : 3)}'/>`
          : "";
      return halo + core;
    })
    .join("");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg'>${defs}${circles}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Sort by duration and split into contiguous buckets so each group runs at a
// clearly different tempo (avoids one lock-step "heartbeat" across the sky).
function bucketByDuration(list: Star[], n: number): Star[][] {
  if (list.length === 0) return [];
  const k = Math.min(n, list.length);
  const sorted = [...list].sort((a, b) => a.duration - b.duration);
  const buckets: Star[][] = Array.from({ length: k }, () => []);
  sorted.forEach((s, i) => buckets[Math.floor((i * k) / sorted.length)].push(s));
  return buckets;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function buildGroups(list: Star[], kind: "breathe" | "twinkle"): StarGroup[] {
  const d = kind === "breathe" ? BREATHE_DEFAULTS : TWINKLE_DEFAULTS;
  const buckets = bucketByDuration(list, kind === "breathe" ? BREATHE_GROUPS : TWINKLE_GROUPS);
  return buckets.map((b, i) => {
    const peaks = b.map((s) => s.opMax ?? d.max);
    const duration = mean(b.map((s) => s.duration));
    const ratio = (pick: (s: Star) => number, fallback: number) =>
      mean(b.map((s, j) => Math.min(1, pick(s) / peaks[j] || fallback / d.max)));
    return {
      url: starsToUrl(b.map((s, j) => ({ x: s.x, y: s.y, size: s.size, alpha: peaks[j] }))),
      duration,
      // Evenly spread phases across groups instead of clustering near t=0.
      delay: -(duration * (i + 0.37)) / b.length,
      lo: ratio((s) => s.opMin ?? d.min, d.min),
      mid1:
        kind === "twinkle"
          ? ratio((s) => s.opMid1 ?? TWINKLE_DEFAULTS.mid1, TWINKLE_DEFAULTS.mid1)
          : undefined,
      mid2:
        kind === "twinkle"
          ? ratio((s) => s.opMid2 ?? TWINKLE_DEFAULTS.mid2, TWINKLE_DEFAULTS.mid2)
          : undefined,
      base: Math.min(1, mean(b.map((s, j) => s.opacity / peaks[j]))),
    };
  });
}

function buildStarLayers(stars: Star[]): StarLayers {
  const still = stars.filter((s) => s.type === "drift-a" || s.type === "drift-b");
  return {
    staticUrl: still.length
      ? starsToUrl(still.map((s) => ({ x: s.x, y: s.y, size: s.size, alpha: s.opacity })))
      : null,
    breathe: buildGroups(
      stars.filter((s) => s.type === "breathe"),
      "breathe",
    ),
    twinkle: buildGroups(
      stars.filter((s) => s.type === "twinkle"),
      "twinkle",
    ),
  };
}

// ─── Hero deep field (Phase 4A) ──────────────────────────────────────────────
// The hero sky is built from three depth layers, all static and all painted by
// the compositor — nothing here animates, and there is no JS after first render:
//
//   FAR   the baked nebula (`.hero-nebula`, styles.css): cool charcoal/navy haze
//   MID   this star field: many very faint distant stars, fewer mid ones, a
//         handful of brighter ones with a soft halo. Cool blue-white, with the
//         odd warm one, as in the reference.
//   NEAR  sparse warm dust points + a few very faint out-of-focus bokeh
//
// Positions come from a deterministic density field (same LCG the other star
// generators use, so the sky is identical on every load): richest around the
// globe / gold-flow area and the upper right, thin along the top, nearly empty
// behind the hero copy and toward the floor. Positions are % of the hero
// atmosphere box; the nebula asset is cover-fitted into the same box.
//
// Phase 4A.1 — starfield density + character: ~550 star dots (was ~175) plus 22
// warm/bokeh dots (4A.2 raised the bokeh-orb count to 23 and brightened both),
// across TWO layers. (The removed particle system was thousands of DOM nodes /
// a canvas loop; this is still two elements carrying two small SVG backgrounds.)
// The star tiers:
//
//   T1  ~430  tiny, faint, distant — the majority. Brightness is skewed low, so most
//             are barely-there and a minority read as clear pinpoints.
//   T2  ~105  moderately visible. Never placed in the copy footprint.
//   T3  ~15   the few brighter stars, each with a subtle halo. Never placed in the
//             copy footprint, the nav row, the globe's silhouette, or near each other.
//
// Copy protection lives in the star density field itself (`copyBox` below): the
// desktop copy column is a rectangle in these % coordinates, so it is nearly empty
// and holds no T2/T3 at all. The stacked (<lg) layout can't be expressed in
// viewport-independent % positions, so that is handled by a mask on the star layer
// in styles.css (`.hero-deepfield-stars`).
//
// The warm dust / bokeh layer draws from its own RNG stream, pinned to the exact
// state it started from before 4A.1, so re-tuning the stars cannot move it.
type HeroSky = { starsUrl: string; nearUrl: string };

const COOL_TINTS = ["#cfdcff", "#dbe6ff", "#e6eeff", "#dfe8ff"];
const WARM_STAR = "#ffe0b0";
const WARM_DUST = ["#f3c986", "#ffd9a0", "#eebd78"];
// RNG state at which the warm-dust / bokeh layer began drawing in Phase 4A (validated).
const HERO_NEAR_SEED = 820431270;

function buildHeroSky(): HeroSky {
  let seed = 1103;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const between = (a: number, b: number) => a + rand() * (b - a);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
  const smooth = (a: number, b: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const blob = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) =>
    Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
  // 0..1: how much this point sits inside the "keep it dark" zone behind the copy
  const copyZone = (x: number, y: number) =>
    Math.exp(-(Math.abs((x - 0.22) / 0.24) ** 2.6 + Math.abs((y - 0.52) / 0.3) ** 2.6));
  const floorFade = (y: number) => 1 - 0.85 * smooth(0.74, 0.93, y);

  // Stars only (4A.1). 1 inside / 0 outside a soft rectangle: the footprint of the
  // desktop hero copy (h1, paragraph, CTAs, note, stat strip) plus margin, in % of
  // the atmosphere box. Measured across lg widths (1024-2560px) the copy column
  // spans x 5%-51% and y 20%-72% of the box, so this is the envelope of all of them.
  const plateau = (v: number, a: number, b: number, feather: number) =>
    smooth(a - feather, a, v) * (1 - smooth(b, b + feather, v));
  const copyBox = (x: number, y: number) => plateau(x, 0.045, 0.515, 0.035) * plateau(y, 0.17, 0.76, 0.05);
  // Where the larger stars (T2/T3) may sit: outside the copy footprint, and not
  // behind the nav links / buttons along the very top of the box.
  const openSky = (x: number, y: number) => copyBox(x, y) < 0.02 && (y >= 0.085 || (x > 0.5 && x < 0.72));
  // T3 also stays off the globe's silhouette (approx. across lg widths), where it would be hidden.
  const behindGlobe = (x: number, y: number) => ((x - 0.72) / 0.09) ** 2 + ((y - 0.38) / 0.25) ** 2 < 1;

  // Where stars are allowed to be (relative density, unitless). Peak of the field below
  // is 0.55 + 0.5 + 1.1 + 0.7 ~= 2.85, so the rejection sampler's ceiling is 3.
  const STAR_DENSITY_MAX = 3;
  const starDensity = (x: number, y: number) =>
    (0.55 +
      0.5 * blob(x, y, 0.58, 0.1, 0.46, 0.14) + // band along the top, weighted to the right
      1.1 * blob(x, y, 0.66, 0.4, 0.26, 0.34) + // around the globe / gold flow
      0.7 * blob(x, y, 0.92, 0.24, 0.14, 0.3)) * // upper right
    (1 - 0.88 * copyBox(x, y)) *
    floorFade(y);
  // Warm dust: hugs the globe halo and the lower right where the flow lands.
  const warmDensity = (x: number, y: number) =>
    (0.18 + 1.0 * blob(x, y, 0.68, 0.42, 0.3, 0.36) + 0.5 * blob(x, y, 0.9, 0.72, 0.15, 0.2)) *
    (1 - 0.95 * copyZone(x, y)) *
    floorFade(y) *
    smooth(0.03, 0.09, y); // keep clear of the nav row

  const sample = (density: (x: number, y: number) => number, max: number) => {
    for (let i = 0; i < 400; i++) {
      const x = rand();
      const y = rand();
      if (rand() * max < density(x, y)) return { x: x * 100, y: y * 100 };
    }
    return { x: 70, y: 30 };
  };

  // Same rejection sampler as `sample`, plus an acceptance test. (`sample` itself is
  // left byte-for-byte alone: the warm layer below uses it.)
  const sampleWhere = (
    density: (x: number, y: number) => number,
    max: number,
    ok: (x: number, y: number) => boolean,
  ) => {
    for (let i = 0; i < 800; i++) {
      const x = rand();
      const y = rand();
      if (ok(x, y) && rand() * max < density(x, y)) return { x: x * 100, y: y * 100 };
    }
    return { x: 66, y: 30 };
  };
  const anywhere = () => true;

  // Loose clusters, so the field clumps like a real sky instead of a grid of noise.
  const clusters = Array.from({ length: 13 }, () => sample(starDensity, STAR_DENSITY_MAX));
  const clusteredWhere = (ok: (x: number, y: number) => boolean) => {
    const c = pick(clusters);
    const x = c.x + (rand() + rand() - 1) * 3.0;
    const y = c.y + (rand() + rand() - 1) * 5.0;
    const inBox = x > 0 && x < 100 && y > 0 && y < 100;
    return inBox && ok(x / 100, y / 100) && copyBox(x / 100, y / 100) < 0.5
      ? { x, y }
      : sampleWhere(starDensity, STAR_DENSITY_MAX, ok);
  };

  const stars: StarDot[] = [];
  const cool = () => pick(COOL_TINTS);

  // Tier 1 — tiny, faint, distant: the majority of the field. Brightness is skewed
  // low (u = rand^1.8), so most are faint and a minority are clearly visible pinpoints;
  // size follows brightness a little. Copy-footprint strays are dimmed further.
  for (let i = 0; i < 430; i++) {
    const p = i % 100 < 50 ? clusteredWhere(anywhere) : sampleWhere(starDensity, STAR_DENSITY_MAX, anywhere);
    const warm = rand() < 0.06;
    const u = rand() ** 1.8;
    const size = 0.75 + rand() * 0.25 + u * 0.4;
    const alpha = (0.1 + u * 0.5) * (1 - 0.5 * copyBox(p.x / 100, p.y / 100));
    stars.push({ ...p, size, alpha, fill: warm ? WARM_STAR : cool() });
  }
  // Tier 2 — moderately visible stars.
  for (let i = 0; i < 105; i++) {
    const p = i % 100 < 30 ? clusteredWhere(openSky) : sampleWhere(starDensity, STAR_DENSITY_MAX, openSky);
    const warm = rand() < 0.07;
    stars.push({
      ...p,
      size: between(1.3, 2.0),
      alpha: 0.42 + rand() ** 1.4 * 0.32,
      fill: warm ? WARM_STAR : cool(),
    });
  }
  // Tier 3 — a few brighter stars with a subtle halo. Kept few: they set scale.
  // Spaced apart so they read as individual bright stars, not a clump.
  const brights: { x: number; y: number }[] = [];
  const spaced = (x: number, y: number) =>
    openSky(x, y) && !behindGlobe(x, y) && brights.every((b) => Math.abs(b.x - x) > 0.07 || Math.abs(b.y - y) > 0.12);
  for (let i = 0; i < 15; i++) {
    const p = sampleWhere(starDensity, STAR_DENSITY_MAX, spaced);
    brights.push({ x: p.x / 100, y: p.y / 100 });
    stars.push({
      ...p,
      size: between(2.1, 3.0),
      alpha: between(0.72, 0.95),
      fill: "#f2f6ff",
      halo: 4.2,
      haloAlpha: between(0.08, 0.13),
    });
  }

  // The warm layer below is unchanged from Phase 4A: it continues from the RNG state
  // the old star loops used to leave behind, so its dots land exactly where they did.
  // Phase 4A.2 — visibility-only pass: the density field and per-draw rand() usage
  // are untouched, so all 22 original dots land exactly where they did in 4A.1;
  // only their alpha/halo strength was raised, plus one extra bokeh orb appended
  // at the end, so the layer actually reads against the night sky instead of
  // disappearing into it.
  seed = HERO_NEAR_SEED;
  const near: StarDot[] = [];
  // Warm distant dust points; about half carry a faint halo.
  for (let i = 0; i < 18; i++) {
    const halo = i % 2 === 0;
    near.push({
      ...sample(warmDensity, 1.8),
      size: between(1.6, 3.4),
      alpha: between(0.34, 0.66),
      fill: pick(WARM_DUST),
      ...(halo ? { halo: 5.5, haloAlpha: between(0.11, 0.17), haloTone: "warm" as const } : {}),
    });
  }
  // A few large, very soft, very faint out-of-focus points: near-field bokeh.
  // Halo-only (alpha 0), gaussian-ish falloff — they should read as a soft warm
  // bloom in the dark, never as a hard-edged disc.
  for (let i = 0; i < 5; i++) {
    near.push({
      ...sample(warmDensity, 1.8),
      size: 2,
      alpha: 0,
      fill: "#f0c27a",
      halo: between(10, 19), // radius = halo x the 1px core radius, i.e. ~10-19px
      haloAlpha: between(0.11, 0.17),
      haloTone: "warm",
    });
  }

  return { starsUrl: starsToUrl(stars, true), nearUrl: starsToUrl(near) };
}

// Built once per page load, on first hero mount (deterministic; not per render).
let heroSkyCache: HeroSky | null = null;
const getHeroSky = () => (heroSkyCache ??= buildHeroSky());

const layerBg = (url: string): React.CSSProperties => ({
  backgroundImage: url,
  backgroundSize: "100% 100%",
  backgroundRepeat: "no-repeat",
});

function StarLayerStack({ layers }: { layers: StarLayers }) {
  const group = (g: StarGroup, i: number, kind: "breathe" | "twinkle") => (
    <div
      key={`${kind}-${i}`}
      className={`absolute inset-0 animate-star-group-${kind}`}
      style={
        {
          ...layerBg(g.url),
          opacity: g.base,
          "--sg-dur": `${g.duration.toFixed(2)}s`,
          "--sg-delay": `${g.delay.toFixed(2)}s`,
          "--sg-lo": g.lo.toFixed(3),
          ...(g.mid1 !== undefined ? { "--sg-m1": g.mid1.toFixed(3) } : {}),
          ...(g.mid2 !== undefined ? { "--sg-m2": g.mid2.toFixed(3) } : {}),
        } as React.CSSProperties
      }
    />
  );
  return (
    <>
      {layers.staticUrl && <div className="absolute inset-0" style={layerBg(layers.staticUrl)} />}
      {layers.breathe.map((g, i) => group(g, i, "breathe"))}
      {layers.twinkle.map((g, i) => group(g, i, "twinkle"))}
    </>
  );
}

// ─── Global Night World Foundation (Continuous backdrop beneath all sections) ──
// Prevents any atmospheric vacuums: ensures every section has faint global night tone,
// sparse distant stars, and subtle ambient depth behind the entire page.
// Star fields are generated once, synchronously, with useMemo rather than
// useEffect+setState. The previous pattern rendered an empty star field on
// first paint, then generated ~48-96 stars and re-rendered a moment later —
// an extra unnecessary render pass (and a visible pop-in) on every mount.
// useMemo computes the list during the initial render itself, so there is
// only ever one render, and (since the deps are stable) the list is never
// regenerated on re-render either.
export function GlobalAtmosphereFoundation() {
  const globalStars = useMemo<Star[]>(() => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const count = 48;
    const list: Star[] = [];

    for (let i = 0; i < count; i++) {
      const x = rand() * 100;
      const y = rand() * 100;
      const roll = rand();
      const size = 0.6 + rand() * 0.5; // Fine micro-stars 0.6px - 1.1px
      let opacity = 0.12 + rand() * 0.16; // Faint 0.12 - 0.28
      let type: Star["type"] = "drift-a";
      let duration = 80;

      if (roll < 0.70) {
        type = rand() > 0.5 ? "drift-a" : "drift-b";
        duration = 75 + rand() * 35;
      } else {
        type = "breathe";
        duration = 7.0 + rand() * 5.0;
      }

      const delay = -(rand() * 25);
      list.push({ id: i, x, y, size, opacity, type, duration, delay });
    }

    return list;
  }, []);
  const globalLayers = useMemo(() => buildStarLayers(globalStars), [globalStars]);

  return (
    <div
      className="fixed inset-0 pointer-events-none select-none -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {/* 1. Deep space base gradient across entire page */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, #020512 0%, #01030c 24%, #01020a 52%, #010208 76%, #000104 100%)",
        }}
      />

      {/* 2. Global faint atmospheric depth veils (percentage widths avoid scrollbar vw mismatch) */}
      <div
        className="atmo-soft absolute right-[5%] top-[12%] w-[75%] max-w-[960px] h-[65vh] mix-blend-screen opacity-[0.024] animate-atmo-haze"
        style={HAZE_STYLE.globalA}
      />
      <div
        className="atmo-soft absolute left-[8%] top-[55%] w-[80%] max-w-[1000px] h-[55vh] mix-blend-screen opacity-[0.018]"
        style={HAZE_STYLE.globalB}
      />

      {/* 3. Global sparse distant micro-stars (1 static layer + a few grouped pulse layers) */}
      <div className="absolute inset-0">
        <StarLayerStack layers={globalLayers} />
      </div>
    </div>
  );
}

// ─── Section-Specific Atmosphere (Local Environmental Conditions) ─────────────

function generateStars(variant: SectionAtmosphereVariant, starBoost = false): Star[] {
  let count = 20;
  let seed = 100;

  switch (variant) {
    case "hero":
      count = 34;
      seed = 107;
      break;
    case "solutions":
      count = 22;
      seed = 223;
      break;
    case "features":
      count = 24;
      seed = 349;
      break;
    case "platform":
      count = 26;
      seed = 419;
      break;
    case "customers":
      count = 18;
      seed = 479;
      break;
    case "cta":
      // Boosted on the Pricing page (its CTA is the page's final atmospheric
      // centerpiece); left at its original, quieter count on the landing page.
      count = starBoost ? 42 : 20;
      seed = 541;
      break;
    case "footer":
      count = 18;
      seed = 601;
      break;
    case "pricingHero":
      // Clearly-visible night sky over the Pricing hero — the first thing the
      // page shows, so the star field needs real presence, not a hint of one.
      count = 96;
      seed = 733;
      break;
    case "pricingMid":
      // Comparison + Pipeline sections: still an unmistakable star field,
      // just a step down from the hero. Sized up slightly so the field reads
      // as populated across both sections' full height, not just up top.
      count = 62;
      seed = 811;
      break;
    case "pricingLower":
      // Trust / AI tiers / credits / FAQ — four sections' worth of height,
      // so this needs real coverage to avoid reading as empty in the lower
      // two-thirds of the zone, while staying calmer than pricingMid.
      count = 58;
      seed = 877;
      break;
  }

  // Pricing sections (plus the boosted Pricing-page CTA) get a brighter
  // baseline than the rest of the site so the stars read as an actual night
  // sky rather than a barely-there texture.
  const isPricing =
    variant === "pricingHero" || variant === "pricingMid" || variant === "pricingLower" ||
    (variant === "cta" && starBoost);

  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const stars: Star[] = [];

  for (let i = 0; i < count; i++) {
    const x = rand() * 100;
    const y = rand() * 100;

    const roll = rand();
    let type: Star["type"] = "drift-a";
    let duration = 70;
    let size = 0.75 + rand() * 0.6;
    let opacity = 0.22;
    let delay = 0;
    let opMin: number | undefined;
    let opMid1: number | undefined;
    let opMax: number | undefined;
    let opMid2: number | undefined;

    if (roll < 0.65) {
      // Group A (~65%): Mostly stable with slow micro-drift — this is a static
      // opacity (no opacity keyframes), so it's what actually reads as the
      // baseline brightness of the sky.
      type = rand() > 0.5 ? "drift-a" : "drift-b";
      duration = 60 + rand() * 30;
      opacity = isPricing ? 0.22 + rand() * 0.20 : 0.16 + rand() * 0.16;
      size = 0.7 + rand() * 0.5;
      delay = -(rand() * 35);
    } else if (roll < 0.90) {
      // Group B (~25%): Gentle breathing between a floor and a peak.
      type = "breathe";
      duration = 5.5 + rand() * 4.0;
      size = 0.85 + rand() * 0.5;
      delay = -(rand() * 12);
      opMin = isPricing ? 0.18 + rand() * 0.05 : 0.10 + rand() * 0.04;
      opMax = isPricing ? 0.46 + rand() * 0.09 : 0.42 + rand() * 0.10;
      opacity = opMax;
    } else {
      // Group C (~10%): Noticeable twinkling, four-stop cycle.
      type = "twinkle";
      duration = 3.5 + rand() * 3.0;
      size = 0.95 + rand() * 0.55;
      delay = -(rand() * 8);
      opMin = isPricing ? 0.20 + rand() * 0.05 : 0.13 + rand() * 0.04;
      opMid1 = isPricing ? 0.36 + rand() * 0.08 : 0.30 + rand() * 0.08;
      opMax = isPricing ? 0.58 + rand() * 0.12 : 0.62 + rand() * 0.10;
      opMid2 = isPricing ? 0.34 + rand() * 0.08 : 0.32 + rand() * 0.08;
      opacity = opMax;
    }

    stars.push({ id: i, x, y, size, opacity, type, duration, delay, opMin, opMid1, opMax, opMid2 });
  }

  return stars;
}

export function SectionAtmosphere({ variant, starBoost = false }: { variant: SectionAtmosphereVariant; starBoost?: boolean }) {
  // See the comment on GlobalAtmosphereFoundation above: computed once via
  // useMemo instead of useEffect+setState, so mounting a section (there are
  // up to 10 of these on a single page) costs one render, not two.
  const stars = useMemo(() => generateStars(variant, starBoost), [variant, starBoost]);
  const layers = useMemo(() => buildStarLayers(stars), [stars]);
  // Hero only: the static deep-field (built once per page load, see buildHeroSky).
  const heroSky = variant === "hero" ? getHeroSky() : null;

  // Soft vertical feathering with spatial overlap prevents rectangular boundary cutoffs
  const maskStyle: React.CSSProperties =
    variant === "hero" || variant === "pricingHero"
      ? {
          WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 82%, transparent 100%)",
          maskImage: "linear-gradient(to bottom, black 0%, black 82%, transparent 100%)",
        }
      : variant === "footer"
      ? {
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 20%, black 100%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 20%, black 100%)",
        }
      : {
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 16%, black 84%, transparent 100%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 16%, black 84%, transparent 100%)",
        };

  const verticalPositionClass =
    variant === "hero" || variant === "pricingHero"
      ? "top-0 -bottom-24"
      : variant === "footer"
      ? "-top-24 bottom-0"
      : "-inset-y-24";

  return (
    <div
      className={`absolute inset-x-0 pointer-events-none overflow-hidden select-none z-0 ${verticalPositionClass}`}
      style={maskStyle}
      aria-hidden="true"
    >
      {/* 0. HERO FAR LAYER (Phase 4A): baked nebula — the deepest thing in the scene.
          Static; see `.hero-nebula` in styles.css. Sits under the haze and cloud belts. */}
      {variant === "hero" && <div className="hero-nebula absolute inset-0 pointer-events-none" />}

      {/* 1. Atmospheric Haze & Ambient Depth (Autonomous, time-based) */}
      {variant === "hero" && (
        <>
          {/* Full-width continuous night sky depth across the entire hero width */}
          <div
            className="atmo-soft absolute inset-0 mix-blend-screen opacity-[0.028] animate-atmo-haze pointer-events-none"
            style={HAZE_STYLE.hero}
          />
          {/* Soft planetary back-glow framing the Earth on the right */}
          <div
            className="atmo-soft absolute right-[4%] top-[10%] w-[52%] max-w-[680px] aspect-square mix-blend-screen opacity-[0.032] pointer-events-none"
            style={HAZE_STYLE.heroGlow}
          />
        </>
      )}

      {variant === "solutions" && (
        <div
          className="atmo-soft absolute left-[10%] top-[20%] w-[65%] max-w-[800px] h-[40vh] mix-blend-screen opacity-[0.024]"
          style={HAZE_STYLE.solutions}
        />
      )}

      {variant === "features" && (
        <div
          className="atmo-soft absolute right-[15%] top-[25%] w-[60%] max-w-[760px] h-[40vh] mix-blend-screen opacity-[0.022]"
          style={HAZE_STYLE.features}
        />
      )}

      {variant === "platform" && (
        <div
          className="atmo-soft absolute inset-0 mix-blend-screen opacity-[0.030] animate-atmo-haze"
          style={HAZE_STYLE.platform}
        />
      )}

      {variant === "customers" && (
        <div
          className="atmo-soft absolute right-[12%] top-[25%] w-[55%] max-w-[700px] h-[35vh] mix-blend-screen opacity-[0.016]"
          style={HAZE_STYLE.customers}
        />
      )}

      {variant === "cta" && (
        <div
          className={`atmo-soft absolute inset-0 mix-blend-screen pointer-events-none ${starBoost ? "opacity-[0.036] animate-atmo-haze" : "opacity-[0.024]"}`}
          style={HAZE_STYLE.cta}
        />
      )}

      {variant === "footer" && (
        <div
          className="atmo-soft absolute inset-0 mix-blend-screen opacity-[0.020] pointer-events-none"
          style={HAZE_STYLE.footer}
        />
      )}

      {/* Pricing — top zone (hero + plan cards): slightly stronger depth behind the heading */}
      {variant === "pricingHero" && (
        <>
          <div
            className="atmo-soft absolute inset-0 mix-blend-screen opacity-[0.030] animate-atmo-haze pointer-events-none"
            style={HAZE_STYLE.pricingHeroA}
          />
          {/* Navbar-integration reinforcement: this page's atmosphere box already extends
              to y=0 behind the transparent navbar (via the -mt-16 wrapper in pricing.tsx),
              but the haze above peaks at 30% down — leaving the very top edge (the strip
              directly behind the navbar) noticeably dimmer than the rest of the hero. This
              second layer hugs top-0 specifically so that zone reads as clearly part of the
              same night sky the instant the page loads, not just technically-present. */}
          <div
            className="atmo-soft absolute inset-x-0 top-0 h-[38%] mix-blend-screen opacity-[0.034] pointer-events-none"
            style={HAZE_STYLE.pricingHeroTop}
          />
          <div
            className="atmo-soft absolute left-[10%] top-[35%] w-[70%] max-w-[900px] h-[45vh] mix-blend-screen opacity-[0.020] pointer-events-none"
            style={HAZE_STYLE.pricingHeroC}
          />
        </>
      )}

      {/* Pricing — mid zone (comparison + usage): lighter, thinner atmospheric presence,
          spread across both the Compare and Pipeline sections rather than pooling at the top. */}
      {variant === "pricingMid" && (
        <>
          <div
            className="atmo-soft absolute left-[6%] top-[4%] w-[75%] max-w-[900px] h-[50%] mix-blend-screen opacity-[0.020] pointer-events-none"
            style={HAZE_STYLE.pricingMidA}
          />
          <div
            className="atmo-soft absolute right-[8%] top-[52%] w-[70%] max-w-[860px] h-[48%] mix-blend-screen opacity-[0.016] pointer-events-none"
            style={HAZE_STYLE.pricingMidB}
          />
        </>
      )}

      {/* Pricing — lower zone (trust / AI tiers / credits / FAQ): four sections' worth of
          height, so haze is layered top-to-bottom instead of one faint centered patch. */}
      {variant === "pricingLower" && (
        <>
          <div
            className="atmo-soft absolute left-[8%] top-[2%] w-[72%] max-w-[860px] h-[44%] mix-blend-screen opacity-[0.020] pointer-events-none"
            style={HAZE_STYLE.pricingLowerA}
          />
          <div
            className="atmo-soft absolute right-[6%] top-[38%] w-[68%] max-w-[820px] h-[40%] mix-blend-screen opacity-[0.017] pointer-events-none"
            style={HAZE_STYLE.pricingLowerB}
          />
          <div
            className="atmo-soft absolute left-[10%] top-[74%] w-[65%] max-w-[780px] h-[36%] mix-blend-screen opacity-[0.015] pointer-events-none"
            style={HAZE_STYLE.pricingLowerC}
          />
        </>
      )}

      {/* 2. Autonomous Horizontally Moving Cloud Formations */}
      {/* HERO: Full-width continuous atmospheric field spanning entire viewport + overscan */}
      {variant === "hero" && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none"
          style={{
            maskImage:
              "linear-gradient(to right, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.48) 35%, rgba(0,0,0,0.80) 65%, rgba(0,0,0,0.95) 85%, rgba(0,0,0,0.85) 100%)",
            WebkitMaskImage:
              "linear-gradient(to right, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.48) 35%, rgba(0,0,0,0.80) 65%, rgba(0,0,0,0.95) 85%, rgba(0,0,0,0.85) 100%)",
          }}
        >
          {/* Formation A (Macro Elongated Belt): Translates Left -> Right (115s loop) - mid sky */}
          <div className="absolute top-[16%] inset-x-0 h-[52%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-macro">
              <HeroCloudTileA idSuffix="a1" />
              <HeroCloudTileA idSuffix="a2" />
            </div>
          </div>

          {/* Formation B (Secondary Drift): Translates Right -> Left (82s loop) - upper sky */}
          <div className="absolute top-[-2%] inset-x-0 h-[48%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-secondary">
              <HeroCloudTileB idSuffix="b1" />
              <HeroCloudTileB idSuffix="b2" />
            </div>
          </div>

          {/* Formation C (Cirrus Ribbons): Translates Left -> Right (50s loop) - lower/mid sky */}
          <div className="absolute top-[42%] inset-x-0 h-[44%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-cirrus">
              <HeroCloudTileC idSuffix="c1" />
              <HeroCloudTileC idSuffix="c2" />
            </div>
          </div>
        </div>
      )}

      {variant === "solutions" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.075]">
          <div className="flex w-[200%] h-full animate-cloud-belt-solutions">
            <SolutionsCloudTile idSuffix="s1" />
            <SolutionsCloudTile idSuffix="s2" />
          </div>
        </div>
      )}

      {variant === "features" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.068]">
          <div className="flex w-[200%] h-full animate-cloud-belt-features">
            <FeaturesCloudTile idSuffix="f1" />
            <FeaturesCloudTile idSuffix="f2" />
          </div>
        </div>
      )}

      {/* Platform Section: Upper thin wisps + Middle depth + Lower entering formation */}
      {variant === "platform" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.085]">
          {/* Upper thin wisps (45s loop LTR) */}
          <div className="absolute top-[4%] inset-x-0 h-[46%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-platform-c">
              <PlatformCloudTileUpper idSuffix="p-up1" />
              <PlatformCloudTileUpper idSuffix="p-up2" />
            </div>
          </div>

          {/* Lower entering cloud bank (70s loop RTL) */}
          <div className="absolute bottom-[4%] inset-x-0 h-[52%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-platform-b">
              <PlatformCloudTileLower idSuffix="p-dn1" />
              <PlatformCloudTileLower idSuffix="p-dn2" />
            </div>
          </div>
        </div>
      )}

      {variant === "customers" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.045]">
          <div className="flex w-[200%] h-full animate-cloud-belt-customers">
            <CustomersCloudTile idSuffix="cu1" />
            <CustomersCloudTile idSuffix="cu2" />
          </div>
        </div>
      )}

      {/* CTA Section: quiet, late-night presence on landing; on Pricing (starBoost) this
          is the page's final atmospheric centerpiece, so the clouds get a touch more
          presence while the radial mask still keeps them subordinate to the card text. */}
      {variant === "cta" && (
        <div
          className={`absolute inset-0 overflow-hidden pointer-events-none ${starBoost ? "opacity-[0.075]" : "opacity-[0.055]"}`}
          style={{
            maskImage:
              "radial-gradient(ellipse 70% 55% at 50% 50%, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.85) 70%, rgba(0,0,0,0.95) 100%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 70% 55% at 50% 50%, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.85) 70%, rgba(0,0,0,0.95) 100%)",
          }}
        >
          <div className="absolute top-[10%] inset-x-0 h-[80%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-cta">
              <CTACloudTile idSuffix="cta1" />
              <CTACloudTile idSuffix="cta2" />
            </div>
          </div>
        </div>
      )}

      {/* Footer: Quietest late-night sky with sparse subtle wisps */}
      {variant === "footer" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.028]">
          <div className="absolute top-[15%] inset-x-0 h-[70%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-footer">
              <FooterCloudTile idSuffix="ft1" />
              <FooterCloudTile idSuffix="ft2" />
            </div>
          </div>
        </div>
      )}

      {/* Pricing hero + plan-card zone: full-width macro/secondary/cirrus bands, time-driven only */}
      {variant === "pricingHero" && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none"
          style={{
            // Full opacity (1.0, not 0.9) right at 0% — the top edge sits directly behind
            // the navbar, so cloud coverage needs to be at full strength there, not slightly
            // faded, or that strip reads as thinner than the rest of the hero.
            maskImage:
              "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.75) 55%, rgba(0,0,0,0.4) 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.75) 55%, rgba(0,0,0,0.4) 100%)",
          }}
        >
          {/* Macro cloud belt: ~118s loop — starts slightly above the box's own top edge
              (top-[-2%], matching the landing hero's overscan approach) so there's genuine
              cloud coverage right at y=0, not just the tail end of a band starting at 8%. */}
          <div className="absolute top-[-2%] inset-x-0 h-[46%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-pricing-macro">
              <PricingCloudTileMacro idSuffix="pm1" />
              <PricingCloudTileMacro idSuffix="pm2" />
            </div>
          </div>
          {/* Secondary cloud belt: ~88s loop, opposite direction */}
          <div className="absolute top-[34%] inset-x-0 h-[42%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-pricing-secondary">
              <PricingCloudTileSecondary idSuffix="ps1" />
              <PricingCloudTileSecondary idSuffix="ps2" />
            </div>
          </div>
          {/* Fine cirrus: ~58s loop */}
          <div className="absolute top-[58%] inset-x-0 h-[38%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-pricing-cirrus">
              <PricingCloudTileCirrus idSuffix="pc1" />
              <PricingCloudTileCirrus idSuffix="pc2" />
            </div>
          </div>
        </div>
      )}

      {/* Pricing mid zone: two independent, overlapping formations — reusing the exact same
          Landing tile renderers (Solutions + Platform-upper) — so Compare gets a large slow
          belt and Pipeline gets its own thin, opposite-direction belt instead of one thin
          band pooled at the top of the whole zone. */}
      {variant === "pricingMid" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {/* Compare area: large, slow belt (same renderer as Landing's Solutions section) */}
          <div className="absolute top-[2%] inset-x-0 h-[52%] overflow-hidden opacity-[0.065]">
            <div className="flex w-[200%] h-full animate-cloud-belt-solutions">
              <SolutionsCloudTile idSuffix="pmid-cmp1" />
              <SolutionsCloudTile idSuffix="pmid-cmp2" />
            </div>
          </div>
          {/* Pipeline area: thinner, opposite-direction belt (same renderer as Landing's
              Platform upper wisps), overlapping the Compare formation for a seamless handoff */}
          <div className="absolute top-[46%] inset-x-0 h-[54%] overflow-hidden opacity-[0.05]">
            <div className="flex w-[200%] h-full animate-cloud-belt-platform-c">
              <PlatformCloudTileUpper idSuffix="pmid-pipe1" />
              <PlatformCloudTileUpper idSuffix="pmid-pipe2" />
            </div>
          </div>
        </div>
      )}

      {/* Pricing lower zone: three independent, overlapping formations spanning Trust, AI,
          Data and FAQ — reusing the same Landing tile renderers (Platform-lower, Features,
          and the existing Pricing cirrus tile) at different phases/speeds/positions so the
          whole zone reads as one continuous night sky rather than a dead stretch. */}
      {variant === "pricingLower" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {/* Trust → AI area: broken, drifting cloud bank */}
          <div className="absolute top-[0%] inset-x-0 h-[44%] overflow-hidden opacity-[0.048]">
            <div className="flex w-[200%] h-full animate-cloud-belt-platform-b">
              <PlatformCloudTileLower idSuffix="plow-trust1" />
              <PlatformCloudTileLower idSuffix="plow-trust2" />
            </div>
          </div>
          {/* AI → Data area: wide, low-contrast formation */}
          <div className="absolute top-[32%] inset-x-0 h-[42%] overflow-hidden opacity-[0.04]">
            <div className="flex w-[200%] h-full animate-cloud-belt-features">
              <FeaturesCloudTile idSuffix="plow-ai1" />
              <FeaturesCloudTile idSuffix="plow-ai2" />
            </div>
          </div>
          {/* Data → FAQ area: thin cirrus, carrying the sky into the CTA's own atmosphere */}
          <div className="absolute top-[68%] inset-x-0 h-[38%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-pricing-cirrus">
              <PricingCloudTileCirrus idSuffix="plow-faq1" />
              <PricingCloudTileCirrus idSuffix="plow-faq2" />
            </div>
          </div>
        </div>
      )}

      {/* 2b. HERO DEEP FIELD (Phase 4A): static distant stars (mid layer), then sparse warm
          dust + faint bokeh (near layer). Two elements, two SVG backgrounds, no animation. */}
      {heroSky && (
        <>
          <div
            className="hero-deepfield hero-deepfield-stars absolute inset-0 pointer-events-none"
            style={layerBg(heroSky.starsUrl)}
          />
          <div
            className="hero-deepfield hero-deepfield-near absolute inset-0 pointer-events-none"
            style={layerBg(heroSky.nearUrl)}
          />
        </>
      )}

      {/* 3. Section-Specific Living Stars (No Scroll Parallax): 1 static layer + a few grouped pulse layers */}
      <div className="absolute inset-0 pointer-events-none">
        <StarLayerStack layers={layers} />
      </div>
    </div>
  );
}

// ─── Cloud SVG Tiles (Deterministic elongated procedural atmospheric formations) ──

function HeroCloudTileA({ idSuffix }: { idSuffix: string }) {
  const filterId = `hero-cloud-a-${idSuffix}`;
  const maskId = `hero-mask-a-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.11] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0018 0.008"
              numOctaves="4"
              result="noise"
              seed="42"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.54
                2.4 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="22%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="78%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function HeroCloudTileB({ idSuffix }: { idSuffix: string }) {
  const filterId = `hero-cloud-b-${idSuffix}`;
  const maskId = `hero-mask-b-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.085] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 360" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0024 0.009"
              numOctaves="4"
              result="noise"
              seed="91"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.24
                0 0 0 0 0.34
                0 0 0 0 0.58
                2.2 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="360" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="360" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function HeroCloudTileC({ idSuffix }: { idSuffix: string }) {
  const filterId = `hero-cloud-c-${idSuffix}`;
  const maskId = `hero-mask-c-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.065] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 320" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0032 0.012"
              numOctaves="3"
              result="noise"
              seed="77"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.26
                0 0 0 0 0.38
                0 0 0 0 0.62
                2.0 0 0 0 -0.8"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="30%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="320" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="320" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function SolutionsCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `sol-cloud-${idSuffix}`;
  const maskId = `sol-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0022 0.0085"
              numOctaves="3"
              result="noise"
              seed="12"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.20
                0 0 0 0 0.30
                0 0 0 0 0.50
                2.1 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="20%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="80%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function FeaturesCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `feat-cloud-${idSuffix}`;
  const maskId = `feat-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0020 0.0075"
              numOctaves="3"
              result="noise"
              seed="64"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.18
                0 0 0 0 0.26
                0 0 0 0 0.44
                2.0 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PlatformCloudTileUpper({ idSuffix }: { idSuffix: string }) {
  const filterId = `plat-up-cloud-${idSuffix}`;
  const maskId = `plat-up-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 350" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0026 0.010"
              numOctaves="3"
              result="noise"
              seed="53"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.52
                2.0 0 0 0 -0.82"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="22%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="78%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="350" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="350" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PlatformCloudTileLower({ idSuffix }: { idSuffix: string }) {
  const filterId = `plat-dn-cloud-${idSuffix}`;
  const maskId = `plat-dn-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 420" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0019 0.008"
              numOctaves="3"
              result="noise"
              seed="82"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.20
                0 0 0 0 0.28
                0 0 0 0 0.48
                2.1 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="420" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="420" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function CustomersCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `cust-cloud-${idSuffix}`;
  const maskId = `cust-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 350" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0028 0.011"
              numOctaves="3"
              result="noise"
              seed="88"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.52
                1.8 0 0 0 -0.8"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="30%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="350" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="350" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function CTACloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `cta-cloud-${idSuffix}`;
  const maskId = `cta-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 380" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0022 0.0085"
              numOctaves="3"
              result="noise"
              seed="37"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.20
                0 0 0 0 0.30
                0 0 0 0 0.50
                2.1 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="380" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="380" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PricingCloudTileMacro({ idSuffix }: { idSuffix: string }) {
  const filterId = `price-macro-cloud-${idSuffix}`;
  const maskId = `price-macro-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.09] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0017 0.0072"
              numOctaves="4"
              result="noise"
              seed="146"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.20
                0 0 0 0 0.30
                0 0 0 0 0.52
                2.3 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="22%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="78%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PricingCloudTileSecondary({ idSuffix }: { idSuffix: string }) {
  const filterId = `price-sec-cloud-${idSuffix}`;
  const maskId = `price-sec-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.07] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 360" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0023 0.0088"
              numOctaves="4"
              result="noise"
              seed="169"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.55
                2.1 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="360" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="360" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PricingCloudTileCirrus({ idSuffix }: { idSuffix: string }) {
  const filterId = `price-cirrus-cloud-${idSuffix}`;
  const maskId = `price-cirrus-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.055] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 320" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0031 0.0118"
              numOctaves="3"
              result="noise"
              seed="188"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.25
                0 0 0 0 0.36
                0 0 0 0 0.60
                1.9 0 0 0 -0.8"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="30%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="320" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="320" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function FooterCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `foot-cloud-${idSuffix}`;
  const maskId = `foot-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 320" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0028 0.010"
              numOctaves="3"
              result="noise"
              seed="95"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.18
                0 0 0 0 0.26
                0 0 0 0 0.44
                1.9 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="30%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="320" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="320" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}
