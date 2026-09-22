/**
 * GlobeStand — renders the approved static globe+stand PNG as a single
 * <img>. The asset (globe, meridian ring, pivots, and pedestal) is the
 * complete visual; there is no live canvas, no separate stand layer, and
 * nothing here is redrawn, animated, or recreated in SVG/Canvas/WebGL.
 */

const GLOBE_ASSET = "/images/mast-globe-final.png";
const GLOBE_WIDTH_PX = 1072;
const GLOBE_HEIGHT_PX = 1467;
const GLOBE_ASPECT_RATIO = `${GLOBE_WIDTH_PX} / ${GLOBE_HEIGHT_PX}`;

export function GlobeStand({ className = "" }: { className?: string }) {
  return (
    // 100% of the column gives the asset a bit more visual presence than the
    // prior 92.5% (proportions untouched, still contained by the column's own
    // overflow-visible box so nothing crops), and the -2% lift is a fraction
    // of the asset's own height so it scales with it at every breakpoint.
    <div
      className={`relative mx-auto h-[100%] -translate-y-[2%] ${className}`}
      style={{ aspectRatio: GLOBE_ASPECT_RATIO }}
    >
      <img
        src={GLOBE_ASSET}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
      />
    </div>
  );
}
