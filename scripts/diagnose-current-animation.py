#!/usr/bin/env python3
"""
Diagnostic script for current gold flow animation generator.
Extracts representative frames: 0, 30, 60, 90, 120, 180, 240, 300, 383
Generates contact sheet and computes quantitative differences.
"""

import os
import sys
import importlib.util
import numpy as np
import cv2
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

def main():
    print("Loading generator...")
    spec = importlib.util.spec_from_file_location(
        "anim_gen",
        os.path.join(ROOT, "scripts", "generate-gold-flow-animation.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    P = mod.load_premult()
    r = mod.Renderer(P)

    total_frames = 384
    frame_indices = [0, 30, 60, 90, 120, 180, 240, 300, 383]
    extracted = {}

    print(f"Extracting {len(frame_indices)} representative frames...")
    for idx in frame_indices:
        phi = idx / float(total_frames)
        rgb, a = r.frame(phi)
        
        # Convert to 768x512 RGB as used in production
        rgb_half = cv2.resize(rgb, (768, 512), interpolation=cv2.INTER_AREA)
        rgb8 = (np.clip(rgb_half, 0.0, 1.0) * 255.0).astype(np.uint8)
        extracted[idx] = rgb8
        print(f"Extracted frame {idx} (phi={phi:.4f})")

    # Also extract frame 1, 15 for delta calculations
    for extra_idx in [1, 15]:
        phi = extra_idx / float(total_frames)
        rgb, a = r.frame(phi)
        rgb_half = cv2.resize(rgb, (768, 512), interpolation=cv2.INTER_AREA)
        extracted[extra_idx] = (np.clip(rgb_half, 0.0, 1.0) * 255.0).astype(np.uint8)

    # 1. Create Contact Sheet (3x3 grid)
    # Thumbnail size: 384x256
    sheet_w = 384 * 3
    sheet_h = 256 * 3
    sheet = Image.new("RGB", (sheet_w, sheet_h), (10, 10, 15))

    for i, idx in enumerate(frame_indices):
        thumb = Image.fromarray(extracted[idx]).resize((384, 256), Image.BILINEAR)
        # Put label
        thumb_cv = np.array(thumb)
        cv2.putText(thumb_cv, f"Frame {idx}", (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        row = i // 3
        col = i % 3
        sheet.paste(Image.fromarray(thumb_cv), (col * 384, row * 256))

    sheet.save(os.path.join(ROOT, "diagnostic_contact_sheet.png"))
    print("Saved diagnostic_contact_sheet.png")

    # 2. Quantitative differences
    pairs = [
        ("Consecutive (0 vs 1)", 0, 1),
        ("Delta 15 (0 vs 15)", 0, 15),
        ("Delta 30 (0 vs 30)", 0, 30),
        ("Delta 60 (0 vs 60)", 0, 60),
        ("Delta 120 (0 vs 120)", 0, 120),
        ("Full cycle (0 vs 383)", 0, 383),
    ]

    print("\n" + "=" * 60)
    print("QUANTITATIVE FRAME DIFFERENCES ANALYSIS")
    print("=" * 60)

    for label, i1, i2 in pairs:
        f1 = extracted[i1].astype(np.float32)
        f2 = extracted[i2].astype(np.float32)
        diff = np.abs(f1 - f2) # (512, 768, 3)
        diff_max_ch = diff.max(axis=-1) # (512, 768)

        mean_diff = diff.mean()
        max_diff = diff.max()
        
        # Changed pixel percentages
        changed_p1 = (diff_max_ch >= 1.0).mean() * 100
        changed_p5 = (diff_max_ch >= 5.0).mean() * 100
        changed_p10 = (diff_max_ch >= 10.0).mean() * 100

        # Bounding box of changed region (where diff >= 3.0)
        mask = diff_max_ch >= 3.0
        if np.any(mask):
            ys, xs = np.where(mask)
            bbox = f"[{xs.min()}, {ys.min()}] to [{xs.max()}, {ys.max()}] (size: {xs.max()-xs.min()}x{ys.max()-ys.min()})"
        else:
            bbox = "None (no significant change >= 3.0)"

        print(f"\n[{label}]")
        print(f"  Mean pixel diff: {mean_diff:.3f} / 255 ({mean_diff/255*100:.2f}%)")
        print(f"  Max pixel diff:  {max_diff:.1f} / 255")
        print(f"  Pixels changed >= 1/255:  {changed_p1:.2f}%")
        print(f"  Pixels changed >= 5/255:  {changed_p5:.2f}%")
        print(f"  Pixels changed >= 10/255: {changed_p10:.2f}%")
        print(f"  Bounding box (diff >= 3): {bbox}")

    # Also calculate ratio of static energy to moving energy in the frame
    E_half = cv2.resize(r.E[..., :3], (768, 512), interpolation=cv2.INTER_AREA)
    E_lum = 0.299 * E_half[..., 0] + 0.587 * E_half[..., 1] + 0.114 * E_half[..., 2]
    P_half = cv2.resize(P[..., :3], (768, 512), interpolation=cv2.INTER_AREA)
    P_lum = 0.299 * P_half[..., 0] + 0.587 * P_half[..., 1] + 0.114 * P_half[..., 2]

    print("\n" + "=" * 60)
    print("ENERGY DECOMPOSITION (STATIC ENVELOPE vs MOVING DUST)")
    print("=" * 60)
    mask_stream = P_lum > 0.05
    static_ratio = (E_lum[mask_stream] / np.maximum(P_lum[mask_stream], 1e-4)).mean() * 100
    print(f"Static Envelope (E) percentage of total luminance in stream: {static_ratio:.1f}%")
    print(f"Moving Dust residual percentage of total luminance in stream: {100 - static_ratio:.1f}%")
    print(f"Frozen orbs count: {len(r.freeze)}")
    print(f"Average w_move (movement gating) inside the stream: {(r.w_move[P[..., 3] > 0.1]).mean()*100:.1f}%")
    print("=" * 60)

if __name__ == "__main__":
    main()
