import {
  SignatureGlobe,
  SPHERE_FRACTION as GLOBE_SPHERE_FRACTION,
  CENTER_FRACTION as GLOBE_CENTER_Y_FRACTION,
} from "./SignatureGlobe";

/**
 * GlobeStand — composites the approved static bronze stand PNG with the
 * existing live <SignatureGlobe/> canvas so the two read as ONE physical
 * object: a sphere mounted between the stand's two pivots, seated inside its
 * meridian ring.
 *
 *  - the stand is one static <img>: never redrawn, animated, or recreated in
 *    SVG/Canvas/WebGL, and the PNG itself is not modified
 *  - <SignatureGlobe/> keeps its own canvas, rAF loop, rotation and data; this
 *    file only decides where its box sits, how large it is, and how far its
 *    polar axis leans
 *  - no timers, listeners or observers live here
 *
 * GEOMETRY (all numbers are pixels of the 1072x1467 stand asset)
 * --------------------------------------------------------------
 * Measured from the alpha channel of the asset, not eyeballed.
 *
 * The previous revision sized the globe as "the largest disc that touches no
 * stand pixel" (R 416 at 522,557). That constraint was the bug: it is the
 * definition of a sphere that is NEAR the hardware rather than HELD by it, so
 * the result always read as a ring plus a floating digital sphere. On a real
 * globe the poles sit INSIDE the pivot cups — the hardware overlaps the ball.
 *
 * The correct seat is defined twice over, by two independent features that
 * agree to within 2px:
 *
 *  1. Meridian ring — a circle fitted to the ring's inner edge over 128deg of
 *     arc gives centre (498.0, 569.5), R 487.6 (rms 1.4px, 256 samples).
 *  2. Top pivot cup — the only part of the stand (besides the lower arm) that
 *     intrudes inside that circle. Its centroid is (686.8, 142.6), which is
 *     466.8px from the ring centre, on a bearing of 23.9deg from vertical.
 *
 * So a sphere centred on the ring centre with R 467 puts its north pole
 * exactly at the centre of the pivot cup, and sits 20.6px (4.2% of R) clear of
 * the ring's inner edge all the way round. That 0.958 globe-to-ring ratio is
 * also what the supplied reference image measures (globe limb R 209.7 against
 * a ring inner radius of ~219 — a ratio of 0.957).
 *
 * The lean is the same 23.9deg bearing, which is the stand's own polar axis.
 *
 * LAYERING
 * --------
 * No front/back split of the PNG is needed, and none is used. With the sphere
 * on its true seat the only stand parts that overlap it are the two pivot cups
 * and the lower arm — all of which are correctly IN FRONT of the ball on a
 * real globe. The ring band never overlaps it at all. So the stand is simply
 * painted above the canvas, which gives correct occlusion, lets the pivots
 * visibly bite into the sphere, and tucks the globe's atmospheric glow behind
 * the metal instead of washing over it.
 *
 * The globe box deliberately has no z-index of its own: that would trap
 * SignatureGlobe's country label in a lower stacking context; left alone the
 * label (z-30) stays above the stand.
 */

const STAND_ASSET = "/images/globe-stand.png";
const STAND_WIDTH_PX = 1072;
const STAND_HEIGHT_PX = 1467;
const STAND_ASPECT_RATIO = `${STAND_WIDTH_PX} / ${STAND_HEIGHT_PX}`;

// Sphere seat, in stand-asset pixels (see GEOMETRY above).
const SPHERE_CENTER_X_PX = 498;
const SPHERE_CENTER_Y_PX = 569.5;
const SPHERE_RADIUS_PX = 467;
// The stand's polar lean from vertical (ring centre -> top pivot cup), clockwise.
const STAND_AXIS_TILT_DEG = 23.9;

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
