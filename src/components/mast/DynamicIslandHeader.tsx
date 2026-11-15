import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Bell,
  CheckCircle2,
  ArrowUpCircle,
  Target,
  Trophy,
  Link2,
  Database,
  AlertCircle,
  X,
  LogOut,
  Settings,
  Download,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MastWordmark } from "@/components/mast/MastWordmark";
import { useMastConfirm } from "@/components/mast/ui/MastConfirm";
import {
  type DynamicIslandEvent,
  clampProgress,
} from "@/lib/dynamic-island";
import { formatNotificationTimestamp } from "@/lib/notifications";
import {
  useDesktopUpdater,
  type DesktopUpdaterState,
} from "@/lib/desktop/useDesktopUpdater";

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
  desktopUpdater?: Pick<
    DesktopUpdaterState,
    "status" | "version" | "progress" | "error" | "installUpdate"
  >;
  className?: string;
}

const NOTIF_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  CheckCircle2,
  ArrowUpCircle,
  Bell,
  Target,
  Trophy,
  Link2,
  Database,
  AlertCircle,
};

function resolveNotificationVisual(item: HeaderNotificationItem) {
  const explicitIcon = item.icon && item.icon !== "Bell" ? NOTIF_ICONS[item.icon] : undefined;
  if (explicitIcon) {
    return {
      Icon: explicitIcon,
      iconColor: item.iconColor || "text-brand",
      iconBg: item.iconBg || "bg-brand/12 border-brand/25",
    };
  }

  if (/error|fail|unable|invalid/i.test(item.title)) {
    return {
      Icon: AlertCircle,
      iconColor: item.iconColor || "text-rose-400",
      iconBg: item.iconBg || "bg-rose-500/12 border-rose-500/25",
    };
  }

  if (/connect|sync|integrat/i.test(item.title)) {
    return {
      Icon: Link2,
      iconColor: item.iconColor || "text-sky-400",
      iconBg: item.iconBg || "bg-sky-500/12 border-sky-500/25",
    };
  }

  if (/credit|limit|plan|billing|reset/i.test(item.title)) {
    return {
      Icon: Database,
      iconColor: item.iconColor || "text-brand",
      iconBg: item.iconBg || "bg-brand/12 border-brand/25",
    };
  }

  return {
    Icon: Bell,
    iconColor: item.iconColor || "text-brand",
    iconBg: item.iconBg || "bg-brand/12 border-brand/25",
  };
}

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
 * Unified Dynamic Island contour SVG spanning the navbar well (y=0..56)
 * and, when expanded (morphProgress > 0), seamlessly stretching downward and
 * inward from the exact same top-left/top-right curve into the attached
 * Notifications funnel — with zero color/thickness changes on open/close.
 */
function UnifiedIslandSvg({
  width,
  dropdownHeight,
  morphProgress,
  isError,
  isActive,
}: {
  width: number;
  dropdownHeight: number;
  morphProgress: number;
  isError: boolean;
  isActive: boolean;
}) {
  const w = Math.max(240, Math.round(width));
  const hDrop = Math.max(88, Math.round(dropdownHeight));
  const p = Math.max(0, Math.min(1, morphProgress));

  const bodyInset = getFunnelBodyInset(w);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const yBot = 55 + p * hDrop;
  const br = Math.min(18, p * 18, Math.max(0, (yBot - 55) * 0.45));

  // Closed endpoints match the original 580x56 well ratios exactly (44/580, 56/580, 100/580)
  const cp1L = 0.075862 * w;
  const cp2LX = lerp(0.096552 * w, bodyInset, p);
  const cp2Y = lerp(
    55,
    Math.min(yBot - br, 55 + Math.min(55, hDrop * 0.25)),
    p,
  );
  const endLX = lerp(0.172414 * w, bodyInset, p);
  const endY = lerp(
    55,
    Math.min(yBot - br, 55 + Math.min(130, hDrop * 0.6)),
    p,
  );

  const cp1R = w - cp1L;
  const cp2RX = w - cp2LX;
  const endRX = w - endLX;

  const svgHeight = Math.max(56, Math.ceil(yBot + 2));

  // Identical outline colors in idle/open/closed — only active events or errors tint it
  const strokeColor = isError
    ? "rgba(225, 45, 75, 0.72)"
    : isActive
      ? "rgba(48, 78, 148, 0.95)"
      : "rgba(36, 60, 115, 0.88)";
  const troughColor = isError
    ? "rgba(190, 38, 65, 0.62)"
    : isActive
      ? "rgba(56, 90, 168, 0.92)"
      : "rgba(40, 66, 126, 0.82)";

  const f = (n: number) => n.toFixed(2);

  const strokeD =
    p <= 0.001
      ? [
          `M 0 1`,
          `C ${f(cp1L)} 1, ${f(cp2LX)} 55, ${f(endLX)} 55`,
          `L ${f(endRX)} 55`,
          `C ${f(cp2RX)} 55, ${f(cp1R)} 1, ${w} 1`,
        ].join(" ")
      : [
          `M 0 1`,
          `C ${f(cp1L)} 1, ${f(cp2LX)} ${f(cp2Y)}, ${f(endLX)} ${f(endY)}`,
          `L ${f(endLX)} ${f(yBot - br)}`,
          `Q ${f(endLX)} ${f(yBot)}, ${f(endLX + br)} ${f(yBot)}`,
          `L ${f(endRX - br)} ${f(yBot)}`,
          `Q ${f(endRX)} ${f(yBot)}, ${f(endRX)} ${f(yBot - br)}`,
          `L ${f(endRX)} ${f(endY)}`,
          `C ${f(cp2RX)} ${f(cp2Y)}, ${f(cp1R)} 1, ${w} 1`,
        ].join(" ");

  const fillD = `${strokeD} Z`;

  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 select-none"
      style={{
        width: w,
        height: svgHeight,
        filter:
          p > 0.02
            ? `drop-shadow(0 24px 48px rgba(0, 0, 0, ${(0.75 * p).toFixed(2)}))`
            : undefined,
      }}
      viewBox={`0 0 ${w} ${svgHeight}`}
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
          <stop offset={p > 0.02 ? "22%" : "100%"} stopColor="oklch(0.134 0.032 263)" />
          {p > 0.02 && <stop offset="100%" stopColor="oklch(0.120 0.028 263)" />}
        </linearGradient>

        <clipPath id="mast-dropdown-body-clip" clipPathUnits="userSpaceOnUse">
          <path d={fillD} transform="translate(0, -56)" />
        </clipPath>
      </defs>

      <path d={fillD} fill="url(#mast-header-well-fill)" />

      {/* Subtle dark-blue under-stroke along the unified contour */}
      <path
        d={strokeD}
        fill="none"
        stroke={strokeColor}
        strokeOpacity={isActive ? "0.28" : "0.16"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: "stroke-opacity 320ms ease" }}
      />

      {/* Primary sculpted dark-blue contour stroke */}
      <path
        d={strokeD}
        fill="none"
        stroke="url(#mast-header-contour-stroke)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getFunnelBodyInset(width: number) {
  if (width >= 540) {
    return Math.round((width - Math.min(370, width * 0.59)) / 2);
  }
  return Math.max(Math.round(width * 0.185), Math.round(0.172414 * width) + 6);
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
  desktopUpdater,
  className,
}: DynamicIslandHeaderProps) {
  const hookDesktopUpdater = useDesktopUpdater();
  const updater = desktopUpdater ?? hookDesktopUpdater;
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerPhase, setDrawerPhase] = useState<"closed" | "opening" | "open" | "closing">("closed");
  const [morphProgress, setMorphProgress] = useState(0);
  const morphRef = useRef(0);
  const [accountOpen, setAccountOpen] = useState(false);
  const { confirm, ConfirmDialog } = useMastConfirm();
  const notifRef = useRef<HTMLDivElement>(null);
  const dropdownMeasureRef = useRef<HTMLDivElement>(null);
  const [centerWidth, setCenterWidth] = useState(640);
  const [dropdownHeight, setDropdownHeight] = useState(220);
  const accountRef = useRef<HTMLDivElement>(null);

  // Measure the Dynamic Island slot width so UnifiedIslandSvg always renders 1:1 pixels
  useLayoutEffect(() => {
    const el = notifRef.current;
    if (!el) return;

    const updateWidth = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setCenterWidth((prev) => (Math.abs(prev - rect.width) > 0.5 ? rect.width : prev));
      }
    };

    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure the notifications content natural height while mounted
  useLayoutEffect(() => {
    const el = dropdownMeasureRef.current;
    if (!el || drawerPhase === "closed") return;

    const updateHeight = () => {
      const rect = el.getBoundingClientRect();
      if (rect.height > 0) {
        setDropdownHeight((prev) => (Math.abs(prev - rect.height) > 0.5 ? rect.height : prev));
      }
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawerPhase, notifications.length]);

  const bodyInset = getFunnelBodyInset(Math.max(240, Math.round(centerWidth)));
  const headerInset =
    centerWidth >= 540
      ? Math.max(Math.round(bodyInset * 0.82), Math.round(centerWidth * 0.165))
      : Math.max(54, Math.round(bodyInset * 0.85));

  // Smooth RAF morph lifecycle (0 <-> 1) that stretches/retracts the unified SVG
  // downward from the Dynamic Island with zero CSS transform/animation clipping bugs.
  useEffect(() => {
    let rafId = 0;

    if (notifOpen) {
      setDrawerPhase("opening");
      const startVal = morphRef.current;
      const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
      const duration = 300;

      const tick = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const next = startVal + (1 - startVal) * eased;
        morphRef.current = next;
        setMorphProgress(next);
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          morphRef.current = 1;
          setMorphProgress(1);
          setDrawerPhase("open");
        }
      };

      if (typeof requestAnimationFrame !== "undefined") {
        rafId = requestAnimationFrame(tick);
      }

      const timer = setTimeout(() => {
        cancelAnimationFrame(rafId);
        morphRef.current = 1;
        setMorphProgress(1);
        setDrawerPhase("open");
      }, duration + 16);

      return () => {
        cancelAnimationFrame(rafId);
        clearTimeout(timer);
      };
    }

    if (drawerPhase === "opening" || drawerPhase === "open") {
      setDrawerPhase("closing");
      const startVal = morphRef.current > 0 ? morphRef.current : 1;
      const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
      const duration = 220;

      const tick = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 2.5);
        const next = startVal * (1 - eased);
        morphRef.current = next;
        setMorphProgress(next);
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          morphRef.current = 0;
          setMorphProgress(0);
          setDrawerPhase("closed");
        }
      };

      if (typeof requestAnimationFrame !== "undefined") {
        rafId = requestAnimationFrame(tick);
      }

      const timer = setTimeout(() => {
        cancelAnimationFrame(rafId);
        morphRef.current = 0;
        setMorphProgress(0);
        setDrawerPhase("closed");
      }, duration + 16);

      return () => {
        cancelAnimationFrame(rafId);
        clearTimeout(timer);
      };
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
  const firstUnreadIdx = notifications.findIndex((n) => n.unread);
  const introTitle =
    unreadCount > 0
      ? `${unreadCount} new ${unreadCount === 1 ? "notification" : "notifications"}`
      : notifications.length > 0
        ? "All caught up"
        : "No new notifications";
  const introSubtitle =
    notifications.length > 0
      ? "Here\u2019s what\u2019s new in your workspace."
      : "Discovery, import, and export alerts will appear here.";

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
        "relative h-14 shrink-0 sticky top-0 z-40",
        "bg-[oklch(0.148_0.028_265)]",
        "grid grid-cols-[1fr_auto_1fr] items-stretch",
        className,
      )}
    >
      {/* ── LEFT WING: Fixed single MAST wordmark & seamless navbar contour ─ */}
      <div className="relative z-10 flex items-center pl-4 sm:pl-6 pr-2 border-b border-[oklch(0.21_0.035_262)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-4 right-0 h-[1.5px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(36, 60, 115, 0.12) 0%, rgba(36, 60, 115, 0.88) 100%)",
          }}
        />
        <Link to="/" className="flex items-center shrink-0">
          <MastWordmark
            height={null}
            className="h-[12px] sm:h-[18px] lg:h-[22px] w-auto"
          />
        </Link>
      </div>

      {/* ── CENTER: The Contoured Dynamic Island Container Itself ──────── */}
      <div
        ref={notifRef}
        className="relative z-20 flex items-center justify-center w-[240px] sm:w-[460px] md:w-[540px] lg:w-[640px] max-w-[64vw] h-full"
      >
        {/* Unified sculpted dark-blue Dynamic Island contour — stretches downward into funnel when open, zero color/thickness changes */}
        <UnifiedIslandSvg
          width={centerWidth}
          dropdownHeight={dropdownHeight}
          morphProgress={drawerPhase === "closed" ? 0 : morphProgress}
          isError={isErrorState}
          isActive={showIslandCapsule}
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

        {/* Attached Dynamic Island Notifications Drawer — seamlessly continues the island curve downward */}
        {drawerPhase !== "closed" && (
          <div
            data-testid="dynamic-island-notifications-dropdown"
            data-state={drawerPhase === "closing" ? "closing" : "open"}
            onClick={(e) => e.stopPropagation()}
            className="absolute left-0 right-0 top-[56px] z-30"
            style={{
              clipPath: "url(#mast-dropdown-body-clip)",
              pointerEvents: drawerPhase === "closing" ? "none" : "auto",
            }}
          >
            <div ref={dropdownMeasureRef} className="pb-2.5">
              {/* Compact top bar: title, count pill, bulk controls */}
              <div
                className="flex items-center justify-between py-2 px-3.5"
                style={{
                  marginLeft: headerInset,
                  marginRight: headerInset,
                  opacity: Math.min(1, morphProgress * 1.4),
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-semibold text-xs text-foreground tracking-wide">
                    Notifications
                  </h3>
                  {unreadCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-brand/20 text-brand border border-brand/30 shrink-0">
                      {unreadCount} new
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
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

              <div
                className="border-b border-white/[0.07]"
                style={{
                  marginLeft: headerInset + 6,
                  marginRight: headerInset + 6,
                }}
              />

              {/* Compact notification introduction/summary filling upper island area */}
              <div
                data-testid="dynamic-island-notifications-intro"
                className="flex items-center gap-3 px-3 pt-2.5 pb-2"
                style={{
                  marginLeft: bodyInset + 1,
                  marginRight: bodyInset + 1,
                  opacity: Math.min(1, Math.max(0, (morphProgress - 0.06) * 1.35)),
                }}
              >
                <div
                  className="size-9 rounded-lg bg-brand/12 border border-brand/25 text-brand grid place-items-center shrink-0"
                  aria-hidden="true"
                >
                  <Bell className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-foreground leading-tight truncate">
                    {introTitle}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug truncate">
                    {introSubtitle}
                  </p>
                </div>
              </div>

              {/* Contained notification cards */}
              <div
                className={cn(
                  "max-h-[304px] flex flex-col gap-2 px-2.5 pb-2",
                  drawerPhase === "open" ? "overflow-y-auto" : "overflow-hidden",
                )}
                style={{
                  marginLeft: bodyInset + 1,
                  marginRight: bodyInset + 1,
                  opacity: Math.min(1, Math.max(0, (morphProgress - 0.1) * 1.25)),
                }}
              >
                {notifications.length === 0 ? (
                  <div className="rounded-xl bg-[oklch(0.144_0.025_264)] border border-white/[0.06] py-6 px-4 text-center">
                    <p className="text-xs font-medium text-muted-foreground">
                      No prior notifications
                    </p>
                    <p className="text-[11px] text-muted-foreground/65 mt-0.5">
                      Events from discovery, imports, exports, and reminders will appear here.
                    </p>
                  </div>
                ) : (
                  notifications.map((n, index) => {
                    const { Icon, iconColor, iconBg } = resolveNotificationVisual(n);
                    const formattedTime = formatNotificationTimestamp(
                      n.createdAt,
                      n.time,
                    );
                    const isFeaturedUnread = Boolean(n.unread && index === firstUnreadIdx);
                    return (
                      <div
                        key={n.id}
                        data-testid="dynamic-island-notification-item"
                        data-featured-unread={isFeaturedUnread ? "true" : "false"}
                        className={cn(
                          "group flex items-center gap-2.5 sm:gap-3 rounded-xl px-2.5 py-2 sm:px-3 sm:py-2.5 transition-colors",
                          isFeaturedUnread
                            ? "bg-[oklch(0.165_0.042_274)] border border-brand/35 hover:bg-[oklch(0.175_0.045_274)]"
                            : n.unread
                              ? "bg-[oklch(0.152_0.028_264)] border border-white/[0.07] hover:bg-[oklch(0.164_0.030_264)]"
                              : "bg-[oklch(0.140_0.024_264)] border border-white/[0.05] hover:bg-[oklch(0.152_0.026_264)]",
                        )}
                      >
                        <div
                          className={cn(
                            "size-7 sm:size-8 rounded-lg border grid place-items-center shrink-0",
                            iconBg,
                          )}
                        >
                          <Icon className={cn("size-3.5 sm:size-4", iconColor)} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <p
                            className={cn(
                              "text-[12.5px] font-semibold leading-tight truncate",
                              n.unread ? "text-foreground" : "text-foreground/85",
                            )}
                          >
                            {n.title}
                          </p>
                          <p
                            className={cn(
                              "text-[11px] mt-0.5 leading-snug line-clamp-2",
                              n.unread ? "text-muted-foreground" : "text-muted-foreground/80",
                            )}
                          >
                            {n.body}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            data-testid="notification-item-timestamp"
                            className="inline-flex items-center rounded-full bg-white/[0.05] border border-white/[0.07] px-2 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums whitespace-nowrap"
                          >
                            {formattedTime}
                          </span>
                          {n.unread && (
                            <span
                              aria-label="Unread notification"
                              className="size-2 rounded-full bg-brand shrink-0"
                            />
                          )}
                          {onDismissNotification && (
                            <button
                              type="button"
                              onClick={() => onDismissNotification(n.id)}
                              aria-label="Dismiss notification"
                              className="w-0 overflow-hidden opacity-0 group-hover:w-4 group-hover:opacity-100 focus:w-4 focus:opacity-100 size-4 grid place-items-center text-muted-foreground/60 hover:text-foreground shrink-0 transition-all cursor-pointer"
                            >
                              <X className="size-3.5 shrink-0" />
                            </button>
                          )}
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

      {/* ── RIGHT WING: Compact Desktop Update Pill (when available) + User Avatar ─ */}
      <div className="relative z-10 flex items-center justify-end gap-2.5 pl-2 pr-4 sm:pr-6 border-b border-[oklch(0.21_0.035_262)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 right-4 h-[1.5px]"
          style={{
            background:
              "linear-gradient(90deg, rgba(36, 60, 115, 0.88) 0%, rgba(36, 60, 115, 0.12) 100%)",
          }}
        />
        {(updater.status === "available" ||
          updater.status === "downloading" ||
          updater.status === "installing" ||
          updater.status === "error") && (
          <button
            type="button"
            data-testid="desktop-update-button"
            disabled={
              updater.status === "downloading" ||
              updater.status === "installing"
            }
            onClick={() => void updater.installUpdate()}
            title={
              updater.status === "error"
                ? updater.error || "Update failed — click to retry"
                : updater.version
                  ? `Update MAST to v${updater.version} and restart`
                  : "Update MAST and restart"
            }
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-semibold tracking-tight transition-colors shrink-0 border",
              updater.status === "error"
                ? "bg-destructive/15 border-destructive/40 text-destructive hover:bg-destructive/25 cursor-pointer"
                : updater.status === "downloading" ||
                    updater.status === "installing"
                  ? "bg-brand/15 border-brand/30 text-brand cursor-wait opacity-90"
                  : "bg-brand/15 border-brand/35 text-brand hover:bg-brand/25 cursor-pointer",
            )}
          >
            {updater.status === "downloading" ||
            updater.status === "installing" ? (
              <Loader2 className="size-3 animate-spin shrink-0" />
            ) : updater.status === "error" ? (
              <AlertCircle className="size-3 shrink-0" />
            ) : (
              <Download className="size-3 shrink-0" />
            )}
            <span>
              {updater.status === "downloading"
                ? `Updating ${updater.progress ?? 0}%`
                : updater.status === "installing"
                  ? "Restarting..."
                  : updater.status === "error"
                    ? "Retry update"
                    : "Update available"}
            </span>
          </button>
        )}
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
                    onClick={async () => {
                      setAccountOpen(false);
                      const confirmed = await confirm({
                        title: "Log out of MAST?",
                        description:
                          "You\u2019ll need to sign back in to access your workspace.",
                        confirmLabel: "Log out",
                        cancelLabel: "Cancel",
                        destructive: true,
                      });
                      if (confirmed) {
                        onLogout();
                      }
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
      <ConfirmDialog />
    </header>
  );
}
