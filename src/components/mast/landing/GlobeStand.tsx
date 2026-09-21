import {
  SignatureGlobe,
  SPHERE_FRACTION as GLOBE_SPHERE_FRACTION,
  CENTER_FRACTION as GLOBE_CENTER_Y_FRACTION,
} from "./SignatureGlobe";
import { GlobeCosmicParticles } from "./GlobeCosmicParticles";

/**
 * GlobeStand — composites the authentic antique bronze stand with the
 * live <SignatureGlobe/> canvas so the globe reads as one physical object:
 * a sphere mounted between the stand's two brass pivot cups inside its meridian ring.
 *
 * GEOMETRY (measured from the 1072x1467 stand asset)
 * --------------------------------------------------
 * 1. North Pole Pivot: Cylinder at 21.5° lean, cup contact at (678, 124).
 * 2. South Pole Pivot: Cylinder at 21.5° lean, cup contact at (331.6, 1003.6).
 * 3. Sphere Center: Midpoint between pivot contacts = (502, 571).
 * 4. Sphere Radius: Distance from center to pivot cup = 466px.
 * 5. Polar Lean: Clockwise axis tilt = 21.5°.
 *
 * LAYERING
 * --------
 * - Background: Behind-globe cosmic stardust ribbon and astrolabe tabletop floor (z-0)
 * - Canvas: Live rotating <SignatureGlobe /> (z-[5])
 * - Hardware: Stand image (z-10) with pivot cups clamping onto the globe's poles
 * - Foreground: Cascading foreground stardust bokeh ribbon (z-20)
 * - Editorial: Discovery country label and opportunity confirmation (z-30)
 */

const STAND_ASSET = "/images/globe-stand.png";
const STAND_WIDTH_PX = 1072;
const STAND_HEIGHT_PX = 1467;
const STAND_ASPECT_RATIO = `${STAND_WIDTH_PX} / ${STAND_HEIGHT_PX}`;

// Sphere seat, in stand-asset pixels
const SPHERE_CENTER_X_PX = 502;
const SPHERE_CENTER_Y_PX = 571;
const SPHERE_RADIUS_PX = 466;

// Stand's polar lean from vertical, clockwise
const STAND_AXIS_TILT_DEG = 21.5;

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
    <div
      className={`relative mx-auto h-[92.5%] -translate-y-[3%] ${className}`}
      style={{ aspectRatio: STAND_ASPECT_RATIO }}
    >
      {/* 1. Behind layer: Tabletop celestial astrolabe floor & background stardust ribbon */}
      <GlobeCosmicParticles layer="behind" className="z-0" />

      {/* 2. Live digital globe, perfectly clamped between the measured pivots */}
      <div className="absolute z-[5]" style={globeBoxStyle}>
        <SignatureGlobe
          className="w-full h-full overflow-visible"
          axisTiltDeg={STAND_AXIS_TILT_DEG}
        />
      </div>

      {/* 3. Static bronze stand asset — sits in front of the globe canvas so both
          pivot cups visibly grip the sphere poles */}
      <img
        src={STAND_ASSET}
        alt="Mast antique bronze globe stand"
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full select-none"
      />

      {/* 4. Foreground layer: Cascading golden stardust ribbon & glowing bokeh orbs */}
      <GlobeCosmicParticles layer="infront" className="z-20" />
    </div>
  );
}
