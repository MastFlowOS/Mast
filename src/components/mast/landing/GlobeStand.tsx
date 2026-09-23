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
