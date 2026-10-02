/**
 * Geometry of the supplied Discover globe artwork (`discover-globe.png`,
 * 1774 × 887). The PNG already contains the planet, atmosphere, stars and
 * orbit lines, so these numbers only tell the page where the planet's disk
 * sits inside it — measured from the file, not from the design.
 *
 * The planet in the artwork is a very slightly flattened ellipse
 * (rx 370 × ry 349.5), so the interactive overlay is flattened to match.
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

/** Planet height ÷ planet width. */
export const GLOBE_ASPECT = GLOBE_ART.ry / GLOBE_ART.rx;

/**
 * The camera the artwork was painted from (Americas facing us). The overlay
 * projects with this view whenever the selection is already on show, so
 * highlighted countries land on the countries printed in the PNG.
 */
export const ART_VIEW = { lon: -61, lat: 12, k: 1 } as const;
