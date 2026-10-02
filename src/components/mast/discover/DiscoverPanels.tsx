/**
 * Presentational building blocks for the Discover page. None of these own
 * state or talk to the API — the route passes everything in, so the form's
 * behaviour stays exactly where it was.
 *
 * Surfaces are near-opaque rather than blurred on purpose: backdrop-filter
 * over the animated orbit layers would force a re-blur every frame.
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AnimatedCounter } from "./AnimatedCounter";

type IconType = ComponentType<{ className?: string }>;

/** The shared card surface. */
export const panelSurface =
  "rounded-2xl border border-white/[0.07] bg-[oklch(0.16_0.03_268/0.92)] shadow-[inset_0_1px_0_rgb(255_255_255/0.04),0_18px_40px_-24px_rgb(0_0_0/0.8)]";

export function IconTile({ icon: Icon, className }: { icon: IconType; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl border border-brand/25 bg-brand/[0.13] text-brand",
        className,
      )}
    >
      <Icon className="size-[18px]" />
    </span>
  );
}

/** One numbered step of the discovery form. */
export function StepCard({
  step,
  icon,
  title,
  hint,
  children,
  className,
}: {
  step: number;
  icon: IconType;
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(panelSurface, "min-w-0 p-4 sm:p-5", className)}>
      <header className="flex items-start gap-3">
        <IconTile icon={icon} />
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-[15px] font-semibold leading-tight text-foreground">
            <span aria-hidden="true" className="text-brand tabular-nums">
              {step}
            </span>
            {title}
          </h2>
          {hint && <p className="mt-1 text-xs leading-snug text-muted-foreground">{hint}</p>}
        </div>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Quantity slider with the current value floating over the thumb. */
export function AmountSlider({
  steps,
  index,
  maxIndex,
  onChange,
}: {
  /** Every quantity the slider can land on, in order. */
  steps: readonly number[];
  index: number;
  maxIndex: number;
  onChange: (index: number) => void;
}) {
  const clamped = Math.min(index, maxIndex);
  const pct = maxIndex > 0 ? clamped / maxIndex : 0;
  const THUMB = 18;
  // The native thumb's centre travels (width − thumb), not the full width.
  const x = (p: number) => `calc(${p * 100}% + ${(0.5 - p) * THUMB}px)`;

  const tickIdx = Array.from(
    new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxIndex))),
  );

  return (
    <div className="relative pt-9">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 -translate-x-1/2 text-[28px] font-bold leading-none tracking-tight text-foreground tabular-nums transition-[left] duration-200 ease-out"
        style={{ left: x(pct) }}
      >
        {steps[clamped].toLocaleString()}
      </div>
      <input
        type="range"
        min={0}
        max={maxIndex}
        step={1}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Opportunity amount"
        aria-valuetext={`${steps[clamped].toLocaleString()} businesses`}
        className="dg-range"
        style={{ ["--pct" as string]: `${pct * 100}%` }}
      />
      <div aria-hidden="true" className="relative mt-1 h-4 text-[11px] text-muted-foreground tabular-nums">
        {tickIdx.map((i) => {
          const p = maxIndex > 0 ? i / maxIndex : 0;
          return (
            <span
              key={i}
              className={cn(
                "absolute top-0 -translate-x-1/2 transition-colors",
                i === clamped && "font-semibold text-foreground",
              )}
              style={{ left: x(p) }}
            >
              {steps[i].toLocaleString()}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export type SummaryRow = {
  icon: IconType;
  label: string;
  value: ReactNode;
  /** Dim the value (nothing chosen yet). */
  empty?: boolean;
};

/** "Here's what you're about to discover" — a live readout of the form. */
export function SummaryCard({
  rows,
  credits,
}: {
  rows: SummaryRow[];
  credits: { amount: number };
}) {
  return (
    <section className={cn(panelSurface, "p-5")}>
      <header className="flex items-center gap-3">
        <IconTile icon={SparkIcon} className="size-10" />
        <div>
          <h2 className="text-base font-semibold leading-tight text-foreground">Discovery Summary</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Here&rsquo;s what you&rsquo;re about to discover.</p>
        </div>
      </header>

      <dl className="mt-4 divide-y divide-white/[0.06] rounded-xl border border-white/[0.06] bg-black/20">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2.5 px-3 py-3">
            <r.icon className="size-4 shrink-0 text-brand" />
            <dt className="shrink-0 text-[12.5px] text-muted-foreground">{r.label}</dt>
            <dd
              className={cn(
                "ml-auto min-w-0 text-balance text-right text-[12.5px] font-semibold leading-snug",
                r.empty ? "font-normal text-muted-foreground/70" : "text-foreground",
              )}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex items-center gap-3 rounded-xl border border-brand/20 bg-brand/[0.08] px-3.5 py-3">
        <CreditIcon className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">Estimated Credit Usage</p>
          <p className="text-[11px] text-muted-foreground">Each opportunity found uses one credit.</p>
        </div>
        <p className="shrink-0 text-sm font-bold text-brand tabular-nums">
          {credits.amount.toLocaleString()} {credits.amount === 1 ? "credit" : "credits"}
        </p>
      </div>
    </section>
  );
}

function ProgressRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold text-foreground tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand to-[oklch(0.72_0.15_235)] transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Plan name plus how much of today's and this month's allowance is left. */
export function PlanCard({
  planName,
  daily,
  monthly,
}: {
  planName: string;
  daily: { used?: number; limit?: number; remaining: number };
  monthly: { used?: number; limit?: number; remaining: number };
}) {
  return (
    <section className={cn(panelSurface, "p-5")}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Your Plan</h2>
        <span className="rounded-full border border-brand/30 bg-brand/[0.14] px-2.5 py-0.5 text-xs font-semibold capitalize text-brand">
          {planName}
        </span>
      </div>

      <div className="mt-4 space-y-3.5">
        {isNum(monthly.used) && isNum(monthly.limit) && (
          <ProgressRow label="Monthly" used={monthly.used} limit={monthly.limit} />
        )}
        {isNum(daily.used) && isNum(daily.limit) && (
          <ProgressRow label="Daily" used={daily.used} limit={daily.limit} />
        )}
      </div>

      <div className="mt-4 space-y-0.5 border-t border-white/[0.06] pt-3">
        <p className="text-[11px] text-muted-foreground tabular-nums">
          Today: <AnimatedCounter value={daily.remaining} /> remaining
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          Month: <AnimatedCounter value={monthly.remaining} /> remaining
        </p>
      </div>
    </section>
  );
}

// Inline so this file has no icon-set coupling beyond what the route passes in.
function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
    </svg>
  );
}

function CreditIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
      <path d="M5 5.5v6.5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V5.5" />
      <path d="M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6" />
    </svg>
  );
}
