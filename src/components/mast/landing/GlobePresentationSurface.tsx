/**
 * GlobePresentationSurface — creates the cinematic ground/presentation surface
 * underneath the static globe + stand asset.
 *
 * Visual hierarchy:
 *   dark background → subtle floor → warm reflection/rings → globe + stand
 *
 * Design details matching the visual source of truth:
 * - A very dark, subtle presentation floor plane with soft perspective horizon fade.
 * - Subtle warm bronze/gold illumination pool around the pedestal base.
 * - Soft warm mirror reflection directly beneath the stand's bottom rim with
 *   specular glint matching the right brass facet.
 * - Faint thin circular/astronomical engraved rings centered around the pedestal
 *   (concentric coordinate tracks, azimuth ticks, eccentric orbital arcs, radial spokes).
 * - Subtle horizontal floor reflection / light streaks across the surface.
 * - Mathematically locked to the globe asset's aspect ratio and coordinates:
 *   Horizontal center: 46.64%, Base rim center: 94.2%, Contact seam: 99.32%.
 * - 1:4 perspective ellipse compression (ry = 0.25 * rx).
 * - Ultra-lightweight: zero JS loops, zero canvas particle systems, zero expensive filters.
 */

export function GlobePresentationSurface() {
  return (
    <div
      className="pointer-events-none absolute inset-0 select-none overflow-visible z-0"
      aria-hidden="true"
    >
      {/* ─── 1. Dark Presentation Surface Floor Plane ───────────────────────── */}
      <div
        className="absolute pointer-events-none rounded-[50%]"
        style={{
          width: "255%",
          height: "65%",
          left: "46.64%",
          top: "94.2%",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(ellipse 52% 44% at 50% 50%, rgba(13, 16, 23, 0.96) 0%, rgba(11, 13, 19, 0.84) 34%, rgba(9, 11, 16, 0.52) 60%, rgba(6, 8, 12, 0.16) 78%, transparent 100%)",
          maskImage:
            "radial-gradient(ellipse 52% 44% at 50% 50%, black 35%, rgba(0,0,0,0.6) 65%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 52% 44% at 50% 50%, black 35%, rgba(0,0,0,0.6) 65%, transparent 100%)",
        }}
      />

      {/* ─── 2. Warm Bronze Pedestal Illumination Pool ──────────────────────── */}
      {/* Broad diffuse bronze radiance */}
      <div
        className="absolute pointer-events-none rounded-[50%]"
        style={{
          width: "140%",
          height: "36%",
          left: "46.64%",
          top: "94.8%",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(ellipse 50% 46% at 50% 48%, rgba(225, 165, 75, 0.20) 0%, rgba(190, 125, 45, 0.13) 28%, rgba(145, 85, 25, 0.05) 55%, transparent 75%)",
        }}
      />

      {/* Warm core glow directly surrounding the pedestal base */}
      <div
        className="absolute pointer-events-none rounded-[50%]"
        style={{
          width: "84%",
          height: "22%",
          left: "46.64%",
          top: "95.2%",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(ellipse 50% 45% at 50% 50%, rgba(240, 185, 95, 0.25) 0%, rgba(205, 140, 55, 0.14) 35%, rgba(150, 90, 30, 0.04) 65%, transparent 80%)",
        }}
      />

      {/* ─── 3. Unified High-Precision Presentation Surface & Rings SVG ──────── */}
      <svg
        viewBox="0 0 1000 360"
        className="absolute pointer-events-none select-none overflow-visible"
        style={{
          width: "235%",
          height: "auto",
          left: "46.64%",
          top: "94.2%",
          transform: "translate(-50%, -50%)",
        }}
      >
        <defs>
          {/* Radial mask that naturally lights the rings from the pedestal glow */}
          <radialGradient id="globe-ground-rings-lighting" cx="49%" cy="53%" r="48%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.88" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="0.74" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.45" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>

          {/* Antique gold/bronze ring gradients */}
          <linearGradient id="globe-gold-bright" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f5cf8e" stopOpacity="0.58" />
            <stop offset="45%" stopColor="#d8a658" stopOpacity="0.40" />
            <stop offset="100%" stopColor="#9c6b2a" stopOpacity="0.20" />
          </linearGradient>

          <linearGradient id="globe-gold-subtle" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#dca85c" stopOpacity="0.34" />
            <stop offset="60%" stopColor="#a7732d" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#6e4616" stopOpacity="0.09" />
          </linearGradient>

          {/* Primary horizontal light streak gradient */}
          <linearGradient id="globe-streak-primary" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#c8913c" stopOpacity="0" />
            <stop offset="15%" stopColor="#c8913c" stopOpacity="0.03" />
            <stop offset="38%" stopColor="#f0be64" stopOpacity="0.26" />
            <stop offset="52%" stopColor="#ffe199" stopOpacity="0.44" />
            <stop offset="64%" stopColor="#dca046" stopOpacity="0.22" />
            <stop offset="85%" stopColor="#aa6e23" stopOpacity="0.03" />
            <stop offset="100%" stopColor="#aa6e23" stopOpacity="0" />
          </linearGradient>

          {/* Secondary softer foreground sheen gradient */}
          <linearGradient id="globe-streak-secondary" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#b4782d" stopOpacity="0" />
            <stop offset="20%" stopColor="#b4782d" stopOpacity="0.03" />
            <stop offset="42%" stopColor="#d7a04b" stopOpacity="0.15" />
            <stop offset="52%" stopColor="#f0b95f" stopOpacity="0.20" />
            <stop offset="65%" stopColor="#c38737" stopOpacity="0.10" />
            <stop offset="85%" stopColor="#8c5519" stopOpacity="0.02" />
            <stop offset="100%" stopColor="#8c5519" stopOpacity="0" />
          </linearGradient>

          {/* Rear floor sheen gradient */}
          <linearGradient id="globe-streak-rear" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#b48237" stopOpacity="0" />
            <stop offset="25%" stopColor="#b48237" stopOpacity="0.04" />
            <stop offset="50%" stopColor="#d2a04b" stopOpacity="0.11" />
            <stop offset="75%" stopColor="#b48237" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#b48237" stopOpacity="0" />
          </linearGradient>

          {/* Warm pedestal mirror reflection gradient */}
          <radialGradient id="globe-reflection-warm" cx="52%" cy="18%" r="62%">
            <stop offset="0%" stopColor="#f5cf8e" stopOpacity="0.40" />
            <stop offset="32%" stopColor="#d8a658" stopOpacity="0.22" />
            <stop offset="68%" stopColor="#9c6b2a" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#9c6b2a" stopOpacity="0" />
          </radialGradient>

          {/* Specular brass rim glint reflection gradient */}
          <radialGradient id="globe-reflection-glint" cx="50%" cy="20%" r="52%">
            <stop offset="0%" stopColor="#ffe6ad" stopOpacity="0.55" />
            <stop offset="35%" stopColor="#f5cf8e" stopOpacity="0.28" />
            <stop offset="70%" stopColor="#d8a658" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#d8a658" stopOpacity="0" />
          </radialGradient>

          {/* Soft glint for astronomical ring nodes */}
          <radialGradient id="globe-node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe8b8" stopOpacity="0.65" />
            <stop offset="40%" stopColor="#f5cf8e" stopOpacity="0.30" />
            <stop offset="75%" stopColor="#d8a658" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#d8a658" stopOpacity="0" />
          </radialGradient>

          <mask id="globe-ground-rings-mask">
            <ellipse
              cx="500"
              cy="180"
              rx="490"
              ry="135"
              fill="url(#globe-ground-rings-lighting)"
            />
          </mask>
        </defs>

        {/* ─── 3A. Rear Horizontal Floor Sheen ───────────────────────────────── */}
        <ellipse
          cx="500"
          cy="172"
          rx="260"
          ry="3.5"
          fill="url(#globe-streak-rear)"
        />

        {/* ─── 3B. Astronomical Engraved Rings ───────────────────────────────── */}
        <g mask="url(#globe-ground-rings-mask)">
          {/* Concentric Ring 1: Tight accent ring just outside pedestal base */}
          <ellipse
            cx="500"
            cy="180"
            rx="174"
            ry="43.5"
            fill="none"
            stroke="url(#globe-gold-bright)"
            strokeWidth="1"
          />

          {/* Concentric Ring 1b: Inner compass dial track with fine tick dashes */}
          <ellipse
            cx="500"
            cy="180"
            rx="188"
            ry="47"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.75"
            strokeDasharray="2 4"
          />

          {/* Concentric Ring 2: Accent coordinate ring */}
          <ellipse
            cx="500"
            cy="180"
            rx="224"
            ry="56"
            fill="none"
            stroke="url(#globe-gold-bright)"
            strokeWidth="1.1"
          />

          {/* Concentric Ring 2b: Azimuth degree indicators */}
          <ellipse
            cx="500"
            cy="180"
            rx="232"
            ry="58"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.85"
            strokeDasharray="1.5 5"
          />

          {/* Concentric Ring 3: Main astrolabe ring with double track */}
          <ellipse
            cx="500"
            cy="180"
            rx="282"
            ry="70.5"
            fill="none"
            stroke="url(#globe-gold-bright)"
            strokeWidth="1.2"
          />
          <ellipse
            cx="500"
            cy="180"
            rx="289"
            ry="72.25"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.75"
          />

          {/* Concentric Ring 4: Celestial coordinate dashed ring */}
          <ellipse
            cx="500"
            cy="180"
            rx="355"
            ry="88.75"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.85"
            strokeDasharray="14 8 3 8"
          />

          {/* Concentric Ring 5: Outer astronomical orbit ring */}
          <ellipse
            cx="500"
            cy="180"
            rx="435"
            ry="108.75"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.6"
          />

          {/* Astrolabe intersecting orbital arcs (from visual reference) */}
          <ellipse
            cx="455"
            cy="172"
            rx="300"
            ry="78"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.85"
            strokeDasharray="10 6"
          />
          <ellipse
            cx="430"
            cy="188"
            rx="270"
            ry="70"
            fill="none"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.75"
          />

          {/* Radial azimuth / celestial spoke lines with perspective compression */}
          <line
            x1="312.1"
            y1="162.9"
            x2="86.5"
            y2="142.4"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
            strokeDasharray="4 3"
          />
          <line
            x1="358.6"
            y1="144.6"
            x2="188.9"
            y2="102.2"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="431.6"
            y1="133.0"
            x2="349.5"
            y2="76.6"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="568.4"
            y1="133.0"
            x2="650.5"
            y2="76.6"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="653.2"
            y1="147.9"
            x2="837.0"
            y2="109.3"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="693.2"
            y1="167.1"
            x2="925.0"
            y2="151.5"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
            strokeDasharray="4 3"
          />
          <line
            x1="681.3"
            y1="201.1"
            x2="880.6"
            y2="224.4"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="628.6"
            y1="218.3"
            x2="757.1"
            y2="256.6"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="400.0"
            y1="223.3"
            x2="300.0"
            y2="266.6"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />
          <line
            x1="318.7"
            y1="201.1"
            x2="101.2"
            y2="226.5"
            stroke="url(#globe-gold-subtle)"
            strokeWidth="0.65"
          />

          {/* Soft warm celestial bokeh nodes on the rings */}
          <circle cx="410" cy="242" r="5.5" fill="url(#globe-node-glow)" />
          <circle cx="500" cy="252" r="6" fill="url(#globe-node-glow)" />
          <circle cx="605" cy="245" r="6" fill="url(#globe-node-glow)" />
          <circle cx="276" cy="180" r="4.5" fill="url(#globe-node-glow)" />
          <circle cx="724" cy="180" r="4.5" fill="url(#globe-node-glow)" />
        </g>

        {/* ─── 3C. Primary Horizontal Floor Light Streak ──────────────────────── */}
        <ellipse
          cx="500"
          cy="220.5"
          rx="380"
          ry="2.4"
          fill="url(#globe-streak-primary)"
        />

        {/* ─── 3D. Secondary Wider Foreground Sheen Streak ────────────────────── */}
        <ellipse
          cx="500"
          cy="236"
          rx="460"
          ry="6"
          fill="url(#globe-streak-secondary)"
        />

        {/* ─── 3E. Soft Warm Reflection Directly Beneath Stand Base Rim ───────── */}
        {/* Soft inverted bronze reflection hugging the bottom lip of the pedestal */}
        <ellipse
          cx="500"
          cy="221"
          rx="150"
          ry="18"
          fill="url(#globe-reflection-warm)"
        />

        {/* Specular brass rim glint reflection under the bright right facet */}
        <ellipse
          cx="576"
          cy="219"
          rx="48"
          ry="11"
          fill="url(#globe-reflection-glint)"
        />
      </svg>
    </div>
  );
}
