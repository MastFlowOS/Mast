/**
 * Page-wide backdrop for the Discover tab: deep blue/violet glows plus the long
 * sweeping orbit curves (with glowing nodes) that arc behind the globe, behind
 * the title and under the Discovery Summary. Purely decorative; sits behind all
 * content and is allowed to run past the left column.
 */
const ORBITS = [
  // wide arc sweeping from the title area up and over the globe
  "M -40 330 C 220 170, 520 20, 860 60 S 1330 190, 1560 120",
  // low arc passing under the globe, out beneath the summary
  "M 120 400 C 420 300, 760 250, 1060 300 S 1400 360, 1580 310",
  // long diagonal curve behind the headline
  "M -60 120 C 120 200, 300 330, 520 400",
  // tight ring hugging the globe's right side
  "M 700 20 C 940 -10, 1180 80, 1250 240",
];

const NODES: [number, number, number, string][] = [
  [1010, 34, 5, "#b58cff"],
  [838, 196, 4, "#c58bff"],
  [530, 248, 3.5, "#8f7bff"],
  [1186, 118, 2.5, "#8fb2ff"],
];

const STARS: [number, number, number][] = [
  [60, 60, 1.4], [150, 30, 1], [290, 90, 1.2], [410, 40, 1], [470, 150, 1.4],
  [640, 24, 1.2], [720, 120, 1], [1130, 22, 1.4], [1260, 70, 1], [1340, 40, 1.2],
  [1400, 150, 1], [1450, 90, 1.4], [240, 230, 1], [90, 280, 1.2], [1310, 230, 1],
];

export function DiscoverAtmosphere() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[640px] select-none overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 38% 55% at 60% 28%, rgba(52,90,255,0.20), transparent 70%)",
            "radial-gradient(ellipse 30% 40% at 78% 14%, rgba(124,92,255,0.16), transparent 70%)",
            "radial-gradient(ellipse 28% 45% at 8% 22%, rgba(70,60,200,0.14), transparent 70%)",
          ].join(","),
        }}
      />
      <svg
        viewBox="0 0 1500 560"
        preserveAspectRatio="xMidYMin slice"
        className="absolute inset-0 size-full"
        style={{ maskImage: "linear-gradient(to bottom, #000 55%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, #000 55%, transparent 100%)" }}
      >
        <defs>
          <linearGradient id="da-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6d7dff" stopOpacity="0" />
            <stop offset="0.35" stopColor="#7f8cff" stopOpacity="0.55" />
            <stop offset="0.7" stopColor="#a58bff" stopOpacity="0.5" />
            <stop offset="1" stopColor="#6d7dff" stopOpacity="0" />
          </linearGradient>
          <filter id="da-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>
        {ORBITS.map((d, i) => (
          <g key={i}>
            <path d={d} fill="none" stroke="url(#da-line)" strokeWidth="3" opacity="0.25" filter="url(#da-glow)" />
            <path d={d} fill="none" stroke="url(#da-line)" strokeWidth="1" opacity={i === 3 ? 0.5 : 0.8} />
          </g>
        ))}
        {STARS.map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill="#cfd6ff" opacity="0.5" />
        ))}
        {NODES.map(([x, y, r, c], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={r * 3.2} fill={c} opacity="0.35" filter="url(#da-glow)" />
            <circle cx={x} cy={y} r={r} fill={c} />
            <circle cx={x} cy={y} r={r * 0.45} fill="#fff" opacity="0.9" />
          </g>
        ))}
      </svg>
    </div>
  );
}
