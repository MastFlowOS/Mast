import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CheckCircle2,
  ArrowUpCircle,
  X,
  LogOut,
  Settings,
} from "lucide-react";
import { MastWordmark } from "@/components/mast/MastWordmark";
import { cn } from "@/lib/utils";
import {
  type DynamicIslandEvent,
  clampProgress,
} from "@/lib/dynamic-island";

export interface HeaderNotificationItem {
  id: number | string;
  icon?: string;
  iconColor?: string;
  iconBg?: string;
  title: string;
  body: string;
  time: string;
  unread: boolean;
}

export interface DynamicIslandHeaderProps {
  /** Currently resolved highest-priority event (or idle event) */
  event: DynamicIslandEvent;
  /** Callback when the user clicks the event's primary action or dismisses it */
  onEventAction?: (event: DynamicIslandEvent) => void;
  /** Notifications list for the bell popover */
  notifications?: HeaderNotificationItem[];
  unreadCount?: number;
  onMarkAllRead?: () => void;
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
  const size = 22;
  const strokeWidth = 2.25;
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
          stroke="rgba(255, 255, 255, 0.12)"
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
 * Matches the circular tinted badges in the approved MAST design language.
 */
function EventStatusIcon({ event }: { event: DynamicIslandEvent }) {
  switch (event.type) {
    case "discovery_complete":
      return (
        <div
          className="size-6 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-3.5"
            stroke="currentColor"
            strokeWidth="1.75"
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
          className="size-6 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <Bell className="size-3" />
        </div>
      );

    case "import_complete":
      return (
        <div
          className="size-6 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-3.5"
            stroke="currentColor"
            strokeWidth="1.75"
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
          className="size-6 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-3.5"
            stroke="currentColor"
            strokeWidth="1.6"
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
          className="size-6 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 grid place-items-center shrink-0"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 20 20"
            fill="none"
            className="size-3.5"
            stroke="currentColor"
            strokeWidth="1.75"
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
function HeaderContourSvg({ isError }: { isError: boolean }) {
  const accentColor = isError
    ? "rgba(244, 63, 94, 0.50)"
    : "rgba(139, 92, 246, 0.62)";
  const troughColor = isError
    ? "rgba(244, 63, 94, 0.34)"
    : "rgba(124, 58, 237, 0.44)";

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full select-none"
      viewBox="0 0 1200 52"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mast-header-contour-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(148, 163, 184, 0.08)" />
          <stop offset="22%" stopColor="rgba(139, 92, 246, 0.16)" />
          <stop offset="28%" stopColor={accentColor} />
          <stop offset="36%" stopColor={troughColor} />
          <stop offset="50%" stopColor={troughColor} />
          <stop offset="64%" stopColor={troughColor} />
          <stop offset="72%" stopColor={accentColor} />
          <stop offset="78%" stopColor="rgba(139, 92, 246, 0.16)" />
          <stop offset="100%" stopColor="rgba(148, 163, 184, 0.08)" />
        </linearGradient>

        <linearGradient id="mast-header-well-fill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="oklch(0.125 0.028 265)" />
          <stop offset="100%" stopColor="oklch(0.142 0.030 265)" />
        </linearGradient>
      </defs>

      {/* Recessed center well fill (deep MAST dark navy blue) */}
      <path
        d="M 290 1 C 332 1, 344 46, 386 46 L 814 46 C 856 46, 868 1, 910 1 Z"
        fill="url(#mast-header-well-fill)"
      />

      {/* Subtle ambient under-stroke along the contoured well */}
      <path
        d="M 250 1.25 L 290 1.25 C 332 1.25, 344 46, 386 46 L 814 46 C 856 46, 868 1.25, 910 1.25 L 950 1.25"
        fill="none"
        stroke={accentColor}
        strokeOpacity="0.18"
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />

      {/* Primary sculpted contour stroke */}
      <path
        d="M 16 1.25 L 290 1.25 C 332 1.25, 344 46, 386 46 L 814 46 C 856 46, 868 1.25, 910 1.25 L 1184 1.25"
        fill="none"
        stroke="url(#mast-header-contour-stroke)"
        strokeWidth="1.15"
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

  // Smooth exit handling when returning from an active event to `idle`
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

    // Transitioning from active -> idle: play fast exit, then unmount
    if (visualPhase === "active" || visualPhase === "entering") {
      setVisualPhase("exiting");
      const timer = setTimeout(() => {
        setVisualPhase("idle");
        setRenderedEvent(event);
      }, 190);
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
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
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
  const hasUnreadBellDot = unreadCount > 0 || event.type === "notification";

  const handleActionClick = () => {
    if (renderedEvent.onAction) {
      renderedEvent.onAction();
    }
    onEventAction?.(renderedEvent);
  };

  return (
    <header
      data-testid="mast-dynamic-island-header"
      data-island-state={event.type}
      className={cn(
        "relative h-[52px] shrink-0 sticky top-0 z-30 px-4 sm:px-5",
        "bg-[oklch(0.155_0.028_265)] border-b border-border",
        "grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-5",
        className,
      )}
    >
      {/* Distinctive contoured well silhouette */}
      <HeaderContourSvg isError={isErrorState} />

      {/* ── LEFT: MAST Brand Area ──────────────────────────────────────── */}
      <div className="relative z-10 flex items-center pl-1 sm:pl-2">
        <Link
          to="/dashboard"
          className="inline-flex items-center focus-visible:outline-none rounded-md"
          aria-label="MAST Dashboard"
        >
          <MastWordmark height={14} />
        </Link>
      </div>

      {/* ── CENTER: Dynamic Island Status Surface ──────────────────────── */}
      <div
        data-testid="dynamic-island-center"
        className="relative z-10 flex items-center justify-center min-w-0 h-full px-1 sm:px-3"
        aria-live="polite"
      >
        {showIslandCapsule && (
          <div
            key={renderedEvent.type === "discovery_active" ? "discovery_active" : renderedEvent.id}
            data-testid={`dynamic-island-pill-${renderedEvent.type}`}
            className={cn(
              "relative flex items-center rounded-full border",
              "bg-[oklch(0.165_0.032_264)]",
              isErrorState
                ? "border-rose-500/25"
                : "border-[oklch(0.28_0.045_265)]",
              renderedEvent.type === "discovery_active"
                ? "w-full max-w-[360px] px-3 py-1 gap-2.5 sm:gap-3"
                : "w-full max-w-[380px] px-2.5 py-1 gap-2 sm:gap-3 justify-between",
            )}
            style={{
              opacity: visualPhase === "exiting" ? 0 : 1,
              transform:
                visualPhase === "exiting"
                  ? "scale(0.95) translateY(-2px)"
                  : "scale(1) translateY(0)",
              transition:
                visualPhase === "exiting"
                  ? "opacity 180ms cubic-bezier(0.4, 0, 1, 1), transform 180ms cubic-bezier(0.4, 0, 1, 1), border-color 180ms ease"
                  : "opacity 280ms cubic-bezier(0.16, 1, 0.3, 1), transform 280ms cubic-bezier(0.16, 1, 0.3, 1), border-color 220ms ease",
               animation:
                visualPhase === "active"
                  ? "scale-in-fast 260ms cubic-bezier(0.16, 1, 0.3, 1) both"
                  : undefined,
            }}
          >
            {renderedEvent.type === "discovery_active" ? (
              <>
                <DiscoveryProgressRing progress={renderedEvent.progress ?? 0} />
                <div className="min-w-0 flex-1 flex items-center gap-1.5">
                  <span className="text-[11.5px] sm:text-xs font-medium text-foreground truncate">
                    {renderedEvent.title || "Discovery in progress"}
                  </span>
                  {renderedEvent.description && (
                    <span className="hidden xl:inline text-[10.5px] text-muted-foreground truncate">
                      · {renderedEvent.description}
                    </span>
                  )}
                </div>
                <div
                  className="w-14 sm:w-20 md:w-24 h-1 rounded-full bg-white/[0.10] overflow-hidden shrink-0"
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
                  className="text-[11.5px] sm:text-xs font-semibold tabular-nums text-foreground shrink-0 min-w-[2.1rem] text-right"
                >
                  {clampProgress(renderedEvent.progress)}%
                </span>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
                  <EventStatusIcon event={renderedEvent} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] sm:text-xs font-semibold text-foreground leading-tight truncate">
                      {renderedEvent.title}
                    </p>
                    {renderedEvent.description && (
                      <p className="text-[10.5px] text-muted-foreground leading-tight truncate mt-0.5">
                        {renderedEvent.description}
                      </p>
                    )}
                  </div>
                </div>

                {renderedEvent.actionLabel && (
                  <button
                    type="button"
                    onClick={handleActionClick}
                    data-testid="dynamic-island-action-btn"
                    className={cn(
                      "shrink-0 rounded-full px-2.5 sm:px-3 py-0.5 text-[10.5px] font-medium",
                      "inline-flex items-center gap-1 transition-colors duration-150 cursor-pointer",
                      isErrorState
                        ? "bg-[oklch(0.20_0.038_265)] hover:bg-[oklch(0.235_0.044_265)] text-foreground border border-white/10"
                        : "bg-[oklch(0.205_0.042_265)] hover:bg-[oklch(0.24_0.048_265)] text-foreground border border-[oklch(0.30_0.05_268)]",
                    )}
                  >
                    <span>{renderedEvent.actionLabel}</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── RIGHT: Notification Bell + Circular Avatar ONLY ────────────── */}
      <div className="relative z-10 flex items-center gap-2 sm:gap-2.5 pr-1">
        {/* Notification Bell */}
        <div ref={notifRef} className="relative">
          <button
            type="button"
            onClick={() => setNotifOpen((o) => !o)}
            aria-label="Notifications"
            data-testid="header-notification-bell"
            className="relative size-8 grid place-items-center rounded-lg border border-border bg-[oklch(0.175_0.03_265)] text-muted-foreground hover:text-foreground hover:bg-[oklch(0.20_0.034_265)] transition-colors shrink-0 cursor-pointer"
          >
            <Bell className="size-3.5 shrink-0" />
            {hasUnreadBellDot && (
              <span
                data-testid="notification-unread-badge"
                className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand ring-2 ring-[oklch(0.155_0.028_265)]"
              />
            )}
          </button>

          {notifOpen && (
            <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-border rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-down">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="font-bold text-sm">Notifications</h3>
                <div className="flex items-center gap-3">
                  {unreadCount > 0 && onMarkAllRead && (
                    <button
                      type="button"
                      onClick={onMarkAllRead}
                      className="text-xs text-brand font-semibold hover:text-brand-dark transition-colors cursor-pointer"
                    >
                      Mark all read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setNotifOpen(false)}
                    className="size-6 grid place-items-center text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer"
                  >
                    <X className="size-4 shrink-0" />
                  </button>
                </div>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    No notifications
                  </div>
                ) : (
                  notifications.map((n) => {
                    const Icon = (n.icon && NOTIF_ICONS[n.icon]) || Bell;
                    return (
                      <div
                        key={n.id}
                        className={cn(
                          "flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors",
                          n.unread && "bg-brand/5",
                        )}
                      >
                        <div
                          className={cn(
                            "size-8 rounded-lg border grid place-items-center shrink-0 mt-0.5",
                            n.iconBg || "bg-brand/10 border-brand/20",
                          )}
                        >
                          <Icon className={cn("size-4", n.iconColor || "text-brand")} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p
                              className={cn(
                                "text-sm font-semibold leading-tight",
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
                                className="size-4 grid place-items-center text-muted-foreground/60 hover:text-muted-foreground shrink-0 transition-colors cursor-pointer"
                              >
                                <X className="size-4 shrink-0" />
                              </button>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                            {n.body}
                          </p>
                          <p className="text-[10px] text-muted-foreground/60 mt-1">
                            {n.time}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Circular User Avatar ONLY (no permanent text, no chevron, no permanent menu) */}
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
