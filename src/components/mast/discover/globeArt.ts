/**
 * Geometry of the supplied Discover globe artwork (`discover-globe.png`,
 * 1774 × 887). The PNG already contains the planet, atmosphere, stars and
 * orbit lines, so these numbers only tell the page where the planet's disk
 * sits inside it — measured from the file, not from the design.
 *
 * The planet in the artwork is a very slightly flattened ellipse
 * (rx 370 × ry 349.5).
 */

export const GLOBE_ART = {
  /** Intrinsic image size, px. */
  w: 1774,
  h: 887,
  /** Planet centre and radii inside the image, px. */
  cx: 887,
  cy: 445.5,
  rx: 370,
  ry: 349.5,
} as const;
