/**
 * HeroFloorSurface — PHASE 1D: a single, bounded floor-surface layer that
 * spans the *hero* itself, so the lower portion of the hero reads as one
 * continuous physical floor from edge to edge — independent of the radar/
 * astrolabe artwork and of every pedestal-centered layer in
 * GlobePresentationSurface.
 *
 * Why this is a new, separate component instead of further scaling the
 * layers in GlobePresentationSurface:
 *
 * Every layer in GlobePresentationSurface is positioned as a percentage of
 * GlobeStand's own box. GlobeStand is `h-[92.5%]` of a fixed portrait
 * aspect-ratio (1072 / 1467), centered with `mx-auto` inside just the
 * right-hand globe column — so "its own box" is a narrow, tall rectangle,
 * not the hero. Continuing to inflate those layers' width/height
 * percentages (even to hundreds of vw) still produces a shape that is
 * centered on, and falls off from, that narrow box's own midpoint. That's
 * why it keeps reading as a wide soft glow *under the globe* rather than a
 * floor spanning the hero — the strategy itself, not the sizing, was the
 * problem. This component does not touch any of that; those layers and
 * their percentages are left exactly as they are.
 *
 * Instead, this is mounted as a direct child of the hero `<header>`
 * (already `position: relative`), sized with `inset-x-0` — a real, bounded
 * 100% of the hero's own full width, not an inflated percentage of a small
 * box — and a height clamped to a fraction of the viewport, anchored to the
 * bottom of the hero. Both gradients below are strictly linear (never
 * radial), so there is no ellipse, pool, or spotlight shape at any size,
 * and every edge (top, bottom, left, right) fades to fully transparent
 * well inside the box, so nothing reads as a hard rectangular cutoff.
 *
 * A single, very shallow 3D tilt (perspective + rotateX, anchored at the
 * bottom edge) gives the plane a subtle physical recession instead of
 * reading as a flat gradient wall — kept far shallower than the near-floor
 * tilts in GlobePresentationSurface, since this layer's job is the broad
 * surface, not a foreshortened near band.
 *
 * PHASE 1D.1 — visibility pass. Phase 1D's two gradients were each so low-
 * alpha (peaking around 0.22-0.24) that, layered together, the base barely
 * lifted off the page's near-black background (#02040c) — in practice
 * almost invisible against it, exactly as reported after the real browser
 * check. The fix here is a deliberate two-tier split rather than just
 * turning every number up:
 *
 *   1. floorBase  — the dominant layer, and the one that actually makes the
 *      floor "clearly visible across the lower hero." It varies only by y
 *      (180deg, no x component at all), so at any given row it is the same
 *      strength all the way across — that uniformity *is* what reads as a
 *      broad surface spanning the full width, at a peak alpha (~0.56) high
 *      enough to sit clearly above the background rather than blending into
 *      it. It still fades to fully transparent at 0% and 100%, so the top
 *      and bottom boundaries remain a gradual dissolve, not a cut line.
 *   2. floorWarmth — a secondary, much lower-alpha layer (peaking ~0.24)
 *      that varies only by x (92deg), layered on top of floorBase. Its job
 *      is purely the left/right variation: warmer and a little brighter
 *      loosely toward where the globe/pedestal sits, cooler and dimmer
 *      toward the far left and right edges. Keeping its peak alpha well
 *      below floorBase's matters structurally, not just tonally: because it
 *      has no y component, an x-only gradient is constant along the full
 *      height of the layer, so if it were strong it would leave a visible
 *      band right at the top edge even where floorBase has already faded to
 *      zero. At this lower alpha its contribution there stays a soft, minor
 *      tint rather than a seam.
 *
 * Both remain strictly linear gradients — no radial shape, so no ellipse,
 * pool, spotlight, or circular glow at any size or alpha.
 *
 * PHASE 1D — floor surface only. Deliberately excludes and does not touch:
 * radar markings (the existing photographic asset, painted separately in
 * GlobePresentationSurface), reflection, and gold particle flow — all
 * later, separate phases. The globe/stand, typography, navigation, and
 * SectionAtmosphere are untouched.
 */

export function HeroFloorSurface() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 select-none overflow-hidden z-0"
      aria-hidden="true"
      style={{
        // A real, bounded measurement (a fraction of the viewport, clamped
        // to sane min/max) rather than a percentage of a small ancestor box
        // — lands at roughly the lower 35-45% of a typical hero viewport.
        height: "clamp(170px, 42vh, 320px)",
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: "perspective(2200px) rotateX(5deg)",
          transformOrigin: "50% 100%",
          background:
            // floorWarmth — secondary, low-alpha left/right accent. Warm and
            // a little brighter around a single broad peak slightly right
            // of center (loosely toward the globe/pedestal), cooler and
            // dimmer toward the far left and right. Purely linear along the
            // x-axis, deliberately kept well under floorBase's alpha (see
            // docblock) so it never reads as its own band or glow.
            "linear-gradient(92deg, rgba(9,8,7,0) 0%, rgba(14,13,11,0.05) 8%, rgba(18,15,12,0.10) 20%, rgba(26,21,15,0.16) 34%, rgba(36,28,18,0.20) 48%, rgba(44,33,20,0.24) 60%, rgba(38,29,18,0.20) 72%, rgba(26,21,15,0.12) 85%, rgba(15,13,11,0.05) 95%, rgba(9,8,7,0) 100%), " +
            // floorBase — dominant, x-independent wash. Same strength across
            // the full width at any given row, which is what makes the
            // floor clearly, uniformly visible edge to edge rather than
            // concentrated in the middle. Fades to fully transparent at the
            // top (into the atmosphere above) and the bottom (into the page
            // background below), so both boundaries stay a gradual dissolve.
            "linear-gradient(180deg, rgba(9,8,7,0) 0%, rgba(14,12,10,0.08) 10%, rgba(19,16,13,0.20) 22%, rgba(24,20,16,0.34) 36%, rgba(27,23,18,0.46) 50%, rgba(29,24,19,0.56) 62%, rgba(27,23,18,0.50) 74%, rgba(21,18,14,0.32) 86%, rgba(14,12,10,0.12) 95%, rgba(9,8,7,0) 100%)",
        }}
      />
    </div>
  );
}
