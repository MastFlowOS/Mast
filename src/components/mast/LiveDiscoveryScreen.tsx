import { useEffect, useMemo, useRef, useState } from "react";
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
import type { DiscoveryLiveState, ScoutLiveState } from "@/discovery/liveDiscoveryState";
import { RegionMark } from "@/components/mast/discover/TargetRegionCard";
import type { DiscoveryMode } from "@/config/plans";

/**
 * MAST — Full 3-Column Live Discovery Workspace.
 *
 * Pure presentation of Task 2's DiscoveryLiveState (via useLiveDiscoveryState)
 * plus the active Search Brief read from the Discover request:
 *   - Left column: Scalable Scout containers (starting at 0, appearing only when
 *     each scout is used, numbered sequentially 1..N in order of appearance) with
 *     worker icons, live status pills, timestamps, and a single-line live feed.
 *   - Center column: "Scanning the web" heading, 3D isometric business-location
 *     map asset with glowing storefront pins, and underneath it the ocean-shaped
 *     target journey asset with the 3D MAST raft sailing toward the island.
 *   - Right column: Compact Delivered and Rejected counters, followed by the
 *     compact Search Brief (Country, Niche, Channels, Discovery Method) and
 *     cancellation control.
 */

export type DiscoverySearchBrief = {
  region?: string;
  niche?: string;
  channels?: readonly string[];
  method?: DiscoveryMode | string;
};

function formatTimestamp(ms?: number): string {
  const d = ms ? new Date(ms) : new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
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

/**
 * Extracts the list of scouts that have actually been used/spawned.
 * Starts at 0 (empty array) when no scouts have started working yet, and scales
 * dynamically as scouts emit events.
 */
function selectUsedScouts(state: DiscoveryLiveState | null): ScoutLiveState[] {
  if (!state) return [];

  if (state.activeScouts && Object.keys(state.activeScouts).length > 0) {
    return Object.values(state.activeScouts).sort((a, b) => a.scoutId - b.scoutId);
  }

  // Fallback for callers/tests that populate `state.scouts` directly without `activeScouts`:
  // only include scouts that have left the initial idle state.
  if (state.scouts) {
    return Object.values(state.scouts)
      .filter((s) => s.status !== "idle" || s.sentence !== "Waiting to start...")
      .sort((a, b) => a.scoutId - b.scoutId);
  }

  return [];
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

/**
 * Compact single-line live-feed Scout container.
 * Uses `displayIndex` (1..N) so that when 1 scout is active it is always labeled
 * `Scout (1)`, when 2 scouts are active they are labeled `Scout (1)` and `Scout (2)`,
 * etc., regardless of which backend worker offset started first.
 */
function ScoutCard({
  scout,
  displayIndex,
  highlighted,
  timestamp,
}: {
  scout: ScoutLiveState;
  displayIndex: number;
  highlighted: boolean;
  timestamp: string;
}) {
  const isActive = scout.status === "active";
  const isFinished = scout.status === "finished";
  const isError = scout.status === "error";

  return (
    <div
      data-testid={`scout-card-${displayIndex}`}
      data-raw-scout-id={scout.scoutId}
      className={cn(
        "relative rounded-xl border px-3 py-2.5 transition-all duration-300",
        highlighted
          ? "border-[#3b82f6]/80 bg-gradient-to-b from-[#122347]/95 to-[#0c1832]/95 shadow-[0_0_22px_-6px_rgba(59,130,246,0.5),inset_0_1px_0_rgba(147,197,253,0.22)]"
          : "border-white/[0.07] bg-[#0c152b]/85 hover:border-white/[0.13]",
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Worker Icon Container */}
        <div
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border transition-colors",
            highlighted
              ? "border-blue-400/40 bg-[#152a54] text-white shadow-[0_0_12px_rgba(59,130,246,0.28)]"
              : "border-white/[0.12] bg-[#101c38] text-slate-200",
          )}
        >
          <ScoutWorkerIcon className="size-4.5" />
        </div>

        {/* Scout Title + Single-Line Live Feed Sentence */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13.5px] font-bold leading-tight tracking-tight text-white">
              Scout ({displayIndex})
            </span>

            {/* Live Status Pill */}
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold leading-none",
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

          {/* Single-Line Live Feed + Timestamp */}
          <div
            data-testid={`scout-feed-${displayIndex}`}
            className="mt-1 flex items-baseline justify-between gap-2"
          >
            <span
              key={scout.sentence}
              className={cn(
                "min-w-0 flex-1 truncate text-[11.5px] font-medium animate-in fade-in duration-200",
                isError
                  ? "text-rose-300"
                  : isFinished
                    ? "text-slate-300"
                    : "text-slate-200/95",
              )}
              title={scout.sentence}
            >
              {isFinished ? (
                <Check className="mr-1 inline size-3 text-emerald-400" />
              ) : null}
              {isError ? (
                <AlertTriangle className="mr-1 inline size-3 text-rose-400" />
              ) : null}
              {scout.sentence}
            </span>

            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-slate-400">
              {timestamp}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Center 3D Isometric Business-Location Map using the reference asset
 * (`/images/discover-isometric-map.png`) with the storefront icon inside the
 * center hero pin, scaled generously to anchor the middle workspace.
 */
function IsometricDiscoveryMap() {
  return (
    <div
      data-testid="discovery-isometric-map"
      className="relative mx-auto -mt-3 -mb-7 w-full max-w-[650px] select-none xl:max-w-[705px]"
    >
      {/* Ambient radial glow behind the 3D map */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-8 inset-y-6 -z-10 rounded-full opacity-80 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at 52% 52%, rgba(37, 99, 235, 0.45), rgba(14, 165, 233, 0.18) 52%, transparent 75%)",
        }}
      />

      <div className="relative w-full">
        <img
          src="/images/discover-isometric-map.png"
          alt="3D isometric business location discovery map"
          className="block h-auto w-full drop-shadow-[0_24px_40px_rgba(0,0,0,0.8)]"
          draggable={false}
        />

        {/* Crisp white storefront icon overlaid at the exact center of the hero map pin */}
        <svg
          viewBox="0 0 1024 682"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <g
            transform="translate(531.5, 272)"
            fill="none"
            stroke="#ffffff"
            strokeWidth="5.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Storefront awning roof */}
            <path d="M -26 -24 H 26 L 33 -8 H -33 Z" fill="rgba(255,255,255,0.08)" />
            {/* Awning scallops */}
            <path d="M -33 -8 A 11 9.5 0 0 0 -11 -8 A 11 9.5 0 0 0 11 -8 A 11 9.5 0 0 0 33 -8" />
            {/* Storefront walls & base */}
            <path d="M -24 -2 V 25 H 24 V -2" />
            <path d="M -29 25 H 29" />
            {/* Shop door / window */}
            <rect x="-9" y="7" width="18" height="18" rx="2" />
          </g>
        </svg>
      </div>
    </div>
  );
}

/**
 * Bottom Ocean-Shaped Target Journey Bar:
 * Built on the uploaded ocean-bar & tropical-island asset (`/images/discover-ocean-bar.png`,
 * 1024x230) and the 3D wooden raft asset (`/images/discover-mast-raft.png`, 833x640).
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
  // Raft travels smoothly along the sea lane from x=462 (0%) to x=696 (100%)
  const raftX = 462 + (clampedPct / 100) * 234;
  const raftY = 122 + Math.sin((clampedPct / 100) * Math.PI * 2) * 3;

  return (
    <div
      data-testid="discovery-target-journey"
      className="relative mx-auto w-full max-w-[880px] select-none xl:max-w-[930px]"
    >
      {/* Ambient ocean bottom glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-10 bottom-1 top-6 -z-10 rounded-full opacity-75 blur-2xl"
        style={{
          background:
            "radial-gradient(ellipse at 55% 65%, rgba(14, 165, 233, 0.34), rgba(37, 99, 235, 0.22) 55%, transparent 80%)",
        }}
      />

      <svg
        viewBox="0 0 1024 230"
        className="h-auto w-full overflow-visible drop-shadow-[0_18px_34px_rgba(0,0,0,0.8)]"
        role="img"
        aria-label={`Target progress: ${delivered} of ${target || 0} opportunities`}
      >
        {/* 1. Uploaded Wave-Shaped Ocean Bar + Palm Tree Island + Counter Pill Asset */}
        <image
          href="/images/discover-ocean-bar.png"
          x="0"
          y="0"
          width="1024"
          height="230"
          preserveAspectRatio="xMidYMid meet"
        />

        {/* 2. LEFT: Target Bullseye Badge & "Target / N Opportunities" */}
        <g transform="translate(104, 136)">
          <circle
            cx="0"
            cy="0"
            r="35"
            fill="#071835"
            stroke="rgba(56, 189, 248, 0.35)"
            strokeWidth="1.6"
          />
          <circle
            cx="0"
            cy="0"
            r="26"
            fill="#0c254d"
            stroke="rgba(56, 189, 248, 0.22)"
            strokeWidth="1.2"
          />
          {/* Target rings */}
          <circle cx="-1" cy="1" r="13.5" fill="none" stroke="#38bdf8" strokeWidth="2.4" />
          <circle cx="-1" cy="1" r="7" fill="none" stroke="#38bdf8" strokeWidth="2.1" />
          <circle cx="-1" cy="1" r="2.5" fill="#7dd3fc" />
          {/* Bullseye arrow */}
          <line
            x1="2.5"
            y1="-2.5"
            x2="13.5"
            y2="-13.5"
            stroke="#7dd3fc"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <polyline
            points="7,-13.5 13.5,-13.5 13.5,-7"
            fill="none"
            stroke="#7dd3fc"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        <text
          x="156"
          y="125"
          fill="#cbd5e1"
          fontSize="16"
          fontWeight="500"
          fontFamily="inherit"
        >
          Target
        </text>
        <text
          x="156"
          y="154"
          fontSize="24"
          fontWeight="800"
          fontFamily="inherit"
        >
          <tspan fill="#38bdf8">{target || "—"}</tspan>
          <tspan fill="#ffffff" fontWeight="700"> Opportunities</tspan>
        </text>

        {/* 3. CENTER: Dashed Sea Route + Waypoint Rings */}
        <path
          d="M 462 155 C 520 146, 558 164, 608 156 C 654 148, 694 160, 746 150"
          fill="none"
          stroke="rgba(226, 232, 240, 0.8)"
          strokeWidth="2.6"
          strokeDasharray="7 8"
          strokeLinecap="round"
        />

        {/* Completed Sea Trail behind the raft */}
        {clampedPct > 0 && (
          <line
            x1="452"
            y1="155"
            x2={raftX}
            y2={raftY + 32}
            stroke="#38bdf8"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        )}

        {/* Waypoint Node 1 (~50% along route) */}
        <g transform="translate(592, 158)">
          <circle
            cx="0"
            cy="0"
            r="9.5"
            fill="#071733"
            stroke={clampedPct >= 50 ? "#38bdf8" : "#f1f5f9"}
            strokeWidth="2.6"
          />
          <circle
            cx="0"
            cy="0"
            r="3.5"
            fill={clampedPct >= 50 ? "#38bdf8" : "transparent"}
          />
        </g>

        {/* Waypoint Node 2 (~80% along route) */}
        <g transform="translate(684, 154)">
          <circle
            cx="0"
            cy="0"
            r="9.5"
            fill="#071733"
            stroke={clampedPct >= 80 ? "#38bdf8" : "#f1f5f9"}
            strokeWidth="2.6"
          />
          <circle
            cx="0"
            cy="0"
            r="3.5"
            fill={clampedPct >= 80 ? "#38bdf8" : "transparent"}
          />
        </g>

        {/* 4. RIGHT: Delivered / Target Counter Text inside the Island's Glowing Pill */}
        <text
          x="844"
          y="172"
          textAnchor="middle"
          fill="#ffffff"
          fontSize="20.5"
          fontWeight="800"
          fontFamily="inherit"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {delivered} / {target || "—"}
        </text>

        {/* 5. THE UPLOADED 3D MAST RAFT ASSET (Animated position along the sea route) */}
        <g
          data-testid="discovery-mast-raft"
          style={{
            transform: `translate(${raftX}px, ${raftY}px)`,
            transition: "transform 600ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <image
            href="/images/discover-mast-raft.png"
            x="-84"
            y="-78"
            width="168"
            height="129"
            preserveAspectRatio="xMidYMid meet"
          />

          {/* Bold "M" Emblem on the Raft Sail */}
          <path
            d="M -4 -14 L -2 -33 L 6.5 -21 L 15 -33 L 17 -14"
            fill="none"
            stroke="#1e293b"
            strokeWidth="3.6"
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
  const rawScouts = useMemo(() => selectUsedScouts(state), [state]);

  // Maintain chronological arrival order so the 1st scout that starts working is
  // always Scout (1), the 2nd is always Scout (2), etc. — never jumping to Scout (3)
  // when only 1 scout is active.
  const arrivalOrderRef = useRef<number[]>([]);
  const scouts = useMemo(() => {
    if (rawScouts.length === 0) {
      arrivalOrderRef.current = [];
      return [];
    }
    const order = arrivalOrderRef.current;
    for (const s of rawScouts) {
      if (!order.includes(s.scoutId)) {
        order.push(s.scoutId);
      }
    }
    const byId = new Map(rawScouts.map((s) => [s.scoutId, s]));
    return order
      .map((id) => byId.get(id))
      .filter((s): s is ScoutLiveState => Boolean(s));
  }, [rawScouts]);

  const delivered = state?.delivered ?? 0;
  const rejected = state?.rejected ?? 0;
  const target = state?.target ?? 0;
  const progressPercent = state?.progressPercent ?? 0;
  const { eyebrow, titleWhite, titleAccent, subtitle } = headerCopy(state);
  const isTerminal = state
    ? state.status === "completed" || state.status === "exhausted" || state.status === "failed"
    : false;

  // Track per-scout last-updated timestamps & most recently active scout for highlight
  const [scoutTimestamps, setScoutTimestamps] = useState<Record<number, string>>({});
  const [lastUpdatedScoutId, setLastUpdatedScoutId] = useState<number | null>(null);
  const prevSentencesRef = useRef<Record<number, string>>({});

  useEffect(() => {
    const timeStr = formatTimestamp(state?.latestEventAt);
    const currentScouts = selectUsedScouts(state);
    let latestId: number | null = null;
    const timestampUpdates: Record<number, string> = {};

    for (const s of currentScouts) {
      const prevSentence = prevSentencesRef.current[s.scoutId];
      if (prevSentence !== s.sentence) {
        prevSentencesRef.current[s.scoutId] = s.sentence;
        timestampUpdates[s.scoutId] = timeStr;
        latestId = s.scoutId;
      }
    }

    if (Object.keys(timestampUpdates).length > 0) {
      setScoutTimestamps((prev) => ({ ...prev, ...timestampUpdates }));
      if (latestId !== null) {
        setLastUpdatedScoutId(latestId);
      }
    }
  }, [state]);

  const activeCount = scouts.filter((s) => s.status === "active").length;
  const activeBadgeText = isTerminal
    ? state?.status === "failed"
      ? "Stopped"
      : "Finished"
    : `${activeCount > 0 ? activeCount : scouts.length} active`;

  const highlightedScoutId: number | undefined =
    scouts.find((s) => s.scoutId === lastUpdatedScoutId && s.status === "active")?.scoutId ??
    scouts.find((s) => s.status === "active")?.scoutId ??
    scouts[0]?.scoutId;

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
      className="relative mx-auto w-full max-w-[1440px] overflow-x-clip px-4 pb-2 pt-2 sm:px-6 lg:px-7"
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
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[276px_minmax(0,1fr)_276px] xl:grid-cols-[296px_minmax(0,1fr)_296px]">
        {/* ── LEFT COLUMN: Dynamic & Scalable Scouts Panel ─────────────────── */}
        <section
          aria-label="Scouts"
          className="rounded-2xl border border-white/[0.08] bg-[#0a1224]/90 p-3 shadow-[0_18px_42px_-12px_rgba(0,0,0,0.75)] backdrop-blur-md"
        >
          <header className="mb-2.5 flex items-center gap-2.5 px-1">
            <h2 className="text-[15px] font-bold tracking-tight text-white">Scouts</h2>
            <span
              data-testid="scouts-active-badge"
              className="rounded-full border border-blue-400/20 bg-[#152342] px-2.5 py-0.5 text-[11px] font-semibold text-blue-200"
            >
              {activeBadgeText}
            </span>
          </header>

          {scouts.length === 0 ? (
            <div
              data-testid="scouts-empty-state"
              className="flex items-center gap-2.5 rounded-xl border border-dashed border-white/[0.08] bg-[#0c152b]/60 px-3 py-3 text-left"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/[0.1] bg-[#101c38] text-slate-400">
                <ScoutWorkerIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-300">
                  {state?.initialization?.active && state?.initialization?.message
                    ? state.initialization.message
                    : "Waiting to start..."}
                </p>
                <p className="mt-0.5 text-[10.5px] text-slate-400/80">
                  Scouts appear automatically when assigned work
                </p>
              </div>
            </div>
          ) : (
            <div className="max-h-[340px] space-y-2 overflow-y-auto pr-0.5">
              {scouts.map((scout, index) => {
                const displayIndex = index + 1;
                const latestTime =
                  scoutTimestamps[scout.scoutId] ?? formatTimestamp(state?.latestEventAt);
                return (
                  <ScoutCard
                    key={scout.scoutId}
                    scout={scout}
                    displayIndex={displayIndex}
                    highlighted={!isTerminal && scout.scoutId === highlightedScoutId}
                    timestamp={latestTime}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* ── CENTER COLUMN: Heading + 3D Isometric Business-Location Map ─── */}
        <section className="flex min-w-0 flex-col items-center pt-0.5 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.34em] text-slate-300/80">
            {eyebrow}
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl xl:text-[36px] xl:leading-[1.1]">
            <span className="text-white">{titleWhite}</span>
            <span className="bg-gradient-to-r from-[#60a5fa] via-[#3b82f6] to-[#2563eb] bg-clip-text text-transparent">
              {titleAccent}
            </span>
          </h1>
          {subtitle && (
            <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-slate-300/85">
              {subtitle}
            </p>
          )}

          <div className="w-full">
            <IsometricDiscoveryMap />
          </div>
        </section>

        {/* ── RIGHT COLUMN: Compact Delivered/Rejected + Search Brief ──────── */}
        <aside className="space-y-2.5">
          {/* Delivered & Rejected Counter Cards */}
          <div className="grid grid-cols-2 gap-2.5">
            <div
              data-testid="discovery-delivered-card"
              className="rounded-xl border border-white/[0.08] bg-[#0a1224]/90 px-3.5 py-2.5 shadow-[0_14px_32px_-12px_rgba(0,0,0,0.7)] backdrop-blur-md"
            >
              <div className="grid size-7 place-items-center rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
                <Check className="size-4" strokeWidth={2.6} />
              </div>
              <div className="mt-2 text-2xl font-extrabold leading-none tabular-nums tracking-tight text-white">
                {delivered}
              </div>
              <div className="mt-1 text-[11px] font-medium text-slate-400">Delivered</div>
            </div>

            <div
              data-testid="discovery-rejected-card"
              className="rounded-xl border border-white/[0.08] bg-[#0a1224]/90 px-3.5 py-2.5 shadow-[0_14px_32px_-12px_rgba(0,0,0,0.7)] backdrop-blur-md"
            >
              <div className="grid size-7 place-items-center rounded-lg border border-rose-500/30 bg-rose-500/15 text-rose-400">
                <X className="size-4" strokeWidth={2.6} />
              </div>
              <div className="mt-2 text-2xl font-extrabold leading-none tabular-nums tracking-tight text-white">
                {rejected}
              </div>
              <div className="mt-1 text-[11px] font-medium text-slate-400">Rejected</div>
            </div>
          </div>

          {/* Compact Search Brief Card */}
          <section
            aria-label="Search Brief"
            data-testid="discovery-search-brief"
            className="rounded-2xl border border-white/[0.08] bg-[#0a1224]/90 px-3.5 py-3 shadow-[0_18px_42px_-12px_rgba(0,0,0,0.75)] backdrop-blur-md"
          >
            <header className="flex items-center gap-2.5 border-b border-white/[0.07] pb-2.5">
              <div className="grid size-7 place-items-center rounded-lg border border-blue-400/30 bg-blue-500/15 text-blue-400">
                <Settings className="size-3.5" />
              </div>
              <h2 className="text-[14px] font-bold tracking-tight text-white">Search Brief</h2>
            </header>

            <dl className="mt-1 divide-y divide-white/[0.06]">
              {/* Country */}
              <div className="flex items-center justify-between gap-2.5 py-2">
                <dt className="flex items-center gap-2 text-[11.5px] font-medium text-slate-300">
                  <MapPin className="size-3.5 shrink-0 text-slate-400" />
                  <span>Country</span>
                </dt>
                <dd
                  className="flex min-w-0 items-center gap-1.5 text-right text-[11.5px] font-semibold text-white"
                  title={regionText}
                >
                  <RegionMark name={primaryCountry} small />
                  <span className="truncate">{primaryCountry}</span>
                  {extraCountries > 0 && (
                    <span className="shrink-0 text-[10.5px] text-slate-400">
                      +{extraCountries}
                    </span>
                  )}
                </dd>
              </div>

              {/* Niche */}
              <div className="flex items-center justify-between gap-2.5 py-2">
                <dt className="flex items-center gap-2 text-[11.5px] font-medium text-slate-300">
                  <Layers className="size-3.5 shrink-0 text-slate-400" />
                  <span>Niche</span>
                </dt>
                <dd
                  className="max-w-[150px] truncate text-right text-[11.5px] font-semibold text-white"
                  title={nicheText}
                >
                  {nicheText}
                </dd>
              </div>

              {/* Channels */}
              <div className="flex items-center justify-between gap-2.5 py-2">
                <dt className="flex items-center gap-2 text-[11.5px] font-medium text-slate-300">
                  <Network className="size-3.5 shrink-0 text-slate-400" />
                  <span>Channels</span>
                </dt>
                <dd className="flex items-center gap-2">
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
                        <Icon className="size-3.5" />
                      </span>
                    );
                  })}
                </dd>
              </div>

              {/* Discovery Method */}
              <div className="flex items-center justify-between gap-2.5 pt-2 pb-0.5">
                <dt className="flex items-center gap-2 text-[11.5px] font-medium text-slate-300">
                  <Zap className="size-3.5 shrink-0 text-slate-400" />
                  <span>Discovery Method</span>
                </dt>
                <dd>
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-400/25 bg-[#122244] px-2 py-0.5 text-[10.5px] font-semibold text-blue-100 shadow-inner">
                    <Radio className="size-3 text-sky-400" />
                    <span>{methodLabel}</span>
                  </span>
                </dd>
              </div>
            </dl>

            {/* Accessible Cancel Search control */}
            {!isTerminal && (
              <div className="mt-2.5 border-t border-white/[0.07] pt-2.5">
                <button
                  type="button"
                  disabled={isCancelling}
                  onClick={onCancel}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11.5px] font-medium text-slate-300 transition-colors hover:border-rose-500/35 hover:bg-rose-500/10 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isCancelling ? "Cancelling..." : "Cancel Search"}
                </button>
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* ── BOTTOM TARGET JOURNEY: Ocean Wave + MAST Raft + Destination Island ── */}
      <div className="-mt-4 lg:-mt-7">
        <TargetJourneyBar
          delivered={delivered}
          target={target}
          progressPercent={progressPercent}
        />
      </div>
    </div>
  );
}
