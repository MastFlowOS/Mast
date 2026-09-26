#!/usr/bin/env python3
"""
Generate a high-frame-rate transparent WebM video (public/images/mast-gold-flow-animated.webm)
from the approved static gold-flow PNG (public/images/mast-gold-flow.png).

Targets:
- 30 FPS over 6.4 seconds = 192 frames (completely smooth, continuous dust flow)
- 768x512 resolution (scale 0.5 of master 1536x1024)
- VP9 with alpha channel (yuva420p)
- Direct stdin pipe into FFmpeg (zero disk temporary frames)
"""

import argparse
import importlib.util
import os
import subprocess
import sys
import time
from PIL import Image

import imageio_ffmpeg

# Set single thread per library to avoid memory thrashing on Windows
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["OMP_NUM_THREADS"] = "2"

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "public", "images", "mast-gold-flow.png")
OUT_WEBM = os.path.join(ROOT, "public", "images", "mast-gold-flow-animated.webm")

LOOP_SECONDS = 6.4
FPS = 30.0
N_FRAMES = int(round(LOOP_SECONDS * FPS))  # 192 frames
OUT_W = 768
OUT_H = 512


def main():
    parser = argparse.ArgumentParser(description="Generate 30 FPS transparent WebM video")
    parser.add_argument("--out", default=OUT_WEBM)
    parser.add_argument("--fps", type=float, default=FPS)
    parser.add_argument("--frames", type=int, default=N_FRAMES)
    parser.add_argument("--crf", type=int, default=26)
    parser.add_argument("--bitrate", default="2200k")
    args = parser.parse_args()

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    phis = [k / args.frames for k in range(args.frames)]
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
    to_rgba8 = mod.to_rgba8

    print(f"Starting WebM render: {total} frames at {args.fps} FPS ({LOOP_SECONDS}s loop)...", file=sys.stderr)
    print(f"Output resolution: {OUT_W}x{OUT_H}, target: {args.out}", file=sys.stderr)

    # Launch ffmpeg process listening on stdin
    cmd = [
        ffmpeg_exe, "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-s", f"{OUT_W}x{OUT_H}",
        "-pix_fmt", "rgba",
        "-r", str(args.fps),
        "-i", "-",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        "-b:v", args.bitrate,
        "-minrate", "1000k",
        "-maxrate", "3500k",
        "-crf", str(args.crf),
        "-quality", "good",
        "-speed", "2",
        "-row-mt", "1",
        args.out,
    ]

    t0 = time.time()
    ffmpeg_proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    for i, phi in enumerate(phis):
        rgb, a = r.frame(phi)
        rgba = to_rgba8(rgb, a)
        img = Image.fromarray(rgba, "RGBA")
        if (img.width, img.height) != (OUT_W, OUT_H):
            img = img.resize((OUT_W, OUT_H), Image.LANCZOS)
        
        ffmpeg_proc.stdin.write(img.tobytes())

        elapsed = time.time() - t0
        fps_so_far = (i + 1) / max(0.1, elapsed)
        remaining = (total - (i + 1)) / max(0.1, fps_so_far)
        sys.stderr.write(f"\rRendered {i + 1}/{total} frames ({((i + 1)/total)*100:.1f}%) | {fps_so_far:.2f} fps | ETA: {remaining:.0f}s")
        sys.stderr.flush()

    print("\nFinalizing WebM encoding in FFmpeg...", file=sys.stderr)
    ffmpeg_proc.stdin.close()
    _, stderr_bytes = ffmpeg_proc.communicate()

    if ffmpeg_proc.returncode != 0:
        print(f"FFmpeg error:\n{stderr_bytes.decode('utf-8', errors='ignore')}", file=sys.stderr)
        sys.exit(1)

    t_total = time.time() - t0
    size_mb = os.path.getsize(args.out) / 1e6
    print(f"\nDone! Wrote {args.out} ({size_mb:.2f} MB, {total} frames, {args.fps} FPS, {total/args.fps:.1f}s) in {t_total:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
