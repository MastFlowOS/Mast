import { useId } from "react";

interface GlobeStandProps {
  width: number;
  height: number;
  cx: number;
  cy: number;
  r: number;
  tiltAngleDeg?: number;
}

export function GlobeStand({
  width,
  height,
  cx,
  cy,
  r,
  tiltAngleDeg = 10.5,
}: GlobeStandProps) {
  const idPrefix = useId().replace(/:/g, "_");

  if (width <= 0 || height <= 0 || r <= 0) return null;

  const tiltRad = (tiltAngleDeg * Math.PI) / 180;
  const sinTilt = Math.sin(tiltRad);
  const cosTilt = Math.cos(tiltRad);

  // Meridian ring radius (closely framing the globe's atmosphere at 1.055r)
  const Rm = r * 1.075;

  // North and South Pole pivot coordinates along the tilted axis
  const Nx = cx + Rm * sinTilt;
  const Ny = cy - Rm * cosTilt;
  const Sx = cx - Rm * sinTilt;
  const Sy = cy + Rm * cosTilt;

  // North finial tip
  const northFinialTipX = cx + (Rm + 9) * sinTilt;
  const northFinialTipY = cy - (Rm + 9) * cosTilt;

  // South pivot finial tip
  const southFinialTipX = cx - (Rm + 5) * sinTilt;
  const southFinialTipY = cy + (Rm + 5) * cosTilt;

  // Cradle arm attachment point on lower meridian arc (angle ~145 deg)
  const cradleAngle = 145 * (Math.PI / 180);
  const cradleAttachX = cx + Rm * Math.cos(cradleAngle);
  const cradleAttachY = cy + Rm * Math.sin(cradleAngle);

  // Central mounting point & stem geometry
  const mountY = cy + r * 1.15;
  const stemBottomY = cy + r * 1.25;
  const baseTopY = stemBottomY;
  const baseBottomY = baseTopY + 7;

  // Base dimensions scaled responsively
  const baseWidth = Math.max(54, Math.min(84, r * 0.42));
  const baseHalfW = baseWidth / 2;
  const topTierHalfW = baseHalfW * 0.55;

  // Subtle tick mark notches along the outer semi-meridian
  const tickAngles = [-60, -40, -20, 0, 20, 40, 60, 80];
  const ticks = tickAngles.map((deg) => {
    const rad = (deg * Math.PI) / 180 - Math.PI / 2 + tiltRad;
    const x1 = cx + Rm * Math.cos(rad);
    const y1 = cy + Rm * Math.sin(rad);
    const x2 = cx + (Rm + 2.5) * Math.cos(rad);
    const y2 = cy + (Rm + 2.5) * Math.sin(rad);
    return { x1, y1, x2, y2 };
  });

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none select-none overflow-visible"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        {/* Antique Bronze metallic gradient for meridian ring */}
        <linearGradient
          id={`${idPrefix}-bronzeMeridian`}
          x1={Nx}
          y1={Ny}
          x2={Sx}
          y2={Sy}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#4a3318" />
          <stop offset="25%" stopColor="#8c642e" />
          <stop offset="50%" stopColor="#c79f4c" />
          <stop offset="75%" stopColor="#7a5525" />
          <stop offset="100%" stopColor="#35220e" />
        </linearGradient>

        {/* Fine gold specular edge highlight */}
        <linearGradient
          id={`${idPrefix}-goldBevel`}
          x1={Nx}
          y1={Ny}
          x2={Sx}
          y2={Sy}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="rgba(247, 223, 148, 0.4)" />
          <stop offset="45%" stopColor="rgba(247, 223, 148, 0.85)" />
          <stop offset="70%" stopColor="rgba(201, 166, 107, 0.5)" />
          <stop offset="100%" stopColor="rgba(140, 100, 46, 0.2)" />
        </linearGradient>

        {/* Tapered pillar and base gradient */}
        <linearGradient
          id={`${idPrefix}-standBase`}
          x1={cx - baseHalfW}
          y1={baseTopY}
          x2={cx + baseHalfW}
          y2={baseTopY}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#2a1b0d" />
          <stop offset="25%" stopColor="#5c3f1d" />
          <stop offset="50%" stopColor="#a37c39" />
          <stop offset="75%" stopColor="#5c3f1d" />
          <stop offset="100%" stopColor="#221509" />
        </linearGradient>

        {/* Soft ground contact shadow beneath the base */}
        <radialGradient
          id={`${idPrefix}-groundShadow`}
          cx="50%"
          cy="50%"
          r="50%"
        >
          <stop offset="0%" stopColor="rgba(0, 0, 0, 0.55)" />
          <stop offset="60%" stopColor="rgba(0, 0, 0, 0.25)" />
          <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
        </radialGradient>
      </defs>

      {/* 1. Ground contact shadow beneath pedestal base */}
      <ellipse
        cx={cx}
        cy={baseBottomY + 2}
        rx={baseHalfW * 1.25}
        ry={4.5}
        fill={`url(#${idPrefix}-groundShadow)`}
      />

      {/* 2. Outer Semi-Meridian Ring (Framing the left hemisphere from North Pole to South Pole) */}
      <path
        d={`M ${Nx.toFixed(2)} ${Ny.toFixed(2)} A ${Rm.toFixed(2)} ${Rm.toFixed(2)} 0 0 0 ${Sx.toFixed(2)} ${Sy.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-bronzeMeridian)`}
        strokeWidth="2.2"
        strokeLinecap="round"
      />

      {/* Inner specular highlight line along meridian */}
      <path
        d={`M ${Nx.toFixed(2)} ${Ny.toFixed(2)} A ${(Rm - 0.7).toFixed(2)} ${(Rm - 0.7).toFixed(2)} 0 0 0 ${Sx.toFixed(2)} ${Sy.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-goldBevel)`}
        strokeWidth="0.8"
        strokeLinecap="round"
        opacity="0.85"
      />

      {/* Subtle astronomical degree notches along the meridian */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.x1.toFixed(2)}
          y1={t.y1.toFixed(2)}
          x2={t.x2.toFixed(2)}
          y2={t.y2.toFixed(2)}
          stroke="rgba(247, 223, 148, 0.5)"
          strokeWidth="0.75"
        />
      ))}

      {/* 3. North Pole Finial (Axis pin and decorative turned antique bronze bead) */}
      <line
        x1={(cx + (r * 0.99) * sinTilt).toFixed(2)}
        y1={(cy - (r * 0.99) * cosTilt).toFixed(2)}
        x2={northFinialTipX.toFixed(2)}
        y2={northFinialTipY.toFixed(2)}
        stroke={`url(#${idPrefix}-bronzeMeridian)`}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle
        cx={northFinialTipX}
        cy={northFinialTipY}
        r="2.5"
        fill="#c79f4c"
        stroke="#4a3318"
        strokeWidth="0.8"
      />

      {/* 4. South Pole Pivot Bearing */}
      <line
        x1={(cx - (r * 0.99) * sinTilt).toFixed(2)}
        y1={(cy + (r * 0.99) * cosTilt).toFixed(2)}
        x2={southFinialTipX.toFixed(2)}
        y2={southFinialTipY.toFixed(2)}
        stroke={`url(#${idPrefix}-bronzeMeridian)`}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle
        cx={southFinialTipX}
        cy={southFinialTipY}
        r="2.0"
        fill="#8c642e"
        stroke="#35220e"
        strokeWidth="0.6"
      />

      {/* 5. Curved Cantilever Support Arm connecting lower meridian to center mounting point */}
      <path
        d={`M ${cradleAttachX.toFixed(2)} ${cradleAttachY.toFixed(2)} C ${(cradleAttachX + 8).toFixed(2)} ${(cradleAttachY + 16).toFixed(2)}, ${(cx - 20).toFixed(2)} ${(mountY - 4).toFixed(2)}, ${cx.toFixed(2)} ${mountY.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-bronzeMeridian)`}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d={`M ${cradleAttachX.toFixed(2)} ${cradleAttachY.toFixed(2)} C ${(cradleAttachX + 8).toFixed(2)} ${(cradleAttachY + 16).toFixed(2)}, ${(cx - 20).toFixed(2)} ${(mountY - 4).toFixed(2)}, ${cx.toFixed(2)} ${mountY.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-goldBevel)`}
        strokeWidth="0.75"
        strokeLinecap="round"
        opacity="0.7"
      />

      {/* 6. Central Mounting Point / Swivel Collar */}
      <rect
        x={cx - 6}
        y={mountY - 1.5}
        width="12"
        height="3"
        rx="1"
        fill="#c79f4c"
        stroke="#4a3318"
        strokeWidth="0.6"
      />

      {/* 7. Slender Tapered Pedestal Pillar */}
      <polygon
        points={`${(cx - 2).toFixed(2)},${mountY + 1.5} ${(cx + 2).toFixed(2)},${mountY + 1.5} ${(cx + 2.8).toFixed(2)},${stemBottomY} ${(cx - 2.8).toFixed(2)},${stemBottomY}`}
        fill={`url(#${idPrefix}-standBase)`}
        stroke="#2a1b0d"
        strokeWidth="0.5"
      />

      {/* 8. Stepped Pedestal Base */}
      {/* Tier 1 (narrow upper disc) */}
      <rect
        x={cx - topTierHalfW}
        y={baseTopY}
        width={topTierHalfW * 2}
        height="2.5"
        rx="1"
        fill={`url(#${idPrefix}-standBase)`}
        stroke="#35220e"
        strokeWidth="0.5"
      />
      {/* Tier 2 (main base disc) */}
      <rect
        x={cx - baseHalfW}
        y={baseTopY + 2.5}
        width={baseWidth}
        height="4.5"
        rx="2"
        fill={`url(#${idPrefix}-standBase)`}
        stroke="#221509"
        strokeWidth="0.6"
      />
      {/* Base bevel highlight */}
      <line
        x1={cx - baseHalfW + 2}
        y1={baseTopY + 3.2}
        x2={cx + baseHalfW - 2}
        y2={baseTopY + 3.2}
        stroke="rgba(247, 223, 148, 0.65)"
        strokeWidth="0.7"
      />
    </svg>
  );
}
