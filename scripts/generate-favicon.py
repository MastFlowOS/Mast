#!/usr/bin/env python3
"""
Generate the MAST favicon set from the official wordmark asset.

Source of truth: src/assets/mast-wordmark.png (same file MastWordmark.tsx uses).

The wordmark is ~5.35:1, so it can never fill a square. Instead of stretching
it, we:
  1. crop to the real ink bounds (the source has faint alpha noise around it),
  2. scale it UNIFORMLY so its width fits the square minus a small padding,
  3. centre it on a transparent square canvas,
  4. render with 16x supersampling so anti-aliasing is exact area coverage.

Colour is untouched (white, straight from the source). Nothing is stretched,
re-drawn, or re-spaced.

Usage:  python3 scripts/generate-favicon.py
Needs:  pillow, numpy
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "assets" / "mast-wordmark.png"
OUT = ROOT / "public"

SUPERSAMPLE = 16
NOISE_FLOOR = 8  # source has alpha 1-3 noise in the "empty" area; ignore it

# (filename, canvas px)
PNG_SIZES = [
    ("favicon-16x16.png", 16),
    ("favicon-32x32.png", 32),
    ("favicon-48x48.png", 48),
    ("apple-touch-icon.png", 180),
]
ICO_SIZES = [16, 32, 48]


def load_ink():
    """Return the wordmark cropped to its true ink bounds, as a float alpha map."""
    rgba = np.array(Image.open(SRC).convert("RGBA"))
    alpha = rgba[..., 3].astype(np.float32)
    alpha[alpha < NOISE_FLOOR] = 0  # kill noise so it can't affect bounds/edges
    ys, xs = np.where(alpha > 0)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    return alpha[y0:y1, x0:x1] / 255.0


def padding_for(size: int) -> int:
    # ~4% of the canvas per side, never less than 1px, so the mark isn't
    # clipped by the browser's rounding/scaling but still uses nearly all
    # of the available width.
    return max(1, int(size * 0.04))


def render(ink: np.ndarray, size: int) -> Image.Image:
    h_src, w_src = ink.shape
    aspect = w_src / h_src

    pad = padding_for(size)
    target_w = size - 2 * pad          # width the wordmark gets, in px
    target_h = target_w / aspect       # height follows -> uniform scale

    S = SUPERSAMPLE
    big = size * S
    w_big = round(target_w * S)
    h_big = round(target_h * S)

    # Uniform scale of the alpha map (aspect error < 1/(target_h*S) => negligible)
    a = Image.fromarray((ink * 255).astype(np.uint8), "L").resize(
        (w_big, h_big), Image.Resampling.LANCZOS
    )

    canvas = Image.new("L", (big, big), 0)
    # centre exactly (in supersampled space, so sub-pixel centring is preserved)
    ox = (big - w_big) // 2
    oy = (big - h_big) // 2
    canvas.paste(a, (ox, oy))

    # exact area-coverage downsample
    alpha_small = canvas.resize((size, size), Image.Resampling.BOX)

    out = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    out.putalpha(alpha_small)  # RGB stays pure white, alpha carries the shape
    return out


def main():
    ink = load_ink()
    h, w = ink.shape
    print(f"ink bounds: {w}x{h}  aspect {w / h:.4f}")

    rendered = {}
    for name, size in PNG_SIZES:
        img = render(ink, size)
        img.save(OUT / name, optimize=True)
        rendered[size] = img
        pad = padding_for(size)
        tw = size - 2 * pad
        print(f"{name:24s} {size:>3}px canvas, wordmark {tw} x {tw / (w / h):.2f}px, pad {pad}px")

    # Multi-size .ico (PNG-compressed entries) for /favicon.ico requests.
    # Pillow needs the LARGEST frame as the base image; the other sizes are
    # supplied explicitly so every ICO frame is our own crisp render, not a
    # resized copy.
    largest = max(ICO_SIZES)
    rendered[largest].save(
        OUT / "favicon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=[rendered[s] for s in ICO_SIZES if s != largest],
    )
    print("favicon.ico              sizes", ICO_SIZES)


if __name__ == "__main__":
    main()
