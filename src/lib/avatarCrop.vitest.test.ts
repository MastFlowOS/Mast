import { describe, expect, it } from "vitest";
import { clampPan, computeMinScale, computeSourceRect } from "./avatarCrop";

const CIRCLE = 220;
const cases = [
  { name: "portrait", w: 1200, h: 1800 },
  { name: "landscape", w: 1800, h: 1200 },
  { name: "square", w: 1000, h: 1000 },
  { name: "very large", w: 8000, h: 6000 },
  { name: "tiny", w: 100, h: 80 },
];

describe("avatar crop math", () => {
  for (const { name, w, h } of cases) {
    describe(name, () => {
      const minScale = computeMinScale(w, h, CIRCLE);

      it("min scale makes the shorter side equal the circle (covers it, never over-zoomed)", () => {
        expect(Math.min(w, h) * minScale).toBeCloseTo(CIRCLE, 6);
        expect(w * minScale).toBeGreaterThanOrEqual(CIRCLE - 1e-6);
        expect(h * minScale).toBeGreaterThanOrEqual(CIRCLE - 1e-6);
      });

      it("initial crop (zoom 1, pan 0) is centred and spans the full shorter side", () => {
        const r = computeSourceRect(w, h, minScale, { x: 0, y: 0 }, CIRCLE);
        expect(r.sSize).toBeCloseTo(Math.min(w, h), 6);
        expect(r.sx + r.sSize / 2).toBeCloseTo(w / 2, 6);
        expect(r.sy + r.sSize / 2).toBeCloseTo(h / 2, 6);
      });

      it("zoom 3 shrinks the source window to a third", () => {
        const r = computeSourceRect(w, h, minScale * 3, { x: 0, y: 0 }, CIRCLE);
        expect(r.sSize).toBeCloseTo(Math.min(w, h) / 3, 6);
      });

      it("clamped pan never exposes empty space, at any zoom", () => {
        for (const z of [1, 1.5, 2, 3]) {
          const s = minScale * z;
          for (const p of [
            { x: 1e6, y: 1e6 },
            { x: -1e6, y: -1e6 },
            { x: 1e6, y: -1e6 },
          ]) {
            const c = clampPan(p, w, h, s, CIRCLE);
            // Unclamped (raw) source rect must already be inside the image.
            const sSize = CIRCLE / s;
            const sx = w / 2 - c.x / s - sSize / 2;
            const sy = h / 2 - c.y / s - sSize / 2;
            expect(sx).toBeGreaterThanOrEqual(-1e-6);
            expect(sy).toBeGreaterThanOrEqual(-1e-6);
            expect(sx + sSize).toBeLessThanOrEqual(w + 1e-6);
            expect(sy + sSize).toBeLessThanOrEqual(h + 1e-6);
          }
        }
      });
    });
  }

  it("falls back safely on invalid dimensions", () => {
    expect(computeMinScale(0, 0, CIRCLE)).toBe(1);
  });
});
