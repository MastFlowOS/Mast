/**
 * The flow ribbon and the five stage rings.
 *
 * The ribbon is split by frequency, which is what keeps it sharp:
 *  - the smooth glowing body is a small bitmap (soft content never looks low-res when scaled), and
 *  - everything with an edge is vector SVG: the silk threads, the bright seam and the rings, so
 *    those stay razor sharp at any size or pixel density.
 * The vector detail is traced from the supplied artwork (see flowRibbonTrace.ts).
 */
import { useId } from "react";
import bodyUrl from "@/assets/pipeline-flow-body.webp";
import { ART, ART_NODES, CROP, CROP_H, RING_R } from "./flowRibbon";
import { SEAM, THREADS, THREAD_GLOW } from "./flowRibbonTrace";

/** The three longest bright threads carry a slow pulse of light, left to right. */
const PULSES = THREADS.filter((t) => t.k >= 0.6)
  .sort((a, b) => b.len - a.len)
  .slice(0, 2)
  .map((t, i) => ({ d: t.d, delay: i * 2.6, dur: 7 + i * 1.2 }));

/**
 * The ribbon dissolves into the background at both ends instead of stopping at the container's
 * edge (a full-strength glow cut off by a hard vertical line looked sliced).
 */
const END_FADE = "linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.12) 2.5%, rgba(0,0,0,0.45) 5.5%, rgba(0,0,0,0.85) 9%, #000 12%, #000 88%, rgba(0,0,0,0.85) 91%, rgba(0,0,0,0.45) 94.5%, rgba(0,0,0,0.12) 97.5%, transparent 100%)";

/** Near-black with a trace of the stage colour: the inside of a ring. */
function deep(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * 0.18 + 4);
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

export function FlowRibbonArt({
  colors,
  tints,
  animated = false,
}: {
  /** Stage colours, in flow order. */
  colors: string[];
  /** A pale tint of each stage colour, used for the ring itself. */
  tints: string[];
  animated?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (n: string) => `${uid}-${n}`;
  const ref = (n: string) => `url(#${id(n)})`;
  const region = { filterUnits: "userSpaceOnUse" as const, x: -200, y: -120, width: ART.w + 400, height: 1100 };

  return (
    <>
      {/* the soft glowing body */}
      <img
        src={bodyUrl}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="pointer-events-none absolute left-0 z-[1] w-full max-w-none select-none"
        style={{
          top: `${-(CROP.y0 / CROP_H) * 100}%`,
          height: `${(ART.h / CROP_H) * 100}%`,
          WebkitMaskImage: END_FADE,
          maskImage: END_FADE,
        }}
      />

      <svg
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute inset-0 z-[2] size-full"
        style={{ overflow: "visible" }}
        viewBox={`0 ${CROP.y0} ${ART.w} ${CROP_H}`}
      >
        <defs>
          <linearGradient id={id("glow")} gradientUnits="userSpaceOnUse" x1="0" x2={ART.w} y1="0" y2="0">
            {THREAD_GLOW.map(([o, c]) => (
              <stop key={o} offset={o} stopColor={c} />
            ))}
          </linearGradient>
          <linearGradient id={id("endfade")} gradientUnits="userSpaceOnUse" x1="0" x2={ART.w} y1="0" y2="0">
            {[
              [0, 0],
              [0.025, 0.12],
              [0.055, 0.45],
              [0.09, 0.85],
              [0.12, 1],
              [0.88, 1],
              [0.91, 0.85],
              [0.945, 0.45],
              [0.975, 0.12],
              [1, 0],
            ].map(([o, a]) => (
              <stop key={o} offset={o} stopColor="#fff" stopOpacity={a} />
            ))}
          </linearGradient>
          <mask id={id("endmask")} maskUnits="userSpaceOnUse" x={-200} y={-120} width={ART.w + 400} height={1100}>
            <rect x={-200} y={-120} width={ART.w + 400} height={1100} fill={ref("endfade")} />
          </mask>
          <filter id={id("soft")} {...region}>
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <filter id={id("ringglow")} {...region}>
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id={id("seam")} {...region}>
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
          {ART_NODES.map((_, i) => (
            <radialGradient key={i} id={id(`core${i}`)} cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#02030f" />
              <stop offset="0.7" stopColor={deep(colors[i])} />
              <stop offset="1" stopColor={colors[i]} stopOpacity="0.38" />
            </radialGradient>
          ))}
        </defs>

        {/* the ribbon's vector detail, fading out toward both ends along with the body */}
        <g mask={ref("endmask")}>
          {/* threads: a soft glow under each, then a hairline on top (widths in screen px, so they stay crisp) */}
          <g fill="none" stroke={ref("glow")} strokeLinecap="round" strokeLinejoin="round">
            <g filter={ref("soft")}>
              {THREADS.map((t, i) => (
                <path key={i} d={t.d} strokeWidth={3 + 4 * t.k} strokeOpacity={0.01 + 0.1 * t.k} />
              ))}
            </g>
            {THREADS.map((t, i) => (
              <path key={i} d={t.d} strokeWidth={0.5 + 0.6 * t.k} strokeOpacity={0.06 + 0.4 * t.k} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
          {/* the bright seam */}
          <g filter={ref("seam")} fill="#fff" fillRule="evenodd">
            {SEAM.map((d, i) => (
              <path key={i} d={d} fillOpacity={[0.08, 0.2, 0.45][i]} />
            ))}
          </g>

          {/* light travelling along the brightest threads */}
          {animated &&
            PULSES.map((p, i) => {
              const style = { animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s` };
              return (
                <g key={i} fill="none" strokeLinecap="round">
                  <path d={p.d} pathLength={1000} stroke="#fff" strokeWidth="12" strokeOpacity="0.08" strokeDasharray="130 3000" className="pf-travel" style={style} filter={ref("soft")} />
                  <path d={p.d} pathLength={1000} stroke="#fff" strokeWidth="1.8" strokeOpacity="0.6" strokeDasharray="90 3000" className="pf-travel" style={style} vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
        </g>

        {/* the five rings */}
        {ART_NODES.map((n, i) => (
          <g key={i}>
            <circle cx={n.x} cy={n.y} r={RING_R + 4} fill="none" stroke={colors[i]} strokeWidth="16" opacity="0.2" filter={ref("ringglow")} />
            <circle cx={n.x} cy={n.y} r={RING_R} fill={ref(`core${i}`)} />
            <circle cx={n.x} cy={n.y} r={RING_R} fill="none" stroke={colors[i]} strokeWidth="9" opacity="0.22" />
            <circle cx={n.x} cy={n.y} r={RING_R} fill="none" stroke={tints[i]} strokeWidth="6" opacity="0.7" />
          </g>
        ))}
      </svg>
    </>
  );
}
