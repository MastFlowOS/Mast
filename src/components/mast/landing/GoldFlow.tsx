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
 * PHASE 4C — MOTION. The PNG is still the exact 3A.2 asset, at the exact
 * same left/top/width/rotation. Nothing about the base image moved. What's
 * new is a thin SVG overlay, in the same box, with the same rotation,
 * drawn directly on top of it (see FLOW_ENERGY_PATH_D below): two stroked
 * <path> copies of the flow's own centerline (traced from the asset's pixel
 * data, not eyeballed), each with a repeating stroke-dasharray whose
 * dashoffset is animated by CSS. Shifting a tiled dash pattern along a
 * stationary path reads as particles travelling through it, while the path
 * itself never moves — no element here ever changes position, scale, or
 * shape; only stroke-dashoffset ticks (see hero-gold-flow-* in styles.css).
 * One layer is a wide, heavily-blurred, low-opacity band (the passing
 * "glow"); the other is a thin, faster, brighter dash train (the "spark"
 * dust). Both sit inside an `isolation: isolate` wrapper with the base
 * image so their `mix-blend-mode: screen` only lightens the flow itself,
 * never the floor or atmosphere behind it. Under prefers-reduced-motion the
 * whole overlay unmounts, leaving exactly the static Phase 3A.2 image.
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
 * The asset is a real RGBA PNG (alpha 0 at all four corners; ~66% of pixels
 * fully transparent). It is drawn with plain normal blending. The one
 * exception to "the asset is untouched" is the top mask below, which only
 * dissolves the image's top few percent — the stream runs off the top of the
 * source frame, so on layouts where that edge falls inside the hero (stacked
 * mobile/tablet) it would otherwise read as a flat cut.
 */

import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";

const FLOW_ASSET = "/images/mast-gold-flow.png";
// Natural asset proportions (1536 x 1024 px).
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
// overpowering the tiny dust as the flow gets more visible again.
const FLOW_OPACITY = 0.78;
const FLOW_FILTER = "brightness(0.9) contrast(0.82) saturate(1.05)";

// PHASE 4C — ENERGY OVERLAY. A centerline traced through the asset's own
// bright-core pixels (weighted row centroid, not hand-drawn), in the same
// 1536×1024 pixel space as the PNG. Rendered by an SVG that shares the
// image's exact box/rotation above, so this line sits pixel-for-pixel over
// the source stream at every breakpoint. It is never redrawn or animated
// itself — only used as the <path> two dash overlays travel along.
const FLOW_ENERGY_PATH_D =
  "M147.3 0.0 L182.0 11.5 L215.9 23.0 L249.0 34.5 L281.3 46.0 L312.6 57.5 " +
  "L343.0 69.0 L372.3 80.5 L400.5 92.0 L427.5 103.4 L453.3 114.9 L477.8 126.4 " +
  "L500.9 137.9 L522.6 149.4 L542.8 160.9 L561.4 172.4 L578.4 183.9 L593.8 195.4 " +
  "L607.4 206.9 L619.2 218.4 L629.2 229.9 L637.2 241.4 L643.2 252.9 L647.2 264.4 " +
  "L649.3 275.9 L649.7 287.4 L648.6 298.9 L646.3 310.3 L643.0 321.8 L638.8 333.3 " +
  "L634.0 344.8 L628.9 356.3 L623.6 367.8 L618.3 379.3 L613.3 390.8 L608.8 402.3 " +
  "L605.1 413.8 L602.2 425.3 L600.6 436.8 L600.3 448.3 L601.5 459.8 L604.6 471.3 " +
  "L609.8 482.8 L617.1 494.3 L627.0 505.8 L639.5 517.2 L654.6 528.7 L672.3 540.2 " +
  "L692.2 551.7 L714.0 563.2 L737.7 574.7 L762.8 586.2 L789.3 597.7 L816.8 609.2 " +
  "L845.1 620.7 L874.1 632.2 L903.4 643.7 L932.8 655.2 L962.1 666.7 L991.0 678.2 " +
  "L1019.4 689.7 L1047.0 701.2 L1073.5 712.7 L1098.8 724.1 L1122.5 735.6 L1144.5 747.1 " +
  "L1164.5 758.6 L1182.3 770.1 L1197.8 781.6 L1210.7 793.1 L1221.1 804.6 L1228.9 816.1 " +
  "L1234.1 827.6 L1236.6 839.1 L1236.3 850.6 L1233.3 862.1 L1227.3 873.6 L1218.5 885.1 " +
  "L1206.6 896.6 L1191.8 908.1 L1173.8 919.6 L1152.7 931.0 L1128.3 942.5 L1100.8 954.0 " +
  "L1069.9 965.5 L1035.6 977.0 L997.9 988.5 L956.7 1000.0 L911.9 1011.5 L863.6 1023.0";

// Wide, heavily-blurred, low-opacity dash band: the passing "glow". Dash
// pattern sum (70 + 210 = 280) matches hero-gold-flow-glow-shift's end
// offset in styles.css, so the tiled pattern loops with no visible seam.
const FLOW_ENERGY_GLOW_DASH = "70 210";
const FLOW_ENERGY_GLOW_COLOR = "#F0C170";

// Thin, brighter, faster dash train: the "spark" dust riding the glow.
// Varied dash/gap lengths read as a loose string of particle clusters
// rather than a single traveling blob. Sum (253) matches
// hero-gold-flow-spark-shift's end offset the same way.
const FLOW_ENERGY_SPARK_DASH = "2 34 1 52 3 20 1 60 2 28 4 46";
const FLOW_ENERGY_SPARK_COLOR = "#FFF3D2";

type Frame = { x: number; y: number; w: number; h: number };

export function GoldFlow({
  pedestalAnchorRef,
}: {
  pedestalAnchorRef: RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  // Unique per mount so the SVG filter ids below never collide if this
  // component is ever rendered more than once on a page.
  const uid = useId();
  const glowBlurId = `goldFlowGlowBlur-${uid}`;
  const sparkBlurId = `goldFlowSparkBlur-${uid}`;

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
            // Flow box: identical left/top/width/rotation the image alone used
            // to carry directly. Both the static image and the Phase 4C energy
            // overlay now read their position from this one shared box, so
            // they can never drift apart. `isolation: isolate` scopes the
            // overlay's `mix-blend-mode: screen` (see below) to blending with
            // just the image behind it in here — not the floor or atmosphere
            // further back. The top mask also lives here so it dissolves both
            // layers together (see TRANSPARENCY above).
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
              isolation: "isolate",
            }}
          >
            <img
              src={FLOW_ASSET}
              alt=""
              draggable={false}
              decoding="async"
              className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none"
              style={{ opacity: FLOW_OPACITY, filter: FLOW_FILTER }}
            />
            {/* PHASE 4C — energy overlay. Same box, same rotation, same
                stationary path as the centerline above; only the two dash
                patterns' offsets are animated (see styles.css). Unmounted
                entirely under prefers-reduced-motion, so reduced motion is
                exactly the static Phase 3A.2 image above with nothing on
                top of it. */}
            <svg
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 1536 1024"
              preserveAspectRatio="none"
              className="hero-gold-flow-energy pointer-events-none absolute inset-0 block w-full h-full select-none"
            >
              <defs>
                <filter id={glowBlurId} x="-30%" y="-60%" width="160%" height="220%">
                  <feGaussianBlur stdDeviation="14" />
                </filter>
                <filter id={sparkBlurId} x="-20%" y="-40%" width="140%" height="180%">
                  <feGaussianBlur stdDeviation="2" />
                </filter>
              </defs>
              <path
                d={FLOW_ENERGY_PATH_D}
                className="hero-gold-flow-glow"
                fill="none"
                stroke={FLOW_ENERGY_GLOW_COLOR}
                strokeWidth={60}
                strokeLinecap="round"
                strokeOpacity={0.22}
                strokeDasharray={FLOW_ENERGY_GLOW_DASH}
                style={{ filter: `url(#${glowBlurId})`, mixBlendMode: "screen" }}
              />
              <path
                d={FLOW_ENERGY_PATH_D}
                className="hero-gold-flow-spark"
                fill="none"
                stroke={FLOW_ENERGY_SPARK_COLOR}
                strokeWidth={13}
                strokeLinecap="round"
                strokeOpacity={0.85}
                strokeDasharray={FLOW_ENERGY_SPARK_DASH}
                style={{ filter: `url(#${sparkBlurId})`, mixBlendMode: "screen" }}
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
