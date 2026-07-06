import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState, useCallback } from "react";
import { BrandMark } from "@/components/mast/BrandMark";
import { useAccount, useLogout, useMe, useEnableWorkspace } from "@/hooks/use-mast-api";
import {
  Crosshair, Search, Kanban, Bell, Settings, LogOut, X,
  CheckCircle2, ArrowUpCircle, Network, Upload, CreditCard, Zap,
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

const NOTIF_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  CheckCircle2, ArrowUpCircle, Bell,
};

function DashboardLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate  = useNavigate();

  const { data: auth, isLoading: authLoading } = useMe();
  const user    = auth?.user ?? null;
  const { data: account } = useAccount(!!user);
  const logout  = useLogout();

  // ── Auth redirect ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login" });
  }, [authLoading, navigate, user]);

  // ── Sidebar indicator — measured dynamically based on DOM layout ─────
  const navContainerRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());
  const [indicator, setIndicator] = useState<{ top: number; height: number; opacity: number }>({
    top: 0,
    height: 40,
    opacity: 0,
  });

  const activeTo = NAV.find((item) =>
    item.exact ? pathname === item.to : pathname.startsWith(item.to)
  )?.to || NAV[0].to;

  const measureItem = useCallback((to: string) => {
    const container = navContainerRef.current;
    const el = itemRefs.current.get(to);
    if (!container || !el) return null;
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { top: er.top - cr.top + container.scrollTop, height: er.height };
  }, []);

  useEffect(() => {
    const update = () => {
      const m = measureItem(activeTo);
      if (m) {
        setIndicator({ top: m.top, height: m.height, opacity: 1 });
      }
    };
    
    update();
    const raf = requestAnimationFrame(update);

    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
    };
  }, [activeTo, measureItem]);

  // ── Notification state ────────────────────────────────────────────────────
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

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
  const dismiss = (id: number) => {
    const updated = notifications.filter((n) => n.id !== id);
    setNotifications(updated);
    try { localStorage.setItem("mast_notifications", JSON.stringify(updated)); } catch { /* ignore */ }
  };

  // ── Loading / unauthenticated ─────────────────────────────────────────────
  if (authLoading || !user) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center">
        <div className="text-sm text-muted-foreground animate-pulse">
          Loading workspace…
        </div>
      </div>
    );
  }

  // ── Credits ────────────────────────────────────────────────────────────────
  const credits = account?.credits ?? {
    limit: user.creditsLimit, used: user.creditsUsed, remaining: user.creditsRemaining,
  };
  const planName  = account?.subscription.name ?? user.plan;
  const creditPct = credits.limit > 0
    ? Math.min(100, Math.round((credits.used / credits.limit) * 100)) : 0;

  const initials = user.fullName
    .split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("")
    || user.email[0]?.toUpperCase() || "M";

  const handleLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  // ── Workspace Paused Guard ──────────────────────────────────────────────────
  if (user.workspaceStatus === "disabled") {
    return <WorkspacePausedScreen user={user} onLogout={handleLogout} />;
  }

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      {/*
        No overflow here — the aside is already a well-formed scroll region
        internally (logo shrink-0 / nav flex-1 overflow-y-auto / credits
        shrink-0). Adding another overflow-y-auto on this parent would just
        recreate the nested-scroll-container bug one level up.
      */}
      <aside
        className="w-64 shrink-0 border-r border-border flex flex-col"
        style={{ background: "oklch(0.155 0.028 265)" }}
      >
        {/* Logo */}
        <div className="px-5 h-16 flex items-center border-b border-border shrink-0">
          <Link to="/" className="flex items-center gap-3">
            <BrandMark size={34} />
            <div className="flex flex-col leading-none">
              <span className="font-bold text-[15px] tracking-[0.14em] text-foreground">MAST</span>
              <span className="mt-1 text-[9px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                Client Acquisition OS
              </span>
            </div>
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
        */}
        <nav ref={navContainerRef} className="relative flex-1 overflow-y-auto">
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
                    ref={(el: HTMLAnchorElement | null) => {
                      if (el) itemRefs.current.set(item.to, el);
                      else itemRefs.current.delete(item.to);
                    }}
                    className={cn(
                      "relative z-10 flex items-center gap-3 px-3 py-2 rounded-lg",
                      "text-sm font-medium transition-colors duration-150",
                      active
                        ? "text-brand"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    style={{ height: `${ITEM_H}px` }}
                  >
                    <item.icon className={cn(
                      "size-4 shrink-0 transition-colors",
                      active ? "text-brand" : "text-muted-foreground",
                    )} />
                    {item.label}
                  </Link>
                </Fragment>
              );
            })}
          </div>
        </nav>

        {/* Credits widget */}
        <div className="p-3 border-t border-border shrink-0">
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Credits</p>
              <span className="text-[10px] font-bold text-brand">{planName}</span>
            </div>
            <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-brand rounded-full"
                style={{ width: `${creditPct}%`, transition: "width 1s cubic-bezier(0.16,1,0.3,1)" }}
              />
            </div>
            <p className="mt-2 text-xs text-foreground">
              {credits.remaining.toLocaleString()}{" "}
              <span className="text-muted-foreground">/ {credits.limit.toLocaleString()} credits left</span>
            </p>
            <Link
              to="/dashboard/subscription"
              className="mt-3 block text-center text-[11px] font-semibold text-brand hover:text-brand-dark transition-colors"
            >
              Upgrade plan →
            </Link>
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

        {/* Topbar */}
        <header className="h-16 border-b border-border flex items-center justify-between px-6 bg-background/80 backdrop-blur-xl sticky top-0 z-30 shrink-0">
          <div className="flex items-center gap-3 max-w-md w-full">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input
              placeholder="Search opportunities, campaigns, contacts…"
              className="bg-transparent outline-none text-sm w-full placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Notification bell */}
            <div ref={notifRef} className="relative">
              <button
                onClick={() => setNotifOpen((o) => !o)}
                className="relative size-9 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors shrink-0"
              >
                <Bell className="size-4 shrink-0" />
                {unread > 0 && (
                  <span className="absolute -top-1 -right-1 size-4 rounded-full bg-brand text-brand-foreground text-[9px] font-bold grid place-items-center shrink-0">
                    {unread}
                  </span>
                )}
              </button>


              {notifOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-border rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-down">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <h3 className="font-bold text-sm">Notifications</h3>
                    <div className="flex items-center gap-3">
                      {unread > 0 && (
                        <button onClick={markRead} className="text-xs text-brand font-semibold hover:text-brand-dark transition-colors">
                          Mark all read
                        </button>
                      )}
                      <button onClick={() => setNotifOpen(false)} className="size-6 grid place-items-center text-muted-foreground hover:text-foreground transition-colors shrink-0">
                        <X className="size-4 shrink-0" />
                      </button>

                    </div>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="py-10 text-center text-sm text-muted-foreground">No notifications</div>
                    ) : notifications.map((n) => {
                      const Icon = NOTIF_ICONS[n.icon] ?? Bell;
                      return (
                        <div key={n.id} className={cn(
                          "flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors",
                          n.unread && "bg-brand/5",
                        )}>
                          <div className={cn("size-8 rounded-lg border grid place-items-center shrink-0 mt-0.5", n.iconBg)}>
                            <Icon className={cn("size-4", n.iconColor)} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <p className={cn("text-sm font-semibold leading-tight", n.unread ? "text-foreground" : "text-muted-foreground")}>
                                {n.title}
                                {n.unread && <span className="inline-block ml-1.5 size-1.5 rounded-full bg-brand align-middle" />}
                              </p>
                              <button onClick={() => dismiss(n.id)} className="size-4 grid place-items-center text-muted-foreground/60 hover:text-muted-foreground shrink-0 transition-colors">
                                <X className="size-4 shrink-0" />
                              </button>

                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{n.body}</p>
                            <p className="text-[10px] text-muted-foreground/60 mt-1">{n.time}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* User */}
            <div className="flex items-center gap-2.5 shrink-0">
              <div className="size-9 rounded-full bg-brand/20 border border-brand/30 grid place-items-center text-sm font-bold text-brand shrink-0">
                {initials}
              </div>
              <div className="hidden md:block">
                <p className="text-sm font-semibold leading-tight">{user.fullName}</p>
                <p className="text-[11px] text-muted-foreground leading-tight">{planName} Plan</p>
              </div>
            </div>


            {/* Logout */}
            <button
              onClick={handleLogout}
              className="size-9 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors shrink-0"
              title="Log out"
            >
              <LogOut className="size-4 shrink-0" />
            </button>
          </div>
        </header>

        {/* Page content — plain Outlet, no key trick.
            min-h-0: same flex min-height reset as the column above, so this
            is the ONE element that actually owns vertical scrolling.
            overscroll-behavior: contain stops any residual scroll chaining
            from ever bleeding into a scrollable ancestor. */}
        <main className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
          <Outlet />
        </main>
      </div>
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
