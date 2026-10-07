/**
 * Geometry and palette of the Pipeline "Flow": the forest journey map.
 *
 * Everything is placed in one coordinate space, the pixels of the supplied forest background
 * (1672 × 941). The glowing path, the five rings, the stage markers and the conversion callouts
 * were all traced against that picture (pedestal tops, bridge decks, ground rings), so the
 * overlay lines up with the art at any width. Percentages derived from it are resolution-free.
 */

export const BG = { w: 1672, h: 941 };
/** The slice of the picture that is shown (the sky above and the dark undergrowth below are cropped). */
export const CROP = { y0: 70, y1: 800 };
export const CROP_H = CROP.y1 - CROP.y0;

export const xPct = (x: number) => (x / BG.w) * 100;
export const yPct = (y: number) => ((y - CROP.y0) / CROP_H) * 100;
/** 1 background pixel, expressed in container-width units (cqw). */
export const px = (n: number) => `${((n / BG.w) * 100).toFixed(3)}cqw`;

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
    top: [192, 405],
    ring: { cx: 192, cy: 462, rx: 100, ry: 46 },
  },
  {
    color: PALETTE.blue,
    core: "#cfe1ff",
    top: [505, 471],
    ring: { cx: 500, cy: 552, rx: 102, ry: 42 },
  },
  {
    color: PALETTE.green,
    core: "#d2ffe9",
    top: [865, 540],
    ring: { cx: 865, cy: 630, rx: 118, ry: 46 },
  },
  {
    color: PALETTE.orange,
    core: "#ffe2bd",
    top: [1195, 508],
    ring: { cx: 1195, cy: 570, rx: 102, ry: 50 },
  },
  {
    color: PALETTE.white,
    core: "#ffffff",
    top: [1550, 338],
    ring: { cx: 1550, cy: 402, rx: 98, ry: 48 },
  },
];

/** Half-width and half-height of a pedestal's top face (its front edge is lit in the stage colour). */
export const TOP_RIM = { rx: 78, ry: 16 };

/**
 * The four bridges, as points along each deck's glowing rail (background px), with the colours the
 * light turns through on the way. Each starts and ends where the deck meets a pedestal (or a ring).
 */
export const BRIDGES: { pts: Pt[]; stops: string[] }[] = [
  {
    // New → Contacted
    pts: [
      [262, 388],
      [280, 394],
      [300, 402],
      [318, 414],
      [335, 430],
      [348, 445],
      [360, 460],
      [370, 473],
      [380, 485],
      [395, 495],
      [410, 502],
      [426, 509],
    ],
    stops: [PALETTE.purple, PALETTE.indigo, PALETTE.blue],
  },
  {
    // Contacted → Replied
    pts: [
      [578, 483],
      [600, 490],
      [625, 503],
      [650, 520],
      [675, 540],
      [700, 558],
      [720, 571],
      [745, 580],
      [774, 586],
    ],
    stops: [PALETTE.blue, PALETTE.cyan, PALETTE.green],
  },
  {
    // Replied → Meeting (runs into the Meeting ring)
    pts: [
      [950, 542],
      [975, 544],
      [1000, 547],
      [1025, 556],
      [1050, 567],
      [1075, 577],
      [1095, 590],
      [1107, 596],
    ],
    stops: [PALETTE.green, PALETTE.lime, PALETTE.orange],
  },
  {
    // Meeting → Closed (leaves the Meeting ring, climbs to the Closed ring)
    pts: [
      [1283, 546],
      [1282, 530],
      [1292, 514],
      [1307, 497],
      [1317, 482],
      [1327, 465],
      [1345, 450],
      [1370, 417],
      [1387, 400],
      [1405, 387],
      [1430, 375],
      [1452, 368],
      [1462, 377],
    ],
    stops: [PALETTE.orange, PALETTE.amber, PALETTE.white],
  },
];

/**
 * Short runs of light that carry the path between a ring and the deck of the bridge beside it, so
 * the journey flows through every stage instead of breaking at the pedestals. `stage` is the ring it
 * leaves from (it takes that ring's colour, which is also the colour of the bridge end it meets).
 */
export const LINKS: { stage: number; pts: Pt[] }[] = [
  {
    stage: 0,
    pts: [
      [279, 439],
      [287, 424],
      [285, 408],
      [273, 394],
      [262, 388],
    ],
  }, // New ring → bridge 1
  {
    stage: 1,
    pts: [
      [426, 509],
      [420, 518],
      [412, 531],
    ],
  }, // bridge 1 → Contacted ring
  {
    stage: 1,
    pts: [
      [588, 531],
      [593, 515],
      [590, 498],
      [578, 483],
    ],
  }, // Contacted ring → bridge 2
  {
    stage: 2,
    pts: [
      [774, 586],
      [768, 596],
      [763, 607],
    ],
  }, // bridge 2 → Replied ring
  {
    stage: 2,
    pts: [
      [967, 607],
      [972, 590],
      [968, 568],
      [958, 552],
      [950, 542],
    ],
  }, // Replied ring → bridge 3
];

/** Where each stage-to-stage conversion callout sits (background px, centre of the card). */
export const CALLOUTS: Pt[] = [
  [281, 319],
  [607, 387],
  [912, 422],
  [1228, 369],
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
