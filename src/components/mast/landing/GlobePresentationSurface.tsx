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
 *   4. ringsAsset       — the original photographic radar/astrolabe floor asset
 *                         (unchanged pixels), scaled up further and layered on
 *                         top so it reads as markings embedded in the larger
 *                         floor plane above, not as the floor's own boundary.
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

// ─── PHASE 1C — continuous floor base ──────────────────────────────────────
// A new environment layer, painted *behind* everything above (GRADIENT_LAYERS
// is still the untouched Phase 1A treatment; the rings asset and
// CONTACT_LAYERS below are also untouched). This is the two-layer "physical
// studio floor" the globe stands inside, kept deliberately separate from the
// pedestal-centered pool gradients above it.
//
// Where GRADIENT_LAYERS is sized as a large percentage of this component's
// own narrow, aspect-ratio-locked box, these two layers are sized from the
// viewport (vw/vh) instead — a real, bounded physical measurement rather
// than an inflated percentage of a small box. A width safely over 100vw
// guarantees the layer's left/right edges sit outside the visible frame on
// any screen size, so the floor is clipped by the hero's own
// overflow-x-clip (no page overflow) instead of fading out from its own
// gradient — it reads as continuing past the frame because it genuinely
// does, not because a radial falloff was stretched wide.
//
// Both layers use only *linear* gradients (vertical stops), never radial:
// a linear gradient has zero side-to-side falloff, so nothing here reads as
// a centered ellipse or spotlight no matter how large the box is.
//
// PHASE 1C.1 — floor spread + blending refinement. Widened and heightened
// both layers further (still vw/vh, still bounded), and replaced every
// gradient with many more, much more gradual stops so there is no plateau
// anywhere that could read as a contained "pool" — intensity now rises and
// falls slowly across a long span instead of ramping to a mid-box plateau
// over a short one. floorBase's warm accent used to be a separate radial
// ellipse layered into the background (a second, distinctly-shaped glow);
// it has been removed and replaced with a faint warm tint folded directly
// into the linear ramp's own color stops, so there is no longer any radial
// shape in either layer at all — only a broad, low-contrast vertical wash.
// floorBaseTilt has also been widened much closer to floorBase's own width
// (rather than sitting distinctly narrower) and had its peak opacity
// lowered, so it no longer reads as a brighter inner zone concentric with
// a fainter outer one.
//
// PHASE 1C.2 — full-width hero floor + horizontal perspective. The recorded
// playback showed the floor still concentrated around the globe. Two
// concrete causes, both fixed here without touching width/height order of
// magnitude beyond what 1C already established:
//
//   1. floorBaseTilt was only 112vw wide. At the two-column desktop
//      breakpoints the pedestal sits at roughly 70-75% of viewport width
//      (the globe column is the narrower right-hand fr-track), so a layer
//      needs at least ~150vw of width, centered on the pedestal, before its
//      near edge reaches all the way to the hero's left edge. At 112vw it
//      fell short by a real, visible margin — the near/tilted band simply
//      did not exist yet under the left portion of the hero copy, it
//      wasn't just faint there. floorBaseTilt is now the same 180vw as
//      floorBase so both layers' left/right edges sit safely outside the
//      viewport (still page-clipped by the hero's overflow-x-clip, not by
//      their own gradient falloff) at any realistic viewport width.
//   2. Both layers' colors sat very close in value to the page's near-black
//      atmosphere, so once separated from the bright radar asset the tint
//      was nearly imperceptible. Peak opacity is raised and the color is
//      shifted to a warmer, slightly lighter neutral (distinct from the
//      cooler background) so the floor reads as a physical surface even in
//      isolation, while staying far too subtle to affect text contrast.
//
// Both layers also gain a second, purely *linear* gradient (a shallow
// diagonal angle, not 90/180deg) layered behind the existing vertical wash.
// Its stops rise from a low base, peak at 50% — which, because each layer's
// box is horizontally centered on the pedestal via translate(-50%), is
// exactly where the pedestal sits — and ease back down on both sides. That
// gives the "brighten toward the globe, fade toward the distant reaches"
// quality the flat vertical-only wash couldn't, entirely through straight,
// axis-aligned stops: there is no radial shape, no curve, and (because the
// stops never return to true zero within the visible viewport slice of the
// oversized box) no ellipse or pool boundary anywhere in view.
//
//   floorBase     — the broad flat floor. A gentle diagonal wash (brighter
//                   toward the pedestal, dimmer toward the far left/right)
//                   combined with the original vertical near/far falloff —
//                   fully transparent, up through a subtle peak, back to
//                   fully transparent — no hard edge or plateau anywhere.
//   floorBaseTilt — a wide band at the pedestal contact line, keeping the
//                   same CSS 3D tilt direction (perspective + rotateX) as
//                   before so the nearest part of the floor still
//                   foreshortens like a horizontal surface, with the same
//                   two-gradient treatment as floorBase but kept subtler so
//                   it still reads as part of the same surface rather than
//                   a second, brighter shape.
//
// Both anchor to the same PEDESTAL_LEFT/PEDESTAL_TOP contact point as every
// other layer in this file (left/top percentages are relative to this
// component's own box regardless of how large the sized layer itself is),
// so they track the globe/stand across breakpoints with no new
// breakpoint-specific code.
const FLOOR_BASE_LAYERS: GradientLayer[] = [
  {
    key: "floorBase",
    width: "180vw",
    height: "56vh",
    left: PEDESTAL_LEFT,
    top: PEDESTAL_TOP,
    translate: "translate(-50%, -18%)",
    background:
      "linear-gradient(100deg, rgba(20,17,13,0) 0%, rgba(23,19,15,0.035) 10%, rgba(27,22,17,0.07) 25%, rgba(30,25,19,0.095) 40%, rgba(31,26,19,0.105) 50%, rgba(29,24,18,0.09) 62%, rgba(26,22,17,0.06) 78%, rgba(22,19,15,0.025) 92%, rgba(20,17,13,0) 100%), linear-gradient(180deg, rgba(9,8,7,0) 0%, rgba(14,12,10,0.045) 10%, rgba(19,16,12,0.095) 22%, rgba(23,19,15,0.145) 34%, rgba(26,22,17,0.185) 46%, rgba(24,20,16,0.165) 58%, rgba(19,17,14,0.115) 72%, rgba(14,12,10,0.055) 86%, rgba(9,8,7,0) 100%)",
  },
  {
    key: "floorBaseTilt",
    width: "180vw",
    height: "28vh",
    left: PEDESTAL_LEFT,
    top: PEDESTAL_TOP,
    translate: "translate(-50%, -56%) perspective(900px) rotateX(76deg)",
    background:
      "linear-gradient(96deg, rgba(22,18,14,0) 0%, rgba(25,20,15,0.03) 15%, rgba(28,23,17,0.055) 35%, rgba(29,24,18,0.065) 50%, rgba(28,23,17,0.05) 65%, rgba(25,20,15,0.025) 85%, rgba(22,18,14,0) 100%), linear-gradient(180deg, rgba(11,10,9,0) 0%, rgba(16,14,11,0.06) 16%, rgba(22,18,14,0.115) 34%, rgba(25,21,16,0.15) 50%, rgba(22,18,14,0.115) 66%, rgba(16,14,11,0.06) 84%, rgba(11,10,9,0) 100%)",
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
      {/* Gradient floor base and pool layers removed — replaced by HeroFloorSurface
          (real dark photographic floor texture). Only RADAR MARKINGS and contact
          layers remain here. */}

      {/* Photographic rings/astrolabe markings, embedded in the floor above —
          same asset, same pedestal anchor math as before (the translate ratio is
          relative to the asset's own box, so it still centers on the asset's
          internal ring-center regardless of scale). Sized up further so it reads
          as detail sitting on top of the larger floor plane, not as the floor's
          own boundary. */}
      <img
        src={RADAR_FLOOR_ASSET}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none object-contain max-w-none"
        style={{
          width: "310%",
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
