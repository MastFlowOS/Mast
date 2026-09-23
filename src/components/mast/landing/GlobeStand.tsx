/**
 * GlobeStand — renders the approved static globe+stand PNG as a single
 * <img>. The asset (globe, meridian ring, pivots, and pedestal) is the
 * complete visual; there is no live canvas, no separate stand layer, and
 * nothing here is redrawn, animated, or recreated in SVG/Canvas/WebGL.
 *
 * It also exposes the pedestal's ground-contact point as a zero-size marker
 * element (via `pedestalAnchorRef`). GroundSurface reads that marker's real
 * on-screen position with getBoundingClientRect() so the hero floor can stay
 * aligned to the pedestal at every breakpoint, instead of duplicating these
 * percentages as separate hardcoded CSS in another file.
 *
 * PHASE 2A — adds one static, compositor-friendly reflection layer directly
 * beneath the pedestal's own ground-contact point (same PEDESTAL_LEFT /
 * PEDESTAL_TOP the anchor marker already uses, so no new measurement and no
 * dependency on GroundSurface). It is a single radial-gradient <div>, no
 * canvas/filter-blur/animation, sitting behind the image in this box's own
 * stacking order — the pedestal's opaque pixels naturally cover its top
 * edge, while the surrounding transparent pixels let it read as light
 * pooling on the floor the globe column already renders above. Nothing
 * about the image, the anchor marker, or the existing constants changes.
 *
 * PHASE 2A.1 — same single layer, just turned up: larger footprint and a
 * brighter, multi-stop center so it actually reads against the floor
 * instead of disappearing into it. Still one static radial-gradient <div>,
 * still fully transparent at its outer edge (no hard border), so it stays
 * a soft pool rather than a visible glowing shape.
 *
 * PHASE 2A.1 (round 2) — reference comparison showed the pool still reading
 * too small/round next to the actual floor reflection under the pedestal.
 * Widened and elongated further (height grew faster than width, since the
 * reference's reflection stretches toward the viewer along the floor more
 * than it spreads side to side) and added extra low-opacity gradient stops
 * so the outer edge dissolves into the dark floor over a longer distance
 * instead of tapering off abruptly. Same single <div>, no new layer.
 */

import type { RefObject } from "react";

const GLOBE_ASSET = "/images/mast-globe-final.png";
const GLOBE_WIDTH_PX = 1072;
const GLOBE_HEIGHT_PX = 1467;
const GLOBE_ASPECT_RATIO = `${GLOBE_WIDTH_PX} / ${GLOBE_HEIGHT_PX}`;

// Pedestal ground-contact point, measured directly from the asset's alpha
// channel: the widest row of the base — where it visually meets the floor.
// Expressed as a percentage of this component's own box (which exactly
// matches the image's own box, since the container's aspect-ratio equals
// the asset's, so object-contain adds no letterboxing).
const PEDESTAL_LEFT = "46.64%";
const PEDESTAL_TOP = "94.2%";

// PHASE 2A / 2A.1 — reflection layer. A wide ellipse (reflections
// foreshorten on a floor) centered on the pedestal's contact point. Sized
// off viewport width like the rest of the hero's floor treatment so it
// scales gently across breakpoints instead of jumping. 2A.1 widened it and
// gave it real vertical extent (was near-flat) so it reads as a pool on the
// floor rather than a sliver, brightened the inner stop, and (round 2)
// pushed both dimensions further with a longer low-opacity tail so it blends
// into the dark floor gradually rather than stopping short. The vertical
// shift keeps most of the shape below the contact line, with just enough
// tucked upward that it sits behind the pedestal's own base pixels rather
// than peeking past them.
const REFLECTION_WIDTH = "clamp(130px, 14vw, 290px)";
const REFLECTION_HEIGHT = "clamp(60px, 7vw, 150px)";
const REFLECTION_GRADIENT =
  "radial-gradient(ellipse at center, rgba(205,158,96,0.50) 0%, rgba(205,158,96,0.32) 20%, rgba(205,158,96,0.18) 42%, rgba(205,158,96,0.08) 65%, rgba(205,158,96,0.02) 85%, rgba(205,158,96,0) 100%)";

export function GlobeStand({
  className = "",
  pedestalAnchorRef,
}: {
  className?: string;
  pedestalAnchorRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    // 92.5% of the column keeps the whole pedestal comfortably inside the hero
    // (a small reduction, proportions untouched), and the -3% lift is a
    // fraction of the asset's own height so it scales with it.
    <div
      className={`relative mx-auto h-[92.5%] -translate-y-[3%] overflow-visible ${className}`}
      style={{ aspectRatio: GLOBE_ASPECT_RATIO }}
    >
      {/* Pedestal contact reflection — see PHASE 2A note above. z-0, behind
          the z-10 image, so it only shows through the image's transparent
          pixels around the base rather than drawing over the pedestal. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute z-0"
        style={{
          left: PEDESTAL_LEFT,
          top: PEDESTAL_TOP,
          width: REFLECTION_WIDTH,
          height: REFLECTION_HEIGHT,
          transform: "translate(-50%, -22%)",
          background: REFLECTION_GRADIENT,
        }}
      />

      <img
        src={GLOBE_ASSET}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none relative z-10 h-full w-full select-none object-contain"
      />

      {/* Zero-size pedestal ground-contact marker — not rendered visually,
          only read via getBoundingClientRect() by GroundSurface. */}
      <div
        ref={pedestalAnchorRef}
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{ left: PEDESTAL_LEFT, top: PEDESTAL_TOP, width: 0, height: 0 }}
      />
    </div>
  );
}
