#!/usr/bin/env python3
"""
Generate public/images/mast-gold-flow-animated.webp from the approved static
asset public/images/mast-gold-flow.png.

PHASE 5B — REAL GOLD-DUST FLOW. This is an OFFLINE render. Nothing in here
ships to the browser: the site shows the resulting animated WebP in a plain
<img>. No canvas, no RAF, no per-particle JS, no SVG, no extra DOM.

How a frame is built
--------------------
The still is split into a static part and a moving part:

  STATIC  a smooth base of the still (haze, glow, overall envelope). It never
          moves, so the S-shape, warm palette, diffuse haze and overall density
          are the still's own in every frame.

  DUST    everything finer than that — the thousands of glints, the grain and the
          thin core ridge — is the still's own texture, carried DOWNSTREAM along
          the stream's true ridge (top -> around the globe -> lower sweep ->
          floor). Position in the image is expressed as (distance along the
          ridge, offset from it); flowing = increasing the distance and keeping
          the offset, so the bright ridge always lands back on the ridge. The
          dust is split into two bands (fine grain / mid-scale sparkle) that
          travel at different speeds, so glints slide past each other and
          continually drift apart and regroup instead of moving as one rigid
          sheet; a small periodic swirl adds sideways dispersion. Each band is
          normalised by its own local strength, so density and brightness stay
          where the still has them and nothing can appear where the still has
          no dust. Far from the ridge, and near the "medial axis" inside the
          tight bends where two arms of the S are equally close, the dust holds
          still (there is no unambiguous along-path direction there).

  ORBS    the few big bokeh orbs are lifted out (background inpainted) and drift
          along the flow the same way, each fading in/out on its own cycle. Orbs
          sitting on the ridge stay part of the dust so the ridge never turns
          into "beads".

Seamless loop
-------------
Each dust band mixes two shifted copies: A (moved phi*D downstream) and
B (moved (phi-1)*D). The mix is a spatial *dissolve* driven by a fixed
fine-blob mask, not an alpha cross-fade, so grain keeps full contrast at every
instant. At phi = 0 the frame is exactly A(0) = the still's dust; at phi = 1 it
is B(1) = the same, so the loop closes with no jump. Swirl and orb twinkle use
whole cycles per loop, so they close too.

The stream's ridge is traced from the still itself (see RIDGE_WAYPOINTS).

Usage:  python scripts/generate-gold-flow-animation.py [--preview N]
Needs:  numpy, scipy, opencv-python, scikit-image, pillow (with WebP anim).
"""

from __future__ import annotations

import argparse
import os
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.feature import peak_local_max

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "public", "images", "mast-gold-flow.png")
OUT = os.path.join(ROOT, "public", "images", "mast-gold-flow-animated.webp")

# ---- timing ---------------------------------------------------------------
# 48 frames / 6.4s (7.5 fps) rather than a higher rate: this content is soft,
# diffuse dust, not a sharp-edged animation, so the eye doesn't need a high
# frame rate to read it as smooth motion, and each extra frame costs real
# file size (each one is a full new render, not a cheap inter-frame delta).
LOOP_SECONDS = 6.4
N_FRAMES = 48
FPS = N_FRAMES / LOOP_SECONDS

# ---- flow -----------------------------------------------------------------
# The stream's TRUE ridge is traced from the still itself: a minimum-cost path
# through the bright core, forced through the three bend apexes (asset px).
# (The Phase 4C/5A SVG centerline was a smoothed chord that cut inside the
# bends, up to ~70 px off the ridge — useless for carrying grain along it.)
RIDGE_WAYPOINTS = [(147, 0), (741, 280), (517, 451), (1289, 840), (640, 940)]  # (x, y)
RIDGE_SMOOTH = 9.0  # samples (px) of Gaussian smoothing to remove pixel staircase

SHIFT_FINE_PX = 320.0     # px the fine grain travels downstream per loop
SHIFT_MID_PX = 200.0      # px the mid-scale sparkle travels per loop (slower -> relative drift)
SHEAR_MIN = 0.95          # fringe speed relative to core (very gentle)
SWIRL_AMP = 3.0           # px, periodic sideways dispersion
SWIRL_SCALE = 30.0        # px, spatial size of the swirl
ENV_SIGMA = 10.0          # px, blur separating the static base from the dust
BAND_SPLIT_SIGMA = 1.6    # px, fine grain vs mid-scale sparkle
STRENGTH_SIGMA = 14.0     # px, blur used for local dust strength
STRENGTH_EPS = 0.008
DISSOLVE_BLOB = 7.0       # px, size of the dissolve mask blobs
DISSOLVE_SOFT = 0.14      # phase width of the dissolve edge
FAR_FULL, FAR_ZERO = 80.0, 125.0    # |offset| (px) where flow starts / stops fading
MEDIAL_MARGIN = 38.0      # px; flow fades out this close to the tie between two arms
MEDIAL_MIN_ARC = 160.0    # arcs closer than this along the ridge count as the same arm

# ---- orbs -----------------------------------------------------------------
ORB_THRESHOLD = 0.20
ORB_FREEZE_IN = 0.55       # xr: dust fully frozen inside this radius
ORB_FREEZE_OUT = 2.1       # xr: dust flows fully normally beyond this radius

# ---- encode ---------------------------------------------------------------
WEBP_QUALITY = 50
WEBP_ALPHA_QUALITY = 60
WEBP_METHOD = 6
RNG = np.random.default_rng(5150)


# ===========================================================================
# helpers
# ===========================================================================
def load_premult():
    im = np.asarray(Image.open(SRC).convert("RGBA"), np.float32) / 255.0
    a = im[..., 3:4]
    return np.concatenate([im[..., :3] * a, a], -1)


def lum(p):
    return 0.30 * p[..., 0] + 0.59 * p[..., 1] + 0.11 * p[..., 2]


def blur(x, s):
    return cv2.GaussianBlur(x, (0, 0), s, borderType=cv2.BORDER_REFLECT_101)


def trace_ridge(P):
    """Minimum-cost path along the brightest core, smoothed, evenly resampled."""
    from skimage.graph import route_through_array

    Lc = np.minimum(blur(lum(P), 2.5), 0.8)  # cap so orbs can't hijack the route
    cost = 1.0 / (0.02 + Lc ** 2.5)
    pts = []
    for (x0, y0), (x1, y1) in zip(RIDGE_WAYPOINTS[:-1], RIDGE_WAYPOINTS[1:]):
        path, _ = route_through_array(cost, (y0, x0), (y1, x1), fully_connected=True, geometric=True)
        pts += [(q[1], q[0]) for q in path[:-1]]
    pts.append(RIDGE_WAYPOINTS[-1])
    pts = np.array(pts, np.float64)
    pts = np.stack([ndi.gaussian_filter1d(pts[:, 0], RIDGE_SMOOTH, mode="nearest"),
                    ndi.gaussian_filter1d(pts[:, 1], RIDGE_SMOOTH, mode="nearest")], 1)
    pts[0], pts[-1] = np.array(RIDGE_WAYPOINTS[0], float), np.array(RIDGE_WAYPOINTS[-1], float)
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    return pts, seg


class PathFlow:
    """Path-aligned coordinates: every pixel is (s, n) = (distance along the
    centerline, signed offset from it). Flowing = changing s, keeping n, so the
    thin core ridge always lands back on the ridge."""

    DS = 2.0  # px between centerline samples

    def __init__(self, h, w, P):
        self.h, self.w = h, w
        pts, seg = trace_ridge(P)
        sgrid = np.arange(0, seg[-1], self.DS)
        c0 = np.stack([np.interp(sgrid, seg, pts[:, 0]), np.interp(sgrid, seg, pts[:, 1])], 1)
        n_ext = int(700 / self.DS)
        t0 = c0[0] - c0[8]; t0 /= np.linalg.norm(t0)
        t1 = c0[-1] - c0[-9]; t1 /= np.linalg.norm(t1)
        k = (np.arange(1, n_ext + 1) * self.DS)[:, None]
        self.C = np.vstack([c0[0] + t0 * k[::-1], c0, c0[-1] + t1 * k])
        self.S = np.arange(len(self.C)) * self.DS
        self.s_lo = n_ext * self.DS                       # first on-image sample
        self.s_hi = (n_ext + len(c0) - 1) * self.DS       # last on-image sample
        T = np.gradient(self.C, axis=0)
        T /= np.linalg.norm(T, axis=1, keepdims=True)
        T = np.stack([ndi.gaussian_filter1d(T[:, 0], 6), ndi.gaussian_filter1d(T[:, 1], 6)], 1)
        T /= np.linalg.norm(T, axis=1, keepdims=True)
        self.T = T
        self.N = np.stack([-T[:, 1], T[:, 0]], 1)

    def _interp(self, arr, s):
        f = np.clip(s, 0, self.S[-1]) / self.DS
        i0 = np.minimum(f.astype(np.int64), len(arr) - 2)
        t = (f - i0)[..., None]
        return arr[i0] * (1 - t) + arr[i0 + 1] * t

    def reflect(self, s):
        lo, hi = self.s_lo, self.s_hi
        span = hi - lo
        u = np.mod(s - lo, 2 * span)
        u = np.where(u > span, 2 * span - u, u)
        return lo + u

    def advance(self, p0, s0, n, s_new):
        """Positions of points that started at p0 (path coords s0, n) once they
        have moved to path distance s_new, keeping their offset n. The sideways
        term fades out for points far from the path so stragglers just translate."""
        C1 = self._interp(self.C, s0)
        N1 = self._interp(self.N, s0)
        C2 = self._interp(self.C, s_new)
        N2 = self._interp(self.N, s_new)
        tp = np.clip(1.0 - (np.abs(n) - 60.0) / 110.0, 0.0, 1.0)
        return p0 + (C2 - C1) + (tp * n)[:, None] * (N2 - N1)

    def project(self, pts):
        """(s0, n) for arbitrary points (nearest centerline sample, refined)."""
        from scipy.spatial import cKDTree
        if not hasattr(self, "_tree"):
            self._tree = cKDTree(self.C)
        _, idx = self._tree.query(pts)
        d = pts - self.C[idx]
        return self.S[idx] + (d * self.T[idx]).sum(1), (d * self.N[idx]).sum(1)

    def move_point(self, x, y, ds, s_range=None):
        """Slide a point along the flow by ds (px), keeping its offset."""
        d = np.array([x, y], np.float32) - 0
        i = int(np.argmin(((self.C - d) ** 2).sum(1)))
        rel = d - self.C[i]
        s = self.S[i] + float(rel @ self.T[i])
        n = float(rel @ self.N[i])
        s2 = float(np.clip(s + ds, 0, self.S[-1]))
        C2 = self._interp(self.C, np.array([s2]))[0]
        N2 = self._interp(self.N, np.array([s2]))[0]
        C1 = self._interp(self.C, np.array([s]))[0]
        N1 = self._interp(self.N, np.array([s]))[0]
        tp = float(np.clip(1.0 - (abs(n) - 60.0) / 110.0, 0, 1))
        return d + (C2 - C1) + tp * n * (N2 - N1), N2, s2


# ===========================================================================
# stage 1 — find the sparse bright orbs, so the flow field can freeze around
# them (see freeze_mask). Orbs are left exactly as the still drew them, in
# every frame: no lift, no inpaint, no sprite. Only the fine/mid dust around
# them moves, which reads as dust drifting past fixed points of bokeh. An
# earlier version of this script lifted each orb out, inpainted the hole and
# re-composited a drifting sprite; it was the fragile, seam-prone part of the
# whole pipeline (visible patch edges) for no real gain — a handful of soft
# light points don't need to travel for the flow to read as moving dust.
# ===========================================================================
def detect_orbs(P):
    L = lum(P)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    R = cv2.morphologyEx(L, cv2.MORPH_OPEN, k) - blur(L, 18)
    pk = peak_local_max(R, min_distance=6, threshold_abs=ORB_THRESHOLD)
    orbs = []
    H, W = L.shape
    for y, x in pk:
        peak = L[y, x]
        y0, y1, x0, x1 = max(0, y - 40), min(H, y + 41), max(0, x - 40), min(W, x + 41)
        win = L[y0:y1, x0:x1]
        yy, xx = np.mgrid[y0:y1, x0:x1]
        rr = np.sqrt((yy - y) ** 2 + (xx - x) ** 2)
        half = (win > 0.5 * peak) & (rr < 30)
        r_half = max(1.5, np.sqrt(np.count_nonzero(half) / np.pi))
        orbs.append((int(x), int(y), float(np.clip(3.2 * r_half + 5, 11, 60))))
    return orbs


def freeze_mask(h, w, orbs):
    """1 = dust flows normally, smoothly fading to 0 inside/near each orb."""
    m = np.ones((h, w), np.float32)
    for x, y, r in orbs:
        y0, y1 = max(0, int(y - 3 * r)), min(h, int(y + 3 * r) + 1)
        x0, x1 = max(0, int(x - 3 * r)), min(w, int(x + 3 * r) + 1)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d = np.sqrt((xx - x) ** 2 + (yy - y) ** 2)
        t = np.clip((d - r * ORB_FREEZE_IN) / (r * (ORB_FREEZE_OUT - ORB_FREEZE_IN)), 0, 1)
        t = t * t * (3 - 2 * t)
        m[y0:y1, x0:x1] = np.minimum(m[y0:y1, x0:x1], t)
    return m


# ===========================================================================
# stage 2 — render
# ===========================================================================
def smooth_noise(h, w, sigma, seed):
    r = np.random.default_rng(seed).standard_normal((h, w)).astype(np.float32)
    r = blur(r, sigma)
    return r / (r.std() + 1e-9)


def dissolve_mask(h, w, seed):
    """A spatial threshold each pixel crosses at its own phase, so different
    pixels swap from A to B at different times. Its range is set so that, for
    EVERY pixel, w(phi=0)=0 and w(phi=1)=1 exactly (see _layer's w formula):
    that needs mask in [0.5*soft, 1-0.5*soft], not the full [0,1]. Get that
    wrong (as an earlier version did) and every frame - even phi=0 - is
    already a partial blend of A and B, which is exactly what softens the
    grain relative to the source still."""
    n = smooth_noise(h, w, DISSOLVE_BLOB, seed)
    rank = n.ravel().argsort().argsort().astype(np.float32) / (n.size - 1)
    lo, hi = 0.5 * DISSOLVE_SOFT + 0.01, 1 - 0.5 * DISSOLVE_SOFT - 0.01
    return (lo + (hi - lo) * rank.reshape(n.shape)).astype(np.float32)


def band(Pf, E):
    """Split the dust into (fine, mid), each normalised by its own local strength."""
    mid_src = blur(Pf, BAND_SPLIT_SIGMA)
    fine = (Pf - mid_src).astype(np.float32)
    mid = (mid_src - E).astype(np.float32)
    out = []
    for d in (fine, mid):
        r = np.sqrt(blur(lum(d) ** 2, STRENGTH_SIGMA)).astype(np.float32)  # true local strength (0 where no dust)
        out.append((np.clip(d / (r + STRENGTH_EPS)[..., None], -5, 5).astype(np.float32), r, d))
    return out


class Renderer:
    def __init__(self, P):
        from scipy.spatial import cKDTree

        self.H, self.W = P.shape[:2]
        H, W = self.H, self.W
        self.flow = PathFlow(H, W, P)
        f = self.flow
        Pf = P
        orbs = detect_orbs(P)
        print(f"orbs found (frozen in place): {len(orbs)}", file=sys.stderr)
        self.freeze = freeze_mask(H, W, orbs)

        # ---- per-pixel path coordinates -------------------------------------
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        pts = np.stack([xx.ravel(), yy.ravel()], 1).astype(np.float64)
        onimg = (f.S >= f.s_lo - 300) & (f.S <= f.s_hi + 300)
        tree = cKDTree(f.C[onimg])
        Sm, Cm, Tm, Nm = f.S[onimg], f.C[onimg], f.T[onimg], f.N[onimg]
        d1, i1 = tree.query(pts, workers=1)
        dv = pts - Cm[i1]
        s0 = Sm[i1] + (dv * Tm[i1]).sum(1)
        n = (dv * Nm[i1]).sum(1)
        # second-nearest DIFFERENT arm -> how close this pixel is to a tie
        # (coarse grid is plenty: the tie zone is a smooth, wide band)
        cs = 4
        gy, gx = np.mgrid[cs // 2:H:cs, cs // 2:W:cs]
        gp = np.stack([gx.ravel(), gy.ravel()], 1).astype(np.float64)
        sub = slice(None, None, 3)
        Cq, Sq = Cm[sub], Sm[sub]
        d2 = np.empty(len(gp)); dd1 = np.empty(len(gp))
        for i in range(0, len(gp), 2048):
            blk = gp[i:i + 2048]
            dist = np.sqrt(((blk[:, None, :] - Cq[None]) ** 2).sum(-1))
            j = dist.argmin(1)
            dd1[i:i + 2048] = dist[np.arange(len(blk)), j]
            far_arm = np.abs(Sq[None] - Sq[j][:, None]) > MEDIAL_MIN_ARC
            d2[i:i + 2048] = np.where(far_arm, dist, 1e9).min(1)
        gap = (d2 - dd1).reshape(gy.shape[0], gx.shape[1]).astype(np.float32)
        gap = cv2.resize(gap, (W, H), interpolation=cv2.INTER_LINEAR)
        t = np.clip(gap / MEDIAL_MARGIN, 0, 1)
        w_med = t * t * (3 - 2 * t)
        na = np.abs(n).reshape(H, W)
        t = np.clip((FAR_ZERO - na) / (FAR_ZERO - FAR_FULL), 0, 1)
        w_far = t * t * (3 - 2 * t)
        self.w_move = (w_med * w_far * self.freeze).astype(np.float32)[..., None]

        self.s0 = s0.astype(np.float32).reshape(H, W)
        self.n = n.astype(np.float32).reshape(H, W)
        self.pos0 = np.stack([xx, yy], -1)
        self.C0 = f._interp(f.C, self.s0)
        self.N0 = f._interp(f.N, self.s0)
        self.g = (SHEAR_MIN + (1 - SHEAR_MIN) * np.exp(-((self.n / 85.0) ** 2))).astype(np.float32)

        # ---- static base + dust bands -----------------------------------------
        self.E = blur(Pf, ENV_SIGMA).astype(np.float32)
        (self.Dn_f, self.r_f, self.D_f), (self.Dn_m, self.r_m, self.D_m) = band(Pf, self.E)
        self.mask_f = dissolve_mask(H, W, 11)
        self.mask_m = dissolve_mask(H, W, 12)
        self.sw = [np.stack([smooth_noise(H, W, SWIRL_SCALE, sd), smooth_noise(H, W, SWIRL_SCALE, sd + 1)], -1)
                   for sd in (21, 31)]

    def _map(self, delta, swirl):
        f = self.flow
        s_src = f.reflect(self.s0 - delta * self.g)
        C = f._interp(f.C, s_src)
        N = f._interp(f.N, s_src)
        q = self.pos0 + (C - self.C0) + self.n[..., None] * (N - self.N0) + swirl
        return q[..., 0].astype(np.float32), q[..., 1].astype(np.float32)

    def _layer(self, Dn, r, D, mask, shift, phi, swirl):
        ax, ay = self._map(phi * shift, swirl)
        bx, by = self._map((phi - 1.0) * shift, swirl)
        A = cv2.remap(Dn, ax, ay, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT_101)
        B = cv2.remap(Dn, bx, by, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT_101)
        w = np.clip((phi - mask) / DISSOLVE_SOFT + 0.5, 0, 1)[..., None]
        moving = (A * (1 - w) + B * w) * r[..., None]
        return self.w_move * moving + (1 - self.w_move) * D

    def dust(self, phi):
        ang = 2 * np.pi * phi
        swirl = (SWIRL_AMP * (np.cos(ang) * self.sw[0] + np.sin(ang) * self.sw[1])).astype(np.float32)
        fine = self._layer(self.Dn_f, self.r_f, self.D_f, self.mask_f, SHIFT_FINE_PX, phi, swirl)
        mid = self._layer(self.Dn_m, self.r_m, self.D_m, self.mask_m, SHIFT_MID_PX, phi, swirl)
        return fine + mid

    def frame(self, phi):
        out = self.E + self.dust(phi)
        a = np.clip(out[..., 3:4], 0, 1)
        rgb = np.clip(out[..., :3], 0, a)  # premult: colour can't exceed alpha
        return rgb, a


def to_rgba8(rgb, a):
    with np.errstate(divide="ignore", invalid="ignore"):
        col = np.where(a > 1.0 / 512, rgb / np.maximum(a, 1e-6), 0)
    return (np.clip(np.concatenate([col, a], -1), 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", type=int, default=0, help="render only N evenly spaced frames to PNG (no webp)")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--quality", type=int, default=WEBP_QUALITY)
    ap.add_argument("--alpha-quality", type=int, default=WEBP_ALPHA_QUALITY)
    ap.add_argument("--scale", type=float, default=1.0, help="output scale (1.0 = native 1536x1024)")
    args = ap.parse_args()

    P = load_premult()
    r = Renderer(P)
    frames = []
    phis = [k / N_FRAMES for k in range(N_FRAMES)]
    if args.preview:
        phis = [k / args.preview for k in range(args.preview)]
    for i, phi in enumerate(phis):
        rgb, a = r.frame(phi)
        img = Image.fromarray(to_rgba8(rgb, a), "RGBA")
        if args.scale != 1.0:
            img = img.resize((round(img.width * args.scale), round(img.height * args.scale)), Image.LANCZOS)
        frames.append(img)
        if args.preview:
            img.save(os.path.join(os.path.dirname(args.out), f"prev_{i:02d}.png"))
        print(f"frame {i + 1}/{len(phis)}", file=sys.stderr, end="\r")
    print(file=sys.stderr)
    if args.preview:
        return
    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=int(round(1000 / FPS)),
        loop=0,
        lossless=False,
        quality=args.quality,
        alpha_quality=args.alpha_quality,
        method=WEBP_METHOD,
        minimize_size=False,
    )
    print(f"wrote {args.out}  {os.path.getsize(args.out) / 1e6:.2f} MB  {len(frames)} frames  {len(frames) / FPS:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
