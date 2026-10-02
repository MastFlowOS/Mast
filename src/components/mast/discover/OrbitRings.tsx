/**
 * The Discover globe's orbit lines. Pure CSS — see the "Discover — orbital
 * stage" block in styles.css for how the motion works. Render this twice per
 * stage: side="back" under the globe, side="front" over it. Both copies share
 * the same phase (negative animation-delay), so a ring appears to loop around
 * the planet rather than being two unrelated halves.
 *
 * Sizes are multiples of the globe diameter (--g, set by the page), so the
 * whole composition scales as one piece.
 */
import type { CSSProperties } from "react";

type Ring = {
  /** Ring diameter as a multiple of the globe diameter. */
  size: number;
  /** In-plane rotation of the whole orbit, degrees. */
  rz: number;
  /** Vertical squash: 1 = face-on circle, smaller = more edge-on. */
  squash: number;
  /** Seconds per revolution. Long on purpose — this is ambient. */
  dur: number;
  dir: "normal" | "reverse";
  /** Opacity of the thin always-visible track. */
  line: number;
  /** Starting phase, 0–1 of a revolution. */
  phase: number;
};

const RINGS: readonly Ring[] = [
  { size: 1.62, rz: -18, squash: 0.3, dur: 54, dir: "normal", line: 0.85, phase: 0.1 },
  { size: 1.32, rz: 24, squash: 0.36, dur: 41, dir: "reverse", line: 0.75, phase: 0.55 },
  { size: 1.95, rz: 6, squash: 0.24, dur: 78, dir: "normal", line: 0.55, phase: 0.8 },
];

export function OrbitRings({ side }: { side: "back" | "front" }) {
  return (
    <>
      {RINGS.map((r, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="dg-orbit"
          style={
            {
              "--s": `calc(var(--g) * ${r.size})`,
              "--rz": `${r.rz}deg`,
              "--squash": r.squash,
              "--dur": `${r.dur}s`,
              "--dir": r.dir,
              "--line-o": r.line,
              "--delay": `${-r.dur * r.phase}s`,
            } as CSSProperties
          }
        >
          <div className="dg-orbit-frame">
            <div className="dg-orbit-half" data-side={side}>
              <div className="dg-orbit-plane">
                <div className="dg-orbit-line" />
                <div className="dg-orbit-spin">
                  <div className="dg-orbit-arc" />
                  <div className="dg-orbit-head" />
                  <div className="dg-orbit-sat" />
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
