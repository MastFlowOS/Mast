#!/usr/bin/env python3
"""
PHASE 9 — TRUE PARTICLE GOLD DUST FLOW.

Complete replacement of the texture-warp model.
Every dust grain is an explicit particle with a position on the S-curve.

Each frame:
  1. For every particle: s += velocity * dt
  2. Map s → (x, y) via the S-curve centerline + normal offset
  3. Render the grain as a soft, irregular, gold-toned mark
  4. Render a short trail behind the grain (past positions)

The result: unmistakable downstream travel of thousands of gold dust grains.

Rendering approach:
  - numpy-based splat rendering (no per-pixel Python loops)
  - Each grain is a pre-rendered soft sprite, stamped at computed (x, y)
  - Background: the heavily-blurred static gold-flow envelope (haze/glow)
  - Foreground: particle layer composited with additive blending (screen)

Output: opaque RGB on black background, for mix-blend-mode:screen in browser.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "public", "images", "mast-gold-flow.png")
DIAG_DIR = os.path.join(ROOT, "diag_particles")

# ---------------------------------------------------------------------------
# S-curve waypoints (same as existing ridge)
# ---------------------------------------------------------------------------
RIDGE_WAYPOINTS = [
    (147, 0),
    (741, 280),
    (517, 451),
    (1289, 840),
    (640, 940),
]

# ---------------------------------------------------------------------------
# canvas
# ---------------------------------------------------------------------------
NATIVE_W, NATIVE_H = 1536, 1024
OUT_W, OUT_H = 768, 512

# ---------------------------------------------------------------------------
# particle config
# ---------------------------------------------------------------------------
NUM_PARTICLES   = 8000     # total particles
NUM_BRIGHT      = 400      # trackable bright clusters

BASE_VELOCITY   = 0.07     # curve fraction / second
VELOCITY_SPREAD = 0.05     # ± random
VELOCITY_MIN    = 0.025

MAX_NORMAL_OFF  = 65.0     # px at native res
CORE_FRAC       = 0.60     # fraction concentrated in ±18 px core

GRAIN_R_MIN     = 0.4      # output px
GRAIN_R_MAX     = 2.5

TRAIL_STEPS     = 4        # past positions for motion trail
TRAIL_DECAY     = 0.40     # opacity multiplier per step

TURB_AMP        = 3.5      # native px
TURB_FREQ       = 0.12     # Hz-ish

FADE_IN_S       = 0.035    # curve fraction
FADE_OUT_S      = 0.965

DIAG_SPEED      = 2.0      # exaggerated for diagnostic

# Gold palette — various antique-gold tones
PALETTE = np.array([
    [255, 215, 120],
    [240, 200, 100],
    [220, 185,  90],
    [200, 170,  80],
    [255, 230, 150],
    [180, 150,  70],
    [255, 240, 180],
    [230, 195,  85],
    [210, 180,  75],
    [245, 210, 110],
], dtype=np.float32)


# ═══════════════════════════════════════════════════════════════════════════
# S-CURVE
# ═══════════════════════════════════════════════════════════════════════════
class SCurve:
    """Dense cubic-spline centerline with tangent/normal at every sample."""

    def __init__(self, waypoints, n=3000):
        from scipy.interpolate import CubicSpline

        pts = np.array(waypoints, dtype=np.float64)
        d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
        d /= d[-1]

        csx = CubicSpline(d, pts[:, 0], bc_type="natural")
        csy = CubicSpline(d, pts[:, 1], bc_type="natural")

        self.t = np.linspace(0, 1, n)
        self.x = csx(self.t).astype(np.float32)
        self.y = csy(self.t).astype(np.float32)

        dx = csx(self.t, 1)
        dy = csy(self.t, 1)
        mag = np.sqrt(dx**2 + dy**2).astype(np.float32)
        self.tx = (dx / mag).astype(np.float32)
        self.ty = (dy / mag).astype(np.float32)
        self.nx = (-self.ty).astype(np.float32)
        self.ny = (self.tx).astype(np.float32)

        ds = np.sqrt(np.diff(self.x.astype(np.float64))**2 +
                     np.diff(self.y.astype(np.float64))**2)
        self.arc = np.r_[0, np.cumsum(ds)].astype(np.float32)
        self.total_len = float(self.arc[-1])
        self.n_samples = n

    def eval_batch(self, s_arr):
        """Vectorized: s_arr shape (N,), returns (x, y, nx, ny) each (N,)."""
        s = np.clip(s_arr, 0.0, 1.0).astype(np.float32)
        idx_f = s * (self.n_samples - 1)
        idx = np.minimum(idx_f.astype(np.int32), self.n_samples - 2)
        frac = (idx_f - idx).astype(np.float32)
        frac1 = 1.0 - frac

        x  = self.x[idx]  * frac1 + self.x[idx+1]  * frac
        y  = self.y[idx]  * frac1 + self.y[idx+1]  * frac
        nx = self.nx[idx] * frac1 + self.nx[idx+1] * frac
        ny = self.ny[idx] * frac1 + self.ny[idx+1] * frac
        return x, y, nx, ny


# ═══════════════════════════════════════════════════════════════════════════
# PARTICLE SYSTEM (fully vectorized)
# ═══════════════════════════════════════════════════════════════════════════
class ParticleField:
    """All particles stored as parallel arrays for vectorized update."""

    def __init__(self, n, n_bright, rng: np.random.Generator):
        self.n = n
        self.n_bright = n_bright

        # ---- position on curve ----
        self.s = rng.uniform(0.0, 1.0, n).astype(np.float32)

        # ---- velocity ----
        v = BASE_VELOCITY + rng.uniform(-VELOCITY_SPREAD, VELOCITY_SPREAD, n)
        # bright particles are faster
        bright_mask = np.arange(n) < n_bright
        v[bright_mask] *= rng.uniform(1.15, 1.5, n_bright)
        self.velocity = np.maximum(v, VELOCITY_MIN).astype(np.float32)

        # ---- normal offset ----
        offsets = np.empty(n, np.float32)
        core_count = int(n * CORE_FRAC)
        offsets[:core_count] = rng.normal(0, 12.0, core_count)
        offsets[core_count:] = rng.normal(0, MAX_NORMAL_OFF * 0.45, n - core_count)
        self.normal_off = np.clip(offsets, -MAX_NORMAL_OFF, MAX_NORMAL_OFF).astype(np.float32)

        # ---- grain size (output px) ----
        sizes = rng.exponential(0.65, n) + GRAIN_R_MIN
        sizes[bright_mask] = rng.uniform(GRAIN_R_MAX * 0.5, GRAIN_R_MAX, n_bright)
        self.size = np.clip(sizes, GRAIN_R_MIN, GRAIN_R_MAX).astype(np.float32)

        # ---- base opacity ----
        opac = rng.uniform(0.12, 0.55, n)
        opac[bright_mask] = rng.uniform(0.55, 1.0, n_bright)
        self.opacity_base = opac.astype(np.float32)

        # ---- color index ----
        self.color_idx = rng.integers(0, len(PALETTE), n).astype(np.int32)

        # ---- turbulence phase ----
        self.turb_phase = rng.uniform(0, 2 * np.pi, n).astype(np.float32)
        self.turb_amp = (rng.uniform(0.25, 1.0, n) * TURB_AMP).astype(np.float32)

        # ---- trail history ----
        # Store last TRAIL_STEPS positions
        self.history = np.zeros((TRAIL_STEPS, n), np.float32)
        self.history[:] = self.s[None, :]
        self.hist_valid = np.zeros(n, np.int32)  # how many valid history entries

        self.bright_mask = bright_mask

    def advance(self, dt, speed_mult=1.0):
        """Move all particles downstream."""
        # shift history
        self.history = np.roll(self.history, 1, axis=0)
        self.history[0] = self.s.copy()
        self.hist_valid = np.minimum(self.hist_valid + 1, TRAIL_STEPS)

        # advance
        self.s += self.velocity * dt * speed_mult

        # wrap particles that exit
        wrapped = self.s > 1.0
        self.s[wrapped] = self.s[wrapped] % 1.0
        self.hist_valid[wrapped] = 0  # clear trail for wrapped particles

    def get_opacity(self):
        """Vectorized fade-in/out at curve ends."""
        o = self.opacity_base.copy()
        # fade in
        mask_in = self.s < FADE_IN_S
        o[mask_in] *= self.s[mask_in] / FADE_IN_S
        # fade out
        mask_out = self.s > FADE_OUT_S
        o[mask_out] *= (1.0 - (self.s[mask_out] - FADE_OUT_S) / (1.0 - FADE_OUT_S))
        return o


# ═══════════════════════════════════════════════════════════════════════════
# RENDERER
# ═══════════════════════════════════════════════════════════════════════════
class Renderer:
    def __init__(self, curve: SCurve, field: ParticleField):
        self.curve = curve
        self.field = field
        self.sx = OUT_W / NATIVE_W
        self.sy = OUT_H / NATIVE_H
        self._build_background()
        self._build_sprites()

    def _build_background(self):
        """Heavily blurred static envelope from the source PNG."""
        im = np.asarray(Image.open(SRC).convert("RGBA"), np.float32) / 255.0
        a = im[..., 3:4]
        premult = im[..., :3] * a
        # Heavy blur to keep just the smooth haze/glow (no fine grain)
        env = cv2.GaussianBlur(premult, (0, 0), 22.0,
                               borderType=cv2.BORDER_REFLECT_101)
        # Downscale
        env_small = cv2.resize(env, (OUT_W, OUT_H),
                               interpolation=cv2.INTER_AREA)
        self.bg = (np.clip(env_small, 0, 1) * 255).astype(np.float32)

    def _build_sprites(self):
        """Pre-render a set of soft grain sprites at different sizes."""
        self.sprites = {}
        for r_px in [0.5, 0.8, 1.0, 1.3, 1.6, 2.0, 2.5]:
            s = max(3, int(r_px * 2 + 2))
            if s % 2 == 0:
                s += 1
            cy = cx = s // 2
            yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
            # Slightly elongated ellipse
            dx = (xx - cx) / max(r_px, 0.5)
            dy = (yy - cy) / max(r_px * 0.6, 0.4)
            d2 = dx**2 + dy**2
            # Soft Gaussian falloff
            alpha = np.exp(-d2 * 1.8)
            alpha[d2 > 4.0] = 0
            self.sprites[r_px] = alpha.astype(np.float32)

    def _nearest_sprite(self, size):
        keys = sorted(self.sprites.keys())
        best = keys[0]
        for k in keys:
            if abs(k - size) < abs(best - size):
                best = k
        return best, self.sprites[best]

    def render_frame(self, dt, speed_mult=1.0, frame_time=0.0):
        """Advance + render. Returns (H, W, 3) uint8 RGB on black."""
        field = self.field
        curve = self.curve

        # advance particles
        field.advance(dt, speed_mult)

        # compute positions
        turb_offset = field.turb_amp * np.sin(
            frame_time * TURB_FREQ * 2 * np.pi + field.turb_phase
        )
        total_off = field.normal_off + turb_offset

        cx, cy, nx, ny = curve.eval_batch(field.s)
        px = (cx + total_off * nx) * self.sx
        py = (cy + total_off * ny) * self.sy

        opac = field.get_opacity()

        # Start from background
        frame = self.bg.copy()

        # ---- render trails first (dimmer, behind main grains) ----
        for ti in range(TRAIL_STEPS - 1, -1, -1):
            trail_opac = opac * (TRAIL_DECAY ** (ti + 1))
            valid = field.hist_valid > ti
            if not np.any(valid):
                continue

            hs = field.history[ti]
            turb_past = field.turb_amp * np.sin(
                (frame_time - (ti + 1) * dt) * TURB_FREQ * 2 * np.pi + field.turb_phase
            )
            total_off_h = field.normal_off + turb_past
            hcx, hcy, hnx, hny = curve.eval_batch(hs)
            hpx = (hcx + total_off_h * hnx) * self.sx
            hpy = (hcy + total_off_h * hny) * self.sy

            t_size = field.size * (0.65 - 0.1 * ti)
            self._splat_particles(
                frame, hpx, hpy, t_size, trail_opac, field.color_idx,
                mask=valid
            )

        # ---- render main grains ----
        self._splat_particles(frame, px, py, field.size, opac, field.color_idx)

        return np.clip(frame, 0, 255).astype(np.uint8)

    def _splat_particles(self, frame, px, py, sizes, opacities, color_idx,
                         mask=None):
        """Stamp pre-rendered sprites onto the frame with additive blending."""
        H, W = frame.shape[:2]

        if mask is None:
            indices = range(len(px))
        else:
            indices = np.where(mask)[0]

        for i in indices:
            x = float(px[i])
            y = float(py[i])
            o = float(opacities[i])

            if o < 0.02:
                continue
            if x < -3 or x > W + 3 or y < -3 or y > H + 3:
                continue

            sz = float(sizes[i]) if np.ndim(sizes) > 0 else float(sizes)
            sprite_key, sprite = self._nearest_sprite(sz)
            sh, sw = sprite.shape

            # Compute placement
            ix = int(round(x)) - sw // 2
            iy = int(round(y)) - sh // 2

            # Clip to frame bounds
            sx0 = max(0, -ix)
            sy0 = max(0, -iy)
            dx0 = max(0, ix)
            dy0 = max(0, iy)
            sx1 = min(sw, W - ix)
            sy1 = min(sh, H - iy)

            if sx0 >= sx1 or sy0 >= sy1:
                continue

            # Get sprite patch and color
            sp = sprite[sy0:sy1, sx0:sx1]
            color = PALETTE[color_idx[i]]

            # Additive blend (screen-like): frame += sprite_alpha * opacity * color
            contribution = sp[..., None] * (o * color[None, None, :])
            frame[dy0:dy0 + (sy1-sy0), dx0:dx0 + (sx1-sx0)] += contribution


# ═══════════════════════════════════════════════════════════════════════════
# CONTACT SHEET
# ═══════════════════════════════════════════════════════════════════════════
def make_contact_sheet(frames, indices, path):
    """Horizontal strip of specific frames with labels."""
    selected = [frames[i] for i in indices]
    h, w = selected[0].shape[:2]
    sheet = np.zeros((h, w * len(selected), 3), np.uint8)
    for i, f in enumerate(selected):
        sheet[:, i*w:(i+1)*w] = f

    img = Image.fromarray(sheet)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 20)
    except Exception:
        font = ImageFont.load_default()

    for i, idx in enumerate(indices):
        draw.text((i * w + 8, 6), f"Frame {idx}", fill=(255, 255, 255), font=font)
        # draw s-position markers for reference
        draw.text((i * w + 8, 28), f"t={idx/60:.3f}s", fill=(200, 200, 200), font=font)

    img.save(path)
    print(f"  Contact sheet → {path}", file=sys.stderr)


# ═══════════════════════════════════════════════════════════════════════════
# CLUSTER TRACKING — proves particles traveled
# ═══════════════════════════════════════════════════════════════════════════
def track_bright_particles(curve, rng_seed, frame_indices, dt, speed_mult):
    """Re-simulate bright particles to track their s-parameter and pixel position."""
    rng = np.random.default_rng(rng_seed)
    field = ParticleField(NUM_PARTICLES, NUM_BRIGHT, rng)
    sx_scale = OUT_W / NATIVE_W
    sy_scale = OUT_H / NATIVE_H

    # select 20 bright particles to track
    track_ids = list(range(min(20, NUM_BRIGHT)))

    max_frame = max(frame_indices)
    records = {}

    for f in range(max_frame + 1):
        if f in frame_indices:
            cx, cy, nx, ny = curve.eval_batch(field.s)
            px = (cx + field.normal_off * nx) * sx_scale
            py = (cy + field.normal_off * ny) * sy_scale
            records[f] = {
                tid: {"s": float(field.s[tid]),
                      "x": float(px[tid]),
                      "y": float(py[tid])}
                for tid in track_ids
            }
        field.advance(dt, speed_mult)

    print(f"\n{'='*72}", file=sys.stderr)
    print(f"PARTICLE TRACKING: {len(track_ids)} bright particles", file=sys.stderr)
    print(f"{'='*72}", file=sys.stderr)

    pairs = list(zip(frame_indices[:-1], frame_indices[1:]))
    all_ds = []

    for fa, fb in pairs:
        print(f"\n  Frame {fa} → {fb} ({fb-fa} frames, "
              f"{(fb-fa)*dt:.3f}s):", file=sys.stderr)
        deltas = []
        for tid in track_ids:
            sa = records[fa][tid]["s"]
            sb = records[fb][tid]["s"]
            ds = sb - sa
            if ds < -0.3:  # wrapped
                ds += 1.0
            xa, ya = records[fa][tid]["x"], records[fa][tid]["y"]
            xb, yb = records[fb][tid]["x"], records[fb][tid]["y"]
            pixel_dist = math.sqrt((xb - xa)**2 + (yb - ya)**2)
            deltas.append(ds)
            all_ds.append(ds)
            direction = "↓ downstream" if ds > 0 else "⚠ upstream?!"
            print(f"    P{tid:2d}: s {sa:.4f}→{sb:.4f}  "
                  f"Δs={ds:+.4f} ({ds*100:+.1f}%)  "
                  f"({xa:.0f},{ya:.0f})→({xb:.0f},{yb:.0f})  "
                  f"Δpx={pixel_dist:.0f}  {direction}",
                  file=sys.stderr)

        avg = np.mean(deltas)
        print(f"    ── Average Δs: {avg:.4f} ({avg*100:.2f}% of curve) ──",
              file=sys.stderr)

    overall = np.mean(all_ds)
    arc_px = overall * curve.total_len * (OUT_W / NATIVE_W)
    print(f"\n{'='*72}", file=sys.stderr)
    print(f"OVERALL: avg Δs/gap = {overall:.4f} "
          f"({overall*100:.2f}% of curve, ~{arc_px:.0f} output px)",
          file=sys.stderr)

    if overall > 0.005:
        print("✅ PARTICLES ARE CLEARLY TRAVELING DOWNSTREAM", file=sys.stderr)
    else:
        print("❌ INSUFFICIENT MOVEMENT", file=sys.stderr)
    print(f"{'='*72}\n", file=sys.stderr)

    return overall


# ═══════════════════════════════════════════════════════════════════════════
# VIDEO ENCODING
# ═══════════════════════════════════════════════════════════════════════════
def encode_mp4(frames_rgb, path, fps=60):
    """Encode list of (H,W,3) uint8 arrays to H.264 MP4."""
    import imageio_ffmpeg
    import subprocess

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    h, w = frames_rgb[0].shape[:2]

    cmd = [
        exe, "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{w}x{h}", "-pix_fmt", "rgb24",
        "-r", str(fps), "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", "18", "-preset", "medium", "-tune", "film",
        "-movflags", "+faststart",
        path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    for f in frames_rgb:
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    _, err = proc.communicate()
    if proc.returncode != 0:
        print(f"FFmpeg error:\n{err.decode()}", file=sys.stderr)
        sys.exit(1)
    sz = os.path.getsize(path) / 1e6
    print(f"  Video → {path}  ({sz:.2f} MB, {len(frames_rgb)} frames, "
          f"{fps} FPS)", file=sys.stderr)


# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(
        description="PHASE 9: True particle gold dust flow")
    ap.add_argument("--production", action="store_true",
                    help="Full 6.4s production render directly to public/images/")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--speed", type=float, default=0.45,
                    help="Speed multiplier (0.45 = serene, calm drift)")
    ap.add_argument("--out-mp4", default=os.path.join(ROOT, "public", "images", "mast-gold-flow-animated.mp4"))
    ap.add_argument("--out-webm", default=os.path.join(ROOT, "public", "images", "mast-gold-flow-animated.webm"))
    args = ap.parse_args()

    os.makedirs(DIAG_DIR, exist_ok=True)

    print("═" * 60, file=sys.stderr)
    print("PHASE 9: TRUE PARTICLE GOLD DUST FLOW", file=sys.stderr)
    print("═" * 60, file=sys.stderr)

    print("\nBuilding S-curve...", file=sys.stderr)
    curve = SCurve(RIDGE_WAYPOINTS)
    print(f"  Arc length: {curve.total_len:.0f} native px", file=sys.stderr)

    print(f"\nSpawning {NUM_PARTICLES} particles "
          f"({NUM_BRIGHT} bright trackable)...", file=sys.stderr)
    rng = np.random.default_rng(2024)
    field = ParticleField(NUM_PARTICLES, NUM_BRIGHT, rng)

    renderer = Renderer(curve, field)

    fps = args.fps
    speed = args.speed
    dt = 1.0 / fps

    if args.production:
        duration = 6.4
        n_frames = int(round(fps * duration))
        print(f"\nPRODUCTION RENDER: {n_frames} frames (6.4s @ {fps} FPS, {speed}× calm speed)...", file=sys.stderr)
    else:
        duration = 1.0
        n_frames = 60
        print(f"\nDiagnostic render: {n_frames} frames ({duration}s @ {fps} FPS, {speed}× speed)...", file=sys.stderr)

    t0 = time.time()
    frames = []

    for fi in range(n_frames):
        rgb = renderer.render_frame(dt, speed_mult=speed,
                                    frame_time=fi * dt)
        frames.append(rgb)
        if (fi + 1) % 15 == 0 or fi == n_frames - 1:
            el = time.time() - t0
            rate = (fi + 1) / max(0.01, el)
            eta = (n_frames - fi - 1) / max(0.01, rate)
            sys.stderr.write(
                f"\r  [{fi+1:3d}/{n_frames}] "
                f"{rate:.1f} fps  ETA {eta:.0f}s")
            sys.stderr.flush()

    elapsed = time.time() - t0
    print(f"\n  Render done in {elapsed:.1f}s "
          f"({n_frames/elapsed:.1f} fps)", file=sys.stderr)

    if args.production:
        # Seamless loop blending: blend the tail frames with the start frames over 0.5s (30 frames)
        blend_n = 30
        print(f"\nApplying seamless loop blend over {blend_n} frames...", file=sys.stderr)
        final_frames = [f.copy() for f in frames]
        for bi in range(blend_n):
            alpha = (bi + 1) / (blend_n + 1)
            # End of loop blends smoothly into the beginning
            head_idx = bi
            tail_idx = n_frames - blend_n + bi
            blended = (1.0 - alpha) * frames[tail_idx].astype(np.float32) + alpha * frames[head_idx].astype(np.float32)
            final_frames[tail_idx] = np.clip(blended, 0, 255).astype(np.uint8)

        print(f"\nEncoding MP4 directly to {args.out_mp4}...", file=sys.stderr)
        encode_mp4(final_frames, args.out_mp4, fps=fps)

        print(f"Encoding companion WebM to {args.out_webm}...", file=sys.stderr)
        import imageio_ffmpeg
        import subprocess
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
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
        print(f"\n✅ Production video assets successfully generated in public/images/!", file=sys.stderr)
        return

    # ---- save diagnostic frames ----
    diag_indices = [0, 15, 30, 45, 59]
    for idx in diag_indices:
        p = os.path.join(DIAG_DIR, f"frame_{idx:03d}.png")
        Image.fromarray(frames[idx]).save(p)
        print(f"  {p}", file=sys.stderr)

    # ---- contact sheet ----
    cs_path = os.path.join(DIAG_DIR, "contact_sheet.png")
    make_contact_sheet(frames, diag_indices, cs_path)

    # ---- 1-second video ----
    vid_path = os.path.join(DIAG_DIR, "diagnostic_1s.mp4")
    encode_mp4(frames, vid_path, fps=fps)

    # ---- cluster tracking ----
    print("\nTracking bright particles...", file=sys.stderr)
    track_bright_particles(
        curve, rng_seed=2024,
        frame_indices=diag_indices,
        dt=dt, speed_mult=speed,
    )

    print(f"\n✅ DIAGNOSTIC COMPLETE", file=sys.stderr)
    print(f"   Contact sheet: {cs_path}", file=sys.stderr)
    print(f"   Video:         {vid_path}", file=sys.stderr)
    print(f"   Frames:        {DIAG_DIR}/frame_*.png", file=sys.stderr)


if __name__ == "__main__":
    main()
