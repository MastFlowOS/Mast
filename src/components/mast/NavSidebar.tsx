/**
 * NavSidebar
 *
 * Animated sidebar with a smoothly gliding active indicator.
 * The indicator is a single absolutely-positioned pill whose CSS
 * transition moves it whenever the active route changes.
 *
 * Props:
 *   children — rendered ABOVE the nav (logo header slot)
 *   footer   — rendered BELOW the nav (credits widget slot)
 */

import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  Zap,
  Users,
  Kanban,
  Bell,
  BarChart2,
  Upload,
  CreditCard,
  Receipt,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard",    to: "/dashboard",              icon: LayoutDashboard, exact: true },
  { label: "Get Leads",    to: "/dashboard/leads",        icon: Zap },
  { label: "CRM",          to: "/dashboard/crm",          icon: Users },
  { label: "Pipeline",     to: "/dashboard/pipeline",     icon: Kanban },
  { label: "Follow-ups",   to: "/dashboard/follow-ups",   icon: Bell },
  { label: "Analytics",    to: "/dashboard/analytics",    icon: BarChart2 },
  { label: "Import",       to: "/dashboard/import",       icon: Upload },
  { label: "Subscription", to: "/dashboard/subscription", icon: CreditCard },
  { label: "Billing",      to: "/dashboard/billing",      icon: Receipt },
  { label: "Settings",     to: "/dashboard/settings",     icon: Settings },
];

interface IndicatorStyle {
  top:     number;
  height:  number;
  opacity: number;
}

interface NavSidebarProps {
  /** Rendered above the nav — logo header */
  children?: React.ReactNode;
  /** Rendered below the nav — credits / usage widget */
  footer?: React.ReactNode;
}

export function NavSidebar({ children, footer }: NavSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const navContainerRef = useRef<HTMLElement>(null);
  // Store refs to each <a> element so we can measure their positions
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  const [indicator, setIndicator] = useState<IndicatorStyle>({
    top: 0, height: 40, opacity: 0,
  });
  const [hoveredTo, setHoveredTo] = useState<string | null>(null);

  // Compute which item is active from the current pathname
  function getActiveTo(): string {
    // Reverse so longer paths match before shorter ones
    for (let i = NAV_ITEMS.length - 1; i >= 0; i--) {
      const item = NAV_ITEMS[i];
      if (item.exact ? pathname === item.to : pathname.startsWith(item.to)) {
        return item.to;
      }
    }
    return NAV_ITEMS[0].to;
  }

  const activeTo = getActiveTo();

  function measureItem(to: string): { top: number; height: number } | null {
    const container = navContainerRef.current;
    const el = itemRefs.current.get(to);
    if (!container || !el) return null;
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { top: er.top - cr.top, height: er.height };
  }

  // Glide the indicator whenever the active route changes
  useEffect(() => {
    const m = measureItem(activeTo);
    if (m) setIndicator({ top: m.top, height: m.height, opacity: 1 });
  }, [activeTo, pathname]);

  // Initial position after first render (before any navigation)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const m = measureItem(activeTo);
      if (m) setIndicator({ top: m.top, height: m.height, opacity: 1 });
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isActive(item: NavItem): boolean {
    return item.exact ? pathname === item.to : pathname.startsWith(item.to);
  }

  return (
    <aside
      className="w-64 shrink-0 border-r border-border flex flex-col"
      style={{ background: "oklch(0.155 0.028 265)" }}
    >
      {/* Header slot (logo) */}
      {children}

      {/* Nav */}
      <nav
        ref={navContainerRef}
        className="relative flex-1 p-3 space-y-[2px] overflow-y-auto"
        aria-label="Main navigation"
      >
        {/* Gliding indicator pill */}
        <div
          aria-hidden="true"
          className="nav-indicator-pill"
          style={{
            top:     indicator.top,
            height:  indicator.height,
            opacity: indicator.opacity,
          }}
        />

        {NAV_ITEMS.map((item) => {
          const active  = isActive(item);
          const hovered = hoveredTo === item.to;

          return (
            <Link
              key={item.to}
              to={item.to as any}
              ref={(el: HTMLElement | null) => {
                if (el) itemRefs.current.set(item.to, el);
                else    itemRefs.current.delete(item.to);
              }}
              onMouseEnter={() => setHoveredTo(item.to)}
              onMouseLeave={() => setHoveredTo(null)}
              className={cn(
                "relative z-10 flex items-center gap-3 px-3 py-2 rounded-lg",
                "text-sm font-medium mast-focus",
                "transition-colors duration-150",
                active  ? "text-brand"
                        : hovered ? "text-foreground"
                                  : "text-muted-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <item.icon
                className={cn(
                  "size-4 shrink-0 transition-colors",
                  active  ? "text-brand"
                          : hovered ? "text-foreground/70"
                                    : "text-muted-foreground",
                )}
              />
              <span>{item.label}</span>

              {/* Hover dot preview */}
              {hovered && !active && (
                <span
                  aria-hidden="true"
                  className="ml-auto size-1.5 rounded-full bg-brand/40 animate-scale-in-fast"
                />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer slot (credits widget) */}
      {footer}
    </aside>
  );
}
