import { Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiscoveryLiveState, ScoutLiveState, ScoutId } from "@/discovery/liveDiscoveryState";

/**
 * MAST — Live Discovery UI (Task 3 of 3).
 *
 * Pure presentation. Every sentence/status/count rendered here comes
 * straight from Task 2's DiscoveryLiveState (via useLiveDiscoveryState) —
 * this component computes nothing (no second progress calculation, no
 * second sentence mapper, no local counters). `state === null` is the one
 * truthful pre-plan placeholder (before a planId exists yet, e.g. the
 * moment between pressing Discover and the backend's response) and renders
 * the exact same "Getting ready..." neutral copy Task 2's own
 * createInitialLiveDiscoveryState() produces, so there is no visible seam
 * between this placeholder and the first real idle state.
 */

const SCOUT_IDS: ScoutId[] = [1, 2, 3];

const IDLE_SCOUT: ScoutLiveState = { scoutId: 1, status: "idle", sentence: "Getting ready..." };

function scoutDotClasses(status: ScoutLiveState["status"]): string {
  switch (status) {
    case "active":
      return "bg-brand";
    case "finished":
      return "bg-emerald-400";
    case "error":
      return "bg-red-400";
    case "waiting":
      return "bg-muted-foreground/40";
    case "idle":
    default:
      return "bg-muted-foreground/40";
  }
}

function ScoutRow({ scout }: { scout: ScoutLiveState }) {
  const isActive = scout.status === "active";
  const isFinished = scout.status === "finished";
  const isError = scout.status === "error";

  return (
    <div className="flex items-center gap-3 py-2.5 min-w-0">
      <span className="text-sm font-semibold text-foreground shrink-0 w-[68px]">Scout ({scout.scoutId})</span>

      <span className={cn("size-2 rounded-full shrink-0", scoutDotClasses(scout.status), isActive && "animate-pulse")} />

      <span
        key={scout.sentence}
        className={cn(
          "flex-1 min-w-0 truncate text-sm animate-in fade-in slide-in-from-bottom-0.5 duration-300",
          isFinished ? "text-muted-foreground" : isError ? "text-red-400" : "text-foreground/90",
        )}
        title={scout.sentence}
      >
        {isFinished ? <Check className="inline size-3.5 mr-1 text-emerald-400" /> : null}
        {isError ? <AlertTriangle className="inline size-3.5 mr-1 text-red-400" /> : null}
        {scout.sentence}
      </span>

      <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-mono tracking-wide">
        {isActive ? (
          <>
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
            </span>
            <span className="text-brand">LIVE</span>
          </>
        ) : (
          <span className="text-muted-foreground/50">
            {isFinished ? "DONE" : isError ? "ERROR" : "—"}
          </span>
        )}
      </span>
    </div>
  );
}

function headerCopy(state: DiscoveryLiveState | null): { title: string; subtitle: string } {
  if (!state || state.status === "starting" || state.status === "discovering") {
    return { title: "Discovering Opportunities", subtitle: "Find the best businesses for you in real time" };
  }
  if (state.status === "completed") return { title: "Discovery Complete", subtitle: "Target reached 🎯" };
  if (state.status === "exhausted") return { title: "Discovery complete", subtitle: "We've searched the available opportunities." };
  return { title: "Discovery ran into a problem.", subtitle: "" };
}

export function LiveDiscoveryScreen({
  state,
  onCancel,
  isCancelling,
}: {
  state: DiscoveryLiveState | null;
  onCancel: () => void;
  isCancelling: boolean;
}) {
  const scouts = state ? SCOUT_IDS.map((id) => state.scouts[id]) : SCOUT_IDS.map((id) => ({ ...IDLE_SCOUT, scoutId: id }));
  const delivered = state?.delivered ?? 0;
  const rejected = state?.rejected ?? 0;
  const target = state?.target ?? 0;
  const progressPercent = state?.progressPercent ?? 0;
  const { title, subtitle } = headerCopy(state);
  const isTerminal = state ? state.status === "completed" || state.status === "exhausted" || state.status === "failed" : false;

  return (
    <div className="flex min-h-[75vh] items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card/40 p-8 shadow-2xl backdrop-blur-md space-y-6 relative overflow-hidden">
        {!isTerminal && <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand/20 via-brand to-brand/20 animate-pulse" />}

        {/* Header */}
        <div className="text-center space-y-1.5">
          <h2 className="text-xl font-bold text-foreground tracking-tight">{title}</h2>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>

        <div className="h-px bg-border/60" />

        {/* Three Scouts — one row each, one current sentence each */}
        <div className="divide-y divide-border/40">
          {scouts.map((scout) => (
            <ScoutRow key={scout.scoutId} scout={scout} />
          ))}
        </div>

        <div className="h-px bg-border/60" />

        {/* Global target progress — delivered-only, never rejected */}
        <div className="space-y-2">
          <div className="text-center font-mono text-sm text-foreground">
            {delivered} / {target || "—"}
          </div>
          <div className="h-2 w-full bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-brand/60 to-brand transition-all duration-500 rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-center gap-6 text-xs font-mono text-muted-foreground pt-1">
            <span>
              Rejected <span className="text-foreground font-semibold">{rejected}</span>
            </span>
            <span>
              Delivered <span className="text-foreground font-semibold">{delivered}</span>
            </span>
          </div>
        </div>

        {!isTerminal && (
          <div className="text-center">
            <button
              type="button"
              disabled={isCancelling}
              onClick={onCancel}
              className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCancelling ? "Cancelling..." : "Cancel Search"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
