/**
 * GoldFlow — the hero's gold environmental flow.
 *
 * PHASE 3A — STATIC INTEGRATION ONLY. One approved transparent PNG, rendered
 * as a single <img>, exactly as supplied: not redrawn, recreated in CSS, or
 * turned into a particle system. No canvas, no WebGL, no RAF, no timers, no
 * scroll hooks. Nothing here animates.
 *
 * PHASE 3A.1 / 3A.2 — INTENSITY. The PNG bytes are still untouched and no
 * second asset was generated; opacity/brightness/contrast/saturate are
 * applied as compositing only (see FLOW_OPACITY / FLOW_FILTER below) to
 * bring the rendered intensity toward "cosmic dust, not a solid beam," then
 * tuned back up once 3A.1 read as too dim. Path, scale, rotation, and
 * placement below are unchanged from Phase 3A.
 *
 * PHASE 4C / 5A — SUPERSEDED BY 5B, REMOVED. These phases drove a thin SVG
 * overlay traced over the static PNG: two, then three, stroked <path> copies
 * of the flow's centerline with a repeating stroke-dasharray whose
 * dashoffset was animated by CSS. That reads as beads/dashes travelling
 * along a wire, not as dust — a tiled dash pattern is a small number of
 * discrete repeating shapes, however small each one is drawn, and shifting
 * it along a static path is a fundamentally different motion from a particle
 * field advecting through space. See PHASE 5B below for the replacement.
 *
 * PHASE 5B — REAL GOLD-DUST FLOW. The SVG dash overlay is gone. In its place,
 * FLOW_ASSET is now a pre-rendered, seamlessly-looping, transparent animated
 * WebP (mast-gold-flow-animated.webp): the *same* still, offline-decomposed
 * into a static haze/envelope and a dust texture, then the dust texture is
 * carried downstream along the stream's own traced ridge (see
 * scripts/generate-gold-flow-animation.py for the full method) and baked
 * into 48 frames. So what plays back is thousands of the still's own grains
 * continuously drifting and regrouping along the fixed S-shaped path — not a
 * shape sliding along a line — while remaining a single <img>: still no
 * canvas, no WebGL, no RAF, no per-particle JS, no runtime animation system
 * of any kind. The browser just decodes and plays an animated image, exactly
 * as it would a GIF.
 *
 * Every other value below — position, scale, rotation, opacity/filter,
 * top mask — is untouched from Phase 3A.2; only the asset the <img> points
 * to (and, for prefers-reduced-motion, which asset it points to) changed.
 *
 * REDUCED MOTION. Animated WebPs autoplay all their frames the moment
 * they're decoded — there's no CSS to pause an <img>'s own animation — so
 * respecting prefers-reduced-motion means choosing a different SRC, not
 * stopping a running one. That's done with a <picture>: a <source> that
 * only matches "(prefers-reduced-motion: reduce)" points at the original
 * static PHASE 3A.2 PNG, and the plain <img> fallback (used whenever that
 * media query doesn't match) points at the animated WebP. The browser
 * resolves this itself before ever requesting a file, so a reduced-motion
 * visitor never downloads the animated asset at all — no JS, no
 * matchMedia listener, nothing to hydrate.
 *
 * LAYERING (see Hero in routes/index.tsx)
 *
 *   atmosphere  →  GroundSurface  →  GOLD FLOW  →  globe + stand + copy
 *
 * This component is a z-0 sibling rendered directly after GroundSurface, so
 * DOM order puts it above the floor, and the z-10 content container (globe
 * column + hero copy) sits above it. The flow therefore passes BEHIND the
 * globe and stand and behind the hero text, and stays connected to the floor
 * because its lower end lands at the pedestal's ground-contact height.
 *
 * PLACEMENT — GLOBE-RELATIVE
 * The composition in the reference is defined relative to the globe, not the
 * viewport: the stream enters from the top just left of the globe, sweeps
 * down its left side, passes behind it, and re-emerges lower-right, ending at
 * floor level beside the pedestal. So the flow is positioned in the globe
 * asset's own box (the same box GlobeStand renders — read off the pedestal
 * marker's parent, so GlobeStand needs no changes and this file duplicates none
 * of its sizing). Every FLOW_* value below is a percentage of that box, so the
 * flow scales proportionally with the globe at every breakpoint and never
 * needs a separate breakpoint system.
 *
 * The FLOW_* constants were solved against the reference by least-squares
 * fitting the asset's centerline onto the reference's visible flow path
 * (scale ≈ 1.87x the globe, ≈ 4° clockwise). If the asset is swapped, only
 * FLOW_ASSET / FLOW_ASPECT_RATIO and these constants need to change.
 *
 * TRANSPARENCY
 * Both the static PNG and the animated WebP are real RGBA, alpha 0 at all
 * four corners, drawn with plain normal blending. The one exception to "the
 * asset is untouched" is the top mask below, which only dissolves the
 * image's top few percent — the stream runs off the top of the source frame,
 * so on layouts where that edge falls inside the hero (stacked
 * mobile/tablet) it would otherwise read as a flat cut.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// PHASE 5B — the pre-rendered animated dust flow (see the file-level comment
// above). FLOW_ASSET_STATIC is the original Phase 3A.2 still, kept as the
// prefers-reduced-motion source and as the generator script's input; it is
// pixel-for-pixel what used to be the only asset here.
const FLOW_ASSET = "/images/mast-gold-flow-animated.webp";
const FLOW_ASSET_STATIC = "/images/mast-gold-flow.png";
// Natural asset proportions (1536 x 1024 px) — identical for both assets.
const FLOW_ASPECT_RATIO = "1536 / 1024";

// Placement of the flow image's top-left corner and its width, as a
// percentage of the globe box (width for left/width, height for top).
const FLOW_LEFT_PCT = -90;
const FLOW_TOP_PCT = -25.5;
const FLOW_WIDTH_PCT = 267.8;
// Slight clockwise tilt about the top-left corner: steepens the sweep so the
// stream hugs the globe's left side, as in the reference.
const FLOW_ROTATE_DEG = 3.8;

// Dissolves only the top edge of the image (image-local %). See TRANSPARENCY.
const FLOW_TOP_MASK =
  "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 9%, rgba(0,0,0,1) 100%)";

// PHASE 3A.1 — INTENSITY. The source asset renders as a bright, dense,
// near-solid ribbon with large blown-out orbs. These three values pull it
// toward "fine illuminated cosmic dust" without touching the asset, path,
// placement, or rotation above:
//   - FLOW_OPACITY thins the whole layer so the floor/atmosphere behind it
//     shows through, breaking up the "solid beam" read.
//   - contrast() does most of the shaping work: it pulls extreme (near-white
//     core/orb) values down hard while barely touching — and slightly
//     lifting — the faint dust values, so the tiny particles stay visible
//     while the brightest points get tamed the most.
//   - brightness() knocks the remaining peak brightness down further.
//   - saturate() nudges the color back toward warm gold, since dimming a
//     near-white core desaturates it toward gray.
//
// PHASE 3A.2 — TUNE. 3A.1's values (opacity 0.6, brightness 0.78) read as
// too dim, especially along the upper sweep and the pass behind the globe.
// Opacity and brightness are both eased back up toward the source; contrast
// is left at 3A.1's level, since that's what keeps the large particles from
// overpowering the tiny dust as the flow gets more visible again. PHASE 5B
// applies these identically to the animated WebP — every frame of it was
// rendered from this same still, so the same compositing reads the same way.
const FLOW_OPACITY = 0.78;
const FLOW_FILTER = "brightness(0.9) contrast(0.82) saturate(1.05)";

type Frame = { x: number; y: number; w: number; h: number };

export function GoldFlow({
  pedestalAnchorRef,
}: {
  pedestalAnchorRef: RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // The pedestal marker is a direct child of GlobeStand's root box, which is
    // exactly the globe asset's box — so its parent IS the globe frame.
    const globeBox = () => pedestalAnchorRef.current?.parentElement ?? null;

    const measure = () => {
      const box = globeBox();
      if (!box) return;
      const c = container.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      setFrame({ x: b.left - c.left, y: b.top - c.top, w: b.width, h: b.height });
    };

    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);
    const box = globeBox();
    if (box) resizeObserver.observe(box);
    window.addEventListener("resize", measure);
    // Fonts finishing their swap can shift the globe column slightly.
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pedestalAnchorRef]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 select-none"
    >
      {frame && (
        // Globe frame: same box as the globe asset. Everything inside is
        // expressed as a percentage of it.
        <div
          className="pointer-events-none absolute"
          style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
        >
          <div
            // Flow box: identical left/top/width/rotation the image alone
            // has always carried. The top mask lives here so it dissolves
            // whichever asset the <picture> below resolves to.
            className="pointer-events-none absolute block"
            style={{
              left: `${FLOW_LEFT_PCT}%`,
              top: `${FLOW_TOP_PCT}%`,
              width: `${FLOW_WIDTH_PCT}%`,
              height: "auto",
              aspectRatio: FLOW_ASPECT_RATIO,
              transformOrigin: "0 0",
              transform: `rotate(${FLOW_ROTATE_DEG}deg)`,
              WebkitMaskImage: FLOW_TOP_MASK,
              maskImage: FLOW_TOP_MASK,
            }}
          >
            {/* PHASE 5B — a <picture> resolves the reduced-motion choice
                before any request is made: a reduced-motion visitor's
                browser only ever fetches the static PNG, never the animated
                WebP. No JS, no matchMedia, nothing to hydrate. */}
            <picture>
              <source media="(prefers-reduced-motion: reduce)" srcSet={FLOW_ASSET_STATIC} />
              <img
                src={FLOW_ASSET}
                alt=""
                draggable={false}
                decoding="async"
                className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none"
                style={{ opacity: FLOW_OPACITY, filter: FLOW_FILTER }}
              />
            </picture>
          </div>
        </div>
      )}
    </div>
  );
}
