#!/usr/bin/env python3
"""
Generate a 60 FPS opaque video (public/images/mast-gold-flow-animated.mp4
and mast-gold-flow-animated.webm) from the approved static gold-flow PNG
(public/images/mast-gold-flow.png) with a pure black background.

TUNED MOTION MODEL:
- ENV_SIGMA = 26.0 px (soft glow stays static; dust & core filaments flow)
- SHIFT_FINE = 1150.0 px, SHIFT_MID = 800.0 px (visible dust advection)
- Removed orb freezing (celestial dust flows naturally without dead zones)
- MEDIAL_MARGIN = 24.0 px (smooth flow through inner bends without pinching)
- Mathematical loop closure at phi=0 and phi=1

Used with `mix-blend-mode: screen` in GoldFlow.tsx:
- Black background (#000000) becomes completely invisible against the dark hero environment
- Gold luminance remains fully visible and vibrant
- Bypasses transparent-alpha VP9 software decode (eliminates 410ms stalls and frame drops)
- Hardware-accelerated GPU VPU decode with 0 dropped frames
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

# TUNED MOTION PARAMETERS
ENV_SIGMA = 26.0
SHIFT_FINE = 1150.0
SHIFT_MID = 800.0
MEDIAL_MARGIN = 24.0


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

    print(f"Loading generator and assets...", file=sys.stderr)
    spec = importlib.util.spec_from_file_location(
        "anim_gen",
        os.path.join(ROOT, "scripts", "generate-gold-flow-animation.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    P = mod.load_premult()
    H, W = P.shape[:2]

    print("Building tuned flow model...", file=sys.stderr)
    E = mod.blur(P, ENV_SIGMA).astype(np.float32)

    # Band split: fine dust vs mid sparkle
    mid_src = mod.blur(P, 2.0)
    fine = (P - mid_src).astype(np.float32)
    mid = (mid_src - E).astype(np.float32)

    r_f = np.sqrt(mod.blur(mod.lum(fine) ** 2, mod.STRENGTH_SIGMA)).astype(np.float32)
    Dn_f = np.clip(fine / (r_f + mod.STRENGTH_EPS)[..., None], -5, 5).astype(np.float32)

    r_m = np.sqrt(mod.blur(mod.lum(mid) ** 2, mod.STRENGTH_SIGMA)).astype(np.float32)
    Dn_m = np.clip(mid / (r_m + mod.STRENGTH_EPS)[..., None], -5, 5).astype(np.float32)

    # Build path flow
    flow = mod.PathFlow(H, W, P)

    # Build w_move
    cs = 4
    gy, gx = np.mgrid[cs // 2:H:cs, cs // 2:W:cs]
    gp = np.stack([gx.ravel(), gy.ravel()], 1).astype(np.float64)
    onimg = (flow.S >= flow.s_lo - 300) & (flow.S <= flow.s_hi + 300)
    from scipy.spatial import cKDTree
    tree = cKDTree(flow.C[onimg])
    Sm, Cm, Tm, Nm = flow.S[onimg], flow.C[onimg], flow.T[onimg], flow.N[onimg]

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    pts = np.stack([xx.ravel(), yy.ravel()], 1).astype(np.float64)
    d1, i1 = tree.query(pts, workers=2)
    dv = pts - Cm[i1]
    s0 = (Sm[i1] + (dv * Tm[i1]).sum(1)).astype(np.float32).reshape(H, W)
    n = (dv * Nm[i1]).sum(1).astype(np.float32).reshape(H, W)

    # Medial margin
    sub = slice(None, None, 3)
    Cq, Sq = Cm[sub], Sm[sub]
    d2 = np.empty(len(gp))
    dd1 = np.empty(len(gp))
    for i in range(0, len(gp), 2048):
        blk = gp[i:i + 2048]
        dist = np.sqrt(((blk[:, None, :] - Cq[None]) ** 2).sum(-1))
        j = dist.argmin(1)
        dd1[i:i + 2048] = dist[np.arange(len(blk)), j]
        far_arm = np.abs(Sq[None] - Sq[j][:, None]) > 150.0
        d2[i:i + 2048] = np.where(far_arm, dist, 1e9).min(1)

    gap = (d2 - dd1).reshape(gy.shape[0], gx.shape[1]).astype(np.float32)
    gap = cv2.resize(gap, (W, H), interpolation=cv2.INTER_LINEAR)
    t_med = np.clip(gap / MEDIAL_MARGIN, 0, 1)
    w_med = t_med * t_med * (3 - 2 * t_med)

    na = np.abs(n)
    t_far = np.clip((130.0 - na) / (130.0 - 85.0), 0, 1)
    w_far = t_far * t_far * (3 - 2 * t_far)

    # No orb freeze: entire celestial stream flows
    w_move = (w_med * w_far).astype(np.float32)[..., None]

    pos0 = np.stack([xx, yy], -1)
    C0 = flow._interp(flow.C, s0)
    N0 = flow._interp(flow.N, s0)
    g_arr = (0.95 + (1 - 0.95) * np.exp(-((n / 85.0) ** 2))).astype(np.float32)

    mask_f = mod.dissolve_mask(H, W, 11)
    mask_m = mod.dissolve_mask(H, W, 12)
    sw = [np.stack([mod.smooth_noise(H, W, 30.0, sd), mod.smooth_noise(H, W, 30.0, sd + 1)], -1) for sd in (21, 31)]

    # Fast interpolation precomputation
    d_C = flow.C[1:] - flow.C[:-1]
    d_N = flow.N[1:] - flow.N[:-1]

    def fast_interp_C(s):
        f = np.clip(s, 0, flow.S[-1]) / flow.DS
        i0 = np.minimum(f.astype(np.int32), len(flow.C) - 2)
        t = (f - i0)[..., None]
        return flow.C[i0] + d_C[i0] * t

    def fast_interp_N(s):
        f = np.clip(s, 0, flow.S[-1]) / flow.DS
        i0 = np.minimum(f.astype(np.int32), len(flow.N) - 2)
        t = (f - i0)[..., None]
        return flow.N[i0] + d_N[i0] * t

    def get_map(delta, swirl):
        s_src = flow.reflect(s0 - delta * g_arr)
        C = fast_interp_C(s_src)
        N = fast_interp_N(s_src)
        q = pos0 + (C - C0) + n[..., None] * (N - N0) + swirl
        return q[..., 0].astype(np.float32), q[..., 1].astype(np.float32)

    def get_layer(Dn, r_w, D, mask, shift, phi, swirl):
        ax, ay = get_map(phi * shift, swirl)
        bx, by = get_map((phi - 1.0) * shift, swirl)
        A = cv2.remap(Dn, ax, ay, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
        B = cv2.remap(Dn, bx, by, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
        w = np.clip((phi - mask) / mod.DISSOLVE_SOFT + 0.5, 0, 1)[..., None]
        moving = (A * (1 - w) + B * w) * r_w[..., None]
        return w_move * moving + (1 - w_move) * D

    def render_frame_rgb8(phi):
        ang = 2 * np.pi * phi
        swirl = (3.0 * (np.cos(ang) * sw[0] + np.sin(ang) * sw[1])).astype(np.float32)
        fine_l = get_layer(Dn_f, r_f, fine, mask_f, SHIFT_FINE, phi, swirl)
        mid_l = get_layer(Dn_m, r_m, mid, mask_m, SHIFT_MID, phi, swirl)
        out = E + fine_l + mid_l
        a = np.clip(out[..., 3:4], 0, 1)
        rgb = np.clip(out[..., :3], 0, a)
        rgb_half = cv2.resize(rgb, (OUT_W, OUT_H), interpolation=cv2.INTER_AREA)
        rgb8 = (np.clip(rgb_half, 0.0, 1.0) * 255.0).astype(np.uint8)
        # Zero out sub-threshold background noise for pure black screen blending
        lum_v = 77 * rgb8[:, :, 0].astype(np.uint16) + 150 * rgb8[:, :, 1].astype(np.uint16) + 29 * rgb8[:, :, 2].astype(np.uint16)
        rgb8[lum_v < 400] = 0
        return rgb8

    print(f"Starting Opaque Video render: {n_frames} frames at {args.fps} FPS ({LOOP_SECONDS}s loop)...", file=sys.stderr)
    print(f"Output resolution: {OUT_W}x{OUT_H}, target MP4: {args.out_mp4}", file=sys.stderr)

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
        # Explicitly tag limited (tv/mpeg) range + BT.709 primaries/matrix in
        # the bitstream's VUI parameters. Without this the stream was leaving
        # color_range as "unspecified": most decoders default to limited
        # range for H.264 in that case, but not all do, and a decoder that
        # guesses "full" instead will read our Y=16 black floor as RGB~16 —
        # a faint but visible rectangle where "invisible" black should be.
        # Tagging it removes the guess entirely.
        "-color_range", "tv",
        "-colorspace", "bt709",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        args.out_mp4,
    ]

    t0 = time.time()
    ffmpeg_proc = subprocess.Popen(cmd_mp4, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    for i in range(n_frames):
        phi = i / float(n_frames)
        rgb8 = render_frame_rgb8(phi)
        ffmpeg_proc.stdin.write(rgb8.tobytes())

        if (i + 1) % 20 == 0:
            gc.collect()

        elapsed = time.time() - t0
        fps_so_far = (i + 1) / max(0.1, elapsed)
        remaining = (n_frames - (i + 1)) / max(0.1, fps_so_far)
        sys.stderr.write(f"\rRendered {i + 1}/{n_frames} frames ({((i + 1)/n_frames)*100:.1f}%) | {fps_so_far:.2f} fps | ETA: {remaining:.0f}s")
        sys.stderr.flush()

    print("\nFinalizing MP4 encoding in FFmpeg...", file=sys.stderr)
    ffmpeg_proc.stdin.close()
    ffmpeg_proc.wait()

    if ffmpeg_proc.returncode != 0:
        print(f"FFmpeg MP4 error: return code {ffmpeg_proc.returncode}", file=sys.stderr)
        sys.exit(1)

    t_mp4 = time.time() - t0
    size_mp4_mb = os.path.getsize(args.out_mp4) / 1e6
    print(f"\nWrote MP4: {args.out_mp4} ({size_mp4_mb:.2f} MB, {n_frames} frames, {args.fps} FPS) in {t_mp4:.1f}s", file=sys.stderr)

    # Companion WebM (VP9 opaque yuv420p)
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
            "-color_range", "tv",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            args.out_webm,
        ]
        subprocess.run(cmd_webm, check=True)
        size_webm_mb = os.path.getsize(args.out_webm) / 1e6
        print(f"Wrote WebM: {args.out_webm} ({size_webm_mb:.2f} MB)", file=sys.stderr)

    print("\nAll video assets successfully generated with tuned motion model!", file=sys.stderr)


if __name__ == "__main__":
    main()
