/**
 * GlobePresentationSurface — renders the photographic radar floor presentation
 * surface directly from the visual source of truth asset underneath the static
 * globe + stand.
 *
 * Features:
 * - Exact photographic radar floor matching the uploaded reference:
 *   brushed stone center disc, inner astrolabe graduation teeth, concentric coordinate
 *   tracks, degree markings, intersecting celestial arcs, and starburst glint.
 * - Sized and anchored as a small presentation platform, not a sprawling radar field:
 *   globe center = pedestal center = floor center.
 *   - Pedestal contact point on the globe/stand asset: 46.64% horizontal, 94.2% vertical
 *     (the widest point of the base, i.e. where it visually meets the ground).
 *   - The floor asset's own innermost ring center sits at 56.84%/49.27% of the asset's
 *     own frame (measured from the source photograph), so translate(-56.84%, -49.27%)
 *     is what actually pins that ring center — not the asset's bounding-box center —
 *     to the pedestal contact point above. (The previous -56.15%/-52.05% values were
 *     close on X but off by ~3% of the asset's height on Y, and the 290% width made
 *     that error, plus the sheer size, read as a badly off-center, oversized floor.)
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
          width: "150%",
          left: "46.64%",
          top: "94.2%",
          transform: "translate(-56.84%, -49.27%)",
        }}
      />
    </div>
  );
}
