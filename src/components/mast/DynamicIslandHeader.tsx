import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CheckCircle2,
  ArrowUpCircle,
  X,
  LogOut,
  Settings,
  Clock,
} from "lucide-react";
import { MastWordmark } from "@/components/mast/MastWordmark";
import { cn } from "@/lib/utils";
import {
  type DynamicIslandEvent,
  clampProgress,
} from "@/lib/dynamic-island";
import { formatNotificationTimestamp } from "@/lib/notifications";

export interface HeaderNotificationItem {
  id: number | string;
  icon?: string;
  iconColor?: string;
  iconBg?: string;
  title: string;
  body: string;
  time: string;
  createdAt?: string | number;
  unread: boolean;
}

export interface DynamicIslandHeaderProps {
  /** Currently resolved highest-priority event (or idle event) */
  event: DynamicIslandEvent;
  /** Callback when the user clicks the event's primary action or dismisses it */
  onEventAction?: (event: DynamicIslandEvent) => void;
  /** Notifications list for the centered Dynamic Island dropdown */
  notifications?: HeaderNotificationItem[];
  unreadCount?: number;
  onMarkAllRead?: () => void;
  onClearAllNotifications?: () => void;
  onDismissNotification?: (id: number | string) => void;
  /** User identity for the circular avatar */
  user?: {
    fullName?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } | null;
  planName?: string;
  onLogout?: () => void;
  className?: string;
}

const NOTIF_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  CheckCircle2,
  ArrowUpCircle,
  Bell,
};

/**
 * Circular SVG progress ring for `discovery_active`.
 * Animates stroke-dashoffset smoothly as progress changes.
 */
function DiscoveryProgressRing({ progress }: { progress: number }) {
  const pct = clampProgress(progress);
  const size = 28;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Ensure a small visible arc even at 0-4% so the active ring reads clearly
  const visualPct = Math.max(6, pct);
  const dashOffset = circumference - (visualPct / 100) * circumference;

  return (
    <div
      className="relative grid place-items-center shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90 transform"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.14)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{
            transition: "stroke-dashoffset 420ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
      </svg>
    </div>
  );
}

/**
 * Status icon badge for non-progress Dynamic Island states.
 * Sized to fill the vertical height of the Dynamic Island well cleanly.
 */
function EventStatusIcon({ event }: { event: DynamicIslandEvent }) {
  switch (event.type) {
    case "discovery_complete":
      return (
        <div
          className="size-8 rounded-full bg-emerald-500/12 border border-emerald-500/35 text-emerald-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="10" cy="10" r="7" strokeOpacity="0.85" />
            <path d="M7.2 10.2l1.9 1.9 3.8-3.8" />
          </svg>
        </div>
      );

    case "notification":
      return (
        <div
          className="size-8 rounded-full bg-amber-500/12 border border-amber-500/35 text-amber-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <Bell className="size-4" />
        </div>
      );

    case "import_complete":
      return (
        <div
          className="size-8 rounded-full bg-emerald-500/12 border border-emerald-500/35 text-emerald-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 4.5v7.5" />
            <path d="M7 9.5l3 3 3-3" />
            <path d="M5 14.5h10" />
          </svg>
        </div>
      );

    case "credits_low":
      return (
        <div
          className="size-8 rounded-full bg-amber-500/12 border border-amber-500/35 text-amber-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <ellipse cx="10" cy="6.5" rx="5" ry="2.2" />
            <path d="M5 6.5v3.5c0 1.2 2.24 2.2 5 2.2s5-1 5-2.2V6.5" />
            <path d="M5 10v3.5c0 1.2 2.24 2.2 5 2.2s5-1 5-2.2V10" />
          </svg>
        </div>
      );

    case "discovery_error":
      return (
        <div
          className="size-8 rounded-full bg-rose-500/12 border border-rose-500/35 text-rose-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-4"
            stroke="currentColor"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="10" cy="10" r="7" strokeOpacity="0.85" />
            <path d="M7.8 7.8l4.4 4.4M12.2 7.8l-4.4 4.4" />
          </svg>
        </div>
      );

    default:
      return null;
  }
}

/**
 * Contoured SVG frame that gives the MAST header its signature sculpted
 * center Dynamic Island well. Present in both idle and active states.
 */
function HeaderContourSvg({
  isError,
  isActive,
}: {
  isError: boolean;
  isActive: boolean;
}) {
  const accentColor = isError
    ? "rgba(244, 63, 94, 0.62)"
    : isActive
      ? "rgba(147, 83, 255, 0.78)"
      : "rgba(139, 92, 246, 0.58)";
  const troughColor = isError
    ? "rgba(244, 63, 94, 0.44)"
    : isActive
      ? "rgba(124, 58, 237, 0.60)"
      : "rgba(124, 58, 237, 0.42)";

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full select-none"
      viewBox="0 0 1200 56"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mast-header-contour-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(148, 163, 184, 0.08)" />
          <stop offset="20%" stopColor="rgba(139, 92, 246, 0.18)" />
          <stop offset="26%" stopColor={accentColor} />
          <stop offset="34%" stopColor={troughColor} />
          <stop offset="50%" stopColor={troughColor} />
          <stop offset="66%" stopColor={troughColor} />
          <stop offset="74%" stopColor={accentColor} />
          <stop offset="80%" stopColor="rgba(139, 92, 246, 0.18)" />
          <stop offset="100%" stopColor="rgba(148, 163, 184, 0.08)" />
        </linearGradient>

        <linearGradient id="mast-header-well-fill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="oklch(0.122 0.028 265)" />
          <stop offset="100%" stopColor="oklch(0.140 0.030 265)" />
        </linearGradient>
      </defs>

      {/* Recessed center well fill (deep MAST dark navy blue) */}
      <path
        d="M 270 1 C 316 1, 330 51, 376 51 L 824 51 C 870 51, 884 1, 930 1 Z"
        fill="url(#mast-header-well-fill)"
      />

      {/* Subtle ambient under-stroke along the contoured well */}
      <path
        d="M 230 1.25 L 270 1.25 C 316 1.25, 330 51, 376 51 L 824 51 C 870 51, 884 1.25, 930 1.25 L 970 1.25"
        fill="none"
        stroke={accentColor}
        strokeOpacity={isActive ? "0.28" : "0.18"}
        strokeWidth="2.75"
        vectorEffect="non-scaling-stroke"
        style={{ transition: "stroke-opacity 320ms ease" }}
      />

      {/* Primary sculpted contour stroke */}
      <path
        d="M 16 1.25 L 270 1.25 C 316 1.25, 330 51, 376 51 L 824 51 C 870 51, 884 1.25, 930 1.25 L 1184 1.25"
        fill="none"
        stroke="url(#mast-header-contour-stroke)"
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function DynamicIslandHeader({
  event,
  onEventAction,
  notifications = [],
  unreadCount = 0,
  onMarkAllRead,
  onClearAllNotifications,
  onDismissNotification,
  user,
  planName = "Pro",
  onLogout,
  className,
}: DynamicIslandHeaderProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  // Smooth entrance & disappearing handling for the Dynamic Island capsule
  const isIdle = event.type === "idle";
  const [renderedEvent, setRenderedEvent] = useState<DynamicIslandEvent>(event);
  const [visualPhase, setVisualPhase] = useState<"idle" | "entering" | "active" | "exiting">(
    isIdle ? "idle" : "active",
  );

  useEffect(() => {
    if (event.type !== "idle") {
      setRenderedEvent(event);
      setVisualPhase("active");
      return;
    }

    // Transitioning from active -> idle: play smooth collapsing disappearing animation, then unmount
    if (visualPhase === "active" || visualPhase === "entering") {
      setVisualPhase("exiting");
      const timer = setTimeout(() => {
        setVisualPhase("idle");
        setRenderedEvent(event);
      }, 320);
      return () => clearTimeout(timer);
    } else {
      setVisualPhase("idle");
      setRenderedEvent(event);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNotifOpen(false);
        setAccountOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const initials = user?.fullName
    ? user.fullName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase())
        .join("")
    : user?.email?.[0]?.toUpperCase() || "M";

  const showIslandCapsule = visualPhase !== "idle" && renderedEvent.type !== "idle";
  const isErrorState = showIslandCapsule && renderedEvent.type === "discovery_error";

  const handleActionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (renderedEvent.onAction) {
      renderedEvent.onAction();
    }
    onEventAction?.(renderedEvent);
  };

  const handleIslandToggle = () => {
    setNotifOpen((prev) => !prev);
  };

  return (
    <header
      data-testid="mast-dynamic-island-header"
      data-island-state={event.type}
      className={cn(
        "relative h-14 shrink-0 sticky top-0 z-30 px-4 sm:px-6",
        "bg-[oklch(0.155_0.028_265)] border-b border-border",
        "grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-5",
        className,
      )}
    >
      {/* Distinctive contoured well silhouette */}
      <HeaderContourSvg isError={isErrorState} isActive={showIslandCapsule} />

      {/* ── LEFT: MAST Brand Area ──────────────────────────────────────── */}
      <div className="relative z-10 flex items-center pl-1 sm:pl-2">
        <Link
          to="/dashboard"
          className="inline-flex items-center focus-visible:outline-none rounded-md"
          aria-label="MAST Dashboard"
        >
          <MastWordmark height={15} />
        </Link>
      </div>

      {/* ── CENTER: Dynamic Island Status Surface + Centered Dropdown ──── */}
      <div
        ref={notifRef}
        className="relative z-10 flex items-center justify-center min-w-0 h-full px-1 sm:px-3"
      >
        <div
          data-testid="dynamic-island-center"
          role="button"
          tabIndex={0}
          aria-expanded={notifOpen}
          aria-label="Toggle notifications history"
          onClick={handleIslandToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleIslandToggle();
            }
          }}
          className="flex items-center justify-center w-full max-w-[560px] h-full cursor-pointer select-none focus-visible:outline-none"
          aria-live="polite"
        >
          {showIslandCapsule && (
            <div
              key={renderedEvent.type === "discovery_active" ? "discovery_active" : renderedEvent.id}
              data-testid={`dynamic-island-pill-${renderedEvent.type}`}
              data-visual-phase={visualPhase}
              className={cn(
                "relative flex items-center rounded-full border overflow-hidden",
                "bg-[oklch(0.165_0.032_264)] hover:bg-[oklch(0.175_0.034_264)]",
                isErrorState
                  ? "border-rose-500/25"
                  : "border-[oklch(0.29_0.048_266)]",
                renderedEvent.type === "discovery_active"
                  ? "w-full max-w-[520px] min-h-[40px] px-4 py-1.5 gap-3.5"
                  : "w-full max-w-[530px] min-h-[40px] px-3.5 sm:px-4 py-1.5 gap-3 sm:gap-4 justify-between",
              )}
              style={{
                transformOrigin: "center top",
                animation:
                  visualPhase === "exiting"
                    ? "island-collapse-out 320ms cubic-bezier(0.32, 0, 0.67, 0) forwards"
                    : "island-expand-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both",
              }}
            >
              <div
                className="flex items-center justify-between w-full min-w-0 gap-3 sm:gap-4"
                style={{
                  animation:
                    visualPhase === "exiting"
                      ? "island-content-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards"
                      : "island-content-in 340ms cubic-bezier(0.16, 1, 0.3, 1) 50ms both",
                }}
              >
                {renderedEvent.type === "discovery_active" ? (
                  <>
                    <DiscoveryProgressRing progress={renderedEvent.progress ?? 0} />
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="text-[13.5px] sm:text-sm font-semibold tracking-[-0.01em] text-foreground truncate">
                        {renderedEvent.title || "Discovery in progress"}
                      </span>
                      {renderedEvent.description && (
                        <span className="hidden lg:inline text-xs text-muted-foreground truncate">
                          · {renderedEvent.description}
                        </span>
                      )}
                    </div>
                    <div
                      className="w-20 sm:w-28 md:w-36 h-1.5 rounded-full bg-white/[0.12] overflow-hidden shrink-0"
                      role="progressbar"
                      aria-valuenow={clampProgress(renderedEvent.progress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{
                          width: `${clampProgress(renderedEvent.progress)}%`,
                          transition: "width 420ms cubic-bezier(0.16, 1, 0.3, 1)",
                        }}
                      />
                    </div>
                    <span
                      data-testid="dynamic-island-progress-pct"
                      className="text-[13.5px] sm:text-sm font-bold tabular-nums text-foreground shrink-0 min-w-[2.4rem] text-right"
                    >
                      {clampProgress(renderedEvent.progress)}%
                    </span>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <EventStatusIcon event={renderedEvent} />
                      <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
                        <p className="text-[13.5px] sm:text-sm font-semibold tracking-[-0.01em] text-foreground leading-tight truncate">
                          {renderedEvent.title}
                        </p>
                        {renderedEvent.description && (
                          <p className="text-xs text-muted-foreground leading-tight truncate mt-0.5 sm:mt-0">
                            {renderedEvent.description}
                          </p>
                        )}
                      </div>
                    </div>

                    {renderedEvent.actionLabel ? (
                      <button
                        type="button"
                        onClick={handleActionClick}
                        data-testid="dynamic-island-action-btn"
                        className={cn(
                          "shrink-0 rounded-full px-3.5 py-1 text-xs font-semibold",
                          "inline-flex items-center gap-1 transition-colors duration-150 cursor-pointer",
                          isErrorState
                            ? "bg-[oklch(0.20_0.038_265)] hover:bg-[oklch(0.235_0.044_265)] text-foreground border border-white/10"
                            : "bg-[oklch(0.21_0.045_265)] hover:bg-[oklch(0.245_0.052_265)] text-foreground border border-[oklch(0.32_0.055_268)]",
                        )}
                      >
                        <span>{renderedEvent.actionLabel}</span>
                      </button>
                    ) : (
                      <span className="hidden sm:inline-flex items-center gap-1 shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground bg-white/[0.04] border border-white/[0.07]">
                        Just now
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Centered Dynamic Island Notifications Dropdown */}
        {notifOpen && (
          <div
            data-testid="dynamic-island-notifications-dropdown"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute left-1/2 -translate-x-1/2 top-full mt-2 w-[400px] sm:w-[460px] max-w-[calc(100vw-2rem)]",
              "bg-[oklch(0.145_0.028_265)] border border-[oklch(0.26_0.036_265)] rounded-2xl shadow-2xl z-50 overflow-hidden",
            )}
            style={{
              transformOrigin: "center top",
              animation: "island-dropdown-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
            }}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/70 bg-[oklch(0.132_0.026_265)]">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-xs text-foreground tracking-wide">
                  Notifications
                </h3>
                {unreadCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-brand/20 text-brand border border-brand/30">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2.5">
                {unreadCount > 0 && onMarkAllRead && (
                  <button
                    type="button"
                    onClick={onMarkAllRead}
                    className="text-[11px] text-brand font-semibold hover:text-brand-dark transition-colors cursor-pointer"
                  >
                    Mark all read
                  </button>
                )}
                {notifications.length > 0 && onClearAllNotifications && (
                  <button
                    type="button"
                    onClick={onClearAllNotifications}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    Clear all
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setNotifOpen(false)}
                  aria-label="Close notifications"
                  className="size-5 grid place-items-center text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer"
                >
                  <X className="size-3.5 shrink-0" />
                </button>
              </div>
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-border/40">
              {notifications.length === 0 ? (
                <div className="py-9 px-4 text-center">
                  <p className="text-xs font-medium text-muted-foreground">
                    No prior notifications
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    Events from discovery, imports, exports, and reminders will appear here.
                  </p>
                </div>
              ) : (
                notifications.map((n) => {
                  const Icon = (n.icon && NOTIF_ICONS[n.icon]) || Bell;
                  const formattedTime = formatNotificationTimestamp(
                    n.createdAt,
                    n.time,
                  );
                  return (
                    <div
                      key={n.id}
                      data-testid="dynamic-island-notification-item"
                      className={cn(
                        "flex items-start gap-3 px-4 py-2.5 hover:bg-white/[0.03] transition-colors",
                        n.unread && "bg-brand/[0.06]",
                      )}
                    >
                      <div
                        className={cn(
                          "size-7 rounded-full border grid place-items-center shrink-0 mt-0.5",
                          n.iconBg || "bg-brand/10 border-brand/25",
                        )}
                      >
                        <Icon className={cn("size-3.5", n.iconColor || "text-brand")} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p
                            className={cn(
                              "text-xs font-semibold leading-tight truncate",
                              n.unread ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {n.title}
                            {n.unread && (
                              <span className="inline-block ml-1.5 size-1.5 rounded-full bg-brand align-middle" />
                            )}
                          </p>
                          {onDismissNotification && (
                            <button
                              type="button"
                              onClick={() => onDismissNotification(n.id)}
                              aria-label="Dismiss notification"
                              className="size-4 grid place-items-center text-muted-foreground/60 hover:text-foreground shrink-0 transition-colors cursor-pointer"
                            >
                              <X className="size-3.5 shrink-0" />
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                          {n.body}
                        </p>
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground/75">
                          <Clock className="size-2.5 shrink-0" />
                          <span data-testid="notification-item-timestamp">
                            {formattedTime}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: Circular User Avatar ONLY (no bell, no text, no chevron) ─ */}
      <div className="relative z-10 flex items-center pr-1">
        <div ref={accountRef} className="relative">
          <button
            type="button"
            onClick={() => setAccountOpen((o) => !o)}
            aria-label="Account"
            data-testid="header-user-avatar"
            className="size-8 rounded-full bg-brand/20 border border-brand/30 hover:border-brand/50 flex items-center justify-center text-[11px] font-bold text-brand shrink-0 overflow-hidden transition-colors cursor-pointer"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.fullName || "User avatar"}
                className="w-full h-full object-cover object-center shrink-0 block"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: "center",
                }}
              />
            ) : (
              initials
            )}
          </button>

          {accountOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-card border border-border rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-down">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-semibold text-foreground truncate">
                  {user?.fullName || "My Workspace"}
                </p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                  {user?.email || `${planName} Plan`}
                </p>
              </div>
              <div className="p-1.5 space-y-0.5">
                <Link
                  to="/dashboard/settings"
                  onClick={() => setAccountOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
                >
                  <Settings className="size-3.5" />
                  <span>Settings</span>
                </Link>
                {onLogout && (
                  <button
                    type="button"
                    onClick={() => {
                      setAccountOpen(false);
                      onLogout();
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                  >
                    <LogOut className="size-3.5" />
                    <span>Log out</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
