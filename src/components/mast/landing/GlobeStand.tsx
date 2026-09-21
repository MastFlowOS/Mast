import {
  SignatureGlobe,
  SPHERE_FRACTION as GLOBE_SPHERE_FRACTION,
  CENTER_FRACTION as GLOBE_CENTER_Y_FRACTION,
} from "./SignatureGlobe";

/**
 * GlobeStand — composites the approved static bronze stand PNG with the
 * existing live <SignatureGlobe/> canvas so the globe reads as one physical
 * object: a sphere held by the stand's two pivots inside its meridian ring.
 *
 *  - the stand is one static <img>: never redrawn, animated, or recreated in
 *    SVG/Canvas/WebGL, and the PNG is not modified
 *  - <SignatureGlobe/> keeps its own canvas, rAF loop, rotation and data; this
 *    file only decides where its box sits, how large it is, and how far its
 *    polar axis leans
 *  - no timers, listeners or observers live here
 *
 * GEOMETRY (all numbers are pixels of the 1072x1467 stand asset)
 * --------------------------------------------------------------
 * Measured from the alpha channel of the asset, not eyeballed:
 *
 *  1. Meridian ring — a circle fitted to the ring's inner edge (rms error
 *     1.4px over 130deg of arc) gives centre (504.7, 570.6), R 481.7.
 *  2. Pivot axis — both end barrels are the same part (knob up, cup down)
 *     tilted 22deg from vertical, i.e. the stand's polar lean. The top
 *     barrel's axis line passes within ~17px of the ring centre.
 *  3. The seat — sliding a disc along that axis and asking for the largest
 *     disc that touches no stand pixel peaks at centre (522, 557), R 422.
 *     There it is tangent to the top barrel's cup AND the bottom barrel's
 *     knob at the same time — the two pivots independently define the same
 *     sphere. (A globe concentric with the ring can be at most R 400 before
 *     it hits the knob, which is why "a fraction of the ring radius" always
 *     looked like it was floating.)
 *
 * The rendered sphere is that seat minus a small clearance, which leaves ~6px
 * to each pivot and ~42px (about 10% of R) to the ring, with no stand pixel
 * inside the disc.
 *
 * Because everything below is a percentage of the stand box, whose own aspect
 * ratio is fixed, the relationship holds at every size with no per-breakpoint
 * offsets.
 *
 * LAYERING
 * --------
 * The sphere never overlaps the stand, so no front/back split of the PNG is
 * needed. The stand is simply painted *above* the canvas so the globe's soft
 * atmospheric glow (which extends ~5% past the limb) tucks behind the metal
 * at the pivots instead of washing over it. The globe box deliberately has no
 * z-index of its own: that would trap SignatureGlobe's country label in a
 * lower stacking context; left alone the label (z-30) stays above the stand.
 */

const STAND_ASSET = "/images/globe-stand.png";
const STAND_WIDTH_PX = 1072;
const STAND_HEIGHT_PX = 1467;
const STAND_ASPECT_RATIO = `${STAND_WIDTH_PX} / ${STAND_HEIGHT_PX}`;

// Sphere seat, in stand-asset pixels (see GEOMETRY above).
const SPHERE_CENTER_X_PX = 522;
const SPHERE_CENTER_Y_PX = 557;
const SPHERE_RADIUS_PX = 416; // largest fit is 422; 6px left as clearance
// The stand's polar lean from vertical (the end barrels' tilt), clockwise.
const STAND_AXIS_TILT_DEG = 22;

// SignatureGlobe centres its sphere horizontally in its box; vertically and
// in size it uses the exported fractions (imported above, not mirrored).
const GLOBE_CENTER_X_FRACTION = 0.5;

// SignatureGlobe's box is square and its sphere radius is fraction * side.
const globeBoxSizePx = SPHERE_RADIUS_PX / GLOBE_SPHERE_FRACTION;
const globeBoxLeftPx = SPHERE_CENTER_X_PX - globeBoxSizePx * GLOBE_CENTER_X_FRACTION;
const globeBoxTopPx = SPHERE_CENTER_Y_PX - globeBoxSizePx * GLOBE_CENTER_Y_FRACTION;

const pct = (px: number, of: number) => `${((px / of) * 100).toFixed(3)}%`;

const globeBoxStyle = {
  left: pct(globeBoxLeftPx, STAND_WIDTH_PX),
  top: pct(globeBoxTopPx, STAND_HEIGHT_PX),
  width: pct(globeBoxSizePx, STAND_WIDTH_PX),
  height: pct(globeBoxSizePx, STAND_HEIGHT_PX),
} as const;

export function GlobeStand({ className = "" }: { className?: string }) {
  return (
    // 92.5% of the column keeps the whole pedestal comfortably inside the hero
    // (a small reduction, proportions untouched), and the -3% lift is a
    // fraction of the stand's own height so it scales with it.
    <div
      className={`relative mx-auto h-[92.5%] -translate-y-[3%] ${className}`}
      style={{ aspectRatio: STAND_ASPECT_RATIO }}
    >
      {/* Live globe, seated on the measured sphere. No z-index here on purpose
          (see LAYERING). */}
      <div className="absolute" style={globeBoxStyle}>
        <SignatureGlobe
          className="w-full h-full overflow-visible"
          axisTiltDeg={STAND_AXIS_TILT_DEG}
        />
      </div>

      {/* Static stand asset — never animated, never redrawn. Above the canvas,
          below the label. */}
      <img
        src={STAND_ASSET}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full select-none"
      />
    </div>
  );
}
