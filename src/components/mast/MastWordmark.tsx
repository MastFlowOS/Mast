import mastWordmark from "@/assets/mast-wordmark.png";
import { cn } from "@/lib/utils";

interface MastWordmarkProps {
  className?: string;
  /**
   * Rendered height in px. Width follows automatically from the asset's
   * intrinsic aspect ratio so the mark is never stretched or distorted.
   */
  height?: number;
}

// Intrinsic pixel size of the source asset — used to reserve layout space
// (via the width/height attrs) before the image has loaded, so it never
// causes a layout shift.
const ASSET_WIDTH = 972;
const ASSET_HEIGHT = 198;
const ASPECT_RATIO = ASSET_WIDTH / ASSET_HEIGHT;

/**
 * The canonical MAST wordmark — the single source of truth for every place
 * the "MAST" logotype is rendered across the site. Always render this
 * component (never re-type "MAST" as styled text) so the brand mark stays
 * consistent and only needs to change in one place.
 */
export function MastWordmark({ className, height = 24 }: MastWordmarkProps) {
  return (
    <img
      src={mastWordmark}
      alt="MAST"
      width={Math.round(height * ASPECT_RATIO)}
      height={height}
      style={{ height, width: "auto" }}
      className={cn("select-none shrink-0", className)}
      draggable={false}
    />
  );
}
