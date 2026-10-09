/**
 * Geometry and palette of the Pipeline "Flow": the forest journey map.
 *
 * Everything is placed in one coordinate space, the pixels of the wide forest background
 * (2052 × 766). The glowing path, the five rings, the stage markers and the conversion callouts
 * were all traced against that picture (pedestal tops, bridge decks, ground rings), so the
 * overlay lines up with the art at any width. Percentages derived from it are resolution-free.
 */

export const BG = { w: 2052, h: 766 };
/** The whole picture is the coordinate space (the band shows the part of it around the journey). */
export const CROP = { y0: 0, y1: BG.h };
export const CROP_H = CROP.y1 - CROP.y0;
/** The vertical centre of the journey in the picture: the band is centred on this. */
export const FOCUS_Y = 445;
/** Sizes below were drawn for a 1672-wide picture; this carries them over to the current one. */
export const SCALE = BG.w / 1672;

export const xPct = (x: number) => (x / BG.w) * 100;
export const yPct = (y: number) => ((y - CROP.y0) / CROP_H) * 100;
/** 1 background pixel, expressed in container-width units (cqw). */
export const px = (n: number) => `${(((n * SCALE) / BG.w) * 100).toFixed(3)}cqw`;

type Pt = [number, number];

/** Purple → blue → green → orange → white: the journey's colour progression. */
export const PALETTE = {
  purple: "#c04bff",
  indigo: "#7a6bff",
  blue: "#2f7bff",
  cyan: "#19c6ff",
  green: "#22e58f",
  lime: "#d9ee4c",
  orange: "#ff8a1c",
  amber: "#ffc766",
  white: "#ffffff",
} as const;

export type ForestStage = {
  /** Colour of the ring, the marker tile and the conversion callout that starts at this stage. */
  color: string;
  /** Pale tint of `color`: the bright core of the ring. */
  core: string;
  /** Centre of the pedestal's top face; the marker floats just above it. */
  top: Pt;
  /** The glowing ring on the ground around the pedestal: centre and radii. */
  ring: { cx: number; cy: number; rx: number; ry: number };
};

export const STAGES: ForestStage[] = [
  {
    color: PALETTE.purple,
    core: "#f1d6ff",
    top: [358, 358],
    ring: { cx: 356, cy: 410, rx: 100, ry: 28 },
  },
  {
    color: PALETTE.blue,
    core: "#cfe1ff",
    top: [652, 424],
    ring: { cx: 650, cy: 478, rx: 92, ry: 26 },
  },
  {
    color: PALETTE.green,
    core: "#d2ffe9",
    top: [989, 468],
    ring: { cx: 990, cy: 565, rx: 135, ry: 34 },
  },
  {
    color: PALETTE.orange,
    core: "#ffe2bd",
    top: [1354, 465],
    ring: { cx: 1355, cy: 520, rx: 92, ry: 28 },
  },
  {
    color: PALETTE.white,
    core: "#ffffff",
    top: [1707, 355],
    ring: { cx: 1710, cy: 410, rx: 100, ry: 26 },
  },
];

/** Half-width and half-height of a pedestal's top face (its front edge is lit in the stage colour). */
export const TOP_RIM = { rx: 60, ry: 14 };

/**
 * The four bridges, as points along each deck's glowing rail (background px), with the colours the
 * light turns through on the way. Each starts and ends where the deck meets a pedestal (or a ring).
 */
/**
 * The four bridges, as points along each deck's glowing rail (background px), with the colours the
 * light turns through on the way. Each starts and ends where the deck meets a pedestal.
 */
export const BRIDGES: { pts: Pt[]; stops: string[] }[] = [
  {
    // New → Contacted
    pts: [
      [418, 350],
      [455, 358],
      [490, 375],
      [520, 398],
      [550, 420],
      [580, 437],
      [600, 442],
    ],
    stops: [PALETTE.purple, PALETTE.indigo, PALETTE.blue],
  },
  {
    // Contacted → Replied
    pts: [
      [715, 425],
      [745, 432],
      [780, 452],
      [820, 474],
      [860, 490],
      [900, 500],
      [920, 503],
    ],
    stops: [PALETTE.blue, PALETTE.cyan, PALETTE.green],
  },
  {
    // Replied → Meeting
    pts: [
      [1060, 465],
      [1110, 462],
      [1160, 472],
      [1210, 490],
      [1255, 505],
      [1290, 512],
      [1300, 515],
    ],
    stops: [PALETTE.green, PALETTE.lime, PALETTE.orange],
  },
  {
    // Meeting → Closed
    pts: [
      [1425, 478],
      [1470, 456],
      [1510, 440],
      [1550, 422],
      [1600, 392],
      [1640, 368],
      [1655, 362],
    ],
    stops: [PALETTE.orange, PALETTE.amber, PALETTE.white],
  },
];

/** Short runs of light between a ring and a bridge: none needed here, the decks meet the pedestals directly. */
export const LINKS: { stage: number; pts: Pt[] }[] = [];

/** Where each stage-to-stage conversion callout sits (background px, centre of the card). */
export const CALLOUTS: Pt[] = [
  [510, 306],
  [822, 392],
  [1185, 404],
  [1540, 352],
];

/** The ring is drawn from the back-right, round the front, to the back-left; the back disappears behind the pedestal. */
export const RING_ARC = { from: -30, to: 210 };

/** Smooth cubic path through the points (Catmull-Rom). */
export function smoothPath(pts: Pt[]): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

const ellipsePt = (cx: number, cy: number, rx: number, ry: number, deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
};

/** An elliptical arc from one angle to another, clockwise on screen (0° = right, 90° = front). */
export function arcPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
): string {
  const [x0, y0] = ellipsePt(cx, cy, rx, ry, from);
  const [x1, y1] = ellipsePt(cx, cy, rx, ry, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rx} ${ry} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** Mix a #rrggbb colour towards white (amount 0–1). */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v + (255 - v) * amount);
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
