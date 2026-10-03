/**
 * Discover's hero visual: the supplied globe artwork (`discover-globe.png`),
 * dimmed a touch, with a few tiny dots drifting around it like satellites.
 *
 * It is purely decorative — it no longer reacts to the form (the Target Region
 * card has its own map). The page sizes it through `--g` (the planet's width)
 * and tucks the lower half of the planet under the control cards: the stage
 * fades out just past the equator.
 */
import { useEffect, useState } from "react";
import globeArtUrl from "@/assets/discover-globe.png";
import { GLOBE_ART } from "./globeArt";

// Artwork placement, in multiples of the planet's width (--g), so the planet
// in the PNG lands exactly on the stage's centre and fills `--g`.
const ART_W = GLOBE_ART.w / (2 * GLOBE_ART.rx); // image width ÷ planet width
const ART_LEFT = 0.5 - (ART_W * GLOBE_ART.cx) / GLOBE_ART.w;
const ART_TOP = 0.5 - (ART_W * GLOBE_ART.cy) / GLOBE_ART.w;

// Everything below is in "planet widths", origin = planet centre.
const PLANET_RX = 0.5;
const PLANET_RY = 0.5 * (GLOBE_ART.ry / GLOBE_ART.rx);

type Orbit = { rx: number; ry: number; tilt: number; dots: { dur: number; at: number; r: number; fill: string }[] };

// Invisible ellipses the dots travel along (the PNG already paints its own lines).
const ORBITS: Orbit[] = [
  { rx: 0.74, ry: 0.27, tilt: -20, dots: [
    { dur: 70, at: 0, r: 0.0042, fill: "#c9d2ff" },
    { dur: 70, at: 0.52, r: 0.0030, fill: "#8f7bff" },
  ] },
  { rx: 0.66, ry: 0.36, tilt: 14, dots: [
    { dur: 90, at: 0.2, r: 0.0036, fill: "#8fb2ff" },
    { dur: 90, at: 0.68, r: 0.0028, fill: "#c9d2ff" },
    { dur: 90, at: 0.9, r: 0.0024, fill: "#a78bfa" },
  ] },
  { rx: 0.9, ry: 0.22, tilt: -38, dots: [
    { dur: 110, at: 0.35, r: 0.0034, fill: "#a78bfa" },
    { dur: 110, at: 0.85, r: 0.0026, fill: "#8fb2ff" },
  ] },
];

// Fixed micro-stars around the planet: [angle°, distance, radius, twinkle seconds].
const STARS: [number, number, number, number][] = [
  [200, 0.62, 0.0030, 5.2], [238, 0.78, 0.0022, 7.1], [265, 0.58, 0.0026, 6.3],
  [292, 0.7, 0.0030, 4.6], [322, 0.84, 0.0020, 8.0], [348, 0.6, 0.0028, 5.8],
  [12, 0.72, 0.0022, 6.7], [38, 0.9, 0.0026, 7.7], [152, 0.68, 0.0024, 6.1],
  [172, 0.92, 0.0020, 5.4], [128, 0.8, 0.0028, 7.3], [214, 0.98, 0.0022, 6.9],
  [305, 1.0, 0.0024, 5.0], [75, 0.86, 0.0020, 8.4],
];

const ellipsePath = (rx: number, ry: number) =>
  `M ${rx} 0 A ${rx} ${ry} 0 1 1 ${-rx} 0 A ${rx} ${ry} 0 1 1 ${rx} 0`;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(q.matches);
    const on = () => setReduced(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function DiscoverGlobe({ className }: { className?: string }) {
  const reduced = useReducedMotion();

  return (
    <div
      aria-hidden="true"
      className={`dg-stage pointer-events-none relative select-none ${className ?? ""}`}
      style={{
        width: "var(--g)",
        height: "var(--g)",
        // The lower half sits under the cards: fade out just past the equator.
        maskImage: "linear-gradient(to bottom, #000 0, #000 47%, transparent 56%)",
        WebkitMaskImage: "linear-gradient(to bottom, #000 0, #000 47%, transparent 56%)",
      }}
    >
      {/* the artwork: planet + atmosphere + stars + orbit lines, a bit dimmer */}
      <img
        src={globeArtUrl}
        alt=""
        width={GLOBE_ART.w}
        height={GLOBE_ART.h}
        draggable={false}
        decoding="async"
        className="absolute max-w-none"
        style={{
          width: `calc(var(--g) * ${ART_W})`,
          height: "auto",
          left: `calc(var(--g) * ${ART_LEFT})`,
          top: `calc(var(--g) * ${ART_TOP})`,
          filter: "brightness(0.8) saturate(0.92)",
        }}
      />

      {/* tiny dots drifting around the planet */}
      <svg
        viewBox="-1.2 -0.95 2.4 1.9"
        className="absolute max-w-none overflow-visible"
        style={{
          width: "calc(var(--g) * 2.4)",
          height: "calc(var(--g) * 1.9)",
          left: "calc(var(--g) * -0.7)",
          top: "calc(var(--g) * -0.45)",
        }}
      >
        <defs>
          <mask id="dg-hide-planet" maskUnits="userSpaceOnUse" x="-1.2" y="-0.95" width="2.4" height="1.9">
            <rect x="-1.2" y="-0.95" width="2.4" height="1.9" fill="#fff" />
            <ellipse cx="0" cy="0" rx={PLANET_RX * 1.01} ry={PLANET_RY * 1.01} fill="#000" />
          </mask>
          {ORBITS.map((o, i) => (
            <path key={i} id={`dg-orbit-${i}`} d={ellipsePath(o.rx, o.ry)} />
          ))}
        </defs>

        <g mask="url(#dg-hide-planet)" style={{ filter: "drop-shadow(0 0 0.01px rgba(150,140,255,0.9))" }}>
          {STARS.map(([deg, dist, r, tw], i) => {
            const a = (deg * Math.PI) / 180;
            return (
              <circle key={i} cx={Math.cos(a) * dist} cy={Math.sin(a) * dist * 0.78} r={r} fill="#cfd6ff" opacity={0.55}>
                {!reduced && (
                  <animate attributeName="opacity" values="0.15;0.85;0.15" dur={`${tw}s`} begin={`${-(i * 1.3) % tw}s`} repeatCount="indefinite" />
                )}
              </circle>
            );
          })}

          {ORBITS.map((o, i) => (
            <g key={i} transform={`rotate(${o.tilt})`}>
              {o.dots.map((d, j) => {
                const a = d.at * Math.PI * 2;
                return (
                  <circle
                    key={j}
                    r={d.r}
                    fill={d.fill}
                    cx={reduced ? Math.cos(a) * o.rx : 0}
                    cy={reduced ? Math.sin(a) * o.ry : 0}
                  >
                    {!reduced && (
                      <animateMotion dur={`${d.dur}s`} begin={`${-d.at * d.dur}s`} repeatCount="indefinite">
                        <mpath href={`#dg-orbit-${i}`} />
                      </animateMotion>
                    )}
                  </circle>
                );
              })}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
