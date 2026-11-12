import { useEffect, useRef, useState } from "react";
import {
  Check,
  X,
  AlertTriangle,
  MapPin,
  Layers,
  Network,
  Zap,
  Mail,
  Phone,
  Globe,
  Instagram,
  Radio,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiscoveryLiveState, ScoutLiveState, ScoutId } from "@/discovery/liveDiscoveryState";
import { RegionMark } from "@/components/mast/discover/TargetRegionCard";
import type { DiscoveryMode } from "@/config/plans";

/**
 * MAST — Full 3-Column Live Discovery Workspace.
 *
 * Pure presentation of Task 2's DiscoveryLiveState (via useLiveDiscoveryState)
 * plus the active Search Brief read from the Discover request:
 *   - Left column: Individual Scout containers with worker icons, live statuses,
 *     progress bars, timestamps, and independent activity feeds.
 *   - Center column: "Scanning the web" heading, 3D isometric business-location
 *     map with glowing storefront pins, and underneath it the ocean-shaped
 *     target journey with the MAST raft sailing toward the destination island.
 *   - Right column: Compact Delivered and Rejected counters, followed by the
 *     Search Brief (Country, Niche, Channels, Discovery Method) and cancellation.
 */

const SCOUT_IDS: ScoutId[] = [1, 2, 3];

const IDLE_SCOUT: ScoutLiveState = {
  scoutId: 1,
  status: "idle",
  sentence: "Waiting to start...",
};

export type DiscoverySearchBrief = {
  region?: string;
  niche?: string;
  channels?: readonly string[];
  method?: DiscoveryMode | string;
};

type ScoutFeedEntry = {
  id: string;
  sentence: string;
  time: string;
};

function formatTimestamp(ms?: number): string {
  const d = ms ? new Date(ms) : new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function computeScoutProgress(scout: ScoutLiveState, feedLength: number): number {
  if (scout.status === "finished") return 100;
  if (scout.status === "error") return 100;
  const s = scout.sentence.toLowerCase();
  const stepBonus = Math.min(18, Math.max(0, (feedLength - 1) * 4));
  if (scout.status === "idle" || scout.status === "waiting") {
    if (s.includes("preparing") || s.includes("initializing") || s.includes("querying")) {
      return 26;
    }
    return 16;
  }
  if (s.includes("opportunity secured") || s.includes("target reached")) {
    return Math.min(95, 84 + stepBonus);
  }
  if (s.includes("skipping") || s.includes("moving on") || s.includes("snag")) {
    return Math.min(88, 68 + stepBonus);
  }
  if (s.includes("checking") || s.includes("found ")) {
    return Math.min(82, 56 + stepBonus);
  }
  if (s.includes("exploring")) {
    return Math.min(68, 40 + stepBonus);
  }
  return Math.min(75, 45 + stepBonus);
}

function methodDisplayLabel(method?: string): string {
  if (!method || method === "live") return "Live Discovery";
  if (method === "instant_pool") return "Instant Pool";
  if (method === "instant_pool_ranked") return "Ranked Instant";
  return method;
}

function headerCopy(state: DiscoveryLiveState | null): {
  eyebrow: string;
  titleWhite: string;
  titleAccent: string;
  subtitle: string;
} {
  if (!state || state.status === "starting" || state.status === "discovering") {
    const subtitle =
      state?.initialization?.active && state?.initialization?.message
        ? state.initialization.message
        : "Our AI scouts are finding and collecting the best opportunities for you.";
    return {
      eyebrow: "DISCOVERY",
      titleWhite: "Scanning ",
      titleAccent: "the web",
      subtitle,
    };
  }
  if (state.status === "completed") {
    return {
      eyebrow: "DISCOVERY",
      titleWhite: "Discovery ",
      titleAccent: "Complete",
      subtitle: "Target reached 🎯 All requested opportunities have been collected.",
    };
  }
  if (state.status === "exhausted") {
    return {
      eyebrow: "DISCOVERY",
      titleWhite: "Discovery ",
      titleAccent: "Complete",
      subtitle: "We've searched the available opportunities in this scope.",
    };
  }
  return {
    eyebrow: "DISCOVERY",
    titleWhite: "Discovery ",
    titleAccent: "Interrupted",
    subtitle: "Discovery ran into a problem.",
  };
}

/** Hard-hat Scout Worker icon matching the left-panel containers in the reference. */
function ScoutWorkerIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Hard-hat dome & center ridge */}
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0" />
      <path d="M12 4.5v3" />
      {/* Helmet brim */}
      <path d="M5 10h14" />
      {/* Head contour */}
      <path d="M8.5 10v1.5a3.5 3.5 0 0 0 7 0V10" />
      {/* Shoulders & work jacket collar */}
      <path d="M5 19.5c0-2.6 3.1-4.2 7-4.2s7 1.6 7 4.2" />
      <path d="M9.5 15.6 12 18l2.5-2.4" />
    </svg>
  );
}

function ScoutCard({
  scout,
  highlighted,
  timestamp,
  feed,
}: {
  scout: ScoutLiveState;
  highlighted: boolean;
  timestamp: string;
  feed: ScoutFeedEntry[];
}) {
  const isActive = scout.status === "active";
  const isFinished = scout.status === "finished";
  const isError = scout.status === "error";
  const progress = computeScoutProgress(scout, feed.length);

  // Previous feed entries (excluding the current headline sentence so text queries stay unambiguous)
  const previousEntries = feed
    .slice(0, -1)
    .filter((entry) => entry.sentence !== scout.sentence)
    .slice(-2)
    .reverse();

  const contextHint =
    previousEntries.length === 0
      ? scout.areaName
        ? `Sector · ${scout.areaName}`
        : isFinished
          ? "All assigned sectors scanned"
          : isError
            ? "Worker halted"
            : isActive
              ? "Streaming live telemetry"
              : `Worker slot #${scout.scoutId} standing by`
      : null;

  return (
    <div
      data-testid={`scout-card-${scout.scoutId}`}
      className={cn(
        "relative rounded-xl border p-3.5 transition-all duration-300",
        highlighted
          ? "border-[#3b82f6]/75 bg-gradient-to-b from-[#122347]/95 to-[#0c1832]/95 shadow-[0_0_26px_-6px_rgba(59,130,246,0.5),inset_0_1px_0_rgba(147,197,253,0.22)]"
          : "border-white/[0.07] bg-[#0c152b]/85 hover:border-white/[0.13]",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Worker Icon Container */}
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl border transition-colors",
            highlighted
              ? "border-blue-400/40 bg-[#152a54] text-white shadow-[0_0_14px_rgba(59,130,246,0.3)]"
              : "border-white/[0.12] bg-[#101c38] text-slate-200",
          )}
        >
          <ScoutWorkerIcon className="size-5" />
        </div>

        {/* Scout Title, Sentence & Right Telemetry */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14.5px] font-bold tracking-tight text-white">
              Scout ({scout.scoutId})
            </span>

            {/* Live Status Pill */}
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold leading-none",
                isError
                  ? "border-rose-500/30 bg-rose-500/15 text-rose-400"
                  : isFinished
                    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                    : "border-emerald-500/30 bg-emerald-500/15 text-emerald-400",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  isError
                    ? "bg-rose-400"
                    : isFinished
                      ? "bg-emerald-300"
                      : "bg-emerald-400",
                  (isActive || (!isFinished && !isError)) && "animate-pulse",
                )}
              />
              {isError ? "Error" : isFinished ? "Done" : "Live"}
            </span>
          </div>

          {/* Primary Activity Line + Timestamp */}
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span
              key={scout.sentence}
              className={cn(
                "min-w-0 flex-1 truncate text-xs font-medium animate-in fade-in duration-200",
                isError
                  ? "text-rose-300"
                  : isFinished
                    ? "text-slate-300"
                    : "text-slate-200/95",
              )}
              title={scout.sentence}
            >
              {isFinished ? (
                <Check className="mr-1 inline size-3.5 text-emerald-400" />
              ) : null}
              {isError ? (
                <AlertTriangle className="mr-1 inline size-3.5 text-rose-400" />
              ) : null}
              {scout.sentence}
            </span>

            <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
              {timestamp}
            </span>
          </div>

          {/* Scout Progress Bar */}
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#172647]">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                isError
                  ? "bg-gradient-to-r from-rose-600 to-rose-400 shadow-[0_0_10px_rgba(244,63,94,0.6)]"
                  : "bg-gradient-to-r from-[#2563eb] via-[#3b82f6] to-[#38bdf8] shadow-[0_0_12px_rgba(56,189,248,0.75)]",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Independent Activity Feed Trail */}
          <div
            data-testid={`scout-feed-${scout.scoutId}`}
            className="mt-2 space-y-1 border-t border-white/[0.06] pt-1.5"
          >
            {previousEntries.length > 0 ? (
              previousEntries.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 text-[10.5px] text-slate-400/85"
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                    <span className="size-1 shrink-0 rounded-full bg-blue-400/60" />
                    <span className="truncate">{item.sentence}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-500">
                    {item.time}
                  </span>
                </div>
              ))
            ) : (
              <div className="flex items-center justify-between gap-2 text-[10.5px] text-slate-400/75">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <span className="size-1 shrink-0 rounded-full bg-blue-400/50" />
                  <span className="truncate">{contextHint}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-blue-300/60">
                  Feed
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Upright 3D Storefront Map Pin used on the Isometric Business-Location Map. */
function StorefrontPin({
  cx,
  tipY,
  scale = 1,
  isHero = false,
}: {
  cx: number;
  tipY: number;
  scale?: number;
  isHero?: boolean;
}) {
  return (
    <g transform={`translate(${cx}, ${tipY}) scale(${scale})`}>
      {/* Ground contact shadow & neon reflection */}
      <ellipse
        cx="0"
        cy="0"
        rx={isHero ? 26 : 20}
        ry={isHero ? 13 : 10}
        fill="rgba(56, 189, 248, 0.28)"
        filter="url(#iso-soft-glow)"
      />
      <ellipse cx="0" cy="0" rx="8" ry="4" fill="#60a5fa" opacity="0.85" />

      {/* Outer glow behind teardrop */}
      <path
        d="M 0 0 C -12 -18 -34 -38 -34 -60 A 34 34 0 1 1 34 -60 C 34 -38 12 -18 0 0 Z"
        fill="rgba(37, 99, 235, 0.45)"
        filter="url(#iso-pin-glow)"
      />

      {/* Teardrop pin body */}
      <path
        d="M 0 0 C -12 -18 -34 -38 -34 -60 A 34 34 0 1 1 34 -60 C 34 -38 12 -18 0 0 Z"
        fill="url(#iso-pin-body)"
        stroke="url(#iso-pin-rim)"
        strokeWidth={isHero ? "2.4" : "2.2"}
      />

      {/* Inner glossy highlight arc */}
      <circle
        cx="0"
        cy="-60"
        r="25"
        fill="#08152e"
        stroke="rgba(147, 197, 253, 0.28)"
        strokeWidth="1.2"
      />

      {/* White Storefront / Business Icon */}
      <g
        transform="translate(0, -60)"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Awning roof */}
        <path d="M -12 -11 H 12 L 15 -4 H -15 Z" fill="rgba(255,255,255,0.12)" />
        {/* Awning scallops */}
        <path d="M -15 -4 A 5 4.5 0 0 0 -5 -4 A 5 4.5 0 0 0 5 -4 A 5 4.5 0 0 0 15 -4" />
        {/* Shop walls & base */}
        <path d="M -11 -1 V 11 H 11 V -1" />
        <path d="M -14 11 H 14" />
        {/* Door / window */}
        <rect x="-4" y="3" width="8" height="8" rx="1" />
      </g>
    </g>
  );
}

/** Center 3D Isometric Business-Location Map matching the visual reference. */
function IsometricDiscoveryMap({ activeAreaLabel }: { activeAreaLabel?: string }) {
  // Isometric slab rounded polygon path
  const topSlabPath =
    "M 192 26 Q 212 16 242 21 L 605 78 Q 642 84 628 114 L 534 304 Q 518 334 480 327 L 82 254 Q 44 247 62 214 L 168 42 Q 178 29 192 26 Z";

  const bottomWallPath =
    "M 53 234 L 62 214 Q 44 247 82 254 L 480 327 Q 518 334 534 304 L 628 114 Q 635 100 631 90 L 631 108 Q 634 120 626 134 L 534 322 Q 518 352 480 345 L 82 272 Q 46 265 53 234 Z";

  return (
    <div
      data-testid="discovery-isometric-map"
      className="relative mx-auto w-full max-w-[650px] select-none"
    >
      {/* Ambient radial glow behind the 3D map */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-8 inset-y-4 -z-10 rounded-full opacity-75 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at 52% 54%, rgba(37, 99, 235, 0.42), rgba(14, 165, 233, 0.16) 48%, transparent 75%)",
        }}
      />

      <svg
        viewBox="0 0 680 360"
        className="h-auto w-full overflow-visible drop-shadow-[0_28px_40px_rgba(0,0,0,0.75)]"
        role="img"
        aria-label="3D isometric business location discovery map"
      >
        <defs>
          <clipPath id="iso-slab-clip">
            <path d={topSlabPath} />
          </clipPath>

          <linearGradient id="iso-slab-surface" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#09152e" />
            <stop offset="50%" stopColor="#071126" />
            <stop offset="100%" stopColor="#040a18" />
          </linearGradient>

          <linearGradient id="iso-slab-wall" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#081c45" />
            <stop offset="45%" stopColor="#0d2b6b" />
            <stop offset="85%" stopColor="#092052" />
            <stop offset="100%" stopColor="#051230" />
          </linearGradient>

          <linearGradient id="iso-rim-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#60a5fa" />
            <stop offset="35%" stopColor="#38bdf8" />
            <stop offset="70%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#60a5fa" />
          </linearGradient>

          <linearGradient id="iso-river-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#030917" />
            <stop offset="50%" stopColor="#061534" />
            <stop offset="100%" stopColor="#040d21" />
          </linearGradient>

          <linearGradient id="iso-pin-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1d4ed8" />
            <stop offset="45%" stopColor="#0f295e" />
            <stop offset="100%" stopColor="#081738" />
          </linearGradient>

          <linearGradient id="iso-pin-rim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="50%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#60a5fa" />
          </linearGradient>

          <radialGradient id="iso-center-hotspot" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.65" />
            <stop offset="40%" stopColor="#2563eb" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0" />
          </radialGradient>

          <filter id="iso-neon-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="iso-pin-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" />
          </filter>

          <filter id="iso-soft-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* Deep shadow under the 3D board */}
        <path
          d={topSlabPath}
          transform="translate(0, 24)"
          fill="rgba(2, 6, 20, 0.85)"
          filter="url(#iso-pin-glow)"
        />

        {/* 3D Extruded Bottom Wall */}
        <path
          d={bottomWallPath}
          fill="url(#iso-slab-wall)"
          stroke="#1d4ed8"
          strokeWidth="1.5"
        />

        {/* Glowing neon bottom edge highlight */}
        <path
          d="M 55 244 Q 48 265 82 272 L 480 345 Q 518 352 534 322 L 628 130"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2.2"
          opacity="0.75"
          filter="url(#iso-soft-glow)"
        />

        {/* Top Isometric Map Surface & Clipped Street Grid */}
        <g clipPath="url(#iso-slab-clip)">
          <path d={topSlabPath} fill="url(#iso-slab-surface)" />

          {/* Isometric Major & Minor Street Grid */}
          <g stroke="#132852" strokeWidth="1.4" opacity="0.85">
            {/* Axis A streets (top-left to bottom-left parallel) */}
            <line x1="210" y1="15" x2="88" y2="265" />
            <line x1="275" y1="25" x2="152" y2="278" />
            <line x1="340" y1="36" x2="218" y2="290" />
            <line x1="408" y1="46" x2="286" y2="302" />
            <line x1="476" y1="58" x2="354" y2="314" />
            <line x1="545" y1="68" x2="424" y2="326" />
            <line x1="598" y1="78" x2="482" y2="336" />

            {/* Axis B streets (top-left to top-right parallel) */}
            <line x1="160" y1="56" x2="625" y2="128" />
            <line x1="136" y1="98" x2="602" y2="172" />
            <line x1="112" y1="142" x2="576" y2="216" />
            <line x1="86" y1="186" x2="550" y2="262" />
            <line x1="62" y1="228" x2="526" y2="306" />
          </g>

          {/* 3D Isometric City Blocks */}
          <g fill="#0d1e3f" stroke="#183366" strokeWidth="1">
            {/* Left district blocks */}
            <polygon points="198,64 256,73 238,109 180,100" />
            <polygon points="266,75 325,84 307,120 248,111" />
            <polygon points="174,108 232,117 212,154 154,144" />
            <polygon points="242,119 300,128 280,165 222,156" />
            <polygon points="148,152 206,162 186,198 128,188" />
            <polygon points="216,164 274,173 254,210 196,200" />
            <polygon points="122,196 180,206 160,242 102,232" />
            <polygon points="190,208 248,218 228,254 170,244" />

            {/* Center & upper blocks */}
            <polygon points="336,86 396,95 378,131 318,122" />
            <polygon points="406,97 464,106 446,142 388,133" />
            <polygon points="310,130 370,140 350,176 290,166" />

            {/* Right district blocks */}
            <polygon points="518,114 578,124 558,160 498,150" />
            <polygon points="492,158 552,168 532,204 472,194" />
            <polygon points="466,202 526,212 506,248 446,238" />
            <polygon points="440,246 500,256 480,292 420,282" />
            <polygon points="366,236 426,246 406,282 346,272" />
          </g>

          {/* Winding River / Arterial Channel cutting across the map */}
          <path
            d="M 248 318 C 285 268, 355 256, 405 224 C 455 192, 452 132, 522 62"
            fill="none"
            stroke="#1e40af"
            strokeWidth="36"
            strokeLinecap="round"
            opacity="0.45"
          />
          <path
            d="M 248 318 C 285 268, 355 256, 405 224 C 455 192, 452 132, 522 62"
            fill="none"
            stroke="url(#iso-river-grad)"
            strokeWidth="28"
            strokeLinecap="round"
          />
          <path
            d="M 248 318 C 285 268, 355 256, 405 224 C 455 192, 452 132, 522 62"
            fill="none"
            stroke="#2563eb"
            strokeWidth="1.5"
            strokeOpacity="0.55"
          />

          {/* Subtle vignette at the slab edges */}
          <path
            d={topSlabPath}
            fill="none"
            stroke="#040b1c"
            strokeWidth="18"
            opacity="0.55"
          />

          {/* Center Pin Radar / Sonar Pulse Rings on the Map Plane */}
          <g transform="translate(348, 194) rotate(8)">
            <ellipse cx="0" cy="0" rx="115" ry="60" fill="url(#iso-center-hotspot)" />
            <ellipse
              cx="0"
              cy="0"
              rx="88"
              ry="46"
              fill="none"
              stroke="#3b82f6"
              strokeWidth="1.2"
              opacity="0.28"
            />
            <ellipse
              cx="0"
              cy="0"
              rx="64"
              ry="34"
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.5"
              opacity="0.45"
            />
            <ellipse
              cx="0"
              cy="0"
              rx="42"
              ry="22"
              fill="none"
              stroke="#60a5fa"
              strokeWidth="1.8"
              opacity="0.7"
            />
            <ellipse
              cx="0"
              cy="0"
              rx="22"
              ry="11.5"
              fill="rgba(56, 189, 248, 0.25)"
              stroke="#93c5fd"
              strokeWidth="2"
            />
          </g>
        </g>

        {/* Glowing Neon Top Border of the 3D Map Slab */}
        <path
          d={topSlabPath}
          fill="none"
          stroke="url(#iso-rim-grad)"
          strokeWidth="4.5"
          filter="url(#iso-neon-glow)"
          opacity="0.85"
        />
        <path
          d={topSlabPath}
          fill="none"
          stroke="#93c5fd"
          strokeWidth="1.6"
          opacity="0.95"
        />

        {/* 3 Satellite Storefront Pins + 1 Hero Center Storefront Pin */}
        <StorefrontPin cx={238} tipY={98} scale={0.62} />
        <StorefrontPin cx={506} tipY={90} scale={0.62} />
        <StorefrontPin cx={146} tipY={198} scale={0.62} />
        <StorefrontPin cx={348} tipY={194} scale={1.12} isHero />
      </svg>

      {activeAreaLabel && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-sky-400/30 bg-[#08152d]/90 px-3.5 py-1 text-[11px] font-medium text-sky-200 shadow-lg backdrop-blur-sm">
          Scanning · <span className="font-semibold text-white">{activeAreaLabel}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Bottom Ocean-Shaped Target Journey Bar:
 * Wave-contoured ocean vessel where the MAST raft travels along the dashed sea
 * lane toward the tropical island as opportunities are delivered.
 */
function TargetJourneyBar({
  delivered,
  target,
  progressPercent,
}: {
  delivered: number;
  target: number;
  progressPercent: number;
}) {
  const clampedPct = Math.max(0, Math.min(100, progressPercent));
  // Raft travels smoothly along the wave route from x=408 (0%) to x=655 (100%)
  const raftX = 408 + (clampedPct / 100) * 247;
  const raftY = 104 + Math.sin((clampedPct / 100) * Math.PI * 2) * 3.5;

  // Wave-shaped outer container contour matching the reference artwork
  const oceanWaveShape =
    "M 84 36 " +
    "C 165 36, 225 56, 305 52 " +
    "C 365 49, 395 26, 450 28 " +
    "C 505 30, 535 58, 595 54 " +
    "C 655 50, 695 10, 775 10 " +
    "C 865 10, 944 42, 944 92 " +
    "C 944 132, 908 150, 856 150 " +
    "L 84 150 " +
    "C 38 150, 14 126, 14 93 " +
    "C 14 60, 38 36, 84 36 Z";

  return (
    <div
      data-testid="discovery-target-journey"
      className="relative mx-auto w-full max-w-[940px] select-none"
    >
      {/* Ambient ocean bottom glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-10 -bottom-2 top-4 -z-10 rounded-full opacity-70 blur-2xl"
        style={{
          background:
            "radial-gradient(ellipse at 55% 65%, rgba(14, 165, 233, 0.32), rgba(37, 99, 235, 0.2) 55%, transparent 80%)",
        }}
      />

      <svg
        viewBox="0 0 960 162"
        className="h-auto w-full overflow-visible drop-shadow-[0_18px_36px_rgba(0,0,0,0.75)]"
        role="img"
        aria-label={`Target progress: ${delivered} of ${target || 0} opportunities`}
      >
        <defs>
          <clipPath id="ocean-wave-clip">
            <path d={oceanWaveShape} />
          </clipPath>

          <linearGradient id="ocean-bg-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#071329" />
            <stop offset="50%" stopColor="#091b38" />
            <stop offset="100%" stopColor="#071630" />
          </linearGradient>

          <linearGradient id="ocean-water-swell" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0c244a" stopOpacity="0.3" />
            <stop offset="45%" stopColor="#0284c7" stopOpacity="0.38" />
            <stop offset="80%" stopColor="#0369a1" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#0c244a" stopOpacity="0.3" />
          </linearGradient>

          <linearGradient id="ocean-border-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="35%" stopColor="#60a5fa" />
            <stop offset="70%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#7dd3fc" />
          </linearGradient>

          <linearGradient id="raft-sail-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fef3c7" />
            <stop offset="65%" stopColor="#fde68a" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>

          <linearGradient id="island-sand-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fde68a" />
            <stop offset="55%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#b45309" />
          </linearGradient>

          <filter id="ocean-rim-glow" x="-10%" y="-20%" width="120%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Clipped Interior of the Ocean-Shaped Container */}
        <g clipPath="url(#ocean-wave-clip)">
          <path d={oceanWaveShape} fill="url(#ocean-bg-grad)" />

          {/* Deep Ocean Wave Layers along the bottom */}
          <path
            d="M 0 118 C 140 102, 260 132, 410 114 C 560 96, 690 128, 830 110 C 900 100, 940 114, 960 118 L 960 160 L 0 160 Z"
            fill="url(#ocean-water-swell)"
          />
          <path
            d="M 0 132 C 180 118, 320 144, 480 126 C 640 108, 760 138, 960 122 L 960 160 L 0 160 Z"
            fill="#0ea5e9"
            opacity="0.16"
          />

          {/* Subtle water shimmer & foam highlights */}
          <ellipse cx="425" cy="126" rx="75" ry="12" fill="#38bdf8" opacity="0.18" />
          <ellipse cx="775" cy="112" rx="85" ry="18" fill="#38bdf8" opacity="0.24" />
        </g>

        {/* Glowing Wave-Shaped Outer Border */}
        <path
          d={oceanWaveShape}
          fill="none"
          stroke="url(#ocean-border-grad)"
          strokeWidth="3"
          filter="url(#ocean-rim-glow)"
          opacity="0.85"
        />
        <path
          d={oceanWaveShape}
          fill="none"
          stroke="#bae6fd"
          strokeWidth="1.1"
          opacity="0.9"
        />

        {/* 1. LEFT: Target Bullseye Badge & "Target / N Opportunities" */}
        <g transform="translate(76, 94)">
          <circle
            cx="0"
            cy="0"
            r="31"
            fill="#0b1d3a"
            stroke="rgba(56, 189, 248, 0.35)"
            strokeWidth="1.5"
          />
          <circle
            cx="0"
            cy="0"
            r="23"
            fill="#0e274e"
            stroke="rgba(56, 189, 248, 0.2)"
            strokeWidth="1"
          />
          {/* Target rings */}
          <circle cx="-1" cy="1" r="12" fill="none" stroke="#38bdf8" strokeWidth="2.2" />
          <circle cx="-1" cy="1" r="6" fill="none" stroke="#38bdf8" strokeWidth="2" />
          <circle cx="-1" cy="1" r="2.2" fill="#7dd3fc" />
          {/* Bullseye arrow */}
          <line x1="2" y1="-2" x2="12" y2="-12" stroke="#7dd3fc" strokeWidth="2.2" strokeLinecap="round" />
          <polyline points="6,-12 12,-12 12,-6" fill="none" stroke="#7dd3fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>

        <text
          x="124"
          y="85"
          fill="#cbd5e1"
          fontSize="14.5"
          fontWeight="500"
          fontFamily="inherit"
        >
          Target
        </text>
        <text
          x="124"
          y="111"
          fontSize="21"
          fontWeight="800"
          fontFamily="inherit"
        >
          <tspan fill="#38bdf8">{target || "—"}</tspan>
          <tspan fill="#ffffff" fontWeight="700"> Opportunities</tspan>
        </text>

        {/* 2. CENTER: Dashed Sea Route + Waypoint Rings + MAST Raft */}
        {/* Sea Route Curve (ahead dashed) */}
        <path
          d="M 408 106 C 468 96, 515 116, 565 106 C 615 96, 655 112, 706 102"
          fill="none"
          stroke="rgba(226, 232, 240, 0.75)"
          strokeWidth="2.4"
          strokeDasharray="6 7"
          strokeLinecap="round"
        />

        {/* Completed Sea Trail behind the raft */}
        {clampedPct > 0 && (
          <line
            x1="395"
            y1="106"
            x2={raftX}
            y2={raftY + 4}
            stroke="#38bdf8"
            strokeWidth="3"
            strokeLinecap="round"
          />
        )}

        {/* Waypoint Node 1 (~52% along route) */}
        <g transform="translate(546, 108)">
          <circle
            cx="0"
            cy="0"
            r="8.5"
            fill="#081936"
            stroke={clampedPct >= 50 ? "#38bdf8" : "#e2e8f0"}
            strokeWidth="2.4"
          />
          <circle
            cx="0"
            cy="0"
            r="3"
            fill={clampedPct >= 50 ? "#38bdf8" : "transparent"}
          />
        </g>

        {/* Waypoint Node 2 (~82% along route) */}
        <g transform="translate(642, 104)">
          <circle
            cx="0"
            cy="0"
            r="8.5"
            fill="#081936"
            stroke={clampedPct >= 80 ? "#38bdf8" : "#e2e8f0"}
            strokeWidth="2.4"
          />
          <circle
            cx="0"
            cy="0"
            r="3"
            fill={clampedPct >= 80 ? "#38bdf8" : "transparent"}
          />
        </g>

        {/* 3. RIGHT: Tropical Destination Island + Palm Tree + Counter Pill */}
        <g transform="translate(772, 86)">
          {/* Shallow turquoise water rings around island */}
          <ellipse cx="0" cy="20" rx="74" ry="16" fill="#0284c7" opacity="0.35" />
          <ellipse cx="0" cy="18" rx="62" ry="12" fill="#38bdf8" opacity="0.35" />

          {/* Sandy Island Mound */}
          <path
            d="M -56 16 C -48 -4, -22 -12, 4 -12 C 30 -12, 50 -2, 58 16 C 40 22, -40 22, -56 16 Z"
            fill="url(#island-sand-grad)"
          />

          {/* Island Rocks & Tropical Foliage */}
          <ellipse cx="-32" cy="8" rx="10" ry="6" fill="#64748b" />
          <ellipse cx="-24" cy="10" rx="7" ry="4.5" fill="#94a3b8" />
          <ellipse cx="28" cy="9" rx="9" ry="5.5" fill="#64748b" />
          <path d="M -18 4 Q -10 -6 0 3 Q 10 -5 18 4 Z" fill="#15803d" />
          <path d="M -10 5 Q 0 -4 12 5 Z" fill="#22c55e" />

          {/* Curved Palm Tree Trunk */}
          <path
            d="M -2 2 Q 6 -24 2 -48"
            fill="none"
            stroke="#78350f"
            strokeWidth="6.5"
            strokeLinecap="round"
          />
          <path
            d="M -1 2 Q 7 -24 3 -48"
            fill="none"
            stroke="#b45309"
            strokeWidth="3"
            strokeLinecap="round"
          />

          {/* Coconuts */}
          <circle cx="0" cy="-46" r="3.2" fill="#78350f" />
          <circle cx="5" cy="-45" r="3.2" fill="#92400e" />

          {/* Lush Palm Fronds */}
          <path
            d="M 2 -49 C -14 -58, -32 -50, -38 -36 C -24 -44, -10 -44, 2 -49 Z"
            fill="#22c55e"
          />
          <path
            d="M 2 -49 C -8 -66, -24 -68, -34 -58 C -20 -58, -8 -54, 2 -49 Z"
            fill="#4ade80"
          />
          <path
            d="M 2 -49 C 16 -66, 34 -64, 42 -52 C 28 -56, 14 -54, 2 -49 Z"
            fill="#4ade80"
          />
          <path
            d="M 2 -49 C 20 -56, 38 -44, 44 -30 C 30 -40, 16 -42, 2 -49 Z"
            fill="#16a34a"
          />
          <path
            d="M 2 -49 C 0 -68, 12 -74, 22 -68 C 12 -64, 6 -56, 2 -49 Z"
            fill="#86efac"
          />

          {/* Delivered / Target Pill Badge on the front of the island */}
          <g transform="translate(0, 26)">
            <rect
              x="-52"
              y="-18"
              width="104"
              height="36"
              rx="18"
              fill="#08162f"
              stroke="#38bdf8"
              strokeWidth="1.6"
            />
            <text
              x="0"
              y="6"
              textAnchor="middle"
              fill="#ffffff"
              fontSize="16.5"
              fontWeight="700"
              fontFamily="inherit"
            >
              {delivered} / {target || "—"}
            </text>
          </g>
        </g>

        {/* 4. THE MAST WOODEN RAFT (Animated position along the sea route) */}
        <g
          data-testid="discovery-mast-raft"
          style={{
            transform: `translate(${raftX}px, ${raftY}px)`,
            transition: "transform 600ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {/* Foamy water wake beneath the raft */}
          <ellipse cx="0" cy="10" rx="46" ry="10" fill="#38bdf8" opacity="0.32" />
          <path
            d="M -42 12 Q -22 18 0 13 Q 22 18 42 11"
            fill="none"
            stroke="#e0f2fe"
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity="0.85"
          />
          <path
            d="M -32 16 Q -10 21 16 16 Q 30 19 38 15"
            fill="none"
            stroke="#7dd3fc"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.7"
          />

          {/* Wooden Raft Logs (3D isometric angle) */}
          <g transform="translate(0, 4)">
            {/* Cross-beams */}
            <rect x="-28" y="-3" width="56" height="5" rx="2.5" fill="#78350f" />
            {/* 5 lashed cedar logs */}
            {[-24, -12, 0, 12, 24].map((lx, idx) => (
              <g key={idx} transform={`translate(${lx}, ${idx % 2 === 0 ? 0 : 1})`}>
                <rect
                  x="-6"
                  y="-6"
                  width="12"
                  height="14"
                  rx="4"
                  fill="#b45309"
                  stroke="#78350f"
                  strokeWidth="1"
                />
                <rect x="-4" y="-5" width="5" height="11" rx="2" fill="#d97706" />
                <circle cx="0" cy="5" r="3.5" fill="#fbbf24" stroke="#92400e" strokeWidth="1" />
              </g>
            ))}
            {/* Rope lashings */}
            <line x1="-28" y1="1" x2="28" y2="1" stroke="#fde68a" strokeWidth="1.6" strokeDasharray="4 4" />
          </g>

          {/* Wooden Mast Pole */}
          <line x1="-2" y1="-2" x2="-2" y2="-62" stroke="#78350f" strokeWidth="4" strokeLinecap="round" />
          <line x1="-3" y1="-2" x2="-3" y2="-62" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round" />
          {/* Masthead flag/cap */}
          <polygon points="-2,-64 8,-60 -2,-56" fill="#f59e0b" />

          {/* Billowing Square Sail with "M" Emblem */}
          <path
            d="M -22 -54 Q 2 -58 22 -48 C 28 -32, 26 -16, 18 -6 Q -2 -10 -20 -8 C -14 -22, -14 -38, -22 -54 Z"
            fill="url(#raft-sail-grad)"
            stroke="#d97706"
            strokeWidth="1.2"
          />

          {/* Bold "M" Mark on the Sail */}
          <path
            d="M -7 -21 L -5 -38 L 2 -27 L 9 -38 L 11 -21"
            fill="none"
            stroke="#1e293b"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </div>
  );
}

export function LiveDiscoveryScreen({
  state,
  onCancel,
  isCancelling,
  searchBrief,
}: {
  state: DiscoveryLiveState | null;
  onCancel: () => void;
  isCancelling: boolean;
  searchBrief?: DiscoverySearchBrief;
}) {
  const scouts = state
    ? SCOUT_IDS.map((id) => state.scouts[id])
    : SCOUT_IDS.map((id) => ({ ...IDLE_SCOUT, scoutId: id }));

  const delivered = state?.delivered ?? 0;
  const rejected = state?.rejected ?? 0;
  const target = state?.target ?? 0;
  const progressPercent = state?.progressPercent ?? 0;
  const { eyebrow, titleWhite, titleAccent, subtitle } = headerCopy(state);
  const isTerminal = state
    ? state.status === "completed" || state.status === "exhausted" || state.status === "failed"
    : false;

  // Track independent per-scout timestamps and activity feeds as real-time events arrive
  const [scoutFeeds, setScoutFeeds] = useState<Record<ScoutId, ScoutFeedEntry[]>>(() => {
    const initialTime = formatTimestamp(state?.latestEventAt);
    return {
      1: [{ id: "1-init", sentence: scouts[0].sentence, time: initialTime }],
      2: [{ id: "2-init", sentence: scouts[1].sentence, time: initialTime }],
      3: [{ id: "3-init", sentence: scouts[2].sentence, time: initialTime }],
    };
  });
  const [lastUpdatedScoutId, setLastUpdatedScoutId] = useState<ScoutId>(1);
  const seqRef = useRef(0);

  useEffect(() => {
    const timeStr = formatTimestamp(state?.latestEventAt);
    setScoutFeeds((prev) => {
      let changed = false;
      const next: Record<ScoutId, ScoutFeedEntry[]> = { ...prev };
      for (const id of SCOUT_IDS) {
        const s = state ? state.scouts[id] : { ...IDLE_SCOUT, scoutId: id };
        const list = prev[id] ?? [];
        const last = list[list.length - 1];
        if (!last || last.sentence !== s.sentence) {
          seqRef.current += 1;
          next[id] = [
            ...list.slice(-5),
            { id: `${id}-${seqRef.current}`, sentence: s.sentence, time: timeStr },
          ];
          setLastUpdatedScoutId(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state]);

  const activeCount = scouts.filter((s) => s.status === "active").length;
  const activeBadgeText = isTerminal
    ? state?.status === "failed"
      ? "Stopped"
      : "Finished"
    : `${activeCount > 0 ? activeCount : scouts.length} active`;

  const highlightedScoutId: ScoutId =
    scouts.find((s) => s.scoutId === lastUpdatedScoutId && s.status === "active")?.scoutId ??
    scouts.find((s) => s.status === "active")?.scoutId ??
    1;

  const activeAreaLabel = scouts.find((s) => s.areaName)?.areaName;

  // Search Brief values with clean fallbacks
  const regionText = searchBrief?.region?.trim() || "United States";
  const primaryCountry = regionText.split(",")[0]?.trim() || "United States";
  const extraCountries = Math.max(0, regionText.split(",").filter(Boolean).length - 1);
  const nicheText = searchBrief?.niche?.trim() || "All Niches";
  const requestedChannels = searchBrief?.channels ?? ["email", "phone", "website", "instagram"];
  const methodLabel = methodDisplayLabel(searchBrief?.method);

  const channelIcons = [
    { id: "email", label: "Email", Icon: Mail },
    { id: "phone", label: "Phone", Icon: Phone },
    { id: "website", label: "Website", Icon: Globe },
    { id: "instagram", label: "Instagram", Icon: Instagram },
  ] as const;

  return (
    <div
      data-testid="live-discovery-workspace"
      className="relative mx-auto w-full max-w-[1480px] overflow-x-clip px-4 pb-8 pt-5 sm:px-6 lg:px-8"
    >
      {/* Subtle deep-space background atmosphere */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        style={{
          background: [
            "radial-gradient(ellipse 46% 42% at 50% 38%, rgba(29, 78, 216, 0.16), transparent 72%)",
            "radial-gradient(ellipse 35% 30% at 50% 85%, rgba(14, 165, 233, 0.12), transparent 70%)",
          ].join(","),
        }}
      />

      {/* Main Three-Column Discovery Workspace */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[310px_minmax(0,1fr)_310px] xl:grid-cols-[336px_minmax(0,1fr)_336px]">
        {/* ── LEFT COLUMN: Scouts Panel ────────────────────────────────────── */}
        <section
          aria-label="Scouts"
          className="rounded-2xl border border-white/[0.08] bg-[#0a1224]/90 p-4 shadow-[0_22px_50px_-12px_rgba(0,0,0,0.75)] backdrop-blur-md"
        >
          <header className="mb-3.5 flex items-center gap-3 px-1">
            <h2 className="text-lg font-bold tracking-tight text-white">Scouts</h2>
            <span className="rounded-full border border-blue-400/20 bg-[#152342] px-2.5 py-0.5 text-xs font-semibold text-blue-200">
              {activeBadgeText}
            </span>
          </header>

          <div className="space-y-3">
            {scouts.map((scout) => {
              const feed = scoutFeeds[scout.scoutId] ?? [];
              const latestTime =
                feed[feed.length - 1]?.time ?? formatTimestamp(state?.latestEventAt);
              return (
                <ScoutCard
                  key={scout.scoutId}
                  scout={scout}
                  highlighted={!isTerminal && scout.scoutId === highlightedScoutId}
                  timestamp={latestTime}
                  feed={feed}
                />
              );
            })}
          </div>
        </section>

        {/* ── CENTER COLUMN: Heading + 3D Isometric Business-Location Map ─── */}
        <section className="flex min-w-0 flex-col items-center pt-1 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-slate-300/80">
            {eyebrow}
          </p>
          <h1 className="mt-1.5 text-3xl font-extrabold tracking-tight sm:text-4xl xl:text-[42px] xl:leading-[1.1]">
            <span className="text-white">{titleWhite}</span>
            <span className="bg-gradient-to-r from-[#60a5fa] via-[#3b82f6] to-[#2563eb] bg-clip-text text-transparent">
              {titleAccent}
            </span>
          </h1>
          {subtitle && (
            <p className="mt-2.5 max-w-lg text-sm leading-relaxed text-slate-300/85">
              {subtitle}
            </p>
          )}

          <div className="mt-2 w-full">
            <IsometricDiscoveryMap activeAreaLabel={activeAreaLabel} />
          </div>
        </section>

        {/* ── RIGHT COLUMN: Delivered/Rejected Counters + Search Brief ────── */}
        <aside className="space-y-4">
          {/* Delivered & Rejected Counter Cards */}
          <div className="grid grid-cols-2 gap-3.5">
            <div
              data-testid="discovery-delivered-card"
              className="rounded-2xl border border-white/[0.08] bg-[#0a1224]/90 p-4 shadow-[0_18px_40px_-15px_rgba(0,0,0,0.7)] backdrop-blur-md"
            >
              <div className="grid size-9 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
                <Check className="size-5" strokeWidth={2.6} />
              </div>
              <div className="mt-3 text-3xl font-extrabold tabular-nums tracking-tight text-white">
                {delivered}
              </div>
              <div className="mt-1 text-xs font-medium text-slate-400">Delivered</div>
            </div>

            <div
              data-testid="discovery-rejected-card"
              className="rounded-2xl border border-white/[0.08] bg-[#0a1224]/90 p-4 shadow-[0_18px_40px_-15px_rgba(0,0,0,0.7)] backdrop-blur-md"
            >
              <div className="grid size-9 place-items-center rounded-xl border border-rose-500/30 bg-rose-500/15 text-rose-400">
                <X className="size-5" strokeWidth={2.6} />
              </div>
              <div className="mt-3 text-3xl font-extrabold tabular-nums tracking-tight text-white">
                {rejected}
              </div>
              <div className="mt-1 text-xs font-medium text-slate-400">Rejected</div>
            </div>
          </div>

          {/* Search Brief Card */}
          <section
            aria-label="Search Brief"
            data-testid="discovery-search-brief"
            className="rounded-2xl border border-white/[0.08] bg-[#0a1224]/90 p-5 shadow-[0_22px_50px_-12px_rgba(0,0,0,0.75)] backdrop-blur-md"
          >
            <header className="flex items-center gap-3 pb-3.5 border-b border-white/[0.07]">
              <div className="grid size-8 place-items-center rounded-lg border border-blue-400/30 bg-blue-500/15 text-blue-400">
                <Settings className="size-4" />
              </div>
              <h2 className="text-base font-bold tracking-tight text-white">Search Brief</h2>
            </header>

            <dl className="mt-2 divide-y divide-white/[0.06]">
              {/* Country */}
              <div className="flex items-center justify-between gap-3 py-3">
                <dt className="flex items-center gap-2.5 text-xs font-medium text-slate-300">
                  <MapPin className="size-4 shrink-0 text-slate-400" />
                  <span>Country</span>
                </dt>
                <dd
                  className="flex min-w-0 items-center gap-2 text-right text-xs font-semibold text-white"
                  title={regionText}
                >
                  <RegionMark name={primaryCountry} small />
                  <span className="truncate">{primaryCountry}</span>
                  {extraCountries > 0 && (
                    <span className="shrink-0 text-[11px] text-slate-400">
                      +{extraCountries}
                    </span>
                  )}
                </dd>
              </div>

              {/* Niche */}
              <div className="flex items-center justify-between gap-3 py-3">
                <dt className="flex items-center gap-2.5 text-xs font-medium text-slate-300">
                  <Layers className="size-4 shrink-0 text-slate-400" />
                  <span>Niche</span>
                </dt>
                <dd
                  className="max-w-[165px] truncate text-right text-xs font-semibold text-white"
                  title={nicheText}
                >
                  {nicheText}
                </dd>
              </div>

              {/* Channels */}
              <div className="flex items-center justify-between gap-3 py-3">
                <dt className="flex items-center gap-2.5 text-xs font-medium text-slate-300">
                  <Network className="size-4 shrink-0 text-slate-400" />
                  <span>Channels</span>
                </dt>
                <dd className="flex items-center gap-2.5">
                  {channelIcons.map(({ id, label, Icon }) => {
                    const isSelected =
                      requestedChannels.length === 0 || requestedChannels.includes(id);
                    return (
                      <span
                        key={id}
                        title={`${label}${isSelected ? " (selected)" : ""}`}
                        data-channel={id}
                        data-selected={isSelected ? "true" : "false"}
                        className={cn(
                          "transition-opacity",
                          isSelected ? "text-slate-100" : "text-slate-500/35",
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                    );
                  })}
                </dd>
              </div>

              {/* Discovery Method */}
              <div className="flex items-center justify-between gap-3 pt-3 pb-1">
                <dt className="flex items-center gap-2.5 text-xs font-medium text-slate-300">
                  <Zap className="size-4 shrink-0 text-slate-400" />
                  <span>Discovery Method</span>
                </dt>
                <dd>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-400/25 bg-[#122244] px-2.5 py-1 text-[11px] font-semibold text-blue-100 shadow-inner">
                    <Radio className="size-3.5 text-sky-400" />
                    <span>{methodLabel}</span>
                  </span>
                </dd>
              </div>
            </dl>

            {/* Accessible Cancel Search control */}
            {!isTerminal && (
              <div className="mt-4 border-t border-white/[0.07] pt-3.5">
                <button
                  type="button"
                  disabled={isCancelling}
                  onClick={onCancel}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-rose-500/35 hover:bg-rose-500/10 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isCancelling ? "Cancelling..." : "Cancel Search"}
                </button>
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* ── BOTTOM TARGET JOURNEY: Ocean Wave + MAST Raft + Destination Island ── */}
      <div className="-mt-1 lg:-mt-3">
        <TargetJourneyBar
          delivered={delivered}
          target={target}
          progressPercent={progressPercent}
        />
      </div>
    </div>
  );
}
