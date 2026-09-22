/**
 * GlobePresentationSurface — renders the globe's ground plane as a continuous,
 * cinematic floor/environment that the globe stands inside, rather than a small
 * circular mat sitting underneath it.
 *
 * Composition (back to front):
 *   1. floorBed   — a very large, soft dark field that gives the whole lower/right
 *                    portion of the hero a sense of "large reflective room", anchored
 *                    below and slightly left of the pedestal so it reads as a floor
 *                    the globe stands *inside*, not a spotlight centered on it.
 *   2. floorHaze  — a wide, flat ellipse around the pedestal. Deliberately much wider
 *                    than it is tall (a circle foreshortened by a low viewing angle),
 *                    which is what gives the floor its "receding into the scene"
 *                    perspective without any 3D transform.
 *   3. floorMid   — a tighter, more saturated ellipse in the same spot: the part of
 *                    the floor closest to camera, i.e. the most "present" part of the
 *                    surface right around the pedestal.
 *   4. ringsAsset — the original photographic radar/astrolabe floor asset (unchanged
 *                    pixels), scaled up and layered on top so its rings, graduation
 *                    marks and glints read as markings embedded in the floor above,
 *                    not as the floor's entire boundary.
 *   5. contactShadow — small dark ellipse right at the base, grounding the pedestal.
 *   6. goldGlow   — small warm gold reflection at the exact contact point, screened
 *                    on top so it reads as light bouncing off the floor by the base.
 *
 * All layers are pure CSS radial-gradient divs (steps 1-3, 5-6) plus the one existing
 * raster asset (step 4) — no canvas, no WebGL, no new images, no animation. Every
 * layer is sized and positioned with percentages anchored to the same pedestal
 * contact point used by the ring asset, so the whole environment scales together
 * with GlobeStand's own responsive height across breakpoints.
 *
 * Pedestal contact point (globe/stand asset): 46.64% horizontal, 94.2% vertical —
 * the widest point of the base, where it visually meets the ground. This anchor is
 * shared by every layer below; only the ring asset additionally needs its own
 * internal offset (translate(-56.84%, -49.27%)) because — unlike the gradient
 * layers, which are symmetric and centered on their own box — the photographed
 * ring asset's own innermost-ring center isn't at the center of its frame.
 *
 * Every gradient's outermost stop is fully transparent well inside its own box
 * (never at the box edge), so nothing ever shows a rectangular cutoff — the floor
 * simply fades away in every direction, including toward the bottom of the hero.
 */

const RADAR_FLOOR_ASSET = "/images/mast-radar-floor.webp";

const PEDESTAL_LEFT = "46.64%";
const PEDESTAL_TOP = "94.2%";

type GradientLayer = {
  key: string;
  width: string;
  height: string;
  left: string;
  top: string;
  translate: string;
  background: string;
  mixBlendMode?: React.CSSProperties["mixBlendMode"];
};

const GRADIENT_LAYERS: GradientLayer[] = [
  // 1. Broad ambient floor bed — establishes the large dark "room" the globe stands
  // inside, offset down/left of the pedestal so the globe reads as placed within it
  // rather than centered on top of it.
  {
    key: "floorBed",
    width: "480%",
    height: "200%",
    left: "43%",
    top: "118%",
    translate: "translate(-50%, -50%)",
    background:
      "radial-gradient(ellipse at center, rgba(26,21,16,0.50) 0%, rgba(18,15,12,0.30) 38%, rgba(12,10,9,0.14) 62%, rgba(12,10,9,0) 82%)",
  },
  // 2. Wide, flat perspective ellipse around the pedestal — a circle foreshortened
  // by a low viewing angle, which is what sells "floor receding into the scene".
  {
    key: "floorHaze",
    width: "300%",
    height: "76%",
    left: PEDESTAL_LEFT,
    top: PEDESTAL_TOP,
    translate: "translate(-50%, -42%)",
    background:
      "radial-gradient(ellipse at center, rgba(52,42,28,0.50) 0%, rgba(40,32,22,0.28) 42%, rgba(40,32,22,0) 74%)",
  },
  // 3. Tighter, more saturated plane closest to the pedestal.
  {
    key: "floorMid",
    width: "195%",
    height: "48%",
    left: PEDESTAL_LEFT,
    top: PEDESTAL_TOP,
    translate: "translate(-50%, -40%)",
    background:
      "radial-gradient(ellipse at center, rgba(68,52,32,0.55) 0%, rgba(48,38,24,0.30) 46%, rgba(48,38,24,0) 76%)",
  },
];

// Rendered after the rings asset: grounds the pedestal, then lights it.
const CONTACT_LAYERS: GradientLayer[] = [
  {
    key: "contactShadow",
    width: "58%",
    height: "15%",
    left: PEDESTAL_LEFT,
    top: "95%",
    translate: "translate(-50%, -50%)",
    background:
      "radial-gradient(ellipse at center, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.22) 50%, rgba(0,0,0,0) 80%)",
  },
  {
    key: "goldGlow",
    width: "66%",
    height: "19%",
    left: PEDESTAL_LEFT,
    top: "93.4%",
    translate: "translate(-50%, -50%)",
    background:
      "radial-gradient(ellipse at center, rgba(216,171,96,0.42) 0%, rgba(216,171,96,0.16) 48%, rgba(216,171,96,0) 78%)",
    mixBlendMode: "screen",
  },
];

function FloorLayer({ layer }: { layer: GradientLayer }) {
  return (
    <div
      className="pointer-events-none absolute select-none"
      style={{
        width: layer.width,
        height: layer.height,
        left: layer.left,
        top: layer.top,
        transform: layer.translate,
        background: layer.background,
        mixBlendMode: layer.mixBlendMode,
      }}
    />
  );
}

export function GlobePresentationSurface() {
  return (
    <div
      className="pointer-events-none absolute inset-0 select-none overflow-visible z-0"
      aria-hidden="true"
    >
      {GRADIENT_LAYERS.map((layer) => (
        <FloorLayer key={layer.key} layer={layer} />
      ))}

      {/* Photographic rings/astrolabe markings, embedded in the floor above —
          same asset, same pedestal anchor math as before, just scaled up so it
          reads as detail on a large floor rather than the floor's own boundary. */}
      <img
        src={RADAR_FLOOR_ASSET}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none object-contain max-w-none"
        style={{
          width: "225%",
          left: PEDESTAL_LEFT,
          top: PEDESTAL_TOP,
          transform: "translate(-56.84%, -49.27%)",
        }}
      />

      {CONTACT_LAYERS.map((layer) => (
        <FloorLayer key={layer.key} layer={layer} />
      ))}
    </div>
  );
}
