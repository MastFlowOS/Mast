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
            // Horizontal wash — transparent at both edges, rising to a
            // single broad peak slightly right of center (loosely toward
            // where the globe/pedestal sits in the two-column layout),
            // dark toward the far left and right. Purely linear along the
            // x-axis: no side-to-side falloff shaped like an ellipse.
            "linear-gradient(92deg, rgba(10,9,8,0) 0%, rgba(15,13,11,0.05) 10%, rgba(19,16,13,0.12) 26%, rgba(22,18,15,0.18) 42%, rgba(24,20,16,0.22) 58%, rgba(23,19,15,0.19) 72%, rgba(18,15,12,0.11) 86%, rgba(12,10,9,0.04) 95%, rgba(10,9,8,0) 100%), " +
            // Vertical wash — fades up into the atmosphere above (0%) and
            // eases back down again toward the very bottom (100%), so
            // there is no hard line at either the top or bottom boundary,
            // only a gradual dissolve into the surrounding page background.
            "linear-gradient(180deg, rgba(8,7,6,0) 0%, rgba(12,10,9,0.05) 16%, rgba(16,14,11,0.14) 34%, rgba(19,16,13,0.21) 52%, rgba(20,17,14,0.24) 68%, rgba(17,14,12,0.17) 84%, rgba(11,10,9,0.06) 95%, rgba(8,7,6,0) 100%)",
        }}
      />
    </div>
  );
}
