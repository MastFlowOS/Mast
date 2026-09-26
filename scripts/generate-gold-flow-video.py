#!/usr/bin/env python3
"""
Generate a 60 FPS opaque video (public/images/mast-gold-flow-animated.mp4
and mast-gold-flow-animated.webm) from the approved static gold-flow PNG
(public/images/mast-gold-flow.png) with a pure black background.

Used with `mix-blend-mode: screen` in GoldFlow.tsx:
- Black background (0,0,0) becomes completely invisible against the dark hero environment
- Gold luminance remains fully visible and vibrant
- Bypasses the transparent-alpha video decode path (VP9 yuva420p) which caused Media thread
  stalls (410ms, 135ms, 54ms) and dropped frames in Chromium
- Hardware accelerated H.264 / VP9 decode on GPU VPU with zero stalls
"""

import argparse
import gc
import importlib.util
import os
import subprocess
import sys
import time
import cv2
import numpy as np

import imageio_ffmpeg

# Avoid memory thrashing on Windows
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["OMP_NUM_THREADS"] = "2"

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "public", "images", "mast-gold-flow.png")
OUT_MP4 = os.path.join(ROOT, "public", "images", "mast-gold-flow-animated.mp4")
OUT_WEBM = os.path.join(ROOT, "public", "images", "mast-gold-flow-animated.webm")

LOOP_SECONDS = 6.4
DEFAULT_FPS = 60.0
OUT_W = 768
OUT_H = 512


def render_to_opaque_rgb24(rgb, a):
    """
    Convert premultiplied gold flow to opaque RGB24 on a pure black (#000000) background.
    Since `rgb` is already premultiplied (col * a), compositing over black (0,0,0)
    is simply `rgb`.
    We strictly clamp any sub-threshold background noise to exact 0 to eliminate any
    faint video bounding-box artifacts when rendered with `mix-blend-mode: screen`.
    """
    # Downsample using area averaging (fast, clean, zero ringing)
    rgb_half = cv2.resize(rgb, (OUT_W, OUT_H), interpolation=cv2.INTER_AREA)
    rgb8 = (np.clip(rgb_half, 0.0, 1.0) * 255.0).astype(np.uint8)
    
    # Zero out near-black background pixels (luminance < 1.5 out of 255)
    lum = 77 * rgb8[:, :, 0].astype(np.uint16) + 150 * rgb8[:, :, 1].astype(np.uint16) + 29 * rgb8[:, :, 2].astype(np.uint16)
    rgb8[lum < 400] = 0

    return rgb8.tobytes()


def main():
    parser = argparse.ArgumentParser(description="Generate 60 FPS opaque gold flow video on black background")
    parser.add_argument("--out-mp4", default=OUT_MP4)
    parser.add_argument("--out-webm", default=OUT_WEBM)
    parser.add_argument("--fps", type=float, default=DEFAULT_FPS)
    parser.add_argument("--frames", type=int, default=None)
    parser.add_argument("--crf", type=int, default=18)
    args = parser.parse_args()

    n_frames = args.frames if args.frames is not None else int(round(LOOP_SECONDS * args.fps))

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    phis = [k / n_frames for k in range(n_frames)]
    total = len(phis)

    print(f"Loading generator and assets...", file=sys.stderr)
    spec = importlib.util.spec_from_file_location(
        "anim_gen",
        os.path.join(ROOT, "scripts", "generate-gold-flow-animation.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    P = mod.load_premult()
    r = mod.Renderer(P)
    gc.collect()

    print(f"Starting Opaque Video render: {total} frames at {args.fps} FPS ({LOOP_SECONDS}s loop)...", file=sys.stderr)
    print(f"Output resolution: {OUT_W}x{OUT_H}, target MP4: {args.out_mp4}", file=sys.stderr)

    # Launch ffmpeg process encoding H.264 MP4 with yuv420p (standard hardware decode)
    cmd_mp4 = [
        ffmpeg_exe, "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-s", f"{OUT_W}x{OUT_H}",
        "-pix_fmt", "rgb24",
        "-r", str(args.fps),
        "-i", "-",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", str(args.crf),
        "-preset", "medium",
        "-tune", "film",
        "-movflags", "+faststart",
        "-g", str(int(args.fps)),
        args.out_mp4,
    ]

    t0 = time.time()
    ffmpeg_proc = subprocess.Popen(cmd_mp4, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    for i, phi in enumerate(phis):
        rgb, a = r.frame(phi)
        raw_bytes = render_to_opaque_rgb24(rgb, a)
        del rgb, a

        ffmpeg_proc.stdin.write(raw_bytes)

        if (i + 1) % 15 == 0:
            gc.collect()

        elapsed = time.time() - t0
        fps_so_far = (i + 1) / max(0.1, elapsed)
        remaining = (total - (i + 1)) / max(0.1, fps_so_far)
        sys.stderr.write(f"\rRendered {i + 1}/{total} frames ({((i + 1)/total)*100:.1f}%) | {fps_so_far:.2f} fps | ETA: {remaining:.0f}s")
        sys.stderr.flush()

    print("\nFinalizing MP4 encoding in FFmpeg...", file=sys.stderr)
    ffmpeg_proc.stdin.close()
    _, stderr_bytes = ffmpeg_proc.communicate()

    if ffmpeg_proc.returncode != 0:
        print(f"FFmpeg MP4 error:\n{stderr_bytes.decode('utf-8', errors='ignore')}", file=sys.stderr)
        sys.exit(1)

    t_mp4 = time.time() - t0
    size_mp4_mb = os.path.getsize(args.out_mp4) / 1e6
    print(f"\nWrote MP4: {args.out_mp4} ({size_mp4_mb:.2f} MB, {total} frames, {args.fps} FPS) in {t_mp4:.1f}s", file=sys.stderr)

    # Also generate WebM (VP9 opaque yuv420p without alpha) from the MP4
    if args.out_webm:
        print(f"Encoding companion WebM (VP9 opaque yuv420p)...", file=sys.stderr)
        cmd_webm = [
            ffmpeg_exe, "-y",
            "-i", args.out_mp4,
            "-c:v", "libvpx-vp9",
            "-pix_fmt", "yuv420p",
            "-b:v", "1800k",
            "-minrate", "800k",
            "-maxrate", "3000k",
            "-crf", "28",
            "-speed", "4",
            "-row-mt", "1",
            args.out_webm,
        ]
        subprocess.run(cmd_webm, check=True)
        size_webm_mb = os.path.getsize(args.out_webm) / 1e6
        print(f"Wrote WebM: {args.out_webm} ({size_webm_mb:.2f} MB)", file=sys.stderr)

    print("\nAll video assets successfully generated!")


if __name__ == "__main__":
    main()
