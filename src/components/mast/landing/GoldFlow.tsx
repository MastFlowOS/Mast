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
 * PHASE 8 — TRIED, REVERTED. Swapped the animated WebP for an opaque 60 FPS
 * H.264/VP9 video on a pure-black background, composited with
 * `mix-blend-mode: screen` (screen-blending pure black is mathematically a
 * no-op, so black was meant to read as "invisible"). In practice this never
 * fully worked: lossy video compression does not preserve exact (0,0,0)
 * black, so the whole video frame carried faint compression noise that
 * screen-blending lightened into a visible rectangle sitting behind the
 * globe — worse, that rectangle survives even after the blend-mode/
 * stacking-context isolation bug (transform on an ancestor breaking the
 * blend's backdrop) is fixed, because the noise floor itself is baked into
 * the encoded pixels, not a compositing bug. A blend-mode illusion of
 * transparency is strictly less reliable than real alpha. Reverted back to
 * the Phase 5B animated WebP, which carries genuine RGBA alpha (verified
 * fully transparent, alpha 0, at all four corners and throughout the
 * background) — no blend trick, so no rectangle, at some cost in decode
 * efficiency versus hardware video.
 *
 * PHASE 9 — MOTION-BLUR SMOOTHING, SUPERSEDED BY 10. First attempt at the
 * "still stiff" problem: bumped the WebP to 32 frames / 5 fps and added
 * motion blur (each frame = an average of several renders across a small
 * shutter window). Measurably smoother (adjacent-frame difference dropped
 * ~16%) but still visibly stepping — because the animated-WebP format
 * itself was the ceiling, not this file's choice of frame count. See PHASE
 * 10.
 *
 * PHASE 10 — TRUE VIDEO, TRUE ALPHA. The animated WebP is a SOFTWARE-decoded
 * image format: the main thread fully decodes every frame, so its frame
 * budget is capped by decode cost, not by how smooth the motion needs to
 * look. Phase 1 already found that format's ceiling (48 frames @ native
 * caused real scroll jank; even Phase 9's eased-up 32 @ half-res still read
 * as stepping) — there was no frame-count knob left to turn without either
 * reintroducing jank or staying stiff.
 *
 * Video is decoded by the OS/GPU, so frame count is effectively free. FLOW_
 * ASSET_MOTION is 160 frames / 25 fps over the same 6.4s loop — 5x Phase 9's
 * temporal resolution — encoded from the exact same offline flow model
 * (scripts/generate-gold-flow-animation.py's Renderer) at NATIVE 1536x1024,
 * for less browser CPU cost than Phase 9's WebP, because decode moved to
 * hardware.
 *
 * This is not Phase 8 again. Phase 8 was reverted because it encoded an
 * OPAQUE video and faked transparency with `mix-blend-mode: screen` over
 * pure black — lossy compression doesn't preserve exact (0,0,0) black, so
 * compression noise in the "invisible" areas turned into a visible
 * rectangle. That bug was in the transparency trick, not in video itself.
 * Phase 10 never treats any color as transparent: the video's single frame
 * packs two honest signals, stacked —
 *
 *     [ color  — straight RGB,      top half    ]
 *     [ alpha  — grayscale matte,   bottom half  ]
 *
 * — and a two-line WebGL fragment shader (see useAlphaVideoLayer below)
 * recombines them into one RGBA image on the GPU every frame: rgb from the
 * top half, alpha from the bottom half's luminance. Compression noise in a
 * lossy matte just softens its edges slightly; it can never paint color
 * into a transparent area, because color and alpha are independent channels
 * of the signal, not one channel standing in for both.
 *
 * Degrades safely in three independent ways, in order: no WebGL context →
 * falls back to the static PNG. WebGL OK but the video errors or autoplay
 * is blocked → falls back to the static PNG. prefers-reduced-motion → same
 * static PNG as always, video element never even mounts. The canvas gets
 * the exact same wrapper box, CSS mask, filter, opacity, and rotation the
 * <img> always had, so none of the PLACEMENT/TRANSPARENCY math below
 * changed — only how the pixels inside that box get onto the screen.
 *
 * REDUCED MOTION. Same as every prior phase: prefers-reduced-motion swaps in
 * the static PHASE 3A.2 PNG and skips video/canvas/WebGL entirely — nothing
 * autoplays, nothing to pause.
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
 * four corners, drawn with plain normal blending — no mix-blend-mode, no
 * chroma-key, nothing that depends on the exact color value of "background"
 * pixels. The one exception to "the asset is untouched" is the top mask
 * below, which only dissolves the image's top few percent — the stream runs
 * off the top of the source frame, so on layouts where that edge falls
 * inside the hero (stacked mobile/tablet) it would otherwise read as a flat
 * cut.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const FLOW_ASSET_MOTION = "/images/mast-gold-flow-motion.mp4";
const FLOW_ASSET_STATIC = "/images/mast-gold-flow.png";
// Natural asset proportions (1536 x 1024 px per channel) — 1.5 aspect ratio.
// The video file itself is 1536x2048 (color+matte stacked); this is the
// displayed/composited aspect ratio, unchanged from every prior phase.
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

// ---- alpha-video compositor ------------------------------------------------
// One video frame = color (top half) stacked on a grayscale alpha matte
// (bottom half). Each vertex carries its own UV (top of screen = v 0), so the
// shader just samples the top half for rgb and the bottom half's red channel
// for alpha and emits premultiplied RGBA. NOTE: UNPACK_FLIP_Y_WEBGL must stay
// at its default (false) — verified in a real browser; flipping it swaps the
// halves and renders the matte as the picture.
const VERT_SRC = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  vec3 rgb = texture2D(uTex, vec2(vUv.x, vUv.y * 0.5)).rgb;
  float a = texture2D(uTex, vec2(vUv.x, 0.5 + vUv.y * 0.5)).r;
  gl_FragColor = vec4(rgb * a, a);
}`;

// x, y, u, v — triangle strip covering the whole canvas.
const QUAD = new Float32Array([-1, 1, 0, 0, -1, -1, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1]);

type VideoWithVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

function useAlphaVideoLayer(
  enabled: boolean,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onFail: () => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    const video = videoRef.current as VideoWithVFC | null;
    if (!canvas || !video) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) {
      onFail();
      return;
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram()!;
    if (!vs || !fs) {
      onFail();
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      onFail();
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    const aUv = gl.getAttribLocation(prog, "aUv");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.clearColor(0, 0, 0, 0);

    let stopped = false;
    let vfcId = 0;
    let rafId = 0;

    const draw = () => {
      if (stopped || video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
      try {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } catch {
        stopped = true;
        onFail();
      }
    };

    // Draw exactly when a new video frame is presented where supported;
    // otherwise fall back to a plain rAF loop (same visual result).
    const useVFC = typeof video.requestVideoFrameCallback === "function";
    const loopVFC = () => {
      draw();
      if (!stopped) vfcId = video.requestVideoFrameCallback!(loopVFC);
    };
    const loopRAF = () => {
      draw();
      if (!stopped) rafId = requestAnimationFrame(loopRAF);
    };
    const start = () => (useVFC ? loopVFC() : loopRAF());

    video.muted = true;
    video.play().then(start, onFail);

    // Don't decode/draw while the flow is scrolled out of view.
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            if (stopped) return;
            if (entry.isIntersecting) {
              if (video.paused) video.play().catch(() => {});
            } else if (!video.paused) {
              video.pause();
            }
          })
        : null;
    io?.observe(canvas);

    const onLost = (e: Event) => {
      e.preventDefault();
      stopped = true;
      onFail();
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      stopped = true;
      io?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      if (vfcId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(vfcId);
      if (rafId) cancelAnimationFrame(rafId);
      video.pause();
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, [enabled, canvasRef, videoRef, onFail]);
}

type Frame = { x: number; y: number; w: number; h: number };

export function GoldFlow({
  globeBox,
}: {
  // The globe's own box, measured once by Hero via useGlobeBox and shared
  // with GroundSurface — see that hook for why this replaced GoldFlow's own
  // resize/fonts-ready measurement of the same element.
  globeBox: DOMRect | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [motionFailed, setMotionFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onMotionFail = useCallback(() => setMotionFailed(true), []);
  const useStatic = prefersReducedMotion || motionFailed;

  // Only start the compositor once the flow box exists (canvas + video are
  // mounted together with it).
  useAlphaVideoLayer(!useStatic && !!frame, canvasRef, videoRef, onMotionFail);

  // Backing-store size: the flow box's CSS size x DPR, capped at the video's
  // native per-channel resolution (no point rendering past the source).
  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const cssW = frame ? (frame.w * FLOW_WIDTH_PCT) / 100 : 0;
  const pxW = Math.max(1, Math.min(1536, Math.round(cssW * dpr)));
  const pxH = Math.max(1, Math.round((pxW * 1024) / 1536));

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mql.matches);

    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !globeBox) return;

    const c = container.getBoundingClientRect();
    const nextX = globeBox.left - c.left;
    const nextY = globeBox.top - c.top;
    const nextW = globeBox.width;
    const nextH = globeBox.height;

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
  }, [globeBox]);

  // Identical compositing the <img> always carried, shared by both paths.
  const flowLayerStyle: React.CSSProperties = {
    opacity: FLOW_OPACITY,
    filter: FLOW_FILTER,
    WebkitMaskImage: FLOW_TOP_MASK,
    maskImage: FLOW_TOP_MASK,
    transformOrigin: "0 0",
    transform: `rotate(${FLOW_ROTATE_DEG}deg)`,
  };

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
            // carried. The top mask lives here so it dissolves whichever
            // asset below resolves to.
            className="pointer-events-none absolute block"
            style={{
              left: `${FLOW_LEFT_PCT}%`,
              top: `${FLOW_TOP_PCT}%`,
              width: `${FLOW_WIDTH_PCT}%`,
              height: "auto",
              aspectRatio: FLOW_ASPECT_RATIO,
            }}
          >
            {useStatic ? (
              <img
                src={FLOW_ASSET_STATIC}
                alt=""
                draggable={false}
                decoding="async"
                className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none"
                style={flowLayerStyle}
              />
            ) : (
              <>
                <canvas
                  ref={canvasRef}
                  width={pxW}
                  height={pxH}
                  className="pointer-events-none absolute inset-0 block w-full h-full max-w-none select-none"
                  style={flowLayerStyle}
                />
                {/* Decode-only source for the canvas; 1px + transparent rather
                    than display:none so browsers don't throttle its decode. */}
                <video
                  ref={videoRef}
                  src={FLOW_ASSET_MOTION}
                  muted
                  loop
                  playsInline
                  autoPlay
                  preload="auto"
                  onError={onMotionFail}
                  className="pointer-events-none absolute left-0 top-0"
                  style={{ width: 1, height: 1, opacity: 0 }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
