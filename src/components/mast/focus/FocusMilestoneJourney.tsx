import React, { useMemo, useState, useEffect } from "react";
import { Check, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MILESTONE_TIERS,
  getTimeOfDayPeriod,
  type GreetingPeriod,
} from "@/lib/focus";
import { MILESTONE_XP_BADGE_ID } from "@/lib/xp-fly";

export type FocusMilestoneJourneyProps = {
  xp: number;
  currentName: string;
  nextName: string | null;
  progressPct?: number;
  leveledUpTier?: string | null;
  period?: GreetingPeriod;
  now?: Date;
  overridePeriod?: GreetingPeriod;
};

export type Point = { x: number; y: number };

export type BezierSegment = {
  p0: Point;
  c0: Point;
  c1: Point;
  p1: Point;
};

// 4 Mountain summits aligned directly with the visual artwork peaks (1024x341):
// Explorer (144, 215) < Prospector (400, 168) < Closer (656, 128) < Rainmaker (911, 85)
export const MOUNTAIN_PEAKS: Point[] = [
  { x: 144, y: 215 }, // Explorer (left pyramid peak near sunrise)
  { x: 400, y: 168 }, // Prospector (center-left sharp peak)
  { x: 656, y: 128 }, // Closer (prominent rocky summit)
  { x: 911, y: 85 },  // Rainmaker (highest alpine summit)
];

// 3 Bézier segments traveling through the natural valleys between the 4 summits
export const MOUNTAIN_SEGMENTS: BezierSegment[] = [
  // Explorer -> Prospector
  {
    p0: { x: 144, y: 215 },
    c0: { x: 215, y: 250 },
    c1: { x: 310, y: 230 },
    p1: { x: 400, y: 168 },
  },
  // Prospector -> Closer
  {
    p0: { x: 400, y: 168 },
    c0: { x: 475, y: 205 },
    c1: { x: 575, y: 195 },
    p1: { x: 656, y: 128 },
  },
  // Closer -> Rainmaker
  {
    p0: { x: 656, y: 128 },
    c0: { x: 730, y: 175 },
    c1: { x: 825, y: 150 },
    p1: { x: 911, y: 85 },
  },
];

export const WAYPOINT_T_VALUES = [0.25, 0.5, 0.75];

export function cubicBezier(p0: Point, c0: Point, c1: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * c0.x + 3 * mt * t2 * c1.x + t2 * t * p1.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * c0.y + 3 * mt * t2 * c1.y + t2 * t * p1.y,
  };
}

// de Casteljau split at t to cleanly divide active and prospective curve segments
export function splitCubicBezier(
  p0: Point,
  c0: Point,
  c1: Point,
  p1: Point,
  t: number
): {
  left: [Point, Point, Point, Point];
  right: [Point, Point, Point, Point];
} {
  const clampedT = Math.max(0, Math.min(1, t));
  const p01 = { x: (1 - clampedT) * p0.x + clampedT * c0.x, y: (1 - clampedT) * p0.y + clampedT * c0.y };
  const p12 = { x: (1 - clampedT) * c0.x + clampedT * c1.x, y: (1 - clampedT) * c0.y + clampedT * c1.y };
  const p23 = { x: (1 - clampedT) * c1.x + clampedT * p1.x, y: (1 - clampedT) * c1.y + clampedT * p1.y };

  const p012 = { x: (1 - clampedT) * p01.x + clampedT * p12.x, y: (1 - clampedT) * p01.y + clampedT * p12.y };
  const p123 = { x: (1 - clampedT) * p12.x + clampedT * p23.x, y: (1 - clampedT) * p12.y + clampedT * p23.y };

  const splitPt = { x: (1 - clampedT) * p012.x + clampedT * p123.x, y: (1 - clampedT) * p012.y + clampedT * p123.y };

  return {
    left: [p0, p01, p012, splitPt],
    right: [splitPt, p123, p23, p1],
  };
}

export function bezierToSvgPath(pts: [Point, Point, Point, Point]): string {
  return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} C ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}, ${pts[2].x.toFixed(1)} ${pts[2].y.toFixed(1)}, ${pts[3].x.toFixed(1)} ${pts[3].y.toFixed(1)}`;
}

// Background environment images matching the 4 time-of-day states
export const PERIOD_IMAGES: Record<GreetingPeriod, { src: string; alt: string }> = {
  morning: {
    src: "/images/focus/mountain-morning.png",
    alt: "Early morning mountain background with sunrise",
  },
  afternoon: {
    src: "/images/focus/mountain-afternoon.png",
    alt: "Afternoon mountain background with daylight peaks",
  },
  evening: {
    src: "/images/focus/mountain-evening.png",
    alt: "Evening sunset mountain background with warm orange sky",
  },
  night: {
    src: "/images/focus/mountain-night.png",
    alt: "Night mountain background with starry sky and moon",
  },
};

export function FocusMilestoneJourney({
  xp,
  currentName,
  nextName,
  period,
  now,
  overridePeriod,
}: FocusMilestoneJourneyProps) {
  // Synchronized time-of-day state (exact match with Focus greeting)
  const [localPeriod, setLocalPeriod] = useState<GreetingPeriod>(() => {
    if (overridePeriod) return overridePeriod;
    if (period) return period;
    return getTimeOfDayPeriod(now ?? new Date());
  });

  useEffect(() => {
    if (overridePeriod) {
      setLocalPeriod(overridePeriod);
      return;
    }
    if (period) {
      setLocalPeriod(period);
      return;
    }
    const update = () => {
      const p = getTimeOfDayPeriod(now ?? new Date());
      setLocalPeriod((curr) => (curr !== p ? p : curr));
    };
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [period, overridePeriod, now]);

  const activePeriod = overridePeriod ?? localPeriod;

  // Resolve current and next tier from MILESTONE_TIERS
  const currentIndex = Math.max(0, MILESTONE_TIERS.findIndex((t) => t.name === currentName));
  const currentTier = MILESTONE_TIERS[currentIndex] ?? MILESTONE_TIERS[0];
  const nextTier = MILESTONE_TIERS.find((t) => t.name === nextName) ?? null;

  // Window of 4 displayed tiers (Explorer, Prospector, Closer, Rainmaker for standard progression)
  const displayTiers = useMemo(() => {
    const maxStart = Math.max(0, MILESTONE_TIERS.length - 4);
    const idealStart = currentIndex > 2 ? currentIndex - 2 : 0;
    const start = Math.min(idealStart, maxStart);
    return MILESTONE_TIERS.slice(start, start + 4);
  }, [currentIndex]);

  const xpRemaining = nextTier ? Math.max(0, nextTier.xpRequired - xp) : 0;
  const targetXp = nextTier ? nextTier.xpRequired : currentTier.xpRequired;

  // Active progression calculation across the 3 route segments
  const { activeSegmentIndex, activeProgressRatio, activePoint } = useMemo(() => {
    let segIdx = 0;
    for (let i = 0; i < 3; i++) {
      const tEnd = displayTiers[i + 1]?.xpRequired ?? Infinity;
      if (xp >= tEnd && i < 2) {
        continue;
      }
      segIdx = i;
      break;
    }

    const tStart = displayTiers[segIdx]?.xpRequired ?? 0;
    const tEnd = displayTiers[segIdx + 1]?.xpRequired ?? (tStart + 100);
    const segRange = Math.max(1, tEnd - tStart);
    const ratio = Math.max(0, Math.min(1, (xp - tStart) / segRange));

    const seg = MOUNTAIN_SEGMENTS[segIdx];
    const point = cubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, ratio);

    return {
      activeSegmentIndex: segIdx,
      activeProgressRatio: ratio,
      activePoint: point,
    };
  }, [displayTiers, xp]);

  return (
    <section
      className="focus-milestone-journey-section animate-fade-up"
      aria-label="Milestone Journey"
    >
      <div className="focus-milestone-canvas-card">
        {/* CARD HEADER */}
        <div className="focus-milestone-card-header">
          <h2 className="focus-milestone-title">MILESTONE JOURNEY</h2>
          <p className="focus-milestone-sub">
            Complete goals, earn XP and climb to the next tier.
          </p>
        </div>

        {/* TERRAIN PROGRESSION SCENE (SVG & Background locked 1:1 together) */}
        <div className="focus-mountain-terrain-stage">
          {/* TIME-OF-DAY MOUNTAIN BACKGROUND ENVIRONMENT */}
          <div className="focus-mountain-environment" aria-hidden="true">
            {(Object.keys(PERIOD_IMAGES) as GreetingPeriod[]).map((p) => {
              const isCurrent = p === activePeriod;
              return (
                <img
                  key={p}
                  src={PERIOD_IMAGES[p].src}
                  alt={PERIOD_IMAGES[p].alt}
                  className={cn(
                    "focus-mountain-bg-img",
                    isCurrent ? "focus-mountain-bg-visible" : "focus-mountain-bg-hidden"
                  )}
                  loading={isCurrent ? "eager" : "lazy"}
                  fetchPriority={isCurrent ? "high" : "low"}
                  decoding="async"
                />
              );
            })}

            {/* Subtle readability scrim: maintains vivid day/evening/night skies while protecting UI contrast */}
            <div className="focus-mountain-readability-scrim" />
          </div>

          <svg
            className="focus-milestone-route-svg"
            viewBox="0 0 1024 341"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              {/* Subtle green drop glow for completed segment */}
              <filter id="greenGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#34d399" floodOpacity="0.45" />
              </filter>
              {/* Subtle accent glow for active trail */}
              <filter id="activeGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#a78bfa" floodOpacity="0.4" />
              </filter>
            </defs>

            {/* ROUTE SEGMENTS */}
            {MOUNTAIN_SEGMENTS.map((seg, sIdx) => {
              const isPastSegment = sIdx < activeSegmentIndex;
              const isActiveSegment = sIdx === activeSegmentIndex;
              const isFutureSegment = sIdx > activeSegmentIndex;

              const fullD = bezierToSvgPath([seg.p0, seg.c0, seg.c1, seg.p1]);

              if (isPastSegment) {
                // Completed segment: solid green route
                return (
                  <path
                    key={`seg-${sIdx}`}
                    d={fullD}
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    filter="url(#greenGlow)"
                    className="focus-path-completed"
                  />
                );
              }

              if (isFutureSegment) {
                // Future/locked segment: dashed muted route
                return (
                  <path
                    key={`seg-${sIdx}`}
                    d={fullD}
                    fill="none"
                    stroke="rgba(255, 255, 255, 0.22)"
                    strokeWidth="1.75"
                    strokeDasharray="4 6"
                    strokeLinecap="round"
                    className="focus-path-future"
                  />
                );
              }

              // Active segment: dynamically split at activeProgressRatio
              const { left, right } = splitCubicBezier(
                seg.p0,
                seg.c0,
                seg.c1,
                seg.p1,
                activeProgressRatio
              );
              const leftD = bezierToSvgPath(left);
              const rightD = bezierToSvgPath(right);

              return (
                <g key={`seg-${sIdx}`} className="focus-active-segment-group">
                  {/* Traversed portion of active segment */}
                  {activeProgressRatio > 0.005 && (
                    <path
                      d={leftD}
                      fill="none"
                      stroke="#c4b5fd"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      filter="url(#activeGlow)"
                      className="focus-path-active-trail"
                    />
                  )}
                  {/* Remaining prospective path to next summit */}
                  <path
                    d={rightD}
                    fill="none"
                    stroke="rgba(255, 255, 255, 0.3)"
                    strokeWidth="1.75"
                    strokeDasharray="4 6"
                    strokeLinecap="round"
                    className="focus-path-prospective"
                  />
                </g>
              );
            })}

            {/* WAYPOINT DOTS ALONG ROUTE */}
            {MOUNTAIN_SEGMENTS.map((seg, sIdx) => {
              const isPastSegment = sIdx < activeSegmentIndex;
              const isActiveSegment = sIdx === activeSegmentIndex;

              return WAYPOINT_T_VALUES.map((tVal, wIdx) => {
                const pt = cubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, tVal);
                const isTraversed =
                  isPastSegment || (isActiveSegment && tVal <= activeProgressRatio);

                let dotColor = "rgba(255, 255, 255, 0.28)";
                let dotRadius = 2.5;

                if (isPastSegment) {
                  dotColor = "#34d399";
                  dotRadius = 3;
                } else if (isActiveSegment && isTraversed) {
                  dotColor = "#c4b5fd";
                  dotRadius = 3.25;
                }

                return (
                  <circle
                    key={`wp-${sIdx}-${wIdx}`}
                    cx={pt.x}
                    cy={pt.y}
                    r={dotRadius}
                    fill={dotColor}
                    className={cn(
                      "focus-waypoint-dot",
                      isTraversed && "focus-waypoint-traversed"
                    )}
                  />
                );
              });
            })}

            {/* ACTIVE PROGRESS BEACON (physically sits at the interpolated coordinates) */}
            {activeProgressRatio > 0 && activeProgressRatio < 1 && (
              <g className="focus-active-progress-beacon">
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r="8.5"
                  fill="rgba(167, 139, 250, 0.2)"
                  stroke="rgba(196, 181, 253, 0.75)"
                  strokeWidth="1.25"
                  className="focus-beacon-pulse"
                />
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r="3.5"
                  fill="#ffffff"
                  className="focus-beacon-core"
                />
              </g>
            )}

            {/* 4 MOUNTAIN SUMMIT NODES & METADATA OVERLAYS */}
            {displayTiers.map((tier, idx) => {
              const peak = MOUNTAIN_PEAKS[idx];
              if (!peak) return null;

              const isPassed = tier.xpRequired < currentTier.xpRequired;
              const isCurrent = tier.id === currentTier.id;
              const isNext = nextTier ? tier.id === nextTier.id : false;
              const isLocked = !isPassed && !isCurrent && !isNext;

              let stateTag = "LOCKED";
              if (isPassed) stateTag = "COMPLETED";
              else if (isCurrent) stateTag = "CURRENT TIER";
              else if (isNext) stateTag = "NEXT TIER";

              return (
                <g key={tier.id} className="focus-summit-node">
                  {/* NODE LABELS: positioned strictly above the peak */}
                  <foreignObject
                    x={peak.x - 70}
                    y={peak.y - 68}
                    width="140"
                    height="50"
                    className="overflow-visible pointer-events-none"
                  >
                    <div
                      className={cn(
                        "w-full flex flex-col items-center gap-0.5 select-none text-center",
                        isPassed && "focus-summit-passed",
                        isCurrent && "focus-summit-current",
                        isNext && "focus-summit-next",
                        isLocked && "focus-summit-locked"
                      )}
                    >
                      <span className="focus-summit-name tracking-tight">{tier.name}</span>
                      <span className="focus-summit-badge font-semibold">{stateTag}</span>
                      <span className="focus-summit-xp font-mono tracking-tight">{tier.xpRequired.toLocaleString()} XP</span>
                    </div>
                  </foreignObject>

                  {/* SUMMIT PIN: mathematically centered directly on the mountain summit at (peak.x, peak.y) */}
                  <g
                    id={isCurrent ? MILESTONE_XP_BADGE_ID : undefined}
                    className={cn(
                      "focus-summit-pin-group cursor-pointer",
                      isPassed && "focus-summit-passed",
                      isCurrent && "focus-summit-current",
                      isNext && "focus-summit-next",
                      isLocked && "focus-summit-locked"
                    )}
                    role="img"
                    aria-label={`${tier.name}: ${stateTag}, ${tier.xpRequired} XP`}
                  >
                    {/* Active aura ring for current summit */}
                    {isCurrent && (
                      <circle
                        cx={peak.x}
                        cy={peak.y}
                        r="18"
                        fill="rgba(139, 92, 246, 0.15)"
                        stroke="rgba(196, 181, 253, 0.45)"
                        strokeWidth="1"
                        className="focus-beacon-pulse"
                      />
                    )}

                    {/* Outer dark summit base */}
                    <circle
                      cx={peak.x}
                      cy={peak.y}
                      r="13"
                      className="focus-summit-circle-svg"
                    />

                    {/* Completed checkmark */}
                    {isPassed && (
                      <path
                        d={`M ${peak.x - 4.5} ${peak.y - 0.5} L ${peak.x - 1} ${peak.y + 3.5} L ${peak.x + 5} ${peak.y - 3.5}`}
                        fill="none"
                        stroke="#34d399"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}

                    {/* Current tier center core */}
                    {isCurrent && (
                      <circle
                        cx={peak.x}
                        cy={peak.y}
                        r="3.5"
                        fill="#ffffff"
                        className="focus-current-core-svg"
                      />
                    )}

                    {/* Next tier center core */}
                    {isNext && (
                      <circle
                        cx={peak.x}
                        cy={peak.y}
                        r="3"
                        fill="#f59e0b"
                        className="focus-next-core-svg"
                      />
                    )}

                    {/* Locked padlock */}
                    {isLocked && (
                      <g transform={`translate(${peak.x - 5}, ${peak.y - 5.5})`}>
                        <rect x="1" y="4.5" width="8" height="6.5" rx="1.5" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.2" />
                        <path d="M 2.5 4.5 V 2.5 A 2.5 2.5 0 0 1 7.5 2.5 V 4.5" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.2" />
                      </g>
                    )}
                  </g>
                </g>
              );
            })}
          </svg>
        </div>

        {/* BOTTOM STATS STRIP */}
        <div className="focus-milestone-stats-strip">
          <div className="focus-stats-col">
            <span className="focus-stats-caption">CURRENT TIER</span>
            <span className="focus-stats-value">{currentName}</span>
          </div>

          <div className="focus-stats-divider" aria-hidden="true" />

          <div className="focus-stats-col">
            <span className="focus-stats-caption">XP PROGRESS</span>
            <span className="focus-stats-value font-mono">
              {xp.toLocaleString()} / {targetXp.toLocaleString()} XP
            </span>
          </div>

          <div className="focus-stats-divider" aria-hidden="true" />

          <div className="focus-stats-col">
            <span className="focus-stats-caption">XP TO NEXT TIER</span>
            <span className="focus-stats-value font-mono focus-stats-highlight">
              {nextTier ? `${xpRemaining.toLocaleString()} XP to ${nextTier.name}` : "Top tier reached"}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        .focus-milestone-journey-section {
          width: 100%;
          margin-bottom: 1.25rem;
          position: relative;
        }

        .focus-milestone-canvas-card {
          position: relative;
          width: 100%;
          background: #090d15;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.6);
        }

        /* ── TIME-OF-DAY MOUNTAIN BACKGROUND ── */
        .focus-mountain-environment {
          position: absolute;
          inset: 0;
          overflow: hidden;
          border-radius: inherit;
          pointer-events: none;
          z-index: 0;
        }

        .focus-mountain-bg-img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: fill;
          opacity: 0;
          transition: opacity 1000ms cubic-bezier(0.4, 0, 0.2, 1);
          will-change: opacity;
        }

        .focus-mountain-bg-visible {
          opacity: 1;
          z-index: 1;
        }

        .focus-mountain-bg-hidden {
          opacity: 0;
          z-index: 0;
        }

        @media (prefers-reduced-motion: reduce) {
          .focus-mountain-bg-img {
            transition: none !important;
          }
        }

        /* Subtle readability scrim: maintains vivid day/evening/night atmosphere without purple gradients */
        .focus-mountain-readability-scrim {
          position: absolute;
          inset: 0;
          z-index: 2;
          background: linear-gradient(
            180deg,
            rgba(10, 14, 23, 0.58) 0%,
            rgba(10, 14, 23, 0.1) 32%,
            rgba(10, 14, 23, 0.1) 60%,
            rgba(10, 14, 23, 0.78) 100%
          );
          pointer-events: none;
        }

        /* ── CARD HEADER ── */
        .focus-milestone-card-header {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .focus-milestone-title {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.95);
          font-family: var(--font-sans, system-ui);
          margin: 0;
        }

        .focus-milestone-sub {
          font-size: 0.8125rem;
          color: rgba(255, 255, 255, 0.55);
          font-weight: 400;
          margin: 0;
        }

        /* ── TERRAIN STAGE ── */
        .focus-mountain-terrain-stage {
          position: relative;
          width: 100%;
          aspect-ratio: 1024 / 341;
        }

        .focus-milestone-route-svg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          overflow: visible;
          z-index: 5;
        }

        .focus-beacon-pulse {
          animation: beaconPulse 2s infinite ease-in-out;
        }

        @keyframes beaconPulse {
          0%, 100% {
            opacity: 0.85;
          }
          50% {
            opacity: 0.35;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .focus-beacon-pulse {
            animation: none !important;
          }
        }

        /* ── SUMMIT LABELS & BADGES ── */
        .focus-summit-name {
          font-size: 0.875rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.95);
          text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95);
          line-height: 1.1;
        }

        .focus-summit-badge {
          font-size: 0.5625rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 2px 7px;
          border-radius: 9999px;
          line-height: 1.1;
          display: inline-block;
        }

        .focus-summit-xp {
          font-size: 0.6875rem;
          font-family: var(--font-mono, monospace);
          color: rgba(255, 255, 255, 0.6);
          text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
          line-height: 1.1;
        }

        /* COMPLETED STATE */
        .focus-summit-passed .focus-summit-name {
          color: rgba(255, 255, 255, 0.9);
        }

        .focus-summit-passed .focus-summit-badge {
          color: #34d399;
          background: rgba(52, 211, 153, 0.16);
          border: 1px solid rgba(52, 211, 153, 0.4);
        }

        /* CURRENT STATE */
        .focus-summit-current .focus-summit-name {
          color: #ffffff;
          font-weight: 700;
        }

        .focus-summit-current .focus-summit-badge {
          color: #c4b5fd;
          background: rgba(139, 92, 246, 0.2);
          border: 1px solid rgba(139, 92, 246, 0.5);
        }

        /* NEXT STATE */
        .focus-summit-next .focus-summit-name {
          color: rgba(255, 255, 255, 0.95);
          font-weight: 600;
        }

        .focus-summit-next .focus-summit-badge {
          color: #f59e0b;
          background: rgba(245, 158, 11, 0.18);
          border: 1px solid rgba(245, 158, 11, 0.45);
        }

        /* LOCKED STATE */
        .focus-summit-locked .focus-summit-name {
          color: rgba(255, 255, 255, 0.85);
        }

        .focus-summit-locked .focus-summit-badge {
          color: rgba(255, 255, 255, 0.65);
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.18);
        }

        /* ── SVG SUMMIT PIN CIRCLES (Physically locked directly on mountain peaks) ── */
        .focus-summit-node,
        .focus-summit-pin-group {
          pointer-events: auto;
          transform: none !important;
        }

        .focus-summit-circle-svg {
          fill: #0f1420;
          stroke: rgba(255, 255, 255, 0.28);
          stroke-width: 1.5;
          transform: none !important;
          transition: stroke 180ms ease, filter 180ms ease, stroke-width 180ms ease;
        }

        .focus-summit-passed .focus-summit-circle-svg {
          stroke: #34d399;
          filter: drop-shadow(0 0 6px rgba(52, 211, 153, 0.4));
        }

        .focus-summit-passed.focus-summit-pin-group:hover .focus-summit-circle-svg {
          stroke: #6ee7b7;
          filter: drop-shadow(0 0 10px rgba(52, 211, 153, 0.75));
        }

        .focus-summit-current .focus-summit-circle-svg {
          stroke: #8b5cf6;
          stroke-width: 2;
          filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.55));
        }

        .focus-summit-current.focus-summit-pin-group:hover .focus-summit-circle-svg {
          stroke: #a78bfa;
          filter: drop-shadow(0 0 14px rgba(139, 92, 246, 0.85));
        }

        .focus-summit-next .focus-summit-circle-svg {
          stroke: #f59e0b;
          filter: drop-shadow(0 0 6px rgba(245, 158, 11, 0.35));
        }

        .focus-summit-next.focus-summit-pin-group:hover .focus-summit-circle-svg {
          stroke: #fbbf24;
          filter: drop-shadow(0 0 10px rgba(245, 158, 11, 0.7));
        }

        .focus-summit-locked .focus-summit-circle-svg {
          stroke: rgba(255, 255, 255, 0.25);
        }

        .focus-summit-locked.focus-summit-pin-group:hover .focus-summit-circle-svg {
          stroke: rgba(255, 255, 255, 0.45);
          filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.25));
        }

        .focus-current-core-svg {
          filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.85));
        }

        /* ── BOTTOM STATS STRIP ── */
        .focus-milestone-stats-strip {
          position: relative;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(9, 13, 21, 0.85);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 1rem 1.75rem;
        }

        .focus-stats-col {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          flex: 1;
        }

        .focus-stats-caption {
          font-size: 0.5625rem;
          font-weight: 700;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.4);
          font-family: var(--font-sans, system-ui);
        }

        .focus-stats-value {
          font-size: 1.0625rem;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.95);
          letter-spacing: -0.01em;
          line-height: 1.2;
        }

        .focus-stats-highlight {
          color: rgba(255, 255, 255, 0.95);
        }

        .focus-stats-divider {
          width: 1px;
          height: 28px;
          background: rgba(255, 255, 255, 0.08);
          margin: 0 1.5rem;
          flex-shrink: 0;
        }

        /* ── RESPONSIVE ADAPTATIONS (Desktop vs Mobile) ── */
        @media (min-width: 960px) {
          .focus-milestone-canvas-card {
            aspect-ratio: 1024 / 341;
            padding: 0;
          }

          .focus-milestone-card-header {
            position: absolute;
            top: 1.5rem;
            left: 1.75rem;
            z-index: 15;
            margin: 0;
          }

          .focus-mountain-terrain-stage {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
            margin: 0;
          }

          .focus-milestone-stats-strip {
            position: absolute;
            bottom: 1.25rem;
            left: 1.5rem;
            right: 1.5rem;
            z-index: 15;
            margin: 0;
          }
        }

        @media (max-width: 959px) {
          .focus-milestone-canvas-card {
            padding: 1rem 0.875rem;
          }

          .focus-milestone-card-header {
            position: static;
            margin-bottom: 0.75rem;
          }

          .focus-mountain-terrain-stage {
            position: relative;
            width: 100%;
            aspect-ratio: 1024 / 341;
            min-height: 150px;
            border-radius: 10px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.08);
            margin-bottom: 0.75rem;
          }

          .focus-milestone-stats-strip {
            position: static;
            width: 100%;
            padding: 0.75rem 0.875rem;
          }

          .focus-summit-name {
            font-size: 0.625rem;
          }

          .focus-summit-badge {
            font-size: 0.4375rem;
            padding: 1px 4px;
            letter-spacing: 0.03em;
          }

          .focus-summit-xp {
            font-size: 0.5rem;
          }

          .focus-stats-caption {
            font-size: 0.5rem;
          }

          .focus-stats-value {
            font-size: 0.8125rem;
          }

          .focus-stats-divider {
            margin: 0 0.5rem;
            height: 20px;
          }
        }

        @media (max-width: 480px) {
          .focus-milestone-stats-strip {
            display: grid;
            grid-template-columns: 1fr;
            gap: 0.5rem;
            padding: 0.75rem;
          }

          .focus-stats-divider {
            display: none;
          }
        }
      `}</style>
    </section>
  );
}
