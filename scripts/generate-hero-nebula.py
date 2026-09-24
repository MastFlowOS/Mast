#!/usr/bin/env python3
"""
Generates public/images/mast-hero-nebula.webp — the FAR layer of the hero sky.

PHASE 4A. A static, baked, very-low-amplitude nebula: deep-blue / charcoal
haze with soft cloud-like billows.

It is an RGBA image: RGB is a slate-navy / charcoal tone and ALPHA carries the
amount of haze. The `.hero-nebula` rule in src/styles.css displays it with
normal blending at ~0.12 opacity, so it only ever lifts the existing night sky
by a few RGB levels. (Not an opaque image + `screen`: the hero atmosphere
wrapper is masked, i.e. an isolated group, so an opaque black backdrop would
paint over the global sky instead of blending with it.) Baking alpha across
0..ALPHA_MAX and displaying at low opacity also means each alpha step is
~0.07 RGB level, so the asset itself cannot introduce banding.

Design rules baked into the maths below:
  * Peak additive light is ~(7, 10, 18) of 255 — this is atmosphere, not a
    gradient you can point at. The reference sky sits at ~rgb(2..7, 7..9, 13).
  * The envelope keeps the copy zone (left-centre) almost black and lets the
    haze gather around the globe / gold-flow area (right of centre) and the
    upper right, mirroring the reference.
  * Cloud edges are soft (smoothstep on domain-warped fBm), never hard shapes.
  * Alpha is dithered by *stochastic rounding* and carries a fine photographic
    mottle, so the on-screen result is naturally dithered as well.

Deterministic (fixed seeds). Run:  python3 scripts/generate-hero-nebula.py
Requires: numpy, scipy, pillow.
"""

from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

W, H = 1600, 833  # soft content: the browser upscales it, no visible loss
OUT = Path(__file__).resolve().parent.parent / "public" / "images" / "mast-hero-nebula.webp"

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
U = xx / (W - 1)  # 0..1 across
V = yy / (H - 1)  # 0..1 down


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def gauss2(cx, cy, sx, sy):
    return np.exp(-(((U - cx) / sx) ** 2 + ((V - cy) / sy) ** 2))


def spectral(seed, beta, stretch=1.0, warp=None):
    """
    1/f^beta ("natural") noise via FFT. Higher beta = smoother, larger features.
    `stretch` > 1 elongates features horizontally (atmospheric drift look).
    Returns a field normalised to 0..1 (1st-99th percentile).
    """
    rng = np.random.default_rng(seed)
    fy = np.fft.fftfreq(H)[:, None]
    fx = np.fft.fftfreq(W)[None, :] * (H / W) * stretch
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    amp = 1.0 / f ** (beta / 2.0)
    amp[0, 0] = 0.0
    spec = amp * np.exp(2j * np.pi * rng.random((H, W)))
    field = np.fft.ifft2(spec).real.astype(np.float32)
    if warp is not None:
        field = ndi.map_coordinates(field, [yy + warp[0], xx + warp[1]], order=1, mode="reflect")
    lo, hi = np.percentile(field, [1, 99])
    return np.clip((field - lo) / (hi - lo), 0, 1).astype(np.float32)


# ── domain warp: small, just enough to keep cloud edges from looking blobby ──
wy = (spectral(11, 3.6) - 0.5) * 0.05 * H
wx = (spectral(12, 3.6) - 0.5) * 0.08 * W
warp = (wy, wx)

large = spectral(101, 3.4, 1.35, warp)  # big soft billows
mid = spectral(202, 2.7, 1.3, warp)  # secondary drifts (cloud clumps ~150-250 px)
fine = spectral(404, 1.6)  # photographic mottle
hue = spectral(505, 3.4)  # navy <-> charcoal drift

field = 0.55 * large + 0.45 * mid
field = np.clip((field - np.percentile(field, 3)) / (np.percentile(field, 99) - np.percentile(field, 3)), 0, 1)
# broad haze floor + soft-rolled cloud modulation: haze everywhere in the lobe,
# clouds as *variation* in it (as in the reference), never isolated hard shapes
density = 0.16 + 0.84 * smoothstep(0.28, 0.90, field)
density *= 0.90 + 0.10 * fine

# ── spatial envelope (fractions of the asset; hero box maps ~1:1 via cover) ──
# A low-frequency noise field perturbs the envelope's own geometry, so its
# boundary is never a clean ellipse / straight line.
_pu = (spectral(606, 3.6, 1.4) - 0.5) * 0.16
_pv = (spectral(707, 3.6, 1.4) - 0.5) * 0.16
Uo, Vo = U, V
U = np.clip(U + _pu, 0, 1)
V = np.clip(V + _pv, 0, 1)
env = (
    1.00 * gauss2(0.64, 0.40, 0.30, 0.40)  # main lobe: globe + gold-flow area
    + 0.70 * gauss2(0.92, 0.16, 0.17, 0.22)  # upper-right
    + 0.32 * gauss2(0.42, 0.46, 0.13, 0.26)  # faint lifted haze between copy and globe
    + 0.22 * gauss2(0.50, 0.06, 0.30, 0.10)  # thin high-sky veil
)
env = np.clip(env, 0, 1)
env *= 0.55 + 0.45 * spectral(808, 3.0, 1.5)  # break the lobe into cloud masses

# keep the copy zone (left / centre-left) clean and dark
clean = 1.0 - 0.94 * np.exp(-((np.abs((U - 0.20) / 0.24) ** 2.6) + (np.abs((V - 0.52) / 0.36) ** 2.6)))
# fall away toward the floor so the nebula never competes with the ground plane
U, V = Uo, Vo
floor_fade = 1.0 - smoothstep(0.68, 0.94, V)
# and a whisper of edge fade so no rectangular boundary can read
edge = smoothstep(0.0, 0.05, U) * smoothstep(1.0, 0.95, U) * smoothstep(0.0, 0.03, V)

light = density * env * clean * floor_fade * edge
light = np.clip(light / np.percentile(light, 99.7), 0, 1)  # stacked multipliers must not silently dim it
# slight contrast curve: leaves the faint tails very faint, lets billow cores read
light = light ** 1.25

# ── colour: cool slate-navy with a drift toward neutral charcoal ─────────────
# RGB is the *tone* of the haze; ALPHA is how much of it. Displayed at ~0.12
# opacity, alpha 200/255 adds roughly (7, 10, 18) over the sky — see docstring.
ALPHA_MAX = 200.0
navy = np.array([76.0, 104.0, 168.0], np.float32)
charcoal = np.array([106.0, 108.0, 120.0], np.float32)
t = (smoothstep(0.22, 0.70, hue) * 0.90)[..., None]
rgb = (navy * (1 - t) + charcoal * t).clip(0, 255).astype(np.uint8)

drng = np.random.default_rng(7)
alpha = light * ALPHA_MAX
alpha8 = np.floor(alpha + drng.random(alpha.shape, dtype=np.float32)).clip(0, 255).astype(np.uint8)

rgba = np.dstack([rgb, alpha8])
OUT.parent.mkdir(parents=True, exist_ok=True)
# Lossy colour (smooth, hides nothing) + near-lossless alpha (the actual signal).
Image.fromarray(rgba, "RGBA").save(OUT, "WEBP", quality=82, alpha_quality=97, method=6)
print(f"wrote {OUT}  ({OUT.stat().st_size / 1024:.0f} KB)  alpha mean {alpha8.mean():.2f} max {alpha8.max()}")
