import { SignatureGlobe } from "./SignatureGlobe";

/**
 * GlobeStand — composites the approved static bronze/gold stand asset with
 * the existing live <SignatureGlobe/> canvas so the globe appears physically
 * seated inside the stand's meridian ring.
 *
 * This is a pure compositing layer:
 *  - the stand is a single static <img>, never redrawn, animated, or
 *    recreated in SVG/Canvas/WebGL
 *  - <SignatureGlobe/> is used completely unmodified — its own rendering,
 *    rAF loop, rotation and dot logic are untouched; this file only decides
 *    where its container sits and how big it is
 *
 * GEOMETRY
 * --------
 * The stand artwork is 1072x1467px. Its inner ring opening (the circular
 * space a globe would sit in) was measured directly from the asset by
 * fitting a circle to the ring's inner edge:
 *   center  ≈ (485.8, 568.1)   in image-pixel space
 *   radius  ≈ 498.2px
 *
 * SignatureGlobe draws its sphere at a fixed, fraction-based geometry
 * relative to its own container (see SignatureGlobe.tsx, untouched here):
 *   sphere center = (50%, 43%) of the container
 *   sphere radius = 32% of min(container width, container height)
 *
 * To make the live sphere line up with the stand's ring opening — with a
 * bit of breathing room so it doesn't touch the band — the SignatureGlobe
 * container is sized so its 32%-radius sphere equals ~80% of the ring's
 * inner radius, then offset so its (50%, 43%) center lands exactly on the
 * ring's measured center. Both values are expressed as percentages of the
 * stand box, so the composition stays correct at any size (desktop,
 * tablet, mobile) without per-breakpoint overrides.
 */

const STAND_ASSET = "/images/globe-stand.png";
const STAND_ASPECT_RATIO = "1072 / 1467";

// Measured from the stand asset (image-pixel space, 1072 wide x 1467 tall).
const RING_CENTER_X = 485.78;
const RING_CENTER_Y = 568.11;
const RING_INNER_RADIUS = 498.2;

// Sphere fills 80% of the ring opening, leaving a realistic gap to the band.
const GLOBE_FIT_FRACTION = 0.8;

// SignatureGlobe's own internal constants (must mirror SignatureGlobe.tsx).
const GLOBE_SPHERE_FRACTION = 0.32;
const GLOBE_CENTER_X_FRACTION = 0.5;
const GLOBE_CENTER_Y_FRACTION = 0.43;

const STAND_WIDTH_PX = 1072;
const STAND_HEIGHT_PX = 1467;

const targetSphereRadius = RING_INNER_RADIUS * GLOBE_FIT_FRACTION;
// SignatureGlobe's container is square: its own r = min(w,h) * 0.32, so a
// square box of side D gives a sphere radius of D * 0.32.
const globeBoxSizePx = targetSphereRadius / GLOBE_SPHERE_FRACTION;

const globeBoxLeftPx = RING_CENTER_X - globeBoxSizePx * GLOBE_CENTER_X_FRACTION;
const globeBoxTopPx = RING_CENTER_Y - globeBoxSizePx * GLOBE_CENTER_Y_FRACTION;

const globeBoxStyle = {
  left: `${((globeBoxLeftPx / STAND_WIDTH_PX) * 100).toFixed(3)}%`,
  top: `${((globeBoxTopPx / STAND_HEIGHT_PX) * 100).toFixed(3)}%`,
  width: `${((globeBoxSizePx / STAND_WIDTH_PX) * 100).toFixed(3)}%`,
  height: `${((globeBoxSizePx / STAND_HEIGHT_PX) * 100).toFixed(3)}%`,
} as const;

export function GlobeStand({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative mx-auto h-full ${className}`}
      style={{ aspectRatio: STAND_ASPECT_RATIO }}
    >
      {/* Live globe, sized/positioned so its sphere sits fully inside the
          ring's transparent opening (no pixel overlap with the ring or
          base artwork — see geometry notes above). Explicit z-10 keeps the
          whole SignatureGlobe subtree — including its own country-name
          label, which SignatureGlobe already elevates internally — above
          the static stand image, regardless of DOM order. */}
      <div className="absolute z-10" style={globeBoxStyle}>
        <SignatureGlobe className="w-full h-full overflow-visible" />
      </div>

      {/* Static stand asset — never animated, never redrawn. It sits below
          the globe's z-10 layer; that's safe because the sphere is sized to
          stay fully inside the ring's opening, so the two never overlap in
          practice — this just guarantees the label is never hidden. */}
      <img
        src={STAND_ASSET}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 z-0 h-full w-full select-none"
      />
    </div>
  );
}
