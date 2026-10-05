/**
 * Presentational pieces of the Pipeline "Flow" view: executive briefing, health strip,
 * the connected flow ribbon (the hero) and the sales coach. No opportunity cards live
 * here; those belong to the Kanban view only. Data comes from pipelineFlowModel.ts.
 */
import { useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CalendarCheck,
  Clock,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Inbox,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { FlowStage } from "@/lib/lead-workspace";
import flowArtUrl from "@/assets/pipeline-flow.png";
import { cn } from "@/lib/utils";
import { STAGE_COLOR, STAGE_ORDER, STAGE_SHORT, type FlowHealth, type FlowNode } from "./pipelineFlowModel";

const surface = "rounded-2xl border border-white/[0.07] bg-[#070a18]/70";

/* ───────────────────────── AI Executive Briefing ───────────────────────── */

export function PipelineBriefing({
  headline,
  body,
  needAttention,
  highPotential,
  conversionPct,
  wonCount,
  onViewAttention,
  onViewPotential,
}: {
  headline: string;
  body: string;
  needAttention: number;
  highPotential: number;
  conversionPct: number;
  wonCount: number;
  onViewAttention: () => void;
  onViewPotential: () => void;
}) {
  return (
    <section className={cn(surface, "relative overflow-hidden border-brand/25 px-5 py-4 shadow-[0_0_40px_-24px_var(--brand)]")}>
      <div className="grid items-center gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 items-start gap-4">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-2xl border border-brand/25 bg-brand/[0.12] text-brand"
          >
            <Sparkles className="size-6" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground">AI Executive Briefing</span>
              <span className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-1.5 py-px text-[10px] font-semibold text-success">
                <span className="size-1.5 rounded-full bg-success" /> Live
              </span>
            </div>
            <h2 className="mt-1.5 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-foreground">{headline}</h2>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x divide-white/[0.07] border-t border-white/[0.07] pt-4 lg:border-l lg:border-t-0 lg:pl-2 lg:pt-0">
          <BriefStat
            icon={<Clock className="size-[18px]" />}
            tint="#f59e0b"
            value={String(needAttention)}
            label="need attention"
            action={needAttention > 0 ? { label: "View", onClick: onViewAttention } : undefined}
          />
          <BriefStat
            icon={<BarChart3 className="size-[18px]" />}
            tint="#2dd4a8"
            value={String(highPotential)}
            label="high-potential"
            action={highPotential > 0 ? { label: "View", onClick: onViewPotential } : undefined}
          />
          <BriefStat
            icon={<TrendingUp className="size-[18px]" />}
            tint="#4f6bff"
            value={`${conversionPct}%`}
            label="conversion rate"
            hint={`${wonCount} won`}
          />
        </div>
      </div>
    </section>
  );
}

function BriefStat({
  icon,
  tint,
  value,
  label,
  action,
  hint,
}: {
  icon: React.ReactNode;
  tint: string;
  value: string;
  label: string;
  action?: { label: string; onClick: () => void };
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5 px-3 first:pl-0 lg:items-center lg:px-2">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          style={{ background: `${tint}26`, color: tint }}
          className="grid size-10 shrink-0 place-items-center rounded-full"
        >
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-[17px] font-semibold leading-none tabular-nums text-foreground">{value}</span>
          <span className="mt-1 block text-[11px] leading-none text-muted-foreground">{label}</span>
        </span>
      </div>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-foreground/90 transition-colors hover:border-white/25"
        >
          {action.label} <ArrowRight className="size-3" />
        </button>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── Pipeline Health ───────────────────────────── */

export function PipelineHealthStrip({ health }: { health: FlowHealth }) {
  const cells: { value: number | string; label: string; dot?: string; trend?: number | null; icon?: React.ReactNode }[] = [
    { value: health.total, label: "Total opportunities", icon: <Inbox className="size-[18px]" />, trend: health.totalTrendPct },
    { value: health.active, label: "Active", dot: "#3b82f6" },
    { value: health.stalled, label: "Stalled", dot: "#f59e0b" },
    { value: health.overdue, label: "Overdue", dot: "#ec4899" },
    { value: `${health.conversionPct}%`, label: "Conversion rate", icon: <TrendingUp className="size-[18px]" /> },
  ];
  return (
    <section className={cn(surface, "flex flex-wrap items-center gap-x-2 gap-y-3 px-5 py-3.5")}>
      <h2 className="mr-4 text-[15px] font-semibold text-foreground">Pipeline Health</h2>
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-y-3 sm:grid-cols-5">
        {cells.map((c, i) => (
          <div key={c.label} className={cn("flex min-w-0 items-center gap-3 px-2", i > 0 && "sm:border-l sm:border-white/[0.07] sm:pl-5")}>
            {c.dot ? (
              <span aria-hidden="true" style={{ background: c.dot, boxShadow: `0 0 8px ${c.dot}` }} className="size-2.5 shrink-0 rounded-full" />
            ) : (
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-muted-foreground">
                {c.icon}
              </span>
            )}
            <span className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="text-[19px] font-semibold leading-none tabular-nums text-foreground">{c.value}</span>
                {c.trend != null && (
                  <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", c.trend >= 0 ? "text-success" : "text-destructive")}>
                    {c.trend >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                    {c.trend >= 0 ? "+" : ""}
                    {c.trend}%
                  </span>
                )}
              </span>
              <span className="mt-1 block text-[11.5px] leading-none text-muted-foreground">{c.label}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────── The Flow (hero) ─────────────────────────────── */

// The flow's visual backbone is the supplied artwork (`pipeline-flow.png`, 2172 × 724, transparent).
// It is shown unmodified and scaled proportionally; everything else is positioned over it using
// coordinates measured from the artwork itself: its five circles and the top edge of the ribbon.
const ART = { w: 2172, h: 724 };
// Crop the artwork's empty top and bottom margins (no content is cut: it spans y 81 → 602).
const CROP = { y0: 60, y1: 640 };
const CROP_H = CROP.y1 - CROP.y0;
/** Centres of the five circles in the artwork, in artwork pixels. */
const ART_NODES = [
  { x: 305, y: 389.5 },
  { x: 723, y: 390.3 },
  { x: 1142, y: 394.6 },
  { x: 1558, y: 395 },
  { x: 1957, y: 397.2 },
];
/** Where an alert pins to the ribbon's upper edge beside each circle (artwork px). */
const ART_ANCHORS = [
  { x: 403, y: 221 },
  { x: 821, y: 163 },
  { x: 1240, y: 232 },
  { x: 1656, y: 267 },
  { x: 1859, y: 306 },
];
const xPct = (x: number) => (x / ART.w) * 100;
const yPct = (y: number) => ((y - CROP.y0) / CROP_H) * 100;

const ALERT_COLOR = { bottleneck: "#f59e0b", low: "#ec4899", good: "#34d399" } as const;

/** Three rising bars; the taller they are, the better the stage converts. */
function MiniBars({ pct, color }: { pct: number; color: string }) {
  const fill = Math.max(0.25, Math.min(1, pct / 100));
  const heights = [0.4, 0.68, 1].map((k) => Math.round(8 + 14 * k * (0.45 + 0.55 * fill)));
  return (
    <span aria-hidden="true" className="flex h-[22px] items-end gap-[3px]">
      {heights.map((h, i) => (
        <span key={i} style={{ height: h, background: color, opacity: 0.5 + i * 0.25 }} className="w-[4px] rounded-[2px]" />
      ))}
    </span>
  );
}

const CARD_W = 128;
const CARD_H = 44;

export function PipelineFlowHero({
  nodes,
  loading,
  onSelect,
}: {
  nodes: FlowNode[];
  loading: boolean;
  onSelect: (stage: FlowStage) => void;
}) {
  return (
    <section aria-label="Pipeline flow" className="relative">
      <div className="overflow-x-auto">
        {/* container-type lets the type and node sizes below scale with the artwork (cqw) */}
        <div
          className="relative mx-auto min-w-[760px] max-w-[1320px]"
          style={{ aspectRatio: `${ART.w} / ${CROP_H}`, containerType: "inline-size" }}
        >
          {/* the artwork: the visual backbone, untouched */}
          <img
            src={flowArtUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute left-0 w-full max-w-none select-none"
            style={{ top: `${-(CROP.y0 / CROP_H) * 100}%`, height: `${(ART.h / CROP_H) * 100}%` }}
          />

          {/* movement between stages, centred between two circles on the ribbon's centre line */}
          {!loading &&
            nodes.slice(0, -1).map((n, i) => (
              <div
                key={n.stage}
                style={{
                  left: `${xPct((ART_NODES[i].x + ART_NODES[i + 1].x) / 2)}%`,
                  top: `${yPct((ART_NODES[i].y + ART_NODES[i + 1].y) / 2)}%`,
                  color: STAGE_COLOR[STAGE_ORDER[i + 1]],
                  fontSize: "clamp(12px, 1.1cqw, 15px)",
                }}
                className="pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 font-medium tabular-nums"
              >
                {n.toNextPct ?? 0}%
                <ArrowRight className="size-[1.2em]" strokeWidth={2.2} />
              </div>
            ))}

          {/* alerts: a small card pinned to the ribbon edge beside its stage by a dotted line */}
          {!loading &&
            nodes.map((n, i) => {
              if (!n.alert) return null;
              const ac = ALERT_COLOR[n.alert.kind];
              const flip = i === nodes.length - 1; // the last stage pins to its left so the card stays in view
              const ax = xPct(ART_ANCHORS[i].x);
              const ay = yPct(ART_ANCHORS[i].y);
              return (
                <div key={`a-${n.stage}`} className="pointer-events-none absolute inset-0 z-10">
                  <div
                    style={{
                      left: `${ax}%`,
                      top: 4,
                      width: CARD_W,
                      transform: flip ? "translateX(calc(-100% + 14px))" : "translateX(-14px)",
                    }}
                    className="absolute rounded-lg border border-white/10 bg-[#0a0d20]/90 px-3 py-1.5"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                      <span style={{ background: ac }} className="size-1.5 shrink-0 rounded-full" />
                      <span className="truncate">{n.alert.title}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground">{n.alert.sub}</div>
                  </div>
                  <span
                    aria-hidden="true"
                    style={{
                      left: `${ax}%`,
                      top: 4 + CARD_H,
                      height: `max(0px, calc(${ay}% - ${4 + CARD_H + 3}px))`,
                      borderColor: `${ac}80`,
                    }}
                    className="absolute -translate-x-1/2 border-l border-dashed"
                  />
                  <span
                    aria-hidden="true"
                    style={{ left: `${ax}%`, top: `calc(${ay}% - 3px)`, background: ac, boxShadow: `0 0 6px ${ac}` }}
                    className="absolute size-1.5 -translate-x-1/2 rounded-full"
                  />
                </div>
              );
            })}

          {/* the five stages, each centred on its circle in the artwork */}
          {STAGE_ORDER.map((stage, i) => {
            const n = nodes[i];
            const node = ART_NODES[i];
            const last = i === STAGE_ORDER.length - 1;
            return (
              <div key={stage}>
                {/* stage name, just above the circle */}
                <span
                  style={{
                    left: `${xPct(node.x)}%`,
                    top: `${yPct(node.y)}%`,
                    transform: "translate(-50%, calc(-100% - 4.1cqw))",
                    fontSize: "clamp(12px, 1.05cqw, 14.5px)",
                  }}
                  className="pointer-events-none absolute z-20 whitespace-nowrap font-medium leading-none text-foreground"
                >
                  {STAGE_SHORT[stage]}
                </span>

                {/* the count sits inside the artwork's circle (the ring itself is part of the artwork) */}
                {loading || !n ? (
                  <Skeleton
                    style={{ left: `${xPct(node.x)}%`, top: `${yPct(node.y)}%`, width: "5.2cqw", height: "5.2cqw" }}
                    className="absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelect(stage)}
                    aria-label={`${n.label}: ${n.count} opportunities. Open stage details`}
                    style={{
                      left: `${xPct(node.x)}%`,
                      top: `${yPct(node.y)}%`,
                      width: "6.4cqw",
                      height: "6.4cqw",
                      fontSize: "clamp(16px, 1.75cqw, 24px)",
                    }}
                    className="absolute z-20 grid -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full font-semibold tabular-nums text-foreground outline-none transition-transform duration-200 hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-brand/60"
                  >
                    {n.count.toLocaleString()}
                  </button>
                )}

                {/* stage performance, under the circle */}
                {!loading && n && (
                  <div
                    style={{
                      left: `${xPct(node.x)}%`,
                      top: `${yPct(node.y)}%`,
                      width: "clamp(124px, 12.4cqw, 168px)",
                      transform: "translate(-50%, 4.6cqw)",
                    }}
                    className="pointer-events-none absolute z-20 flex items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#080b1c]/85 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold leading-none tabular-nums text-foreground">
                        {n.toNextPct ?? 0}%
                      </span>
                      <span className="mt-1 block whitespace-nowrap text-[10.5px] leading-none text-muted-foreground">
                        {last ? "win rate" : `move to ${n.nextLabel}`}
                      </span>
                    </span>
                    <MiniBars pct={n.toNextPct ?? 0} color={n.color} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────── AI Sales Coach ─────────────────────────────── */

export type CoachCard = {
  id: string;
  tone: "priority" | "growth" | "upcoming" | "next";
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  /** Stages this recommendation is relevant to (drives the stage filter). */
  stages: FlowStage[];
};

const TONE = {
  priority: { tag: "Priority", color: "#f59e0b", icon: Clock },
  growth: { tag: "Growth", color: "#2dd4a8", icon: TrendingUp },
  upcoming: { tag: "Upcoming", color: "#8b5cf6", icon: CalendarCheck },
  next: { tag: "Next step", color: "#4f6bff", icon: Inbox },
} as const;

export function PipelineCoach({
  cards,
  counts,
  loading,
}: {
  cards: CoachCard[];
  counts: Record<FlowStage, number>;
  loading: boolean;
}) {
  const [stage, setStage] = useState<FlowStage | "all">("all");
  const shown = useMemo(() => (stage === "all" ? cards : cards.filter((c) => c.stages.includes(stage))), [cards, stage]);
  const pills: { id: FlowStage | "all"; label: string; count?: number }[] = [
    { id: "all", label: "All stages" },
    ...STAGE_ORDER.map((s) => ({ id: s, label: STAGE_SHORT[s], count: counts[s] })),
  ];

  return (
    <section className={cn(surface, "px-5 py-4")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl border border-brand/25 bg-brand/[0.12] text-brand">
            <Sparkles className="size-5" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-tight text-foreground">AI Sales Coach</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Personalized insights to help you move opportunities forward.</p>
          </div>
        </div>
        <div role="tablist" aria-label="Filter by stage" className="flex flex-wrap gap-1.5">
          {pills.map((p) => {
            const on = stage === p.id;
            return (
              <button
                key={p.id}
                role="tab"
                aria-selected={on}
                type="button"
                onClick={() => setStage(p.id)}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors",
                  on ? "border-brand/50 bg-brand/[0.16] text-foreground" : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                )}
              >
                {p.label}
                {p.count !== undefined && (
                  <span className="rounded-full bg-white/[0.07] px-1.5 py-px text-[10px] tabular-nums">{p.count.toLocaleString()}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {loading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-[112px] rounded-xl" />)
        ) : shown.length === 0 ? (
          <p className="col-span-full rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-muted-foreground">
            Nothing needs your attention in {stage === "all" ? "any stage" : STAGE_SHORT[stage]} right now.
          </p>
        ) : (
          shown.slice(0, 3).map((c) => {
            const t = TONE[c.tone];
            const Icon = t.icon;
            return (
              <article
                key={c.id}
                style={{ backgroundImage: `radial-gradient(120% 100% at 0% 0%, ${t.color}14, transparent 60%)` }}
                className="flex min-w-0 gap-3 rounded-xl border border-white/[0.08] bg-black/20 p-3.5"
              >
                <span
                  aria-hidden="true"
                  style={{ background: `${t.color}22`, color: t.color }}
                  className="grid size-11 shrink-0 place-items-center rounded-full"
                >
                  <Icon className="size-5" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <span
                    style={{ color: t.color, borderColor: `${t.color}40`, background: `${t.color}12` }}
                    className="inline-block rounded-md border px-1.5 py-px text-[10px] font-medium"
                  >
                    {t.tag}
                  </span>
                  <h3 className="mt-1 text-[14px] font-semibold leading-snug text-foreground">{c.title}</h3>
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{c.body}</p>
                  <button
                    type="button"
                    onClick={c.onAction}
                    style={{ borderColor: `${t.color}55` }}
                    className="mt-2.5 inline-flex cursor-pointer items-center gap-2 rounded-lg border bg-white/[0.02] px-3 py-1.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
                  >
                    {c.action} <ArrowRight className="size-3.5" />
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
