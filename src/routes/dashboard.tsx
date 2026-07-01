import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/mast/BrandMark";
import { useAccount, useLogout, useMe } from "@/hooks/use-mast-api";
import {
  Crosshair, Search, Kanban, Bell, Settings, LogOut, X,
  CheckCircle2, ArrowUpCircle, Network,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  head: () => ({ meta: [{ title: "Focus — Mast" }] }),
  // No beforeLoad — auth is handled in the component via useEffect + navigate.
  // beforeLoad with supabase.auth.getSession() has no timeout and can hang
  // indefinitely. The AuthGate in __root.tsx already handles this with a 5s timeout.
  component: DashboardLayout,
});

const NAV = [
  { label: "Focus",         to: "/dashboard",              icon: Crosshair, exact: true },
  { label: "Discover",      to: "/dashboard/leads",        icon: Search },
  { label: "Relationships", to: "/dashboard/relationships",          icon: Network },
  { label: "Pipeline",      to: "/dashboard/pipeline",     icon: Kanban },
  { label: "Mission",       to: "/dashboard/follow-ups",   icon: Bell },
  { label: "Settings",      to: "/dashboard/settings",     icon: Settings },
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

  // ── Sidebar indicator — index-based translateY, no DOM measurement ─────
  const activeIdx = NAV.findIndex((item) =>
    item.exact ? pathname === item.to : pathname.startsWith(item.to)
  );
  const safeIdx = activeIdx >= 0 ? activeIdx : 0;

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

  return (
    <div className="min-h-screen flex bg-background text-foreground">

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
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
        <nav className="relative flex-1 overflow-y-auto">
          {/* Gliding indicator — positioned to match the p-3 item container */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: "12px",
              right: "12px",
              height: `${ITEM_H}px`,
              // 12px = p-3 top-padding of the item container below
              top: `${12 + safeIdx * (ITEM_H + ITEM_GAP)}px`,
              borderRadius: "8px",
              background: "color-mix(in oklab, var(--brand) 12%, transparent)",
              transition: "top 400ms cubic-bezier(0.16, 1, 0.3, 1)",
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
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
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
      <div className="flex-1 flex flex-col min-w-0">

        {/* Topbar */}
        <header className="h-16 border-b border-border flex items-center justify-between px-6 bg-background/80 backdrop-blur-xl sticky top-0 z-30">
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
                className="relative size-9 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
              >
                <Bell className="size-4" />
                {unread > 0 && (
                  <span className="absolute -top-1 -right-1 size-4 rounded-full bg-brand text-brand-foreground text-[9px] font-bold grid place-items-center">
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
                      <button onClick={() => setNotifOpen(false)} className="size-6 grid place-items-center text-muted-foreground hover:text-foreground transition-colors">
                        <X className="size-3.5" />
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
                                <X className="size-3" />
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
            <div className="flex items-center gap-2.5">
              <div className="size-9 rounded-full bg-brand/20 border border-brand/30 grid place-items-center text-sm font-bold text-brand">
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
              className="size-9 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
              title="Log out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </header>

        {/* Page content — plain Outlet, no key trick */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
