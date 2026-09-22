/**
 * GlobePresentationSurface — renders the photographic radar floor presentation
 * surface directly from the visual source of truth asset underneath the static
 * globe + stand.
 *
 * Features:
 * - Exact photographic radar floor matching the uploaded reference:
 *   brushed stone center disc, inner astrolabe graduation teeth, concentric coordinate
 *   tracks, degree markings, intersecting celestial arcs, and starburst glint.
 * - Perfectly anchored to the pedestal base:
 *   Horizontal center: 46.64%, Base rim center: 94.2%.
 * - Feather-soft alpha vignette that blends seamlessly into the hero's dark atmosphere.
 * - Responsive: scales proportionally across desktop, tablet, and mobile breakpoints.
 * - Ultra-lightweight: pure static WebP asset (111 KB), zero JS, zero runtime CPU cost.
 */

const RADAR_FLOOR_ASSET = "/images/mast-radar-floor.webp";

export function GlobePresentationSurface() {
  return (
    <div
      className="pointer-events-none absolute inset-0 select-none overflow-visible z-0"
      aria-hidden="true"
    >
      <img
        src={RADAR_FLOOR_ASSET}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none object-contain max-w-none"
        style={{
          width: "290%",
          left: "46.64%",
          top: "94.2%",
          transform: "translate(-56.15%, -52.05%)",
        }}
      />
    </div>
  );
}
