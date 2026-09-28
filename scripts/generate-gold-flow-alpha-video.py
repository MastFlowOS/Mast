#!/usr/bin/env python3
"""
Generate public/images/mast-gold-flow-motion.mp4 — PHASE 10.

WHY THIS EXISTS. Phase 5B/9's animated WebP is a *software-decoded* image
format: the browser's main thread has to fully decode every frame (libwebp,
no GPU path), so its frame budget is capped by decode cost, not by how
smooth the motion needs to look. Phase 1 already found the ceiling on this
asset's own resolution/frame-count trade-off (48 frames @ native caused real
scroll jank; Phase 9's 32 frames @ half-res was the safe side of that
ceiling) — and at the frame rate that ceiling allows (5 fps), fine dust
grain still visibly steps between frames no matter how the frames
themselves are rendered. There is no frame-count knob left to turn on this
format; the format itself is the limit.

Video is decoded by the OS/GPU, not the main thread, so frame count is
effectively free: this renders the *same* Renderer pipeline as
generate-gold-flow-animation.py, at native 1536x1024, at 25 fps (160 frames
over the same 6.4s loop) — 5x the temporal resolution of Phase 9, for less
CPU cost in the browser than Phase 9's 32-frame WebP, because decode moves
to hardware.

WHY THIS ISN'T PHASE 8 AGAIN. Phase 8 was reverted because it encoded an
OPAQUE video and relied on `mix-blend-mode: screen` over pure black to fake
transparency — lossy video compression doesn't preserve exact (0,0,0)
black, so compression noise in the "invisible" areas got lightened into a
visible rectangle. That bug was in the transparency *trick*, not in using
video per se. This script never pretends black is transparent: it encodes a
REAL alpha channel, as a second, honest video signal —

  a single frame = [ color (top half, straight RGB) ]
                    [ alpha (bottom half, grayscale matte) ]

— and GoldFlow.tsx composites the two halves back into one RGBA image on
the GPU with a two-line WebGL shader (rgb from the top half, alpha from the
bottom half's luminance). The matte is still lossy-compressed like anything
else in video, but compression noise in a matte just softens its edges
slightly; it can never paint a wrong color into a fully transparent area,
because the color and alpha tracks are independent channels of the same
lossy signal, not one channel standing in for both. No blend-mode, no
"black must decode to exactly zero" assumption anywhere.

Usage:  python scripts/generate-gold-flow-alpha-video.py [--frames N] [--fps F]
Needs:  same as generate-gold-flow-animation.py, plus ffmpeg (libx264) on PATH.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import subprocess
import sys
import time

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "public", "images", "mast-gold-flow-motion.mp4")

LOOP_SECONDS = 6.4
FPS = 25.0
N_FRAMES = round(LOOP_SECONDS * FPS)  # 160 — integer frames, closed loop


def _load_anim_module():
    """Import generate-gold-flow-animation.py by path (its name has hyphens,
    so it isn't a normal importable module) to reuse its Renderer, dust
    model, and render_frame_blurred exactly as-is — same flow model as the
    WebP, just sampled at a frame rate video can afford."""
    path = os.path.join(ROOT, "scripts", "generate-gold-flow-animation.py")
    spec = importlib.util.spec_from_file_location("gold_flow_animation", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--fps", type=float, default=FPS)
    ap.add_argument("--frames", type=int, default=None, help="overrides fps-derived count; loop length stays LOOP_SECONDS")
    ap.add_argument("--crf", type=int, default=18, help="x264 quality (lower = better/bigger; 18 is visually near-lossless)")
    ap.add_argument("--blur-samples", type=int, default=1, help="motion-blur samples per frame (1 = off; video's own frame rate does most of the smoothing work already)")
    ap.add_argument("--shutter", type=float, default=0.5)
    ap.add_argument("--frames-dir", default=None, help="if set, render PNGs into this dir instead of piping to ffmpeg (for chunked/resumable rendering)")
    ap.add_argument("--start", type=int, default=0, help="first frame index to render (with --frames-dir)")
    ap.add_argument("--end", type=int, default=None, help="one-past-last frame index to render (with --frames-dir); default = n_frames")
    ap.add_argument("--encode-only", action="store_true", help="skip rendering; just encode an existing --frames-dir of PNGs to --out")
    args = ap.parse_args()

    n_frames = args.frames if args.frames is not None else round(LOOP_SECONDS * args.fps)
    fps = n_frames / LOOP_SECONDS

    if args.frames_dir:
        os.makedirs(args.frames_dir, exist_ok=True)

    if args.encode_only:
        assert args.frames_dir, "--encode-only needs --frames-dir"
        encode_from_pngs(args.frames_dir, n_frames, fps, args.out, args.crf)
        return

    mod = _load_anim_module()
    print("Loading source + building flow model...", file=sys.stderr)
    P = mod.load_premult()
    r = mod.Renderer(P)
    H, W = r.H, r.W

    start = args.start
    end = args.end if args.end is not None else n_frames

    if args.frames_dir:
        from PIL import Image
        t0 = time.time()
        for i in range(start, end):
            phi = i / n_frames
            rgb, a = mod.render_frame_blurred(r, phi, n_frames, args.blur_samples, args.shutter)
            rgba8 = mod.to_rgba8(rgb, a)
            color = rgba8[..., :3]
            alpha_gray = np.repeat(rgba8[..., 3:4], 3, axis=2)
            combined = np.vstack([color, alpha_gray]).astype(np.uint8)
            Image.fromarray(combined, "RGB").save(os.path.join(args.frames_dir, f"frame_{i:04d}.png"))
            elapsed = time.time() - t0
            done = i - start + 1
            rate = done / max(elapsed, 0.001)
            eta = (end - i - 1) / max(rate, 0.001)
            print(f"\rframe {i + 1}/{n_frames} (batch {done}/{end - start})  {rate:.2f} fps  ETA {eta:.0f}s", end="", file=sys.stderr)
        print(file=sys.stderr)
        n_done = len([f for f in os.listdir(args.frames_dir) if f.startswith("frame_")])
        print(f"{n_done}/{n_frames} frames on disk in {args.frames_dir}", file=sys.stderr)
        return

    out_w, out_h = W, H * 2  # top: color, bottom: alpha matte
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{out_w}x{out_h}", "-pix_fmt", "rgb24", "-r", str(fps),
        "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", str(args.crf), "-preset", "medium", "-tune", "film",
        "-movflags", "+faststart",
        args.out,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    t0 = time.time()
    for i in range(n_frames):
        phi = i / n_frames
        rgb, a = mod.render_frame_blurred(r, phi, n_frames, args.blur_samples, args.shutter)
        rgba8 = mod.to_rgba8(rgb, a)  # (H, W, 4) uint8, straight (non-premultiplied) alpha
        color = rgba8[..., :3]
        alpha_gray = np.repeat(rgba8[..., 3:4], 3, axis=2)
        combined = np.vstack([color, alpha_gray]).astype(np.uint8)  # (2H, W, 3)
        proc.stdin.write(combined.tobytes())
        elapsed = time.time() - t0
        rate = (i + 1) / max(elapsed, 0.001)
        eta = (n_frames - i - 1) / max(rate, 0.001)
        print(f"\rframe {i + 1}/{n_frames}  ({rate:.2f} fps render, ETA {eta:.0f}s)", end="", file=sys.stderr)
    print(file=sys.stderr)

    proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        print(f"ffmpeg failed with code {proc.returncode}", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(args.out) / 1e6
    print(f"wrote {args.out}  {size_mb:.2f} MB  {n_frames} frames  {fps:.1f} fps  {n_frames/fps:.1f}s loop  {out_w}x{out_h} packed ({W}x{H} per channel)", file=sys.stderr)


def encode_from_pngs(frames_dir, n_frames, fps, out, crf):
    missing = [i for i in range(n_frames) if not os.path.exists(os.path.join(frames_dir, f"frame_{i:04d}.png"))]
    if missing:
        print(f"ERROR: {len(missing)} frames missing, e.g. {missing[:5]}", file=sys.stderr)
        sys.exit(1)
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frames_dir, "frame_%04d.png"),
        "-frames:v", str(n_frames),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", str(crf), "-preset", "medium", "-tune", "film",
        "-movflags", "+faststart",
        out,
    ]
    subprocess.run(cmd, check=True)
    size_mb = os.path.getsize(out) / 1e6
    print(f"wrote {out}  {size_mb:.2f} MB  {n_frames} frames  {fps:.1f} fps", file=sys.stderr)


if __name__ == "__main__":
    main()
