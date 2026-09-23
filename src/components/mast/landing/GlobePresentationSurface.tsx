/**
 * GlobePresentationSurface — renders the globe's ground plane as a continuous,
 * cinematic floor/environment that the globe stands inside, rather than a small
 * circular mat sitting underneath it.
 *
 * PHASE 1A — floor structure only. The three pedestal-centered "pool" layers
 * that used to sit here (floorBed / floorHaze / floorMid — all radial ellipses
 * concentric with the pedestal, stacked so their brightness peaked together
 * right at the base) read as a glowing spotlight disc under the globe. They
 * have been replaced with a floor built the opposite way: broad and largely
 * flat/uniform across the hero, only loosely centered on the pedestal, with
 * a genuine CSS 3D tilt for the near band instead of relying on concentric
 * rings of brightness to imply depth.
 *
 * PHASE 1B — radar floor markings only. The floor structure above (its size,
 * perspective, fade and placement) is unchanged from 1A. This phase only
 * changes how the existing mast-radar-floor.webp asset is presented: it now
 * carries the same perspective tilt as the floor itself, fades out via a soft
 * mask instead of relying solely on its own baked-in edge fade, and is toned
 * down (opacity + desaturation) so it reads as markings embedded in the floor
 * rather than a separate decal sitting on top of it. No reflection, gold
 * particles, comet trail, or globe/stand changes are part of this phase.
 *
 * Composition (back to front):
 *   1. floorPlane      — the large continuous ground plane. Extremely wide and
 *                         low, flat opacity, relative to its own footprint —
 *                         so within the visible hero it reads as a broad
 *                         uniform floor extending well past both sides of the
 *                         globe, not a bright center fading to dark edges.
 *   2. floorPerspective — a real CSS 3D tilt (perspective + rotateX) on a wide
 *                         rectangle right at the pedestal, so the "near" part
 *                         of the floor reads as a physically foreshortened
 *                         horizontal surface rather than a flat decal.
 *   3. floorHorizonFade — sits below the pedestal and dissolves the floor
 *                         gradually into the surrounding dark background
 *                         toward its most distant/lowest edge, instead of the
 *                         floor stopping abruptly.
 *   4. ringsCore, ringsExtend — the original photographic radar/astrolabe floor
 *                         asset (unchanged pixels), reused as two instances rather
 *                         than one. Each carries a gentler version of the same
 *                         perspective/rotateX tilt used by floorPerspective (so the
 *                         markings sit in the same 3D floor context instead of
 *                         floating on top of it as a flat decal, without crushing
 *                         their fine detail), a soft radial mask so they fade out
 *                         well before their own box edge, and reduced
 *                         opacity/saturation so they read as markings toned into
 *                         the floor rather than a bright sticker. ringsCore is the
 *                         legible instance at the pedestal; ringsExtend is a
 *                         larger, much fainter copy offset along the floor so the
 *                         grid/ring pattern feels like it continues naturally
 *                         across the wider plane instead of stopping at one
 *                         graphic's boundary.
 *   5. contactShadow    — small dark ellipse right at the base, grounding the pedestal.
 *   6. goldGlow         — small warm gold reflection at the exact contact point, screened
 *                         on top so it reads as light bouncing off the floor by the base.
 *
 * (Reflection, gold particle trail, and comet effects are deliberately not part
 * of this phase — floor structure only.)
 *
 * All layers are pure CSS gradient divs (steps 1-3, 5-6) plus the one existing
 * raster asset (step 4) — no canvas, no WebGL, no new images, no animation, no
 * particle system. Every layer is sized and positioned with percentages anchored
 * to the same pedestal contact point used by the ring asset, so the whole
 * environment scales together with GlobeStand's own responsive height across
 * breakpoints, and stays centered on the pedestal/globe composition rather than
 * the viewport.
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
  // 1. Continuous floor plane — very wide and shallow relative to its own box, so
  // its curvature is imperceptible across the visible hero and it reads as a
  // broad, largely uniform physical floor extending well past both sides of the
  // globe, rather than a bright spot that fades out toward the pedestal's edges.
  {
    key: "floorPlane",
    width: "820%",
    height: "120%",
    left: PEDESTAL_LEFT,
    top: PEDESTAL_TOP,
    translate: "translate(-50%, -18%)",
    background:
      "radial-gradient(ellipse at center, rgba(18,15,13,0.34) 0%, rgba(15,13,11,0.22) 32%, rgba(13,11,10,0.11) 58%, rgba(12,10,9,0) 80%)",
  },
  // 2. Foreshortened near-floor band — an actual CSS 3D tilt (perspective + rotateX)
  // on a wide rectangle right at the pedestal contact line, so the floor closest to
  // camera reads as a tilted horizontal surface receding into the scene, instead of
  // faking depth with concentric rings of brightness.
  {
    key: "floorPerspective",
    width: "360%",
    height: "70%",
    left: PEDESTAL_LEFT,
    top: PEDESTAL_TOP,
    translate: "translate(-50%, -60%) perspective(760px) rotateX(74deg)",
    background:
      "radial-gradient(ellipse at center, rgba(32,26,18,0.30) 0%, rgba(26,21,15,0.18) 45%, rgba(24,20,14,0) 82%)",
  },
  // 3. Horizon fade — anchored below the pedestal, dissolves the floor gradually
  // into the surrounding dark background toward its most distant/lowest edge
  // rather than the plane stopping abruptly.
  {
    key: "floorHorizonFade",
    width: "480%",
    height: "150%",
    left: PEDESTAL_LEFT,
    top: "150%",
    translate: "translate(-50%, -50%)",
    background:
      "radial-gradient(ellipse at center, rgba(13,11,10,0.16) 0%, rgba(12,10,9,0.08) 40%, rgba(12,10,9,0) 75%)",
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

      {/* Radar/astrolabe markings, embedded in the floor above — same unmodified
          asset (mast-radar-floor.webp) used twice, not redesigned. floorPerspective's
          own rotateX(74deg) is a near-edge-on tilt that only ever renders a soft,
          detail-free gradient, so applying it verbatim to this image (which has real
          fine detail — rings, tick marks, graduation lines) would crush it into an
          unreadable sliver. Instead both instances use a gentler tilt in the same
          perspective(760px) 3D context — enough to visually agree with the floor's
          foreshortening without destroying the markings — plus a soft radial mask so
          they dissolve well before their own box edge instead of showing a graphic
          boundary. Reduced opacity/saturation keeps them toned into the dark floor
          rather than reading as a bright sticker. */}
      <img
        src={RADAR_FLOOR_ASSET}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none object-contain max-w-none"
        style={{
          width: "360%",
          left: PEDESTAL_LEFT,
          top: PEDESTAL_TOP,
          transform:
            "translate(-56.84%, -49.27%) perspective(760px) rotateX(22deg) scale(1.4, 1)",
          transformOrigin: "50% 8%",
          opacity: 0.8,
          filter: "saturate(0.85) brightness(0.92)",
          WebkitMaskImage:
            "radial-gradient(ellipse 60% 55% at 50% 42%, black 0%, black 45%, transparent 78%)",
          maskImage:
            "radial-gradient(ellipse 60% 55% at 50% 42%, black 0%, black 45%, transparent 78%)",
        }}
      />

      {/* Fainter, larger copy of the same asset, offset along the floor so the
          ring/grid pattern reads as continuing naturally across the wider plane
          rather than stopping at one graphic's edge — not a second design, just
          the same markings extended and heavily faded. */}
      <img
        src={RADAR_FLOOR_ASSET}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none object-contain max-w-none"
        style={{
          width: "620%",
          left: PEDESTAL_LEFT,
          top: PEDESTAL_TOP,
          transform:
            "translate(-52%, -49.27%) perspective(760px) rotateX(22deg) scale(1.3, 1)",
          transformOrigin: "50% 8%",
          opacity: 0.16,
          filter: "saturate(0.8) brightness(0.9)",
          WebkitMaskImage:
            "radial-gradient(ellipse 62% 50% at 50% 42%, black 0%, black 30%, transparent 68%)",
          maskImage:
            "radial-gradient(ellipse 62% 50% at 50% 42%, black 0%, black 30%, transparent 68%)",
        }}
      />

      {CONTACT_LAYERS.map((layer) => (
        <FloorLayer key={layer.key} layer={layer} />
      ))}
    </div>
  );
}
