/**
 * EmptyState — Canonical empty state component
 *
 * Every "no data yet" surface in MAST uses this component.
 * Consistent visual treatment, entrance animation, and optional CTA.
 *
 * Variants:
 *   default  — centred, moderate size (most pages)
 *   compact  — small inline (table cells, sidebar panels)
 *   feature  — large hero (first-use of a core feature)
 *
 * Usage:
 *   <EmptyState
 *     icon={Users}
 *     title="No leads yet"
 *     description="Generate your first batch to get started."
 *     action={{ label: "Get Leads", to: "/dashboard/leads" }}
 *   />
 *
 *   <EmptyState
 *     variant="compact"
 *     icon={Bell}
 *     title="No follow-ups scheduled"
 *   />
 */

import { Link } from "@tanstack/react-router";
import { type LucideIcon, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateAction {
  label: string;
  /** Internal route — use `to` for TanStack Link */
  to?: string;
  /** External URL */
  href?: string;
  /** Custom click handler (overrides to/href) */
  onClick?: () => void;
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  variant?: "default" | "compact" | "feature";
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  variant = "default",
  className,
}: EmptyStateProps) {
  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 py-4 px-3 text-muted-foreground animate-fade-in",
          className,
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="text-sm">{title}</span>
        {description && (
          <span className="text-xs text-muted-foreground/70">{description}</span>
        )}
        {action && <ActionLink action={action} compact />}
      </div>
    );
  }

  if (variant === "feature") {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center text-center py-20 px-6 animate-fade-up",
          className,
        )}
      >
        {/* Icon — large, glowing */}
        <div className="relative mb-6">
          <div className="absolute inset-0 rounded-full bg-brand/20 blur-2xl scale-150 animate-pulse-glow" />
          <div className="relative size-20 rounded-2xl border border-brand/30 bg-brand/10 grid place-items-center">
            <Icon className="size-9 text-brand" strokeWidth={1.5} />
          </div>
        </div>

        <h3 className="text-2xl font-bold tracking-tight mb-3">{title}</h3>
        {description && (
          <p className="text-muted-foreground text-base max-w-sm leading-relaxed mb-8">
            {description}
          </p>
        )}
        {action && (
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <ActionLink action={action} primary />
            {secondaryAction && <ActionLink action={secondaryAction} />}
          </div>
        )}
      </div>
    );
  }

  // Default variant
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-14 px-6 animate-fade-up",
        className,
      )}
    >
      {/* Icon */}
      <div className="size-14 rounded-xl border border-border bg-card grid place-items-center mb-4">
        <Icon className="size-6 text-muted-foreground" strokeWidth={1.5} />
      </div>

      <h3 className="text-base font-semibold text-foreground mb-1.5">{title}</h3>

      {description && (
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed mb-5">
          {description}
        </p>
      )}

      {(action || secondaryAction) && (
        <div className="flex items-center gap-3 flex-wrap justify-center">
          {action && <ActionLink action={action} primary />}
          {secondaryAction && <ActionLink action={secondaryAction} />}
        </div>
      )}
    </div>
  );
}

// ── Internal: Action link / button ────────────────────────────────────────────
function ActionLink({
  action,
  primary = false,
  compact = false,
}: {
  action: EmptyStateAction;
  primary?: boolean;
  compact?: boolean;
}) {
  const baseClass = compact
    ? "text-xs font-semibold text-brand hover:text-brand-dark transition-colors"
    : primary
    ? cn(
        "inline-flex items-center gap-2 px-4 h-9 rounded-lg",
        "bg-brand text-brand-foreground text-sm font-semibold",
        "transition-all hover:bg-brand-dark",
        "btn-press mast-focus",
      )
    : cn(
        "inline-flex items-center gap-1.5 text-sm font-medium",
        "text-muted-foreground hover:text-foreground transition-colors",
      );

  const content = (
    <>
      {action.label}
      {!compact && <ArrowRight className="size-3.5" />}
    </>
  );

  if (action.onClick) {
    return (
      <button onClick={action.onClick} className={baseClass}>
        {content}
      </button>
    );
  }

  if (action.href) {
    return (
      <a href={action.href} className={baseClass} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }

  if (action.to) {
    return (
      <Link to={action.to} className={baseClass}>
        {content}
      </Link>
    );
  }

  return null;
}
