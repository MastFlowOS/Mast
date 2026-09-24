/**
 * GroundSurface — the hero's single ground layer.
 *
 * PHASE 1F — the floor is a PRE-BAKED PERSPECTIVE SURFACE. All of the depth
 * (grid converging toward a horizon, foreshortened rings, the warm pool, the
 * dark falloff toward the distance) is already in the artwork. This component
 * does not redraw, warp or duplicate that artwork — it only composites it:
 *
 *   - width      one bounded, viewport-relative size (no stretching)
 *   - position   pinned so the artwork's focal point sits under the pedestal
 *   - masking    image-local (percentage-of-artwork) gradients only, so the
 *                treatment holds regardless of breakpoint or measured size
 *   - filter     one mild, uniform brightness/contrast/saturation trim
 *
 * There are NO transforms beyond the alignment translate (no rotateX /
 * perspective / scale), NO second copy of the image and NO second floor.
 * Depth still comes from the image (the perspective grid itself is never
 * touched) — CSS here only fades and grades it, it never redraws it.
 *
 * PHASE 1F.1 — compositing pass on top of the above. The artwork's own
 * transition from black into the lit floor (~41%–55% down its own frame) is
 * abrupt at the pixel level, which read as a hard horizontal "floor starts
 * here" seam once displayed at hero scale. This phase widens that transition
 * into a soft image-local mask (TOP_FADE, on a wrapper around the image) and
 * adds an asymmetric horizontal mask (GROUND_FADE, on the image itself) that
 * keeps the left side — behind the hero copy — substantially darker than the
 * pedestal side, so the warm light stays read as localized to the globe. A
 * single mild filter reduces how hard the grid/ring lines pop, without
 * touching their scale or position. All of this is masking/filter math on the
 * existing artwork; no new gradient layer stands in for the material itself.
 *
 * ALIGNMENT
 * The artwork's focal point — center of its innermost engraved ring, where the
 * warm light converges (~64.5%, 62% of its frame) — must land on the globe
 * pedestal's ground-contact point. The globe column moves across breakpoints,
 * so the pedestal marker rendered by GlobeStand is read with
 * getBoundingClientRect() and re-measured on resize.
 *
 * SWAPPING THE ASSET
 * If the artwork is replaced, only GROUND_ASSET, GROUND_ASPECT_RATIO and the
 * FOCAL_* constants below need to change. TOP_FADE's stops are keyed to this
 * artwork's own horizon position (~41%–55% down its frame) and would need
 * re-checking against a new asset's row-brightness profile too.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const GROUND_ASSET = "/images/mast-hero-ground.webp";

// Natural asset proportions (2172 x 724 px).
const GROUND_ASPECT_RATIO = "2172 / 724";

// Focal point of the artwork as a fraction of its own frame.
const FOCAL_X = 0.645;
const FOCAL_Y = 0.62;

// Bounded width. ~1.34x the band: wide enough that the floor runs continuously
// across the lower scene, small enough that grid and rings stay fine rather
// than a giant graphic (the old 190vw / 2600px was ~1.8x). Since height
// follows width at a locked aspect ratio, this factor is also what controls
// how tall the artwork renders — and because it's pinned to the pedestal via
// FOCAL_Y, a taller render pushes the horizon further above the pedestal in
// absolute px, i.e. it's the one knob that raises how high the lit floor
// reaches, without stretching or distorting anything (bumped slightly up
// from 1.25 for that reason). CSS clamp is the pre-measurement fallback; the
// measured width below is the same rule plus a guarantee that the artwork's
// right edge always clears the viewport (on stacked layouts the pedestal is
// mid-screen, so a plain 134vw would stop short and read as a vertical cut).
const GROUND_WIDTH_FALLBACK = "clamp(820px, 134vw, 2250px)";
const MIN_W = 820;
const MAX_W = 2400;
const WIDTH_FACTOR = 1.34;
const RIGHT_EDGE_CLEARANCE = 1.1;

// Bottom-anchored band, matches the hero's footprint.
const BAND_HEIGHT = "clamp(320px, 54vh, 540px)";

// Single constant opacity.
const GROUND_OPACITY = 1;

// Horizontal mask on the image itself, in image-local percentages (stable
// across breakpoints since it never depends on measured pixel size).
//
// Two jobs in one gradient:
//   - true edges (0–3%, 97–100%) stay fully hidden, as before, so no
//     rectangle reads at the artwork's left/right boundary.
//   - PHASE 1F.1: the whole left run — from just past the edge (9%) through
//     the hero-copy zone (up to ~46%) — is held at a fraction of full
//     opacity (0.32) rather than the old flat 1.0, then eased back up to
//     full brightness by 66%, just past the pedestal's focal point (64.5%).
//     That keeps the warm light read as pooled around the globe instead of
//     washing the whole floor.
const GROUND_FADE =
  "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0.18) 3%, rgba(0,0,0,0.32) 9%, rgba(0,0,0,0.32) 46%, rgba(0,0,0,0.58) 56%, rgba(0,0,0,0.88) 63%, rgba(0,0,0,1) 68%, rgba(0,0,0,1) 91%, rgba(0,0,0,0.5) 97%, rgba(0,0,0,0) 100%)";

// Vertical mask on a wrapper around the image, in image-local percentages.
// The artwork's own black-to-lit-floor transition sits at ~41%–55% down its
// frame (measured off the source: rows are flat black through ~41%, then
// ramp up to full floor brightness by ~55% of the 724px-tall artwork). That
// ramp is only ~14% of the frame, which reads as a hard seam at hero scale.
// This mask widens the same transition to a ~28%-of-frame band (34%–62%)
// with intermediate stops so it eases rather than switches on, letting the
// floor "emerge" out of the dark instead of starting behind a visible line.
// Below 62% (past the focal point) the artwork is already fully lit, so the
// mask stays fully opaque and touches nothing else.
const TOP_FADE =
  "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 34%, rgba(0,0,0,0.12) 40%, rgba(0,0,0,0.4) 46%, rgba(0,0,0,0.85) 54%, rgba(0,0,0,1) 62%, rgba(0,0,0,1) 100%)";

// Single mild, uniform grade on the artwork: takes some of the snap off the
// grid/ring linework (item 3 — "embedded" rather than "printed over") without
// touching their scale, position, or the material's own dark charcoal/bronze
// color. Applied once, to the whole image — the pedestal keeps its relative
// dominance because GROUND_FADE (above) darkens the rest of the floor
// further on top of this same uniform trim.
const FLOOR_FILTER = "brightness(0.88) contrast(0.92) saturate(0.9)";

// PHASE 5A — floor-glow placement. GoldFlow's own FLOW_* constants put the
// flow's lower end (the tail of FLOW_ENERGY_PATH_D, at image pixel
// 863.6/1536, 1023/1024 of the flow asset) at roughly (60.6%, 104.8%) of the
// globe's own box — worked out the same way GoldFlow reads that box (see its
// PLACEMENT comment). GlobeStand's PEDESTAL_LEFT/TOP put the pedestal's
// ground-contact point at (46.64%, 94.2%) of that same box. The difference
// between the two — ~13.9% of the globe box's width to the right, ~10.6% of
// its height below — is where the flow actually lands beside the pedestal,
// expressed as an offset from the pedestal anchor this file already measures
// below, so no second globe-relative measurement system is needed. (The
// flow box's own 3.8° tilt is small enough at this scale to ignore for a
// glow this faint.)
const FLOW_LANDING_OFFSET_X_PCT = 13.93;
const FLOW_LANDING_OFFSET_Y_PCT = 10.63;

// Floor-glow ellipse size, as a fraction of the globe box's own width —
// scales with the globe like GlobeStand's reflection pool does, instead of
// a fixed px size that would look right at only one breakpoint.
const FLOOR_GLOW_WIDTH_FACTOR = 0.11;
const FLOOR_GLOW_HEIGHT_FACTOR = 0.045;

type Measure = {
  x: number;
  y: number;
  h: number;
  w: number;
  // PHASE 5A — floor-glow center (px, relative to this component's own
  // container, same space as x/y) and size, only set once the globe box is
  // measurable; null hides the glow rather than guessing a position.
  glowX: number | null;
  glowY: number | null;
  glowW: number | null;
  glowH: number | null;
};

export function GroundSurface({
  pedestalAnchorRef,
}: {
  pedestalAnchorRef: RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<Measure | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const anchor = pedestalAnchorRef.current;
      if (!anchor) return;
      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const x = anchorRect.left - containerRect.left;
      const y = anchorRect.top - containerRect.top;

      // PHASE 5A — the pedestal marker's parent IS the globe box (see
      // GoldFlow's globeBox() helper for the same trick), so its measured
      // width/height is what FLOW_LANDING_OFFSET_*_PCT above are percentages
      // of.
      const globeBox = anchor.parentElement?.getBoundingClientRect() ?? null;
      const glowX = globeBox ? x + (FLOW_LANDING_OFFSET_X_PCT / 100) * globeBox.width : null;
      const glowY = globeBox ? y + (FLOW_LANDING_OFFSET_Y_PCT / 100) * globeBox.height : null;
      const glowW = globeBox ? globeBox.width * FLOOR_GLOW_WIDTH_FACTOR : null;
      const glowH = globeBox ? globeBox.width * FLOOR_GLOW_HEIGHT_FACTOR : null;

      setM({
        x,
        y,
        h: containerRect.height,
        w: containerRect.width,
        glowX,
        glowY,
        glowW,
        glowH,
      });
    };

    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    window.addEventListener("resize", measure);
    // Fonts finishing their swap can shift the pedestal slightly.
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pedestalAnchorRef]);

  // Single-frame fallback before the first measurement.
  const left = m ? `${m.x}px` : "68%";
  const top = m ? `${m.y}px` : "88%";

  // Width only: the bounded rule above, widened if needed so the artwork's
  // right edge (a (1 - FOCAL_X) fraction of its width beyond the pedestal)
  // stays past the viewport's right edge.
  const groundWidth = m
    ? `${Math.min(
        MAX_W,
        Math.max(MIN_W, WIDTH_FACTOR * m.w, ((m.w - m.x) / (1 - FOCAL_X)) * RIGHT_EDGE_CLEARANCE),
      )}px`
    : GROUND_WIDTH_FALLBACK;

  // Lower-edge fade only: starts a little below the pedestal's contact line and
  // reaches transparent exactly at the hero's bottom, so the floor dissolves
  // instead of being cropped by the next section.
  const fadeStart = m ? Math.min(m.y + 24, m.h - 60) : null;
  const bandMask =
    fadeStart === null
      ? "linear-gradient(to bottom, #000 0%, #000 90%, transparent 100%)"
      : `linear-gradient(to bottom, #000 0px, #000 ${fadeStart}px, rgba(0,0,0,0.5) ${fadeStart + (m!.h - fadeStart) * 0.5}px, transparent ${m!.h}px)`;

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 select-none overflow-hidden z-0"
      aria-hidden="true"
      style={{
        height: BAND_HEIGHT,
        WebkitMaskImage: bandMask,
        maskImage: bandMask,
      }}
    >
      {/* Alignment wrapper: unchanged position/size/transform math from
          Phase 1F. Carries the vertical (horizon) mask only, in image-local
          percentages, so it holds regardless of the measured pixel size. */}
      <div
        className="pointer-events-none absolute block max-w-none select-none"
        style={{
          width: groundWidth,
          aspectRatio: GROUND_ASPECT_RATIO,
          left,
          top,
          // Alignment only: puts the artwork's focal point on the pedestal.
          transform: `translate(-${FOCAL_X * 100}%, -${FOCAL_Y * 100}%)`,
          opacity: GROUND_OPACITY,
          WebkitMaskImage: TOP_FADE,
          maskImage: TOP_FADE,
        }}
      >
        <img
          src={GROUND_ASSET}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 block h-full w-full select-none"
          style={{
            WebkitMaskImage: GROUND_FADE,
            maskImage: GROUND_FADE,
            filter: FLOOR_FILTER,
          }}
        />
      </div>
      {/* PHASE 5A — floor interaction. A faint, purely-opacity-pulsing radial
          glow at the point where the gold flow's lower sweep lands beside
          the pedestal (see FLOW_LANDING_OFFSET_*_PCT above). It never moves
          or resizes — only hero-floor-flow-glow-pulse's opacity animates
          (styles.css) — so it reads as the passing energy warming the floor,
          not as a light of its own. Omitted entirely until the globe box is
          measurable, rather than guessing a position for one frame. */}
      {m && m.glowX !== null && m.glowY !== null && m.glowW !== null && m.glowH !== null && (
        <div
          className="hero-floor-flow-glow pointer-events-none absolute"
          style={{
            left: m.glowX,
            top: m.glowY,
            width: m.glowW,
            height: m.glowH,
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
    </div>
  );
}
