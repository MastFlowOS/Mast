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
 *
 * PHASE 2A.2 — the single symmetric radial-gradient was the reason it kept
 * reading as a glow no matter how it was resized: a plain ellipse gradient
 * is round in every direction, which nothing on a real floor reflection is.
 * This pass keeps it one <div> with one `background`, but composites two
 * radial-gradients into that one background — a small brighter hotspot
 * positioned high in the box (the actual point of contact) and a broader,
 * much softer shape stacked lower and taller beneath it (the tapering
 * spread away from that contact point). Two gradients, still a single
 * paint on a single static element — not a second decorative layer.
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

// PHASE 2A / 2A.1 / 2A.2 — reflection layer, centered on the pedestal's
// contact point and sized off viewport width like the rest of the hero's
// floor treatment so it scales gently across breakpoints instead of
// jumping. 2A.2 reshaped it from one symmetric ellipse into two
// radial-gradients composited in a single `background`: CONTACT sits high
// and tight — the subtle brighter point directly beneath the base — and
// TAPER is wider, taller, and much softer, stacked lower so the light
// visibly spreads and fades as it extends away rather than forming one
// uniform round glow. The vertical shift keeps most of the box below the
// contact line, with just enough tucked upward that CONTACT sits behind
// the pedestal's own base pixels rather than peeking past them.
const REFLECTION_WIDTH = "clamp(150px, 16vw, 320px)";
const REFLECTION_HEIGHT = "clamp(120px, 14vw, 280px)";
const REFLECTION_GRADIENT = [
  // CONTACT — small, brighter, high in the box: the point where the
  // pedestal actually meets the floor.
  "radial-gradient(ellipse 58% 42% at 50% 14%, rgba(205,158,96,0.42) 0%, rgba(205,158,96,0.22) 45%, rgba(205,158,96,0) 100%)",
  // TAPER — broader and much softer, centered lower: the reflection
  // spreading and fading away from that contact point.
  "radial-gradient(ellipse 92% 80% at 50% 56%, rgba(205,158,96,0.16) 0%, rgba(205,158,96,0.09) 35%, rgba(205,158,96,0.03) 65%, rgba(205,158,96,0) 100%)",
].join(", ");

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
          transform: "translate(-50%, -14%)",
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
