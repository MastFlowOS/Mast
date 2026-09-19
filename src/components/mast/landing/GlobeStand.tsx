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

  // Meridian ring radius: generous clearance so the blue globe sits comfortably INSIDE
  const ringRadius = r * 1.22;
  const ringThickness = Math.max(9, Math.min(14, r * 0.085));

  // Outer and inner edges of the thick meridian ring
  const R_outer = ringRadius + ringThickness / 2;
  const R_inner = ringRadius - ringThickness / 2;

  // North & South pole positions on the ring
  const N_outer_x = cx + R_outer * sinTilt;
  const N_outer_y = cy - R_outer * cosTilt;
  const S_outer_x = cx - R_outer * sinTilt;
  const S_outer_y = cy + R_outer * cosTilt;

  const N_inner_x = cx + R_inner * sinTilt;
  const N_inner_y = cy - R_inner * cosTilt;
  const S_inner_x = cx - R_inner * sinTilt;
  const S_inner_y = cy + R_inner * cosTilt;

  // North finial geometry
  const northFinialBaseX = cx + (R_outer + 1) * sinTilt;
  const northFinialBaseY = cy - (R_outer + 1) * cosTilt;
  const northFinialTipX = cx + (R_outer + 18) * sinTilt;
  const northFinialTipY = cy - (R_outer + 18) * cosTilt;

  // South pivot hub geometry
  const southPivotHubX = cx - (R_outer + 2) * sinTilt;
  const southPivotHubY = cy + (R_outer + 2) * cosTilt;

  // Cradle arm attachment point on lower meridian arc (angle ~148 degrees)
  const cradleAngle = 148 * (Math.PI / 180);
  const cradleAttachOuterX = cx + (R_outer - 1) * Math.cos(cradleAngle);
  const cradleAttachOuterY = cy + (R_outer - 1) * Math.sin(cradleAngle);

  // Central mounting piece and vertical stem
  const mountY = cy + r * 1.34;
  const stemHeight = Math.max(28, Math.min(42, r * 0.28));
  const stemBottomY = mountY + stemHeight;
  const stemWidth = Math.max(14, Math.min(20, r * 0.12));

  // Base dimensions: large weighted pedestal firmly anchoring the composition
  const baseWidth = Math.max(140, Math.min(195, r * 1.25));
  const baseHalfW = baseWidth / 2;
  const midTierHalfW = baseHalfW * 0.72;
  const topTierHalfW = baseHalfW * 0.44;

  const baseTopY = stemBottomY;
  const baseHeight = 22;
  const baseBottomY = baseTopY + baseHeight;

  // Astronomical degree notches along the meridian ring
  const ticks: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let deg = -75; deg <= 75; deg += 15) {
    const rad = (deg * Math.PI) / 180 - Math.PI / 2 + tiltRad;
    ticks.push({
      x1: cx + (R_inner + 1.5) * Math.cos(rad),
      y1: cy + (R_inner + 1.5) * Math.sin(rad),
      x2: cx + (R_outer - 1.5) * Math.cos(rad),
      y2: cy + (R_outer - 1.5) * Math.sin(rad),
    });
  }

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none select-none overflow-visible z-10"
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        {/* Rich antique bronze gradient for the heavy meridian ring */}
        <linearGradient
          id={`${idPrefix}-bronzeRing`}
          x1={N_outer_x}
          y1={N_outer_y}
          x2={S_outer_x}
          y2={S_outer_y}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#3d2712" />
          <stop offset="20%" stopColor="#694821" />
          <stop offset="42%" stopColor="#a8803b" />
          <stop offset="55%" stopColor="#dfbf6c" />
          <stop offset="70%" stopColor="#966e30" />
          <stop offset="90%" stopColor="#4f3316" />
          <stop offset="100%" stopColor="#2c1a0c" />
        </linearGradient>

        {/* Specular golden edge highlights */}
        <linearGradient
          id={`${idPrefix}-goldBevel`}
          x1={N_outer_x}
          y1={N_outer_y}
          x2={S_outer_x}
          y2={S_outer_y}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="rgba(247, 223, 148, 0.4)" />
          <stop offset="35%" stopColor="rgba(255, 235, 175, 0.95)" />
          <stop offset="65%" stopColor="rgba(215, 178, 102, 0.8)" />
          <stop offset="100%" stopColor="rgba(140, 98, 42, 0.3)" />
        </linearGradient>

        {/* Heavy curved cantilever arm gradient */}
        <linearGradient
          id={`${idPrefix}-cradleArm`}
          x1={cradleAttachOuterX}
          y1={cradleAttachOuterY}
          x2={cx}
          y2={mountY}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#54391b" />
          <stop offset="35%" stopColor="#967033" />
          <stop offset="55%" stopColor="#d8b663" />
          <stop offset="80%" stopColor="#7a5525" />
          <stop offset="100%" stopColor="#3d2712" />
        </linearGradient>

        {/* Turned column stem cylindrical shading */}
        <linearGradient
          id={`${idPrefix}-stemPillar`}
          x1={cx - stemWidth / 2}
          y1={mountY}
          x2={cx + stemWidth / 2}
          y2={mountY}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#2a1b0c" />
          <stop offset="25%" stopColor="#5a3d1b" />
          <stop offset="50%" stopColor="#c7a14e" />
          <stop offset="75%" stopColor="#6e4a22" />
          <stop offset="100%" stopColor="#25160a" />
        </linearGradient>

        {/* Large weighted stepped base tiered shading */}
        <linearGradient
          id={`${idPrefix}-steppedBase`}
          x1={cx - baseHalfW}
          y1={baseTopY}
          x2={cx + baseHalfW}
          y2={baseTopY}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#24170a" />
          <stop offset="18%" stopColor="#4d3417" />
          <stop offset="38%" stopColor="#87622b" />
          <stop offset="50%" stopColor="#cfab59" />
          <stop offset="65%" stopColor="#7d5926" />
          <stop offset="88%" stopColor="#432c13" />
          <stop offset="100%" stopColor="#1e1207" />
        </linearGradient>

        {/* Deep ambient contact shadow underneath the base */}
        <radialGradient
          id={`${idPrefix}-baseShadow`}
          cx="50%"
          cy="50%"
          r="50%"
        >
          <stop offset="0%" stopColor="rgba(0, 0, 0, 0.75)" />
          <stop offset="50%" stopColor="rgba(0, 0, 0, 0.45)" />
          <stop offset="80%" stopColor="rgba(0, 0, 0, 0.15)" />
          <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
        </radialGradient>
      </defs>

      {/* 1. Deep ambient ground contact shadow beneath the wide circular base */}
      <ellipse
        cx={cx}
        cy={baseBottomY + 3}
        rx={baseHalfW * 1.2}
        ry={7}
        fill={`url(#${idPrefix}-baseShadow)`}
      />

      {/* 2. Heavy Stepped Circular Pedestal Base */}
      {/* Tier 1: Upper collar */}
      <rect
        x={cx - topTierHalfW}
        y={baseTopY}
        width={topTierHalfW * 2}
        height="5"
        rx="2"
        fill={`url(#${idPrefix}-steppedBase)`}
        stroke="#1a1006"
        strokeWidth="0.8"
      />
      {/* Golden bevel highlight on upper collar */}
      <line
        x1={cx - topTierHalfW + 2}
        y1={baseTopY + 1}
        x2={cx + topTierHalfW - 2}
        y2={baseTopY + 1}
        stroke="rgba(247, 223, 148, 0.7)"
        strokeWidth="1"
      />

      {/* Tier 2: Middle stepped tier */}
      <rect
        x={cx - midTierHalfW}
        y={baseTopY + 5}
        width={midTierHalfW * 2}
        height="6"
        rx="2.5"
        fill={`url(#${idPrefix}-steppedBase)`}
        stroke="#1a1006"
        strokeWidth="0.8"
      />
      <line
        x1={cx - midTierHalfW + 3}
        y1={baseTopY + 6}
        x2={cx + midTierHalfW - 3}
        y2={baseTopY + 6}
        stroke="rgba(247, 223, 148, 0.65)"
        strokeWidth="1"
      />

      {/* Tier 3: Main wide weighted bottom plinth */}
      <rect
        x={cx - baseHalfW}
        y={baseTopY + 11}
        width={baseWidth}
        height="11"
        rx="3.5"
        fill={`url(#${idPrefix}-steppedBase)`}
        stroke="#120b04"
        strokeWidth="1"
      />
      {/* Broad metallic edge highlight across base plinth */}
      <line
        x1={cx - baseHalfW + 4}
        y1={baseTopY + 12.5}
        x2={cx + baseHalfW - 4}
        y2={baseTopY + 12.5}
        stroke="rgba(255, 235, 175, 0.85)"
        strokeWidth="1.2"
      />

      {/* 3. Substantial Vertical Stem / Pedestal Column */}
      <rect
        x={cx - stemWidth / 2}
        y={mountY + 7}
        width={stemWidth}
        height={stemHeight - 7}
        rx="2"
        fill={`url(#${idPrefix}-stemPillar)`}
        stroke="#1e1307"
        strokeWidth="0.8"
      />
      {/* Turned decorative ring bands on stem */}
      <rect
        x={cx - stemWidth * 0.62}
        y={mountY + 14}
        width={stemWidth * 1.24}
        height="4"
        rx="1.5"
        fill="#c7a14e"
        stroke="#3a2510"
        strokeWidth="0.8"
      />
      <rect
        x={cx - stemWidth * 0.58}
        y={baseTopY - 4}
        width={stemWidth * 1.16}
        height="4"
        rx="1.5"
        fill="#a8803b"
        stroke="#2c1b0c"
        strokeWidth="0.8"
      />

      {/* 4. Heavy Central Mounting Collar / Swivel Piece */}
      <rect
        x={cx - stemWidth * 0.75}
        y={mountY}
        width={stemWidth * 1.5}
        height="7.5"
        rx="2"
        fill={`url(#${idPrefix}-bronzeRing)`}
        stroke="#24170a"
        strokeWidth="0.9"
      />
      <circle
        cx={cx}
        cy={mountY + 3.75}
        r="2"
        fill="#fae392"
      />

      {/* 5. Thick Curved Cantilever Cradle Arm */}
      {/* Outer thick stroke forming the heavy arm body */}
      <path
        d={`M ${cradleAttachOuterX.toFixed(2)} ${cradleAttachOuterY.toFixed(2)} C ${(cradleAttachOuterX + 16).toFixed(2)} ${(cradleAttachOuterY + 34).toFixed(2)}, ${(cx - 32).toFixed(2)} ${(mountY - 6).toFixed(2)}, ${cx.toFixed(2)} ${mountY.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-cradleArm)`}
        strokeWidth="11"
        strokeLinecap="round"
      />
      {/* Inner metallic highlight contour along the arm */}
      <path
        d={`M ${(cradleAttachOuterX + 1).toFixed(2)} ${(cradleAttachOuterY + 1).toFixed(2)} C ${(cradleAttachOuterX + 16).toFixed(2)} ${(cradleAttachOuterY + 32).toFixed(2)}, ${(cx - 30).toFixed(2)} ${(mountY - 6).toFixed(2)}, ${cx.toFixed(2)} ${mountY.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-goldBevel)`}
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.9"
      />

      {/* 6. Substantial Outer Meridian Ring (Thick dimensional band around left hemisphere) */}
      {/* Solid dimensional ring body */}
      <path
        d={`M ${N_outer_x.toFixed(2)} ${N_outer_y.toFixed(2)} A ${R_outer.toFixed(2)} ${R_outer.toFixed(2)} 0 0 0 ${S_outer_x.toFixed(2)} ${S_outer_y.toFixed(2)} L ${S_inner_x.toFixed(2)} ${S_inner_y.toFixed(2)} A ${R_inner.toFixed(2)} ${R_inner.toFixed(2)} 0 0 1 ${N_inner_x.toFixed(2)} ${N_inner_y.toFixed(2)} Z`}
        fill={`url(#${idPrefix}-bronzeRing)`}
        stroke="#1a1006"
        strokeWidth="1"
      />

      {/* Outer edge gold highlight rim */}
      <path
        d={`M ${N_outer_x.toFixed(2)} ${N_outer_y.toFixed(2)} A ${R_outer.toFixed(2)} ${R_outer.toFixed(2)} 0 0 0 ${S_outer_x.toFixed(2)} ${S_outer_y.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-goldBevel)`}
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* Inner edge gold highlight rim */}
      <path
        d={`M ${N_inner_x.toFixed(2)} ${N_inner_y.toFixed(2)} A ${R_inner.toFixed(2)} ${R_inner.toFixed(2)} 0 0 0 ${S_inner_x.toFixed(2)} ${S_inner_y.toFixed(2)}`}
        fill="none"
        stroke={`url(#${idPrefix}-goldBevel)`}
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.85"
      />

      {/* Astronomical degree tick notches along the meridian */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.x1.toFixed(2)}
          y1={t.y1.toFixed(2)}
          x2={t.x2.toFixed(2)}
          y2={t.y2.toFixed(2)}
          stroke="rgba(255, 235, 175, 0.65)"
          strokeWidth="1"
        />
      ))}

      {/* 7. Obvious North Pole Pivot Assembly */}
      {/* Axial axle entering the globe north pole */}
      <line
        x1={(cx + (r * 0.95) * sinTilt).toFixed(2)}
        y1={(cy - (r * 0.95) * cosTilt).toFixed(2)}
        x2={N_outer_x.toFixed(2)}
        y2={N_outer_y.toFixed(2)}
        stroke="#5a3d1b"
        strokeWidth="4"
        strokeLinecap="round"
      />
      {/* Heavy bracket wrapping around the meridian ring */}
      <circle
        cx={(cx + ringRadius * sinTilt).toFixed(2)}
        cy={(cy - ringRadius * cosTilt).toFixed(2)}
        r="7.5"
        fill={`url(#${idPrefix}-bronzeRing)`}
        stroke="#1a1006"
        strokeWidth="1"
      />
      {/* Turned brass finial pin and ornamental top bead */}
      <line
        x1={northFinialBaseX.toFixed(2)}
        y1={northFinialBaseY.toFixed(2)}
        x2={northFinialTipX.toFixed(2)}
        y2={northFinialTipY.toFixed(2)}
        stroke={`url(#${idPrefix}-bronzeRing)`}
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <circle
        cx={northFinialTipX.toFixed(2)}
        cy={northFinialTipY.toFixed(2)}
        r="5.5"
        fill="#dfbf6c"
        stroke="#3d2712"
        strokeWidth="1"
      />

      {/* 8. Obvious South Pole Pivot Assembly */}
      {/* Axial axle entering the globe south pole */}
      <line
        x1={(cx - (r * 0.95) * sinTilt).toFixed(2)}
        y1={(cy + (r * 0.95) * cosTilt).toFixed(2)}
        x2={S_outer_x.toFixed(2)}
        y2={S_outer_y.toFixed(2)}
        stroke="#5a3d1b"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      {/* Heavy lower pivot bearing housing */}
      <circle
        cx={southPivotHubX.toFixed(2)}
        cy={southPivotHubY.toFixed(2)}
        r="8"
        fill={`url(#${idPrefix}-bronzeRing)`}
        stroke="#1a1006"
        strokeWidth="1.2"
      />
      <circle
        cx={southPivotHubX.toFixed(2)}
        cy={southPivotHubY.toFixed(2)}
        r="4"
        fill="#c7a14e"
      />
    </svg>
  );
}
