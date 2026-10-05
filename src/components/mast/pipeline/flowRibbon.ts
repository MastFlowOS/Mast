/**
 * Shared geometry for the Pipeline flow. Everything (the ribbon artwork, the rings, the counts,
 * the cards and the alerts) is placed in one coordinate space, the 2172 × 724 "artwork space" the
 * supplied ribbon was drawn in, so the overlay lines up with the artwork at any width.
 */

export const ART = { w: 2172, h: 724 };
/** Crop the artwork's empty top and bottom margins (no content is cut: it spans y 81 → 602). */
export const CROP = { y0: 60, y1: 640 };
export const CROP_H = CROP.y1 - CROP.y0;

/** Centres of the five stage circles, in artwork pixels. */
export const ART_NODES = [
  { x: 305, y: 389.5 },
  { x: 723, y: 390.3 },
  { x: 1142, y: 394.6 },
  { x: 1558, y: 395 },
  { x: 1957, y: 397.2 },
];

/** Radius of the centre-line of each ring. */
export const RING_R = 66;

/** Where an alert pins to the ribbon's upper edge beside each circle (artwork px). */
export const ART_ANCHORS = [
  { x: 403, y: 221 },
  { x: 821, y: 163 },
  { x: 1240, y: 232 },
  { x: 1656, y: 267 },
  { x: 1859, y: 306 },
];
