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
 * Contoured SVG frame that forms the Dynamic Island container itself.
 * The curve starts at the top of the navbar (y=1) and sweeps all the way
 * down to touch the bottom edge of the navbar (y=55 in a 56px header),
 * outlined in dark navy blue.
 */
function HeaderContourSvg({
  isError,
  isActive,
  isOpen,
}: {
  isError: boolean;
  isActive: boolean;
  isOpen: boolean;
}) {
  const strokeColor = isError
    ? "rgba(225, 45, 75, 0.72)"
    : isActive || isOpen
      ? "rgba(48, 78, 148, 0.95)"
      : "rgba(36, 60, 115, 0.88)";
  const troughColor = isError
    ? "rgba(190, 38, 65, 0.62)"
    : isActive || isOpen
      ? "rgba(56, 90, 168, 0.92)"
      : "rgba(40, 66, 126, 0.82)";

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full select-none"
      viewBox="0 0 580 56"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mast-header-contour-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={strokeColor} />
          <stop offset="18%" stopColor={troughColor} />
          <stop offset="50%" stopColor={troughColor} />
          <stop offset="82%" stopColor={troughColor} />
          <stop offset="100%" stopColor={strokeColor} />
        </linearGradient>

        <linearGradient id="mast-header-well-fill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="oklch(0.118 0.028 263)" />
          <stop offset="100%" stopColor="oklch(0.134 0.032 263)" />
        </linearGradient>
      </defs>

      {isOpen ? (
        <>
          {/* Open state: keep the EXACT same top curve (zero shrinking), and open the bottom into the dropdown */}
          <path
            d="M 0 1 C 44 1, 56 55, 100 55 L 100 56 L 480 56 L 480 55 C 524 55, 536 1, 580 1 Z"
            fill="url(#mast-header-well-fill)"
          />
          <path
            d="M 0 1 C 44 1, 56 55, 100 55 L 100 56"
            fill="none"
            stroke="url(#mast-header-contour-stroke)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M 480 56 L 480 55 C 524 55, 536 1, 580 1"
            fill="none"
            stroke="url(#mast-header-contour-stroke)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : (
        <>
          {/* Closed state: recessed center Dynamic Island well touching bottom of navbar */}
          <path
            d="M 0 1 C 44 1, 56 55, 100 55 L 480 55 C 524 55, 536 1, 580 1 Z"
            fill="url(#mast-header-well-fill)"
          />

          {/* Subtle dark-blue under-stroke along the contoured well */}
          <path
            d="M 0 1 C 44 1, 56 55, 100 55 L 480 55 C 524 55, 536 1, 580 1"
            fill="none"
            stroke={strokeColor}
            strokeOpacity={isActive ? "0.28" : "0.16"}
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
            style={{ transition: "stroke-opacity 320ms ease" }}
          />

          {/* Primary sculpted dark-blue contour stroke touching the bottom of the navbar */}
          <path
            d="M 0 1 C 44 1, 56 55, 100 55 L 480 55 C 524 55, 536 1, 580 1"
            fill="none"
            stroke="url(#mast-header-contour-stroke)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
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
  const [drawerPhase, setDrawerPhase] = useState<"closed" | "open" | "closing">("closed");
  const [accountOpen, setAccountOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);

  // Smooth CSS keyframe lifecycle for the Dynamic Island notifications drawer
  useEffect(() => {
    if (notifOpen) {
      setDrawerPhase("open");
      return;
    }
    if (drawerPhase === "open") {
      setDrawerPhase("closing");
      const timer = setTimeout(() => {
        setDrawerPhase("closed");
      }, 240);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifOpen]);

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
        "relative h-14 shrink-0 sticky top-0 z-30",
        "bg-[oklch(0.148_0.028_265)]",
        "grid grid-cols-[1fr_auto_1fr] items-stretch",
        className,
      )}
    >
      {/* ── LEFT WING: Top/Bottom Contour Continuation (no duplicate MAST logo) ─ */}
      <div className="relative z-10 flex items-center pl-4 sm:pl-6 pr-2 border-b border-[oklch(0.21_0.035_262)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-4 right-0 h-[1.5px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(36, 60, 115, 0.12) 0%, rgba(36, 60, 115, 0.88) 100%)",
          }}
        />
      </div>

      {/* ── CENTER: The Contoured Dynamic Island Container Itself ──────── */}
      <div
        ref={notifRef}
        className="relative z-20 flex items-center justify-center w-[340px] sm:w-[560px] md:w-[640px] max-w-[74vw] h-full"
      >
        {/* Sculpted dark-blue Dynamic Island contour — flows down into the notifications drawer when open */}
        <HeaderContourSvg
          isError={isErrorState}
          isActive={showIslandCapsule}
          isOpen={drawerPhase === "open"}
        />

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
          className="relative z-10 flex items-center justify-center w-full h-full px-10 sm:px-[92px] md:px-[106px] cursor-pointer select-none focus-visible:outline-none"
          aria-live="polite"
        >
          {showIslandCapsule && (
            <div
              key={renderedEvent.type === "discovery_active" ? "discovery_active" : renderedEvent.id}
              data-testid={`dynamic-island-pill-${renderedEvent.type}`}
              data-visual-phase={visualPhase}
              className={cn(
                "relative flex items-center justify-between w-full h-full min-w-0 gap-3 sm:gap-4",
                isErrorState ? "border-rose-500/25" : "",
              )}
              style={{
                transformOrigin: "center top",
                animation:
                  visualPhase === "exiting"
                    ? "island-collapse-out 320ms cubic-bezier(0.32, 0, 0.67, 0) forwards"
                    : "island-expand-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both",
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
                          : "bg-[oklch(0.19_0.042_262)] hover:bg-[oklch(0.225_0.048_262)] text-foreground border border-[rgba(56,90,168,0.45)]",
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
          )}
        </div>

        {/* Attached Dynamic Island Notifications Drawer — smooth dropdown down & up */}
        {drawerPhase !== "closed" && (
          <div
            data-testid="dynamic-island-notifications-dropdown"
            data-state={drawerPhase}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "absolute left-[17.241%] right-[17.241%] top-full -mt-[1px]",
              "bg-[oklch(0.130_0.031_263)] border-x border-b border-t-0 rounded-b-2xl shadow-2xl z-50 overflow-hidden",
              isErrorState
                ? "border-[rgba(190,38,65,0.62)]"
                : "border-[rgba(56,90,168,0.92)]",
            )}
            style={{
              transformOrigin: "center top",
              animation:
                drawerPhase === "closing"
                  ? "island-dropdown-out 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards"
                  : "island-dropdown-in 320ms cubic-bezier(0.16, 1, 0.3, 1) forwards",
            }}
          >
            <div>
              <div className="flex items-center justify-between px-4 py-2 border-b border-[rgba(56,90,168,0.24)] bg-[oklch(0.122_0.029_263)]">
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
          </div>
        )}
      </div>

      {/* ── RIGHT WING: Circular User Avatar ONLY (no bell, no text, no chevron) ─ */}
      <div className="relative z-10 flex items-center justify-end pl-2 pr-4 sm:pr-6 border-b border-[oklch(0.21_0.035_262)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 right-4 h-[1.5px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(36, 60, 115, 0.88) 0%, rgba(36, 60, 115, 0.12) 100%)",
          }}
        />
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
