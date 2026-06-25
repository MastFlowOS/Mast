/**
 * MastSkeleton — Unified loading skeleton system
 *
 * Replaces ad-hoc `animate-pulse` divs scattered across pages.
 * Every skeleton in MAST should use one of these named variants
 * so loading states feel consistent and can be updated from one place.
 *
 * All skeletons use the .mast-skeleton class from styles.css which
 * adds a directional wave sweep on top of the base colour.
 *
 * Usage:
 *   <MastSkeleton.Text />           — single line of text
 *   <MastSkeleton.Text lines={3} /> — block of text
 *   <MastSkeleton.Stat />           — KPI / stat card
 *   <MastSkeleton.Card />           — generic content card
 *   <MastSkeleton.Table rows={6} /> — table body rows
 *   <MastSkeleton.Avatar />         — circular avatar
 *   <MastSkeleton.Badge />          — small pill badge
 *   <MastSkeleton.Button />         — button placeholder
 *   <MastSkeleton.Page />           — full-page layout skeleton
 */

import { cn } from "@/lib/utils";

// ── Base primitive ────────────────────────────────────────────────────────────
function Base({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mast-skeleton", className)} {...props} />;
}

// ── Text ─────────────────────────────────────────────────────────────────────
function Text({
  lines = 1,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  if (lines === 1) {
    return <Base className={cn("h-4 w-3/4 rounded-md", className)} />;
  }
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Base
          key={i}
          className={cn(
            "h-4 rounded-md",
            i === lines - 1 ? "w-2/3" : "w-full",
          )}
        />
      ))}
    </div>
  );
}

// ── Stat / KPI card ────────────────────────────────────────────────────────
function Stat({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-5 space-y-3",
        className,
      )}
    >
      {/* Icon + label row */}
      <div className="flex items-center justify-between">
        <Base className="h-3 w-24 rounded-md" />
        <Base className="size-8 rounded-lg" />
      </div>
      {/* Value */}
      <Base className="h-8 w-28 rounded-md" />
      {/* Delta */}
      <Base className="h-3 w-16 rounded-md" />
    </div>
  );
}

// ── Generic card ──────────────────────────────────────────────────────────
function Card({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-5 space-y-3",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Base className="size-10 rounded-lg shrink-0" />
        <div className="flex-1 space-y-2">
          <Base className="h-4 w-32 rounded-md" />
          <Base className="h-3 w-full rounded-md" />
          <Base className="h-3 w-4/5 rounded-md" />
        </div>
      </div>
    </div>
  );
}

// ── Table rows ────────────────────────────────────────────────────────────
function Table({
  rows = 5,
  columns = 5,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  const widths = ["w-32", "w-24", "w-20", "w-16", "w-20", "w-12"];

  return (
    <div className={cn("divide-y divide-border", className)}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {/* Checkbox placeholder */}
          <Base className="size-4 rounded shrink-0" />
          {Array.from({ length: columns }).map((_, c) => (
            <Base
              key={c}
              className={cn(
                "h-3.5 rounded-md",
                widths[c % widths.length],
                c === 0 && "flex-1 max-w-[180px]",
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────
function Avatar({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = { sm: "size-8", md: "size-10", lg: "size-12" };
  return <Base className={cn("rounded-full", sizes[size], className)} />;
}

// ── Badge ─────────────────────────────────────────────────────────────────
function Badge({ className }: { className?: string }) {
  return <Base className={cn("h-5 w-14 rounded-full", className)} />;
}

// ── Button ────────────────────────────────────────────────────────────────
function Button({
  width = "w-24",
  className,
}: {
  width?: string;
  className?: string;
}) {
  return <Base className={cn("h-9 rounded-lg", width, className)} />;
}

// ── Full page layout ──────────────────────────────────────────────────────
function Page({ className }: { className?: string }) {
  return (
    <div className={cn("p-6 space-y-6", className)}>
      {/* Page header */}
      <div className="space-y-2">
        <Base className="h-7 w-48 rounded-md" />
        <Base className="h-4 w-72 rounded-md" />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Stat key={i} />
        ))}
      </div>

      {/* Content area */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* Table header */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-border">
          <Base className="h-4 w-24 rounded-md" />
          <Base className="h-8 w-64 rounded-lg ml-auto" />
        </div>
        <Table rows={8} />
      </div>
    </div>
  );
}

// ── Workspace three-column ────────────────────────────────────────────────
function Workspace({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-full", className)}>
      {/* Left sidebar */}
      <div className="w-64 shrink-0 border-r border-border p-4 space-y-4">
        <div className="space-y-2">
          <Base className="h-4 w-24 rounded-md" />
          <Base className="h-3 w-32 rounded-md" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Base key={i} className="h-3 w-full rounded-md" />
          ))}
        </div>
        <Base className="h-px w-full" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Base className="size-8 rounded-lg shrink-0" />
              <Base className="h-3 flex-1 rounded-md" />
            </div>
          ))}
        </div>
      </div>

      {/* Center */}
      <div className="flex-1 flex flex-col p-6 space-y-4">
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Base key={i} className="h-8 w-20 rounded-lg" />
          ))}
        </div>
        <Base className="flex-1 rounded-xl min-h-64" />
        <Base className="h-28 rounded-xl" />
      </div>

      {/* Right sidebar */}
      <div className="w-72 shrink-0 border-l border-border p-4 space-y-4">
        <Base className="h-4 w-20 rounded-md" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} />
        ))}
      </div>
    </div>
  );
}

// ── Named export ──────────────────────────────────────────────────────────
export const MastSkeleton = {
  Base,
  Text,
  Stat,
  Card,
  Table,
  Avatar,
  Badge,
  Button,
  Page,
  Workspace,
};
