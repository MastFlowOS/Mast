import { useId } from "react";

interface GlobeStandProps {
  width: number;
  height: number;
  cx: number;
  cy: number;
  r: number;
  tiltAngleDeg?: number;
}

const DEG = Math.PI / 180;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const f = (n: number) => n.toFixed(2);

/**
 * Antique desk-globe cradle, modelled directly on the reference photograph:
 *
 *   - graduated meridian band entering at the NORTH pin, wrapping the RIGHT
 *     hemisphere, sweeping UNDER the sphere and terminating in a rounded knob
 *     at the lower LEFT (same side/orientation as the reference — not mirrored)
 *   - turned baluster column with beaded collars
 *   - wide stepped pedestal with a domed top plate and heavy rolled foot
 *
 * Material: polished premium gold / antique bronze with a mottled rust-patina
 * filter and fine micro-sparkle grain so it reads as a real cast-metal object.
 * The whole assembly is a stationary layer — only the sphere inside it rotates.
 */
export function GlobeStand({
  width,
  height,
  cx,
  cy,
  r,
  tiltAngleDeg = 10.5,
}: GlobeStandProps) {
  const uid = useId().replace(/:/g, "_");

  if (width <= 0 || height <= 0 || r <= 0) return null;

  const tilt = tiltAngleDeg * DEG;

  /* ── Meridian band geometry ───────────────────────────────────────────── */
  const band = clamp(r * 0.096, 9, 20);
  const Rc = r * 1.112; // centreline radius — tight clearance, as in the photo
  const Ro = Rc + band / 2;
  const Ri = Rc - band / 2;

  const px = (R: number, a: number) => cx + R * Math.cos(a);
  const py = (R: number, a: number) => cy + R * Math.sin(a);

  const aN = -90 * DEG + tilt; // north pole / axis pin
  const aS = 90 * DEG + tilt; // south pole bearing
  const aEnd = 154 * DEG; // rounded terminal knob, lower LEFT

  const arcSpan = aEnd - aN; // ~233° — right side + under the sphere
  const largeArc = arcSpan > Math.PI ? 1 : 0;

  const bandPath =
    `M ${f(px(Ro, aN))} ${f(py(Ro, aN))} ` +
    `A ${f(Ro)} ${f(Ro)} 0 ${largeArc} 1 ${f(px(Ro, aEnd))} ${f(py(Ro, aEnd))} ` +
    `L ${f(px(Ri, aEnd))} ${f(py(Ri, aEnd))} ` +
    `A ${f(Ri)} ${f(Ri)} 0 ${largeArc} 0 ${f(px(Ri, aN))} ${f(py(Ri, aN))} Z`;

  const arcStroke = (R: number) =>
    `M ${f(px(R, aN))} ${f(py(R, aN))} ` +
    `A ${f(R)} ${f(R)} 0 ${largeArc} 1 ${f(px(R, aEnd))} ${f(py(R, aEnd))}`;

  /* Graduation notches engraved across the band */
  const ticks: { x1: number; y1: number; x2: number; y2: number; w: number }[] = [];
  for (let d = -76; d <= 152; d += 4) {
    const a = d * DEG;
    if (a < aN + 0.06 || a > aEnd - 0.06) continue;
    const major = Math.round(d) % 20 === 0;
    const inner = Ri + band * 0.1;
    const outer = inner + band * (major ? 0.62 : 0.38);
    ticks.push({
      x1: px(inner, a),
      y1: py(inner, a),
      x2: px(outer, a),
      y2: py(outer, a),
      w: major ? 1.5 : 0.9,
    });
  }

  /* ── Axis pin / finial (north) ────────────────────────────────────────── */
  const pinLen = clamp(r * 0.155, 16, 40);
  const pinR = band * 0.42;
  const pinBaseX = px(r * 0.92, aN);
  const pinBaseY = py(r * 0.92, aN);
  const pinTipX = px(Ro + pinLen, aN);
  const pinTipY = py(Ro + pinLen, aN);
  const finialX = px(Ro + pinLen + band * 0.28, aN);
  const finialY = py(Ro + pinLen + band * 0.28, aN);

  /* ── Vertical layout: collar → column → pedestal ──────────────────────── */
  const arcBottomY = cy + Ro;
  const collarY = arcBottomY - band * 0.3;

  const bottomLimit = height - Math.max(2, height * 0.01);
  const idealStem = r * 0.3;
  const idealBase = r * 0.44;
  const avail = Math.max(30, bottomLimit - (collarY + band * 0.8));
  const fit = clamp(avail / (idealStem + idealBase), 0.45, 1);

  const stemH = Math.max(16, idealStem * fit);
  const baseH = Math.max(20, idealBase * fit);

  const stemTopY = collarY + band * 0.75;
  const baseTopY = stemTopY + stemH;

  const bw = Math.min(r * 0.68, width * 0.33); // pedestal half-width
  const persp = 0.3; // elliptical foreshortening of the round base

  const stemW = clamp(r * 0.085, 8, 18); // half-width of the column waist

  /* Stacked pedestal tiers (top plate → skirt → rolled foot) */
  const t1rx = bw * 0.93;
  const t2rx = bw * 0.82;
  const t3rx = bw;
  const t1h = baseH * 0.2;
  const t2h = baseH * 0.32;
  const t3h = baseH * 0.36;
  const t1y = baseTopY;
  const t2y = t1y + t1h;
  const t3y = t2y + t2h;
  const baseBottomY = t3y + t3h;

  /** Side wall of a foreshortened cylinder tier. */
  const wall = (rx: number, topY: number, h: number) => {
    const ry = rx * persp;
    return (
      `M ${f(cx - rx)} ${f(topY)} L ${f(cx - rx)} ${f(topY + h)} ` +
      `A ${f(rx)} ${f(ry)} 0 0 0 ${f(cx + rx)} ${f(topY + h)} ` +
      `L ${f(cx + rx)} ${f(topY)} ` +
      `A ${f(rx)} ${f(ry)} 0 0 1 ${f(cx - rx)} ${f(topY)} Z`
    );
  };

  /* Turned baluster column profile */
  const wNeck = stemW * 0.62;
  const wBelly = stemW * 1.15;
  const columnPath =
    `M ${f(cx - wNeck)} ${f(stemTopY)} ` +
    `C ${f(cx - wNeck * 1.05)} ${f(stemTopY + stemH * 0.2)}, ${f(cx - wBelly)} ${f(stemTopY + stemH * 0.3)}, ${f(cx - wBelly)} ${f(stemTopY + stemH * 0.5)} ` +
    `C ${f(cx - wBelly)} ${f(stemTopY + stemH * 0.7)}, ${f(cx - stemW * 0.8)} ${f(stemTopY + stemH * 0.82)}, ${f(cx - stemW * 1.02)} ${f(stemTopY + stemH)} ` +
    `L ${f(cx + stemW * 1.02)} ${f(stemTopY + stemH)} ` +
    `C ${f(cx + stemW * 0.8)} ${f(stemTopY + stemH * 0.82)}, ${f(cx + wBelly)} ${f(stemTopY + stemH * 0.7)}, ${f(cx + wBelly)} ${f(stemTopY + stemH * 0.5)} ` +
    `C ${f(cx + wBelly)} ${f(stemTopY + stemH * 0.3)}, ${f(cx + wNeck * 1.05)} ${f(stemTopY + stemH * 0.2)}, ${f(cx + wNeck)} ${f(stemTopY)} Z`;

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none select-none overflow-visible z-10"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        {/* Polished gold across the meridian band — grazing light from upper left */}
        <linearGradient
          id={`${uid}-bandMetal`}
          x1={cx - Ro}
          y1={cy - Ro}
          x2={cx + Ro}
          y2={cy + Ro}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#c9ab72" />
          <stop offset="12%" stopColor="#9c7734" />
          <stop offset="26%" stopColor="#53381a" />
          <stop offset="40%" stopColor="#8f6b2d" />
          <stop offset="52%" stopColor="#dcc389" />
          <stop offset="63%" stopColor="#7d5a24" />
          <stop offset="78%" stopColor="#36220e" />
          <stop offset="90%" stopColor="#6a4a1e" />
          <stop offset="100%" stopColor="#2a1a0b" />
        </linearGradient>

        {/* Specular rim catching the light along the outer edge of the band */}
        <linearGradient
          id={`${uid}-rimLight`}
          x1={cx}
          y1={cy - Ro}
          x2={cx + Ro}
          y2={cy + Ro}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="rgba(243,226,178,0.62)" />
          <stop offset="34%" stopColor="rgba(228,202,144,0.46)" />
          <stop offset="70%" stopColor="rgba(166,124,58,0.26)" />
          <stop offset="100%" stopColor="rgba(96,64,26,0.15)" />
        </linearGradient>

        {/* Cylindrical shading for column + pedestal walls */}
        <linearGradient
          id={`${uid}-turnedMetal`}
          x1={cx - bw}
          y1={0}
          x2={cx + bw}
          y2={0}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#1d1208" />
          <stop offset="9%" stopColor="#4a3014" />
          <stop offset="22%" stopColor="#8b6529" />
          <stop offset="31%" stopColor="#dcc086" />
          <stop offset="40%" stopColor="#a17930" />
          <stop offset="55%" stopColor="#5e401b" />
          <stop offset="68%" stopColor="#412c12" />
          <stop offset="82%" stopColor="#3a2512" />
          <stop offset="100%" stopColor="#150d05" />
        </linearGradient>

        {/* Column is narrower — its own tighter cylindrical ramp */}
        <linearGradient
          id={`${uid}-columnMetal`}
          x1={cx - stemW * 1.2}
          y1={0}
          x2={cx + stemW * 1.2}
          y2={0}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#1a1007" />
          <stop offset="14%" stopColor="#573a18" />
          <stop offset="30%" stopColor="#957033" />
          <stop offset="40%" stopColor="#dfc68f" />
          <stop offset="54%" stopColor="#825d26" />
          <stop offset="74%" stopColor="#4e3316" />
          <stop offset="100%" stopColor="#150d05" />
        </linearGradient>

        {/* Lit top faces of the pedestal discs */}
        <radialGradient
          id={`${uid}-topFace`}
          cx="38%"
          cy="30%"
          r="78%"
        >
          <stop offset="0%" stopColor="#e4cd9b" />
          <stop offset="28%" stopColor="#bb9750" />
          <stop offset="62%" stopColor="#785527" />
          <stop offset="88%" stopColor="#3c2711" />
          <stop offset="100%" stopColor="#2a1b0c" />
        </radialGradient>

        {/* Small parts: pins, beads, pivots */}
        <linearGradient id={`${uid}-bead`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ecd6a4" />
          <stop offset="34%" stopColor="#b8934d" />
          <stop offset="68%" stopColor="#6b4a1e" />
          <stop offset="100%" stopColor="#2c1b0b" />
        </linearGradient>

        <linearGradient
          id={`${uid}-pinMetal`}
          x1={pinBaseX - pinR}
          y1={pinBaseY}
          x2={pinBaseX + pinR}
          y2={pinBaseY}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#2a1a0a" />
          <stop offset="26%" stopColor="#87632a" />
          <stop offset="46%" stopColor="#e0c894" />
          <stop offset="70%" stopColor="#77551f" />
          <stop offset="100%" stopColor="#231508" />
        </linearGradient>

        <radialGradient id={`${uid}-groundShadow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(0,0,0,0.8)" />
          <stop offset="48%" stopColor="rgba(0,0,0,0.44)" />
          <stop offset="78%" stopColor="rgba(0,0,0,0.14)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>

        {/* Warm light the sphere picks up from the bronze cradle beside it */}
        <linearGradient
          id={`${uid}-bounce`}
          x1={cx + r * 0.9}
          y1={cy - r * 0.9}
          x2={cx + r * 0.2}
          y2={cy + r}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="rgba(198,150,74,0)" />
          <stop offset="26%" stopColor="rgba(214,170,96,0.34)" />
          <stop offset="58%" stopColor="rgba(194,146,76,0.24)" />
          <stop offset="100%" stopColor="rgba(150,106,48,0)" />
        </linearGradient>

        <radialGradient id={`${uid}-castShadow`} cx="50%" cy="46%" r="52%">
          <stop offset="0%" stopColor="rgba(0,0,0,0.62)" />
          <stop offset="58%" stopColor="rgba(0,0,0,0.34)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>

        <filter id={`${uid}-softBlur`} x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation={Math.max(1.6, r * 0.028)} />
        </filter>

        {/* Rust patina + micro-sparkle grain: makes the cast metal read as real */}
        <filter
          id={`${uid}-patina`}
          x="-12%"
          y="-12%"
          width="124%"
          height="124%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.055 0.09"
            numOctaves="4"
            seed="13"
            result="corrosion"
          />
          <feColorMatrix
            in="corrosion"
            type="matrix"
            values="0 0 0 0 0.36
                    0 0 0 0 0.18
                    0 0 0 0 0.06
                    0.95 0.6 0 0 -0.4"
            result="rustTint"
          />
          <feComposite in="rustTint" in2="SourceAlpha" operator="in" result="rustMask" />
          <feBlend in="SourceGraphic" in2="rustMask" mode="multiply" result="corroded" />
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            seed="41"
            result="grain"
          />
          <feColorMatrix
            in="grain"
            type="matrix"
            values="0 0 0 0 1
                    0 0 0 0 0.9
                    0 0 0 0 0.62
                    0.26 0.2 0 0 -0.4"
            result="sparkleTint"
          />
          <feComposite in="sparkleTint" in2="SourceAlpha" operator="in" result="sparkleMask" />
          <feBlend in="corroded" in2="sparkleMask" mode="screen" />
        </filter>
      </defs>

      {/* Contact shadow on the desk surface */}
      <ellipse
        cx={cx}
        cy={baseBottomY + 1}
        rx={bw * 1.28}
        ry={Math.max(5, bw * 0.2)}
        fill={`url(#${uid}-groundShadow)`}
      />

      <g filter={`url(#${uid}-patina)`}>
        {/* ── Pedestal: rolled foot → skirt → domed top plate ─────────────── */}
        <path d={wall(t3rx, t3y, t3h)} fill={`url(#${uid}-turnedMetal)`} stroke="#120b04" strokeWidth="0.9" />
        <ellipse cx={cx} cy={t3y} rx={t3rx} ry={t3rx * persp} fill={`url(#${uid}-topFace)`} />

        <path d={wall(t2rx, t2y, t2h)} fill={`url(#${uid}-turnedMetal)`} stroke="#160e05" strokeWidth="0.9" />
        <ellipse cx={cx} cy={t2y} rx={t2rx} ry={t2rx * persp} fill={`url(#${uid}-topFace)`} />

        <path d={wall(t1rx, t1y, t1h)} fill={`url(#${uid}-turnedMetal)`} stroke="#1a1006" strokeWidth="0.9" />
        <ellipse cx={cx} cy={t1y} rx={t1rx} ry={t1rx * persp} fill={`url(#${uid}-topFace)`} />

        {/* Broad polished reflections raking across each tier */}
        <ellipse
          cx={cx - t1rx * 0.3}
          cy={t1y - t1rx * persp * 0.28}
          rx={t1rx * 0.46}
          ry={t1rx * persp * 0.34}
          fill="rgba(240,222,176,0.2)"
        />
        <path
          d={`M ${f(cx - t2rx * 0.72)} ${f(t2y + t2h * 0.48)} Q ${f(cx - t2rx * 0.1)} ${f(t2y + t2h * 0.86)}, ${f(cx + t2rx * 0.48)} ${f(t2y + t2h * 0.5)}`}
          fill="none"
          stroke="rgba(236,215,166,0.3)"
          strokeWidth={Math.max(1.6, t2h * 0.16)}
          strokeLinecap="round"
        />
        <path
          d={`M ${f(cx - t3rx * 0.78)} ${f(t3y + t3h * 0.5)} Q ${f(cx - t3rx * 0.05)} ${f(t3y + t3h * 0.92)}, ${f(cx + t3rx * 0.62)} ${f(t3y + t3h * 0.52)}`}
          fill="none"
          stroke="rgba(232,209,160,0.26)"
          strokeWidth={Math.max(1.6, t3h * 0.15)}
          strokeLinecap="round"
        />
        {/* Crisp gold bevel on every tier lip */}
        <path
          d={`M ${f(cx - t1rx)} ${f(t1y)} A ${f(t1rx)} ${f(t1rx * persp)} 0 0 0 ${f(cx + t1rx)} ${f(t1y)}`}
          fill="none"
          stroke="rgba(238,219,172,0.5)"
          strokeWidth="1.1"
        />
        <path
          d={`M ${f(cx - t2rx)} ${f(t2y)} A ${f(t2rx)} ${f(t2rx * persp)} 0 0 0 ${f(cx + t2rx)} ${f(t2y)}`}
          fill="none"
          stroke="rgba(234,213,164,0.46)"
          strokeWidth="1.1"
        />
        <path
          d={`M ${f(cx - t3rx)} ${f(t3y)} A ${f(t3rx)} ${f(t3rx * persp)} 0 0 0 ${f(cx + t3rx)} ${f(t3y)}`}
          fill="none"
          stroke="rgba(230,209,158,0.42)"
          strokeWidth="1.2"
        />

        {/* ── Turned baluster column ──────────────────────────────────────── */}
        <path d={columnPath} fill={`url(#${uid}-columnMetal)`} stroke="#1c1207" strokeWidth="0.9" />
        {/* Beaded collars on the column */}
        <ellipse
          cx={cx}
          cy={stemTopY + stemH * 0.5}
          rx={stemW * 1.32}
          ry={Math.max(2.4, stemH * 0.08)}
          fill={`url(#${uid}-columnMetal)`}
          stroke="#1c1207"
          strokeWidth="0.8"
        />
        <ellipse
          cx={cx}
          cy={stemTopY + stemH * 0.9}
          rx={stemW * 1.12}
          ry={Math.max(2, stemH * 0.07)}
          fill={`url(#${uid}-columnMetal)`}
          stroke="#1c1207"
          strokeWidth="0.8"
        />
        <path
          d={`M ${f(cx - stemW * 0.42)} ${f(stemTopY + stemH * 0.08)} L ${f(cx - stemW * 0.5)} ${f(stemTopY + stemH * 0.92)}`}
          stroke="rgba(234,214,166,0.4)"
          strokeWidth={Math.max(1.2, stemW * 0.2)}
          strokeLinecap="round"
          fill="none"
        />

        {/* ── Mounting collar where the meridian meets the column ─────────── */}
        <rect
          x={cx - stemW * 1.5}
          y={collarY}
          width={stemW * 3}
          height={band * 0.82}
          rx={band * 0.3}
          fill={`url(#${uid}-columnMetal)`}
          stroke="#1a1006"
          strokeWidth="1"
        />
        <rect
          x={cx - stemW * 1.2}
          y={collarY + band * 0.16}
          width={stemW * 2.4}
          height={Math.max(1.4, band * 0.16)}
          rx={band * 0.08}
          fill="rgba(232,212,164,0.36)"
        />

        {/* ── Graduated meridian band (right hemisphere, wrapping under) ──── */}
        <path d={bandPath} fill={`url(#${uid}-bandMetal)`} stroke="#160e05" strokeWidth="1.1" />

        {/* engraved graduation notches */}
        <g opacity="0.55">
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={f(t.x1)}
              y1={f(t.y1)}
              x2={f(t.x2)}
              y2={f(t.y2)}
              stroke="#1b1107"
              strokeWidth={t.w}
              strokeLinecap="butt"
            />
          ))}
        </g>

        {/* polished bevels top and bottom of the band */}
        <path
          d={arcStroke(Ro - band * 0.1)}
          fill="none"
          stroke={`url(#${uid}-rimLight)`}
          strokeWidth={Math.max(1.4, band * 0.16)}
          strokeLinecap="round"
        />
        <path
          d={arcStroke(Rc + band * 0.02)}
          fill="none"
          stroke="rgba(233,214,168,0.34)"
          strokeWidth={Math.max(1, band * 0.09)}
          strokeLinecap="round"
        />
        <path
          d={arcStroke(Ri + band * 0.08)}
          fill="none"
          stroke="rgba(30,19,8,0.85)"
          strokeWidth={Math.max(1, band * 0.1)}
          strokeLinecap="round"
        />

        {/* rounded terminal knob at the lower-left end of the meridian */}
        <circle
          cx={f(px(Rc, aEnd))}
          cy={f(py(Rc, aEnd))}
          r={band * 0.68}
          fill={`url(#${uid}-bead)`}
          stroke="#170f06"
          strokeWidth="1"
        />
        <circle
          cx={f(px(Rc, aEnd) - band * 0.16)}
          cy={f(py(Rc, aEnd) - band * 0.2)}
          r={band * 0.22}
          fill="rgba(238,220,176,0.5)"
        />

        {/* ── South pole bearing ──────────────────────────────────────────── */}
        <line
          x1={f(px(r * 0.99, aS))}
          y1={f(py(r * 0.99, aS))}
          x2={f(px(Rc, aS))}
          y2={f(py(Rc, aS))}
          stroke="#8a6128"
          strokeWidth={band * 0.3}
          strokeLinecap="round"
        />
        <circle
          cx={f(px(Rc, aS))}
          cy={f(py(Rc, aS))}
          r={band * 0.55}
          fill={`url(#${uid}-bead)`}
          stroke="#170f06"
          strokeWidth="1"
        />

        {/* ── North axis pin + finial ─────────────────────────────────────── */}
        <line
          x1={f(pinBaseX)}
          y1={f(pinBaseY)}
          x2={f(pinTipX)}
          y2={f(pinTipY)}
          stroke={`url(#${uid}-pinMetal)`}
          strokeWidth={pinR * 2}
          strokeLinecap="round"
        />
        <line
          x1={f(pinBaseX)}
          y1={f(pinBaseY)}
          x2={f(pinTipX)}
          y2={f(pinTipY)}
          stroke="rgba(235,216,170,0.42)"
          strokeWidth={Math.max(1, pinR * 0.5)}
          strokeLinecap="round"
        />
        <circle
          cx={f(finialX)}
          cy={f(finialY)}
          r={band * 0.6}
          fill={`url(#${uid}-bead)`}
          stroke="#170f06"
          strokeWidth="1"
        />
        <circle
          cx={f(finialX - band * 0.16)}
          cy={f(finialY - band * 0.18)}
          r={band * 0.2}
          fill="rgba(242,226,184,0.55)"
        />
      </g>

      {/* ── Physical integration layer (painted over the sphere) ──────────── */}
      {/* Bronze bounce light along the limb facing the cradle */}
      <path
        d={`M ${f(px(r * 0.955, -52 * DEG))} ${f(py(r * 0.955, -52 * DEG))} A ${f(r * 0.955)} ${f(r * 0.955)} 0 0 1 ${f(px(r * 0.955, 120 * DEG))} ${f(py(r * 0.955, 120 * DEG))}`}
        fill="none"
        stroke={`url(#${uid}-bounce)`}
        strokeWidth={Math.max(3, r * 0.058)}
        strokeLinecap="round"
        filter={`url(#${uid}-softBlur)`}
      />

      {/* Pole sockets: the axis visibly enters the sphere at both pivots */}
      <ellipse
        cx={f(px(r * 0.97, aN))}
        cy={f(py(r * 0.97, aN))}
        rx={band * 0.5}
        ry={band * 0.3}
        transform={`rotate(${tiltAngleDeg} ${f(px(r * 0.97, aN))} ${f(py(r * 0.97, aN))})`}
        fill="rgba(6,10,22,0.5)"
        filter={`url(#${uid}-softBlur)`}
      />
      <ellipse
        cx={f(px(r * 0.96, aS))}
        cy={f(py(r * 0.96, aS))}
        rx={band * 0.46}
        ry={band * 0.28}
        transform={`rotate(${tiltAngleDeg} ${f(px(r * 0.96, aS))} ${f(py(r * 0.96, aS))})`}
        fill="rgba(6,10,22,0.45)"
        filter={`url(#${uid}-softBlur)`}
      />

      {/* Sphere shadow dropped onto the pedestal plate */}
      <ellipse
        cx={cx}
        cy={t1y + t1rx * persp * 0.06}
        rx={t1rx * 0.74}
        ry={t1rx * persp * 0.7}
        fill={`url(#${uid}-castShadow)`}
      />
    </svg>
  );
}
