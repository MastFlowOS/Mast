import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { BrandMark } from "@/components/mast/BrandMark";
import { useAccount, useLogout, useMe } from "@/hooks/use-mast-api";
import {
  LayoutDashboard,
  Zap,
  Users,
  CreditCard,
  Receipt,
  Settings,
  Bell,
  Search,
  LogOut,
} from "lucide-react";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard — Mast" }],
  }),
  component: DashboardLayout,
});

const nav = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, exact: true },
  { label: "Get Leads", to: "/dashboard/leads", icon: Zap },
  { label: "CRM", to: "/dashboard/crm", icon: Users },
  { label: "Subscription", to: "/dashboard/subscription", icon: CreditCard },
  { label: "Billing", to: "/dashboard/billing", icon: Receipt },
  { label: "Settings", to: "/dashboard/settings", icon: Settings },
] as { label: string; to: string; icon: React.ComponentType<{ className?: string }>; exact?: boolean }[];

function DashboardLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { data: auth, isLoading: authLoading } = useMe();
  const user = auth?.user ?? null;
  const { data: account } = useAccount(!!user);
  const logout = useLogout();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login" });
    }
  }, [authLoading, navigate, user]);

  if (authLoading || !user) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center">
        <div className="text-sm text-muted-foreground">Loading workspace...</div>
      </div>
    );
  }

  const credits = account?.credits ?? {
    limit: user.creditsLimit,
    used: user.creditsUsed,
    remaining: user.creditsRemaining,
  };
  const planName = account?.subscription.name ?? user.plan;
  const creditPct = credits.limit > 0 ? Math.min(100, Math.round((credits.used / credits.limit) * 100)) : 0;
  const initials = user.fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || user.email[0]?.toUpperCase() || "M";

  const handleLogout = async () => {
    await logout.mutateAsync();
    await navigate({ to: "/login" });
  };

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-64 shrink-0 border-r border-border bg-[oklch(0.155_0.028_265)] flex flex-col">
        <div className="px-5 h-16 flex items-center border-b border-border">
          <Link to="/" className="group flex items-center gap-3">
            <BrandMark size={34} />
            <div className="flex flex-col leading-none">
              <span className="font-bold text-[15px] tracking-[0.14em] text-foreground">MAST</span>
              <span className="mt-1 text-[9px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">Client Acquisition OS</span>
            </div>
          </Link>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={
                  active
                    ? "flex items-center gap-3 px-3 py-2 rounded-lg bg-brand/10 text-brand text-sm font-medium"
                    : "flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-card text-sm font-medium transition-colors"
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-border">
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Credits</p>
              <span className="text-[10px] font-bold text-brand">{planName}</span>
            </div>
            <div className="mt-2 h-1.5 w-full bg-border rounded-full overflow-hidden">
              <div className="h-full bg-brand" style={{ width: `${creditPct}%` }} />
            </div>
            <p className="mt-2 text-xs text-foreground">
              {credits.remaining.toLocaleString()} / {credits.limit.toLocaleString()} <span className="text-muted-foreground">credits left</span>
            </p>
            <Link to="/dashboard/subscription" className="mt-3 block text-center text-[11px] font-semibold text-brand hover:text-brand-dark">
              Upgrade plan →
            </Link>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b border-border flex items-center justify-between px-6 bg-background/80 backdrop-blur-xl sticky top-0 z-30">
          <div className="flex items-center gap-3 max-w-md w-full">
            <Search className="size-4 text-muted-foreground" />
            <input
              placeholder="Search leads, campaigns, contacts…"
              className="bg-transparent outline-none text-sm w-full placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex items-center gap-4">
            <button className="size-9 grid place-items-center rounded-lg border border-border hover:bg-card transition-colors">
              <Bell className="size-4 text-muted-foreground" />
            </button>
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-full bg-brand/20 border border-brand/30 grid place-items-center text-sm font-bold text-brand">
                {initials}
              </div>
              <div className="hidden md:block">
                <p className="text-sm font-semibold leading-tight">{user.fullName}</p>
                <p className="text-[11px] text-muted-foreground leading-tight">{planName} Plan</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="size-9 grid place-items-center rounded-lg border border-border hover:bg-card transition-colors"
              title="Log out"
            >
              <LogOut className="size-4 text-muted-foreground" />
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
