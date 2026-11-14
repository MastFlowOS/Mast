import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MastWordmark } from "@/components/mast/MastWordmark";
import { DynamicIslandHeader } from "@/components/mast/DynamicIslandHeader";
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
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    const initial = [{
      id: 1, icon: "CheckCircle2",
      iconColor: "text-emerald-400", iconBg: "bg-emerald-400/10 border-emerald-400/20",
      title: "Welcome to MAST",
      body: "Your workspace is ready. Start discovering opportunities.",
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
        if (saved) setNotifications(JSON.parse(saved));
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
    <div className="h-screen flex bg-background text-foreground overflow-hidden">

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      {/*
        Desktop/tablet: a slim icon rail by default that expands into an
        overlay on hover. The `aside` is taken out of flow (fixed) so
        expanding it never reflows the dashboard — the spacer div below
        reserves the rail's footprint in the flex row in its place.
        Mobile (<768px): unchanged from before — the sidebar renders inline
        at full width, no hover/collapse behavior (touch has no hover).
        `overflow-hidden` on the aside clips label/branding text during the
        width transition instead of wrapping or causing a horizontal
        scrollbar; the nav's own overflow-y-auto still scrolls vertically.
      */}
      {!isMobile && (
        <div className="shrink-0" style={{ width: RAIL_WIDTH }} aria-hidden="true" />
      )}
      <aside
        onMouseEnter={!isMobile ? () => setSidebarHovered(true) : undefined}
        onMouseLeave={!isMobile ? () => setSidebarHovered(false) : undefined}
        className={cn(
          "shrink-0 border-r border-border flex flex-col overflow-hidden",
          !isMobile && "fixed left-0 top-0 h-screen z-40",
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
        {/* Logo */}
        <div
          className={cn(
            "h-16 flex items-center border-b border-border shrink-0 overflow-hidden transition-all duration-300",
            sidebarExpanded ? "px-5" : "justify-center px-2",
          )}
        >
          <Link to="/" className="flex items-center min-w-0 shrink-0">
            <MastWordmark height={sidebarExpanded ? 18 : 11} />
          </Link>
        </div>

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

        {/* Account / usage dock — one persistent surface instead of two
            hard-swapped layouts. The avatar (with a thin usage ring baked
            in, so collapsed still shows something) stays put in both
            states; only the identity text and the credits block fade and
            collapse, on the same easing/timing as the rail width. */}
        <div className="p-2.5 border-t border-border shrink-0">
          <div
            className="rounded-xl border border-border overflow-hidden"
            style={{ background: "oklch(0.135 0.024 265)" }}
          >
            {/* Identity row */}
            <div className="flex items-center gap-2.5 px-2.5 py-2">
              <div
                className="relative shrink-0 size-8 rounded-full overflow-hidden border border-brand/30 bg-brand/20 flex items-center justify-center text-[10px] font-bold text-brand"
                title={`${creditPct}% of credits used`}
              >
                {/* Thin usage ring — doubles as the "tiny usage indicator"
                    for the collapsed rail, without needing extra height. */}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full pointer-events-none z-10"
                  style={{
                    background: `conic-gradient(var(--brand) ${creditPct * 3.6}deg, var(--color-border) 0deg)`,
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
                <p className="text-xs font-semibold text-foreground truncate" style={labelStyle}>
                  {user?.fullName || "My Workspace"}
                </p>
                <p className="text-[10px] text-muted-foreground truncate" style={labelStyle}>
                  {planName} Plan
                </p>
              </div>
            </div>

            {/* Credits — collapses its row height (not just opacity) so the
                rail doesn't keep reserving space for hidden content while
                collapsed. */}
            <div
              className="grid"
              style={{
                gridTemplateRows: sidebarExpanded ? "1fr" : "0fr",
                transition: `grid-template-rows ${SIDEBAR_DURATION_MS}ms ${SIDEBAR_EASE}`,
              }}
            >
              <div className="overflow-hidden min-h-0">
                <div className="px-2.5 pb-2.5 pt-0.5" style={labelStyle}>
                  <div className="h-1 w-full bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand rounded-full"
                      style={{ width: `${creditPct}%`, transition: `width 700ms ${SIDEBAR_EASE}` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <p className="text-[10px] text-foreground whitespace-nowrap">
                      {credits.remaining.toLocaleString()}
                      <span className="text-muted-foreground">/{credits.limit.toLocaleString()}</span>
                    </p>
                    <Link
                      to="/dashboard/subscription"
                      className="text-[10px] font-semibold text-brand hover:text-brand-dark transition-colors whitespace-nowrap"
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

      {/* ── Main area ────────────────────────────────────────────────────── */}
      {/*
        min-h-0 is required here: flex items default to min-height:auto,
        which lets them refuse to shrink below their content's intrinsic
        height even with flex-1. Without it, this column (and therefore
        the h-screen shell above it) inflates to fit tall page content
        instead of clamping to the viewport, which hands scrolling to the
        document — a second scroll container fighting the one below.
      */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">

        {/* Dynamic Island Top Header */}
        <DynamicIslandHeader
          event={activeEvent}
          notifications={notifications}
          unreadCount={unread}
          onMarkAllRead={markRead}
          onDismissNotification={dismiss}
          user={user}
          planName={planName}
          onLogout={handleLogout}
        />

        {/* Page content — plain Outlet, no key trick.
            min-h-0: same flex min-height reset as the column above, so this
            is the ONE element that actually owns vertical scrolling.
            overscroll-behavior: contain stops any residual scroll chaining
            from ever bleeding into a scrollable ancestor. */}
        <main ref={mainRef} className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
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
