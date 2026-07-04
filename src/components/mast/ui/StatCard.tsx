/**
 * StatCard — Unified KPI / stat card
 *
 * Replaces the near-identical per-page implementations in:
 *   - dashboard.index.tsx (KPI component)
 *   - dashboard.analytics.tsx (MetricCard)
 *   - dashboard.follow-ups.tsx (stat tiles)
 *   - dashboard.subscription.tsx (usage cards)
 *
 * All stat-card visuals in MAST now flow from one component so
 * global decisions (padding, animation, delta colour, skeleton state)
 * can be changed in one place.
 *
 * Usage:
 *   <StatCard
 *     label="Total Leads"
 *     value={1234}
 *     delta="+12% this week"
 *     deltaPositive
 *     icon={Users}
 *   />
 *
 *   // Loading:
 *   <StatCard label="Total Leads" loading />
 *
 *   // With progress bar (usage, quotas):
 *   <StatCard
 *     label="Daily Leads Used"
 *     value="34 / 100"
 *     progress={34}
 *   />
 */

import { type LucideIcon, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { MastSkeleton } from "./MastSkeleton";

interface StatCardProps {
  label: string;
  value?: string | number;
  /** Formatted delta string, e.g. "+12%" or "-3 this week" */
  delta?: string;
  /** True = green, False = red, undefined = neutral */
  deltaPositive?: boolean | null;
  icon?: LucideIcon;
  /** 0–100, renders a progress bar below the value */
  progress?: number;
  /** Colour for the progress bar (default: brand) */
  progressColor?: "brand" | "success" | "warning" | "destructive";
  /** Render the loading skeleton instead of content */
  loading?: boolean;
  /** Optional click handler — applies card-hover styles */
  onClick?: () => void;
  className?: string;
  /** Stagger delay class for entrance animation, e.g. "delay-100" */
  animationDelay?: string;
}

const progressColors = {
  brand:       "bg-brand",
  success:     "bg-success",
  warning:     "bg-warning",
  destructive: "bg-destructive",
};

export function StatCard({
  label,
  value,
  delta,
  deltaPositive,
  icon: Icon,
  progress,
  progressColor = "brand",
  loading = false,
  onClick,
  className,
  animationDelay,
}: StatCardProps) {
  if (loading) {
    return <MastSkeleton.Stat className={className} />;
  }

  const isClickable = !!onClick;

  return (
    <div
      onClick={onClick}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={
        isClickable
          ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); }
          : undefined
      }
      className={cn(
        // Base card
        "rounded-xl border border-border bg-card p-5 space-y-1.5",
        "animate-fade-up",
        animationDelay,
        // Interactive
        isClickable && "cursor-pointer card-glow mast-focus",
        className,
      )}
    >
      {/* Header: label + icon */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {label}
        </p>
        {Icon && (
          <div className="size-7 rounded-lg bg-brand/10 grid place-items-center">
            <Icon className="size-4 text-brand" />
          </div>
        )}
      </div>

      {/* Value */}
      {value !== undefined && (
        <p className="text-2xl font-bold tracking-tight text-foreground">
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
      )}

      {/* Progress bar */}
      {progress !== undefined && (
        <div className="space-y-1 pt-0.5">
          <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full animate-progress",
                progressColors[progressColor],
              )}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        </div>
      )}

      {/* Delta */}
      {delta && (
        <DeltaBadge delta={delta} positive={deltaPositive} />
      )}
    </div>
  );
}

// ── Delta badge ───────────────────────────────────────────────────────────────
function DeltaBadge({
  delta,
  positive,
}: {
  delta: string;
  positive?: boolean | null;
}) {
  if (positive === true) {
    return (
      <p className="flex items-center gap-1 text-xs font-medium text-success">
        <TrendingUp className="size-4" />
        {delta}
      </p>
    );
  }
  if (positive === false) {
    return (
      <p className="flex items-center gap-1 text-xs font-medium text-destructive">
        <TrendingDown className="size-4" />
        {delta}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Minus className="size-4" />
      {delta}
    </p>
  );
}

// ── StatCard grid helper ──────────────────────────────────────────────────────
/**
 * StatGrid — wraps a set of StatCards in a responsive 4-column grid
 * with automatic stagger delays.
 *
 * Usage:
 *   <StatGrid>
 *     <StatCard label="Leads" value={123} icon={Users} />
 *     <StatCard label="Sent" value={45} icon={Mail} />
 *   </StatGrid>
 */
export function StatGrid({
  children,
  columns = 4,
  className,
}: {
  children: React.ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  const gridClass = {
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-3",
    4: "grid-cols-2 lg:grid-cols-4",
  }[columns];

  return (
    <div className={cn("grid gap-4", gridClass, className)}>
      {children}
    </div>
  );
}
