/**
 * GroundSurface — the hero's entire ground system, replacing the previous
 * stack of separate layers (HeroFloorSurface's CSS-masked texture image,
 * plus GlobePresentationSurface's radar-floor asset, gradient "pool" layers,
 * and contact shadow/glow). There is now exactly one ground: a single
 * photographic floor asset, positioned with CSS only (no gradients trying to
 * recreate the artwork, no canvas/WebGL, no particles).
 *
 * ALIGNMENT
 * The asset's own focal point — the center of its engraved circular marking,
 * where the warm light converges (measured directly from the source image at
 * ~64.5%, 62% of its frame) — must land exactly on the globe pedestal's
 * ground-contact point. Because the globe column's position shifts across
 * breakpoints (stacked on mobile/tablet, a grid column on desktop) a fixed
 * CSS percentage can't track it. Instead this component reads the pedestal
 * anchor marker rendered by GlobeStand with getBoundingClientRect() at
 * runtime, and re-measures on resize — so the floor tracks the pedestal
 * exactly at every breakpoint instead of relying on per-breakpoint guesses.
 *
 * CONTAINMENT
 * The outer band is bottom-anchored with a bounded height (clamp, not vh
 * alone) and overflow-hidden, matching the hero's own footprint. The asset
 * already fades to transparent toward its own top/bottom edges (baked into
 * its alpha channel), so cropping is only ever cutting already-near-empty
 * pixels — never a hard line through the visible floor. Left/right, the
 * image is sized wide enough (bounded clamp, not an extreme percentage) that
 * its own edges clear the viewport at realistic breakpoints; where they
 * don't, the container's overflow-hidden crops it flush with the hero's own
 * edge, which reads as the floor continuing off-page rather than a visible
 * boundary.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const GROUND_ASSET = "/images/mast-hero-ground.webp";

// Natural asset proportions (2172 x 724 px).
const GROUND_ASPECT_RATIO = "2172 / 724";

// Focal point of the source artwork — center of the innermost engraved ring
// / warm highlight — as a fraction of the asset's own frame.
const FOCAL_X = 0.645;
const FOCAL_Y = 0.62;

// Bounded width: comfortably wider than the viewport so the asset's own
// left/right edges clear the frame at typical breakpoints, capped so it's
// never an extreme multiple of the viewport on ultra-wide screens.
const GROUND_WIDTH = "clamp(1400px, 190vw, 2600px)";

// Bottom-anchored band height — bounded, matches the footprint the old
// floor occupied.
const BAND_HEIGHT = "clamp(320px, 54vh, 540px)";

type Offset = { x: number; y: number };

export function GroundSurface({
  pedestalAnchorRef,
}: {
  pedestalAnchorRef: RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Offset | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const anchor = pedestalAnchorRef.current;
      if (!anchor) return;
      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      setOffset({
        x: anchorRect.left - containerRect.left,
        y: anchorRect.top - containerRect.top,
      });
    };

    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    window.addEventListener("resize", measure);
    // Fonts finishing their swap can change header/copy height, which shifts
    // the pedestal a little — catch that once, without polling.
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pedestalAnchorRef]);

  // Before the first measurement, fall back to a reasonable static guess
  // (roughly where the pedestal sits on desktop) rather than rendering
  // nothing — this only ever shows for a single frame before layout effects
  // resolve.
  const left = offset ? `${offset.x}px` : "68%";
  const top = offset ? `${offset.y}px` : "88%";

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 select-none overflow-hidden z-0"
      aria-hidden="true"
      style={{
        height: BAND_HEIGHT,
        // Safety-net fade in addition to the asset's own baked-in alpha —
        // guarantees no hard line at the container's own top/bottom edge
        // regardless of exact measured position.
        WebkitMaskImage:
          "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 14%, rgba(0,0,0,1) 82%, rgba(0,0,0,0) 100%)",
        maskImage:
          "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 14%, rgba(0,0,0,1) 82%, rgba(0,0,0,0) 100%)",
      }}
    >
      <img
        src={GROUND_ASSET}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none max-w-none"
        style={{
          width: GROUND_WIDTH,
          aspectRatio: GROUND_ASPECT_RATIO,
          left,
          top,
          transform: `translate(-${FOCAL_X * 100}%, -${FOCAL_Y * 100}%)`,
        }}
      />
    </div>
  );
}
