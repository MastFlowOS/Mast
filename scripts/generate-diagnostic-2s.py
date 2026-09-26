#!/usr/bin/env python3
"""
Generate a 2-second diagnostic clip (120 frames at 60 FPS) and contact sheet
to verify that the gold dust clearly and visibly travels along the S-curve.
"""

import os
import subprocess
import sys
import importlib.util
import time
import numpy as np
import cv2
from PIL import Image
import imageio_ffmpeg

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

print("Loading generator...")
spec = importlib.util.spec_from_file_location(
    "anim_gen",
    os.path.join(ROOT, "scripts", "generate-gold-flow-animation.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

P = mod.load_premult()
H, W = P.shape[:2]

# TUNED MOTION PARAMETERS:
# 1. ENV_SIGMA = 26.0 px (soft glow stays static; dust & filaments flow)
# 2. SHIFT_FINE = 1150.0 px, SHIFT_MID = 800.0 px (visible dust advection)
# 3. No orb freezing (celestial sparkles travel with dust field)
# 4. MEDIAL_MARGIN = 24.0 px (clean flow through bends without pinching)
ENV_SIGMA = 26.0
SHIFT_FINE = 1150.0
SHIFT_MID = 800.0
MEDIAL_MARGIN = 24.0

E = mod.blur(P, ENV_SIGMA).astype(np.float32)

# Band split
mid_src = mod.blur(P, 2.0)
fine = (P - mid_src).astype(np.float32)
mid = (mid_src - E).astype(np.float32)

out_bands = []
for d in (fine, mid):
    r_str = np.sqrt(mod.blur(mod.lum(d) ** 2, mod.STRENGTH_SIGMA)).astype(np.float32)
    out_bands.append((np.clip(d / (r_str + mod.STRENGTH_EPS)[..., None], -5, 5).astype(np.float32), r_str, d))

(Dn_f, r_f, D_f), (Dn_m, r_m, D_m) = out_bands

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
d2 = np.empty(len(gp)); dd1 = np.empty(len(gp))
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

# No orb freeze: entire celestial dust stream flows
w_move = (w_med * w_far).astype(np.float32)[..., None]

pos0 = np.stack([xx, yy], -1)
C0 = flow._interp(flow.C, s0)
N0 = flow._interp(flow.N, s0)
g = (0.95 + (1 - 0.95) * np.exp(-((n / 85.0) ** 2))).astype(np.float32)

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
    s_src = flow.reflect(s0 - delta * g)
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
    fine_l = get_layer(Dn_f, r_f, D_f, mask_f, SHIFT_FINE, phi, swirl)
    mid_l = get_layer(Dn_m, r_m, D_m, mask_m, SHIFT_MID, phi, swirl)
    out = E + fine_l + mid_l
    a = np.clip(out[..., 3:4], 0, 1)
    rgb = np.clip(out[..., :3], 0, a)
    rgb_half = cv2.resize(rgb, (768, 512), interpolation=cv2.INTER_AREA)
    rgb8 = (np.clip(rgb_half, 0.0, 1.0) * 255.0).astype(np.uint8)
    # Zero out background noise
    lum = 77 * rgb8[:, :, 0].astype(np.uint16) + 150 * rgb8[:, :, 1].astype(np.uint16) + 29 * rgb8[:, :, 2].astype(np.uint16)
    rgb8[lum < 400] = 0
    return rgb8

print("Rendering 2-second diagnostic clip (120 frames at 60 FPS, t=0.0s to t=2.0s)...")
total_loop_frames = 384 # 6.4s * 60 FPS
diag_frames = 120 # 2.0s

cmd = [
    ffmpeg_exe, "-y",
    "-f", "rawvideo",
    "-vcodec", "rawvideo",
    "-s", "768x512",
    "-pix_fmt", "rgb24",
    "-r", "60",
    "-i", "-",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "fast",
    "-tune", "film",
    "-movflags", "+faststart",
    "diagnostic_2s.mp4"
]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

saved_frames = {}
target_sample_indices = [0, 15, 30, 45, 60, 75, 90, 105, 119]

t0 = time.time()
for k in range(diag_frames):
    phi = k / float(total_loop_frames)
    frame = render_frame_rgb8(phi)
    proc.stdin.write(frame.tobytes())
    if k in target_sample_indices:
        saved_frames[k] = frame
    if (k + 1) % 15 == 0:
        elapsed = time.time() - t0
        print(f"Rendered {k + 1}/{diag_frames} frames ({((k + 1)/diag_frames)*100:.0f}%) | {elapsed:.1f}s")

proc.stdin.close()
proc.wait()
print(f"Wrote diagnostic_2s.mp4 ({os.path.getsize('diagnostic_2s.mp4')/1e6:.2f} MB)")

# Build Contact Sheet (3x3 grid)
sheet = Image.new("RGB", (384 * 3, 256 * 3), (10, 10, 15))
for i, k in enumerate(target_sample_indices):
    thumb = Image.fromarray(saved_frames[k]).resize((384, 256), Image.BILINEAR)
    thumb_cv = np.array(thumb)
    sec = k / 60.0
    cv2.putText(thumb_cv, f"t={sec:.2f}s (f{k})", (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    row = i // 3
    col = i % 3
    sheet.paste(Image.fromarray(thumb_cv), (col * 384, row * 256))

sheet.save("diagnostic_2s_contact_sheet.png")
print("Saved diagnostic_2s_contact_sheet.png")

# Quantitative differences
f0 = saved_frames[0].astype(float)
f60 = saved_frames[60].astype(float) # 1.0s apart
f119 = saved_frames[119].astype(float) # ~2.0s apart

diff_1s = np.abs(f0 - f60)
diff_2s = np.abs(f0 - f119)

print("\n" + "=" * 60)
print("DIAGNOSTIC MOTION QUANTITATIVE REPORT")
print("=" * 60)
print(f"[1.0s Separation (Frame 0 vs Frame 60)]")
print(f"  Mean pixel diff: {diff_1s.mean():.2f} / 255 ({diff_1s.mean()/255*100:.2f}%)")
print(f"  Max pixel diff:  {diff_1s.max():.1f} / 255")
print(f"  Pixels changed >= 5/255:  {(diff_1s.max(axis=-1) >= 5).mean()*100:.2f}%")
print(f"  Pixels changed >= 15/255: {(diff_1s.max(axis=-1) >= 15).mean()*100:.2f}%")

print(f"\n[2.0s Separation (Frame 0 vs Frame 119)]")
print(f"  Mean pixel diff: {diff_2s.mean():.2f} / 255 ({diff_2s.mean()/255*100:.2f}%)")
print(f"  Max pixel diff:  {diff_2s.max():.1f} / 255")
print(f"  Pixels changed >= 5/255:  {(diff_2s.max(axis=-1) >= 5).mean()*100:.2f}%")
print(f"  Pixels changed >= 15/255: {(diff_2s.max(axis=-1) >= 15).mean()*100:.2f}%")
print("=" * 60)
