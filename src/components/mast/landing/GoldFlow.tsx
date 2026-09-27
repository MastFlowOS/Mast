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
 * PHASE 4C / 5A — SUPERSEDED BY 5B, REMOVED. Thin SVG dash overlay traced
 * over the static PNG; read as beads travelling a wire, not dust. Replaced.
 *
 * PHASE 5B — Animated WebP (mast-gold-flow-animated.webp), same still
 * offline-decomposed into a haze/envelope layer plus a dust texture carried
 * downstream along the flow's own traced ridge, baked into frames. Real
 * RGBA alpha, no blend tricks — but browser-side animated-WebP playback is
 * comparatively inefficient to decode, and on this page it visibly stutters
 * rather than reading as smooth drifting dust. Kept only as the
 * prefers-reduced-motion fallback (a still frame is fine there — see below).
 *
 * PHASE 8 — HARDWARE-ACCELERATED OPAQUE VIDEO DELIVERY VIA SCREEN BLEND.
 * The same frames as Phase 5B, rendered instead as a normal opaque 30 FPS
 * H.264/VP9 video on a pure black background, composited with
 * `mix-blend-mode: screen`. On truly pure black, screen-blending is a
 * mathematical no-op (1 - (1-d)*(1-0) = d), so black reads as fully
 * "invisible" while gold luminance adds onto the dark hero backdrop —
 * hardware video decode, so it's smooth where the WebP wasn't.
 *
 * PHASE 8 initially shipped with two compounding bugs that both showed up as
 * a visible rectangle behind the globe instead of true transparency:
 *   1. The rotation transform lived on an ancestor wrapper around the
 *      video, not on the video itself. A CSS `transform` establishes a new
 *      stacking context, which isolates mix-blend-mode: the video's "screen"
 *      blend could then only see that empty wrapper as backdrop, not the
 *      real hero background behind it — so the blend never actually
 *      happened and the opaque black painted through as a plain rectangle.
 *      Fixed by moving `transform: rotate(...)` onto the video/img elements
 *      themselves (same visual result, since they fill the wrapper exactly)
 *      so the blend now composites against the real page background.
 *   2. Even after (1), a faint rectangle remained: the encoded mp4/webm
 *      never tagged an explicit color_range, so it was ambiguous whether
 *      the black background was "limited" (16-235) or "full" (0-255) range.
 *      A decoder that guessed differently than the encoder assumed would
 *      read the intended pure-black floor as a slightly-lifted, visibly
 *      non-zero value — not because any pixel was wrong, but because the
 *      decoder didn't know which range to map it through. Fixed at the
 *      source: scripts/generate-gold-flow-video.py now tags
 *      `-color_range tv -colorspace bt709 -color_primaries bt709
 *      -color_trc bt709` on both the H.264 and VP9 encodes, removing the
 *      ambiguity so every decoder reconstructs the same true (0,0,0) black
 *      that mix-blend-mode: screen needs to disappear completely.
 *
 * REDUCED MOTION. Video autoplay is suppressed by the browser under
 * prefers-reduced-motion in some environments and is unnecessary motion
 * regardless, so a reduced-motion visitor gets the static PHASE 3A.2 PNG
 * instead — chosen via a state flag read from matchMedia, no CSS animation
 * to pause.
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
 * The static PNG is real RGBA, alpha 0 at all four corners. The video is
 * opaque pure black at those same corners/background, made to read as
 * transparent via mix-blend-mode: screen (see PHASE 8 notes above for why
 * that requires both the no-ancestor-transform rule and the explicit
 * color_range tagging to actually hold). The one exception to "the asset is
 * untouched" is the top mask below, which only dissolves the image's top few
 * percent — the stream runs off the top of the source frame, so on layouts
 * where that edge falls inside the hero (stacked mobile/tablet) it would
 * otherwise read as a flat cut.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const FLOW_VIDEO_MP4 = "/images/mast-gold-flow-animated.mp4";
const FLOW_VIDEO_WEBM = "/images/mast-gold-flow-animated.webm";
const FLOW_ASSET_STATIC = "/images/mast-gold-flow.png";
// Natural asset proportions (1536 x 1024 px) — 1.5 aspect ratio.
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

const FLOW_OPACITY = 0.78;
const FLOW_FILTER = "brightness(0.9) contrast(0.82) saturate(1.05)";

type Frame = { x: number; y: number; w: number; h: number };

export function GoldFlow({
  pedestalAnchorRef,
}: {
  pedestalAnchorRef: RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mql.matches);

    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!prefersReducedMotion && !videoFailed && videoRef.current) {
      videoRef.current.play().catch(() => {
        // Autoplay rejection or codec error falls back cleanly
      });
    }
  }, [prefersReducedMotion, videoFailed]);

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
      const nextX = b.left - c.left;
      const nextY = b.top - c.top;
      const nextW = b.width;
      const nextH = b.height;

      setFrame((prev) => {
        if (
          prev &&
          Math.abs(prev.x - nextX) < 0.5 &&
          Math.abs(prev.y - nextY) < 0.5 &&
          Math.abs(prev.w - nextW) < 0.5 &&
          Math.abs(prev.h - nextH) < 0.5
        ) {
          return prev;
        }
        return { x: nextX, y: nextY, w: nextW, h: nextH };
      });
    };

    measure();

    // Responsive breakpoints are driven by window resizing; no continuous
    // ResizeObserver is needed, preventing layout thrashing and observer churn.
    window.addEventListener("resize", measure, { passive: true });
    // Fonts finishing their swap can shift the globe column slightly on first load.
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => {
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
            // Flow box: identical left/top/width the image alone has always
            // carried. No transform here — see PHASE 8 note (1) above for
            // why rotation must live on the media element itself, not this
            // wrapper, when that element also carries mix-blend-mode.
            className="pointer-events-none absolute block"
            style={{
              left: `${FLOW_LEFT_PCT}%`,
              top: `${FLOW_TOP_PCT}%`,
              width: `${FLOW_WIDTH_PCT}%`,
              height: "auto",
              aspectRatio: FLOW_ASPECT_RATIO,
            }}
          >
            {prefersReducedMotion || videoFailed ? (
              <img
                src={FLOW_ASSET_STATIC}
                alt=""
                draggable={false}
                decoding="async"
                className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none"
                style={{
                  opacity: FLOW_OPACITY,
                  filter: FLOW_FILTER,
                  WebkitMaskImage: FLOW_TOP_MASK,
                  maskImage: FLOW_TOP_MASK,
                  transformOrigin: "0 0",
                  transform: `rotate(${FLOW_ROTATE_DEG}deg)`,
                }}
              />
            ) : (
              <video
                ref={videoRef}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
                draggable={false}
                onError={() => setVideoFailed(true)}
                className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none object-cover"
                style={{
                  opacity: FLOW_OPACITY,
                  filter: FLOW_FILTER,
                  mixBlendMode: "screen",
                  WebkitMaskImage: FLOW_TOP_MASK,
                  maskImage: FLOW_TOP_MASK,
                  transformOrigin: "0 0",
                  transform: `rotate(${FLOW_ROTATE_DEG}deg)`,
                }}
              >
                <source src={FLOW_VIDEO_MP4} type="video/mp4" />
                <source src={FLOW_VIDEO_WEBM} type='video/webm; codecs="vp9"' />
                {/* Fallback for browsers that do not support video */}
                <img
                  src={FLOW_ASSET_STATIC}
                  alt=""
                  draggable={false}
                  decoding="async"
                  className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none"
                  style={{
                    opacity: FLOW_OPACITY,
                    filter: FLOW_FILTER,
                    WebkitMaskImage: FLOW_TOP_MASK,
                    maskImage: FLOW_TOP_MASK,
                    transformOrigin: "0 0",
                    transform: `rotate(${FLOW_ROTATE_DEG}deg)`,
                  }}
                />
              </video>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
