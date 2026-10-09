/**
 * The light of the Pipeline "Flow": the glowing journey drawn over the forest picture.
 *
 *  - a soft pool of stage-coloured light on the ground under every pedestal,
 *  - the four bridges lit by one continuous path whose colour turns purple → blue → green → orange → white,
 *  - a glowing ring round the foot of every pedestal, and a lit rim on the front edge of its top.
 *
 * Everything is SVG in the background picture's own pixel space (see forestFlow.ts), so it lines
 * up with the art at any width and stays sharp at any pixel density.
 */
import { useId } from "react";
import {
  BG,
  BRIDGES,
  CROP,
  LINKS,
  CROP_H,
  RING_ARC,
  SCALE,
  STAGES,
  TOP_RIM,
  arcPath,
  lighten,
  smoothPath,
} from "./forestFlow";

export function ForestFlowArt({ animated = true }: { animated?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (n: string) => `${uid}-${n}`;
  const ref = (n: string) => `url(#${id(n)})`;
  /** Line widths and blurs were drawn for a 1672-wide picture. */
  const w = (n: number) => Math.round(n * SCALE * 10) / 10;
  const region = {
    filterUnits: "userSpaceOnUse" as const,
    x: -100,
    y: -60,
    width: BG.w + 200,
    height: BG.h + 120,
  };

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 ${CROP.y0} ${BG.w} ${CROP_H}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 z-[2] size-full overflow-visible"
    >
      <defs>
        <filter id={id("glow")} {...region}>
          <feGaussianBlur stdDeviation={w(7)} />
        </filter>
        <filter id={id("soft")} {...region}>
          <feGaussianBlur stdDeviation={w(3)} />
        </filter>

        {STAGES.map((s, i) => (
          <radialGradient key={`pool-${i}`} id={id(`pool-${i}`)}>
            <stop offset="0" stopColor={s.color} stopOpacity={i === 4 ? 0.4 : 0.8} />
            <stop offset="0.55" stopColor={s.color} stopOpacity={i === 4 ? 0.16 : 0.3} />
            <stop offset="1" stopColor={s.color} stopOpacity="0" />
          </radialGradient>
        ))}

        {BRIDGES.map((b, i) => {
          const a = b.pts[0];
          const z = b.pts[b.pts.length - 1];
          const last = b.stops.length - 1;
          return (
            <g key={`grad-${i}`}>
              <linearGradient
                id={id(`bridge-${i}`)}
                gradientUnits="userSpaceOnUse"
                x1={a[0]}
                y1={a[1]}
                x2={z[0]}
                y2={z[1]}
              >
                {b.stops.map((c, k) => (
                  <stop key={k} offset={k / last} stopColor={c} />
                ))}
              </linearGradient>
              <linearGradient
                id={id(`bridge-core-${i}`)}
                gradientUnits="userSpaceOnUse"
                x1={a[0]}
                y1={a[1]}
                x2={z[0]}
                y2={z[1]}
              >
                {b.stops.map((c, k) => (
                  <stop key={k} offset={k / last} stopColor={lighten(c, 0.62)} />
                ))}
              </linearGradient>
            </g>
          );
        })}
      </defs>

      {/* light spilling onto the ground and the water around each pedestal */}
      <g style={{ mixBlendMode: "screen" }}>
        {STAGES.map((s, i) => (
          <ellipse
            key={i}
            cx={s.ring.cx}
            cy={s.ring.cy + 6}
            rx={s.ring.rx * 1.75}
            ry={s.ring.ry * 2.5}
            fill={ref(`pool-${i}`)}
            className={animated ? "pf-breathe" : undefined}
            style={animated ? { animationDelay: `${i * 0.9}s` } : undefined}
          />
        ))}
      </g>

      {/* the journey between the pedestals: glow, body, bright core */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {BRIDGES.map((b, i) => {
          const d = smoothPath(b.pts);
          return (
            <g key={i}>
              <path
                d={d}
                stroke={ref(`bridge-${i}`)}
                strokeWidth={w(26)}
                strokeOpacity="0.7"
                filter={ref("glow")}
              />
              <path
                d={d}
                stroke={ref(`bridge-${i}`)}
                strokeWidth={w(8)}
                strokeOpacity="1"
                filter={ref("soft")}
              />
              <path d={d} stroke={ref(`bridge-${i}`)} strokeWidth={w(4)} />
              <path d={d} stroke={ref(`bridge-core-${i}`)} strokeWidth={w(1.8)} strokeOpacity="0.97" />
            </g>
          );
        })}

        {/* the links between the rings and the bridges */}
        {LINKS.map((l, i) => {
          const d = smoothPath(l.pts);
          const c = STAGES[l.stage].color;
          return (
            <g key={`link-${i}`}>
              <path d={d} stroke={c} strokeWidth={w(20)} strokeOpacity="0.5" filter={ref("glow")} />
              <path d={d} stroke={c} strokeWidth={w(7)} strokeOpacity="0.95" filter={ref("soft")} />
              <path d={d} stroke={c} strokeWidth={w(4)} />
              <path d={d} stroke={STAGES[l.stage].core} strokeWidth={w(1.8)} strokeOpacity="0.95" />
            </g>
          );
        })}

        {/* a mote of light travelling each bridge in turn, so the path reads as one journey */}
        {animated &&
          BRIDGES.map((b, i) => {
            const d = smoothPath(b.pts);
            const style = { animationDelay: `${i * 1.7}s`, animationDuration: "8s" };
            return (
              <g key={`mote-${i}`}>
                <path
                  d={d}
                  pathLength={1000}
                  stroke="#fff"
                  strokeWidth={w(10)}
                  strokeOpacity="0.14"
                  strokeDasharray="120 3000"
                  className="pf-travel"
                  style={style}
                />
                <path
                  d={d}
                  pathLength={1000}
                  stroke="#fff"
                  strokeWidth={w(2.4)}
                  strokeOpacity="0.9"
                  strokeDasharray="70 3000"
                  className="pf-travel"
                  style={style}
                />
              </g>
            );
          })}
      </g>

      {/* the rings round the foot of each pedestal, and the lit front rim of its top */}
      {STAGES.map((s, i) => {
        const { cx, cy, rx, ry } = s.ring;
        const ring = arcPath(cx, cy, rx, ry, RING_ARC.from, RING_ARC.to);
        const rim = arcPath(s.top[0], s.top[1], TOP_RIM.rx, TOP_RIM.ry, 8, 172);
        return (
          <g key={i} fill="none" strokeLinecap="round">
            <path
              d={ring}
              stroke={s.color}
              strokeWidth={w(22)}
              strokeOpacity="0.5"
              filter={ref("glow")}
            />
            <path
              d={ring}
              stroke={s.color}
              strokeWidth={w(7)}
              strokeOpacity="0.9"
              filter={ref("soft")}
            />
            <path d={ring} stroke={s.color} strokeWidth={w(4.2)} />
            <path d={ring} stroke={s.core} strokeWidth={w(2)} strokeOpacity="0.96" />

            <path
              d={rim}
              stroke={s.color}
              strokeWidth={w(9)}
              strokeOpacity="0.5"
              filter={ref("soft")}
            />
            <path d={rim} stroke={s.core} strokeWidth={w(1.8)} strokeOpacity="0.85" />
          </g>
        );
      })}
    </svg>
  );
}
