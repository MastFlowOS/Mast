import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DynamicIslandHeader } from "@/components/mast/DynamicIslandHeader";
import { dedupeDailyResetNotifications } from "@/lib/notifications";
import { useAccount, useFollowups, useLogout, useMe, useEnableWorkspace } from "@/hooks/use-mast-api";
import {
  createDynamicIslandEvent,
  dismissDynamicIslandEvent,
  useDynamicIsland,
  type DynamicIslandEvent,
} from "@/lib/dynamic-island";
import { useNavIndicator } from "@/hooks/use-nav-indicator";
import { useIsMobile } from "@/hooks/use-mobile";
import { DevPlanSwitcher } from "@/components/mast/DevPlanSwitcher";
import {
  Crosshair, Search, Kanban, Bell, Settings, LogOut,
  Network, Upload, CreditCard, Zap, Bug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Focus — Mast" }] }),
  // No beforeLoad — auth is handled in the component via useEffect + navigate.
  // beforeLoad with supabase.auth.getSession() has no timeout and can hang
  // indefinitely. The AuthGate in __root.tsx already handles this with a 5s timeout.
  component: DashboardLayout,
});

const NAV = [
  { label: "Focus",           to: "/dashboard",              icon: Crosshair, exact: true },
  { label: "Discover",        to: "/dashboard/leads",        icon: Search },
  { label: "Relationships",   to: "/dashboard/relationships", icon: Network },
  { label: "Pipeline",        to: "/dashboard/pipeline",     icon: Kanban },
  { label: "Mission",         to: "/dashboard/follow-ups",   icon: Bell },
  { label: "Import / Export", to: "/dashboard/import",        icon: Upload },
  { label: "Billing",         to: "/dashboard/billing",       icon: CreditCard },
  { label: "Subscription",    to: "/dashboard/subscription",  icon: Zap },
  { label: "Settings",        to: "/dashboard/settings",      icon: Settings },
] as { label: string; to: string; icon: React.ComponentType<{ className?: string }>; exact?: boolean }[];

const ITEM_H   = 40; // px — nav item height (py-2 + text-sm line-height)
const ITEM_GAP = 2;  // px — space-y-[2px]

function DashboardLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate  = useNavigate();

  const { data: auth, isLoading: authLoading } = useMe();
  const user    = auth?.user ?? null;
  const { data: account } = useAccount(!!user);
  const { data: followupsData = [] } = useFollowups({ limit: 500 }, !!user);
  const logout  = useLogout();

  // ── Sidebar rail (desktop/tablet only — mobile keeps the original
  // always-expanded layout, since touch devices have no hover state) ────────
  const isMobile = useIsMobile();
  const [sidebarHovered, setSidebarHovered] = useState(false);

  // ── Auth redirect ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate({ to: "/login" });
      return;
    }
    // First login only: onboarding hasn't been completed yet — send the user
    // through "Personalize Your Workspace" before they can reach the dashboard.
    if (!user.onboardingCompleted) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [authLoading, navigate, user]);

  // ── Sidebar indicator — measured dynamically based on DOM layout ─────
  //
  // Root cause of the "pill disappears after reload / after returning to a
  // backgrounded tab" bug: this component early-returns a "Loading
  // workspace…" placeholder (below) while `authLoading` is true, so on a
  // fresh mount the <nav> — and therefore the container/item refs — don't
  // exist yet. The first measurement finds a null container and measures
  // nothing, leaving the indicator at its default `{ opacity: 0 }`. Once
  // `useMe()` resolves and the real layout renders, `activeTo` (the route)
  // is unchanged, so a plain `useRef` container gave the remeasure effect
  // nothing to react to — it never re-ran, and the pill stayed invisible
  // even though the route/active-item match (text/icon color) was always
  // correct. A discarded-and-reloaded background tab (Chrome frees memory
  // for hidden tabs and silently reloads them when you switch back) hits
  // the exact same fresh-mount path, which is why switching tabs "for a
  // while" reproduced it too.
  //
  // Fix (see src/hooks/use-nav-indicator.ts): the container is tracked via
  // a state-backed callback ref instead of a plain useRef, so its identity
  // changes at the exact moment the <nav> mounts, guaranteeing a remeasure
  // right then — regardless of whether `activeTo` changed. `activeTo`
  // remains the sole source of truth for *which* item is active.
  const activeTo = NAV.find((item) =>
    item.exact ? pathname === item.to : pathname.startsWith(item.to)
  )?.to || NAV[0].to;

  const { indicator, setContainer: setNavContainer, registerItem } = useNavIndicator(activeTo);

  // ── Notification state ────────────────────────────────────────────────────
  // <main> is the one element that scrolls and it stays mounted across tabs, so it would
  // otherwise keep the previous tab's scroll position. Always start a new page at the top.
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
  }, [pathname]);
  const [notifications, setNotifications] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem("mast_notifications");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const cleaned = dedupeDailyResetNotifications(parsed);
          if (cleaned.length !== parsed.length) {
            try { localStorage.setItem("mast_notifications", JSON.stringify(cleaned)); } catch { /* ignore */ }
          }
          return cleaned;
        }
      }
    } catch { /* ignore */ }
    const initial = [{
      id: 1, icon: "CheckCircle2",
      iconColor: "text-emerald-400", iconBg: "bg-emerald-400/10 border-emerald-400/20",
      title: "Welcome to MAST",
      body: "Your workspace is ready. Start discovering opportunities.",
      createdAt: new Date().toISOString(),
      time: "Just now", unread: true,
    }];
    try { localStorage.setItem("mast_notifications", JSON.stringify(initial)); } catch { /* ignore */ }
    return initial;
  });

  // Listen to external/real-time notifications state changes
  useEffect(() => {
    const handleUpdate = () => {
      try {
        const saved = localStorage.getItem("mast_notifications");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setNotifications(dedupeDailyResetNotifications(parsed));
          }
        }
      } catch { /* ignore */ }
    };
    window.addEventListener("mast_notifications_update", handleUpdate);
    return () => window.removeEventListener("mast_notifications_update", handleUpdate);
  }, []);

  const unread = notifications.filter((n) => n.unread).length;
  const markRead = () => {
    const updated = notifications.map((n) => ({ ...n, unread: false }));
    setNotifications(updated);
    try { localStorage.setItem("mast_notifications", JSON.stringify(updated)); } catch { /* ignore */ }
  };
  const dismiss = (id: number | string) => {
    const updated = notifications.filter((n) => n.id !== id);
    setNotifications(updated);
    try { localStorage.setItem("mast_notifications", JSON.stringify(updated)); } catch { /* ignore */ }
  };
  const clearAll = () => {
    setNotifications([]);
    try { localStorage.setItem("mast_notifications", JSON.stringify([])); } catch { /* ignore */ }
  };

  const isWorkspaceReady = !authLoading && !!user && user.onboardingCompleted;

  // ── Credits ────────────────────────────────────────────────────────────────
  const credits = account?.credits ?? {
    limit: user?.creditsLimit ?? 1000,
    used: user?.creditsUsed ?? 0,
    remaining: user?.creditsRemaining ?? 1000,
  };
  const planName  = account?.subscription?.name ?? user?.plan ?? "Pro";
  const creditPct = credits.limit > 0
    ? Math.min(100, Math.round((credits.used / credits.limit) * 100)) : 0;

  // ── Ambient Dynamic Island events (real due follow-ups + low credits) ──────
  const dueFollowupsCount = useMemo(() => {
    if (!Array.isArray(followupsData) || followupsData.length === 0) return 0;
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const endOfTodayMs = endOfToday.getTime();
    return followupsData.filter((f) => {
      if (f.status === "completed" || f.status === "cancelled") return false;
      const dueMs = new Date(f.dueAt).getTime();
      return !Number.isNaN(dueMs) && dueMs <= endOfTodayMs;
    }).length;
  }, [followupsData]);

  const ambientEvents = useMemo<DynamicIslandEvent[]>(() => {
    const list: DynamicIslandEvent[] = [];

    if (dueFollowupsCount > 0 && !pathname.startsWith("/dashboard/follow-ups")) {
      const eventId = `followups_due_${dueFollowupsCount}`;
      list.push(
        createDynamicIslandEvent({
          id: eventId,
          type: "notification",
          title: `${dueFollowupsCount} follow-up${dueFollowupsCount === 1 ? " needs" : "s need"} attention`,
          description: "New reminders just now.",
          actionLabel: "Review →",
          actionHref: "/dashboard/follow-ups",
          timestamp: 20,
          onAction: () => {
            dismissDynamicIslandEvent(eventId);
            dismissDynamicIslandEvent("notification");
            void navigate({ to: "/dashboard/follow-ups" });
          },
        }),
      );
    }

    const isLowCredits =
      Boolean(account || user) &&
      credits.limit > 0 &&
      credits.remaining <= Math.min(50, Math.max(10, Math.floor(credits.limit * 0.1)));

    if (isLowCredits && !pathname.startsWith("/dashboard/subscription")) {
      const eventId = `credits_low_${credits.remaining}`;
      list.push(
        createDynamicIslandEvent({
          id: eventId,
          type: "credits_low",
          title: "Credits running low",
          description: `${credits.remaining.toLocaleString()} credit${credits.remaining === 1 ? "" : "s"} remaining.`,
          actionLabel: "Upgrade →",
          actionHref: "/dashboard/subscription",
          timestamp: 10,
          onAction: () => {
            dismissDynamicIslandEvent(eventId);
            dismissDynamicIslandEvent("credits_low");
            void navigate({ to: "/dashboard/subscription" });
          },
        }),
      );
    }

    return list;
  }, [dueFollowupsCount, pathname, navigate, account, user, credits.limit, credits.remaining]);

  const { activeEvent } = useDynamicIsland(ambientEvents);

  const initials = user?.fullName
    ? user.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("")
    : (user?.email?.[0]?.toUpperCase() || "M");

  const handleLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  // ── Workspace Paused Guard ──────────────────────────────────────────────────
  if (user && user.workspaceStatus === "disabled") {
    return <WorkspacePausedScreen user={user} onLogout={handleLogout} />;
  }

  // Collapsed icon rail vs. full-width overlay. Mobile is always "expanded"
  // (unchanged, in-flow, full-width layout) — only desktop/tablet gets the
  // hover-to-expand rail.
  const sidebarExpanded = isMobile ? true : sidebarHovered;
  const RAIL_WIDTH = 72;
  const SIDEBAR_WIDTH = 256; // same as the old w-64
  const sidebarWidth = isMobile ? SIDEBAR_WIDTH : (sidebarExpanded ? SIDEBAR_WIDTH : RAIL_WIDTH);

  // One easing curve drives the whole rail so it reads as a single surface
  // unfolding rather than several elements animating independently.
  const SIDEBAR_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const SIDEBAR_DURATION_MS = 340;

  const labelClass = "whitespace-nowrap";
  // Labels reveal only once the rail has visibly started widening (a short
  // delay on expand), but drop out with zero delay on collapse — so nothing
  // lingers mid-shrink and nothing appears before there's room for it.
  const labelStyle: React.CSSProperties = {
    opacity: sidebarExpanded ? 1 : 0,
    transform: sidebarExpanded ? "translateX(0)" : "translateX(-6px)",
    transition: `opacity 220ms ${SIDEBAR_EASE} ${sidebarExpanded ? "90ms" : "0ms"}, transform 220ms ${SIDEBAR_EASE} ${sidebarExpanded ? "90ms" : "0ms"}`,
    pointerEvents: sidebarExpanded ? "auto" : "none",
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Dynamic Island Top Header — full width across sidebar + page so MAST stays fixed and no vertical border cuts the navbar */}
      <DynamicIslandHeader
        event={activeEvent}
        notifications={notifications}
        unreadCount={unread}
        onMarkAllRead={markRead}
        onClearAllNotifications={clearAll}
        onDismissNotification={dismiss}
        user={user}
        planName={planName}
        onLogout={handleLogout}
      />

      {/* ── Body row below navbar: Sidebar + Main Area ───────────────────── */}
      <div className="flex-1 flex min-w-0 min-h-0 relative">
        {/* ── Sidebar ────────────────────────────────────────────────────── */}
        {/*
          Desktop/tablet: a slim icon rail by default that expands into an
          overlay on hover starting cleanly below the h-14 navbar (top-14),
          so expanding/collapsing never affects the fixed MAST wordmark or
          adds a vertical divider across the navbar.
        */}
        {!isMobile && (
          <div className="shrink-0" style={{ width: RAIL_WIDTH }} aria-hidden="true" />
        )}
        <aside
          onMouseEnter={!isMobile ? () => setSidebarHovered(true) : undefined}
          onMouseLeave={!isMobile ? () => setSidebarHovered(false) : undefined}
          className={cn(
            "shrink-0 border-r border-border flex flex-col overflow-hidden",
            !isMobile && "fixed left-0 top-14 h-[calc(100vh-3.5rem)] z-30",
          )}
          style={{
            background: "oklch(0.155 0.028 265)",
            width: sidebarWidth,
            transition: `width ${SIDEBAR_DURATION_MS}ms ${SIDEBAR_EASE}, box-shadow ${SIDEBAR_DURATION_MS}ms ${SIDEBAR_EASE}`,
            boxShadow: !isMobile && sidebarExpanded
              ? "12px 0 32px -12px rgba(0,0,0,0.55)"
              : "none",
          }}
        >

        {/* Nav with CSS-animated indicator */}
        {/*
          Layout note: the indicator must live OUTSIDE the space-y container
          so Tailwind's `> * + *` selector doesn't add a margin-top to the
          first Link (which would throw off the offset calculation).
          Structure:
            <nav relative>          ← positioned ancestor for the absolute indicator
              <indicator absolute>  ← translated by safeIdx; accounts for p-3 offset
              <div space-y p-3>     ← normal-flow items; items start at 12px from nav top
          The rail/expanded states share the same item order and heights, so
          the indicator's top/height never need to be remeasured on hover —
          only the row's width changes.
        */}
        <nav ref={(el) => setNavContainer(el)} className="relative flex-1 overflow-y-auto">
          {/* Gliding indicator — positioned to match the p-3 item container */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: "12px",
              right: "12px",
              height: `${indicator.height}px`,
              top: `${indicator.top}px`,
              opacity: indicator.opacity,
              borderRadius: "8px",
              background: "color-mix(in oklab, var(--brand) 12%, transparent)",
              transition: "top 400ms cubic-bezier(0.16, 1, 0.3, 1), height 400ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease",
              pointerEvents: "none",
              zIndex: 0,
            }}
          >
            {/* Left accent bar */}
            <div style={{
              position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
              width: "3px", height: "55%", borderRadius: "0 3px 3px 0",
              background: "var(--color-brand)",
              boxShadow: "0 0 10px color-mix(in oklab, var(--brand) 70%, transparent)",
            }} />
          </div>

          {/* Items — p-3 padding + space-y-[2px] gap */}
          <div className="p-3 space-y-[2px]">
            {NAV.map((item, idx) => {
              const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
              const showDividerBefore = idx === 5 || idx === 8;
              return (
                <Fragment key={item.to}>
                  {showDividerBefore && (
                    <div 
                      className="h-px bg-border/30 shrink-0" 
                      style={{ height: '1px', marginTop: '9px', marginBottom: '9px' }} 
                    />
                  )}
                  <Link
                    to={item.to}
                    ref={(el: HTMLAnchorElement | null) => registerItem(item.to, el)}
                    className={cn(
                      "relative z-10 flex items-center gap-3 px-3 py-2 rounded-lg",
                      "text-sm font-medium transition-colors duration-150",
                      active
                        ? "text-brand"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    style={{ height: `${ITEM_H}px` }}
                    title={sidebarExpanded ? undefined : item.label}
                  >
                    <item.icon className={cn(
                      "size-4 shrink-0 transition-colors",
                      active ? "text-brand" : "text-muted-foreground",
                    )} />
                    <span className={labelClass} style={labelStyle}>{item.label}</span>
                  </Link>
                </Fragment>
              );
            })}

            {/* ── Engineering ops nav item — only visible to engineers/admins ── */}
            {(user?.internalRole === "engineer" || user?.internalRole === "admin") && (() => {
              const opsTo = "/dashboard/ops";
              const opsActive = pathname.startsWith(opsTo);
              return (
                <>
                  <div
                    className="h-px bg-amber-500/20 shrink-0"
                    style={{ height: '1px', marginTop: '9px', marginBottom: '9px' }}
                  />
                  <Link
                    to={opsTo}
                    ref={(el: HTMLAnchorElement | null) => registerItem(opsTo, el)}
                    className={cn(
                      "relative z-10 flex items-center gap-3 px-3 py-2 rounded-lg",
                      "text-sm font-medium transition-colors duration-150",
                      opsActive
                        ? "text-amber-400"
                        : "text-amber-600/60 hover:text-amber-400",
                    )}
                    style={{ height: `${ITEM_H}px` }}
                    title={sidebarExpanded ? undefined : "Ops"}
                  >
                    <Bug className={cn(
                      "size-4 shrink-0 transition-colors",
                      opsActive ? "text-amber-400" : "text-amber-600/60",
                    )} />
                    <span className={labelClass} style={labelStyle}>Ops</span>
                    <span
                      className="ml-auto text-[9px] font-bold tracking-wider uppercase text-amber-600/60 border border-amber-600/30 rounded px-1 whitespace-nowrap"
                      style={labelStyle}
                    >
                      eng
                    </span>
                  </Link>
                </>
              );
            })()}
          </div>
        </nav>

        {/* Account / usage dock — dark navy card with layered #191970 waves */}
        <div className="p-2.5 border-t border-border shrink-0">
          <div
            className="relative rounded-xl border overflow-hidden"
            style={{
              background: "linear-gradient(155deg, #0b0d22 0%, #070816 100%)",
              borderColor: "rgba(25, 25, 112, 0.55)",
              boxShadow: "inset 0 1px 0 rgba(25, 25, 112, 0.3), 0 6px 16px -6px rgba(0, 0, 0, 0.55)",
            }}
          >
            {/* Layered flowing #191970 waves in the upper-right portion of the card */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
              style={{
                opacity: sidebarExpanded ? 1 : 0,
                transition: `opacity 200ms ${SIDEBAR_EASE}`,
              }}
            >
              <svg
                viewBox="0 0 236 104"
                preserveAspectRatio="none"
                className="w-full h-full block"
              >
                <defs>
                  <radialGradient id="mast-wave-ambient" cx="88%" cy="16%" r="58%">
                    <stop offset="0%" stopColor="#191970" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#191970" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="mast-wave-back" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#191970" stopOpacity="0.06" />
                    <stop offset="45%" stopColor="#191970" stopOpacity="0.38" />
                    <stop offset="100%" stopColor="#191970" stopOpacity="0.58" />
                  </linearGradient>
                  <linearGradient id="mast-wave-mid" x1="0%" y1="50%" x2="100%" y2="10%">
                    <stop offset="0%" stopColor="#191970" stopOpacity="0.16" />
                    <stop offset="50%" stopColor="#191970" stopOpacity="0.62" />
                    <stop offset="100%" stopColor="#191970" stopOpacity="0.82" />
                  </linearGradient>
                  <linearGradient id="mast-wave-front" x1="0%" y1="40%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#191970" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#191970" stopOpacity="0.98" />
                  </linearGradient>
                </defs>

                <rect width="236" height="104" fill="url(#mast-wave-ambient)" />

                {/* Back flowing wave */}
                <path
                  d="M 68 0 C 94 10, 108 42, 146 42 C 178 42, 198 22, 236 30 L 236 0 Z"
                  fill="url(#mast-wave-back)"
                  stroke="#191970"
                  strokeOpacity="0.75"
                  strokeWidth="1"
                />

                {/* Middle S-curve wave */}
                <path
                  d="M 96 0 C 118 14, 128 54, 166 50 C 194 47, 210 20, 236 22 L 236 0 Z"
                  fill="url(#mast-wave-mid)"
                  stroke="#191970"
                  strokeOpacity="0.9"
                  strokeWidth="1"
                />

                {/* Upper-right crest wave */}
                <path
                  d="M 138 0 C 154 16, 164 42, 194 38 C 212 36, 224 16, 236 12 L 236 0 Z"
                  fill="url(#mast-wave-front)"
                  stroke="#191970"
                  strokeWidth="1"
                />

                {/* Lower subtle right swell */}
                <path
                  d="M 122 80 C 158 76, 186 44, 236 42 L 236 80 Z"
                  fill="#191970"
                  fillOpacity="0.28"
                  stroke="#191970"
                  strokeOpacity="0.55"
                  strokeWidth="0.9"
                />
              </svg>
            </div>

            {/* Identity row */}
            <div className="relative z-10 flex items-center gap-2.5 px-2.5 py-2.5">
              <div
                className="relative shrink-0 size-8 rounded-full overflow-hidden border flex items-center justify-center text-[10px] font-bold text-slate-200"
                style={{
                  borderColor: "rgba(25, 25, 112, 0.7)",
                  backgroundColor: "rgba(25, 25, 112, 0.32)",
                }}
                title={`${creditPct}% of credits used`}
              >
                {/* Thin usage ring — doubles as the "tiny usage indicator"
                    for the collapsed rail, without needing extra height. */}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full pointer-events-none z-10"
                  style={{
                    background: `conic-gradient(#191970 ${creditPct * 3.6}deg, rgba(25, 25, 112, 0.22) 0deg)`,
                    WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
                    mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
                  }}
                />
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.fullName || "User avatar"}
                    className="absolute inset-0 w-full h-full object-cover object-center"
                    style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" }}
                  />
                ) : (
                  initials
                )}
              </div>
              <div className="min-w-0 overflow-hidden">
                <p className="text-xs font-semibold text-white truncate" style={labelStyle}>
                  {user?.fullName || "My Workspace"}
                </p>
                <p className="text-[10px] text-slate-400 truncate" style={labelStyle}>
                  {planName} Plan
                </p>
              </div>
            </div>

            {/* Credits — collapses its row height (not just opacity) so the
                rail doesn't keep reserving space for hidden content while
                collapsed. */}
            <div
              className="relative z-10 grid"
              style={{
                gridTemplateRows: sidebarExpanded ? "1fr" : "0fr",
                transition: `grid-template-rows ${SIDEBAR_DURATION_MS}ms ${SIDEBAR_EASE}`,
              }}
            >
              <div className="overflow-hidden min-h-0">
                <div className="px-2.5 pb-2.5 pt-0.5" style={labelStyle}>
                  <div
                    className="h-1.5 w-full rounded-full overflow-hidden"
                    style={{
                      backgroundColor: "#090a24",
                      boxShadow: "inset 0 0 0 1px rgba(25, 25, 112, 0.4)",
                    }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${creditPct}%`,
                        backgroundColor: "#191970",
                        transition: `width 700ms ${SIDEBAR_EASE}`,
                      }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-[10.5px] font-semibold text-white tabular-nums whitespace-nowrap">
                      {credits.remaining.toLocaleString()}
                      <span className="font-normal text-slate-400">/{credits.limit.toLocaleString()}</span>
                    </p>
                    <Link
                      to="/dashboard/subscription"
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-medium text-slate-200 hover:text-white transition-colors whitespace-nowrap"
                      style={{
                        backgroundColor: "rgba(25, 25, 112, 0.45)",
                        border: "1px solid #191970",
                      }}
                    >
                      Upgrade →
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

        {/* ── Main area ──────────────────────────────────────────────────── */}
        {/*
          min-h-0 is required here: flex items default to min-height:auto,
          which lets them refuse to shrink below their content's intrinsic
          height even with flex-1. Without it, this column (and therefore
          the h-screen shell above it) inflates to fit tall page content
          instead of clamping to the viewport, which hands scrolling to the
          document — a second scroll container fighting the one below.
        */}
        <main ref={mainRef} className="flex-1 min-w-0 min-h-0 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
          {!isWorkspaceReady ? (
            <div className="h-full min-h-[400px] flex flex-col items-center justify-center p-8 space-y-3">
              <div className="size-8 rounded-full border-2 border-brand/30 border-t-brand animate-spin" />
              <div className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
                Loading workspace…
              </div>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
      <DevPlanSwitcher />
    </div>
  );
}

function WorkspacePausedScreen({ user, onLogout }: { user: any; onLogout: () => void }) {
  const enableWorkspace = useEnableWorkspace();
  const [resuming, setResuming] = useState(false);

  const handleResume = async () => {
    setResuming(true);
    try {
      await enableWorkspace.mutateAsync();
      toast.success("Workspace re-enabled. Full access restored.");
      window.location.reload();
    } catch (err) {
      console.error(err);
      toast.error("Failed to re-enable workspace.");
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="min-h-screen bg-[oklch(0.12_0.02_260)] text-foreground grid place-items-center px-4 relative overflow-hidden">
      {/* Dynamic ambient background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-orange-500/10 blur-[100px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md bg-card/45 backdrop-blur-xl border border-orange-500/20 rounded-3xl p-8 shadow-2xl text-center space-y-6">
        <div className="mx-auto size-16 rounded-2xl bg-orange-500/10 border border-orange-500/20 grid place-items-center animate-pulse">
          <Zap className="size-8 text-orange-400" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Workspace Paused</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your MAST workspace has been paused. Full client acquisition operations are temporarily restricted.
          </p>
        </div>

        <div className="bg-orange-500/5 border border-orange-500/10 rounded-xl p-4 text-xs text-orange-300 text-left leading-relaxed">
          All relationship data, opportunities, and configurations are securely preserved. Re-enabling your workspace will immediately restore full operational status.
        </div>

        <div className="space-y-3 pt-2">
          <button
            onClick={handleResume}
            disabled={resuming}
            className="w-full py-3 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-semibold text-sm transition-colors shadow-lg shadow-orange-500/10 disabled:opacity-50 cursor-pointer"
          >
            {resuming ? "Re-enabling..." : "Enable Workspace"}
          </button>
          
          <button
            onClick={onLogout}
            className="w-full py-3 rounded-xl bg-background border border-border hover:bg-muted/10 text-muted-foreground hover:text-foreground font-semibold text-sm transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogOut className="size-4 shrink-0" />
            Log Out
          </button>
        </div>
      </div>
    </div>
  );
}
