/**
 * Presentational pieces of the Pipeline "Flow" view: executive briefing, health strip,
 * the connected flow ribbon (the hero) and the sales coach. No opportunity cards live
 * here; those belong to the Kanban view only. Data comes from pipelineFlowModel.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CalendarCheck,
  CalendarDays,
  Clock,
  FileText,
  Mail,
  MessageCircleMore,
  Sparkles,
  Trophy,
  TrendingDown,
  TrendingUp,
  Inbox,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { FlowStage } from "@/lib/lead-workspace";
import { cn } from "@/lib/utils";
import forestUrl from "@/assets/pipeline-forest-background.webp";
import { ForestFlowArt } from "./ForestFlowArt";
import { BG, CALLOUTS, CROP, CROP_H, STAGES, px, xPct, yPct } from "./forestFlow";
import { STAGE_ORDER, STAGE_SHORT, type FlowHealth, type FlowNode } from "./pipelineFlowModel";

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

// The Flow is a journey through a night forest: five stone pedestals joined by lit bridges, from New
// (purple) to Closed (white). The forest is a picture; the glowing path and rings are SVG drawn over
// it (ForestFlowArt), and the stage markers, counts and conversion callouts are HTML positioned over
// both in the picture's own pixel space (see forestFlow.ts), so everything lines up at any width.

const STAGE_ICON = [FileText, Mail, MessageCircleMore, CalendarDays, Trophy] as const;

/** Counts up to `value` (and between values when it changes) so numbers arrive, not just appear. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 900);
      const eased = 1 - (1 - t) ** 3;
      const v = Math.round(a + (value - a) * eased);
      from.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toLocaleString()}</>;
}

/** The glass tile that floats above a pedestal, in the stage colour. */
function StageTile({ color, core, Icon }: { color: string; core: string; Icon: (typeof STAGE_ICON)[number] }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: px(62),
        height: px(62),
        borderRadius: px(15),
        border: `${px(2.4)} solid ${color}`,
        background: `linear-gradient(155deg, ${color}8c 0%, ${color}33 38%, rgba(6,8,24,0.9) 100%)`,
        boxShadow: `0 0 ${px(26)} ${color}b3, 0 0 ${px(7)} ${color}, inset 0 0 ${px(15)} ${color}66`,
        color: core,
      }}
      className="grid shrink-0 place-items-center backdrop-blur-[2px] transition-[box-shadow,transform] duration-300 group-hover:-translate-y-[3%]"
    >
      <Icon style={{ width: "54%", height: "54%", filter: `drop-shadow(0 0 4px ${color})` }} strokeWidth={1.9} />
    </span>
  );
}

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
    <section aria-label="Pipeline flow" className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#050818]">
      {/* On narrow screens the map keeps its size and scrolls sideways, so the labels stay legible. */}
      <div className="overflow-x-auto">
        {/* container-type lets the type and marker sizes below scale with the picture (cqw) */}
        <div
          className="relative w-full min-w-[980px]"
          style={{ aspectRatio: `${BG.w} / ${CROP_H}`, containerType: "inline-size" }}
        >
          {/* the forest */}
          <img
            src={forestUrl}
            alt=""
            aria-hidden="true"
            decoding="async"
            draggable={false}
            className="pointer-events-none absolute left-0 w-full max-w-none select-none"
            style={{ top: `${-(CROP.y0 / CROP_H) * 100}%` }}
          />

          {/* night grade, and a fade into the page at the bottom and the top */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(to top, rgba(5,8,24,0.92) 0%, rgba(5,8,24,0) 15%), linear-gradient(to bottom, rgba(5,8,24,0.5) 0%, rgba(5,8,24,0) 9%), radial-gradient(ellipse 80% 78% at 50% 48%, rgba(5,8,24,0) 55%, rgba(5,8,24,0.5) 100%), rgba(4,6,22,0.12)",
            }}
          />

          {/* the glowing journey and the rings */}
          <ForestFlowArt />

          {/* stage-to-stage conversion, beside each bridge */}
          {!loading &&
            CALLOUTS.map(([x, y], i) => {
              const color = STAGES[i].color;
              return (
                <div
                  key={`conv-${i}`}
                  aria-label={`${nodes[i]?.label ?? ""} to ${nodes[i + 1]?.label ?? ""}: ${nodes[i]?.toNextPct ?? 0}%`}
                  style={{
                    left: `${xPct(x)}%`,
                    top: `${yPct(y)}%`,
                    padding: `${px(10)} ${px(16)}`,
                    borderRadius: px(14),
                    boxShadow: `0 ${px(8)} ${px(24)} -${px(10)} #000, inset 0 1px 0 rgba(255,255,255,0.06)`,
                    animationDelay: `${300 + i * 110}ms`,
                  }}
                  className="pf-rise pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 border border-white/[0.12] bg-[#080b1e]/72 backdrop-blur-[3px]"
                >
                  <span
                    style={{ color, fontSize: "clamp(12px, 1.3cqw, 22px)", textShadow: `0 0 12px ${color}88` }}
                    className="flex items-center gap-[0.35em] font-semibold leading-none tabular-nums"
                  >
                    {nodes[i]?.toNextPct ?? 0}%
                    <ArrowRight className="size-[0.95em]" strokeWidth={2.2} />
                  </span>
                  <span
                    style={{ fontSize: "clamp(9px, 0.82cqw, 14px)", marginTop: px(7) }}
                    className="block whitespace-nowrap leading-none text-white/70"
                  >
                    to next stage
                  </span>
                </div>
              );
            })}

          {/* the five stages: a tile floating above each pedestal, its name and count on the stone */}
          {STAGE_ORDER.map((stage, i) => {
            const n = nodes[i];
            const s = STAGES[i];
            const Icon = STAGE_ICON[i];
            const content = (
              <>
                <StageTile color={s.color} core={s.core} Icon={Icon} />
                <span
                  style={{ fontSize: "clamp(11px, 1.12cqw, 19px)", marginTop: px(25), textShadow: "0 1px 6px rgba(0,0,0,0.9)" }}
                  className="block whitespace-nowrap font-medium leading-none text-white"
                >
                  {STAGE_SHORT[stage]}
                </span>
                {loading || !n ? (
                  <Skeleton style={{ width: px(70), height: px(34), marginTop: px(5) }} className="rounded-lg bg-white/15" />
                ) : (
                  <span
                    style={{ fontSize: "clamp(19px, 2.15cqw, 36px)", marginTop: px(5), textShadow: "0 2px 10px rgba(0,0,0,0.9)" }}
                    className="block font-bold leading-none tabular-nums text-white"
                  >
                    <CountUp value={n.count} />
                  </span>
                )}
              </>
            );
            const place = {
              left: `${xPct(s.top[0])}%`,
              top: `${yPct(s.top[1] - 65)}%`,
              width: px(150),
              ["--stage" as string]: s.color,
            };
            const base = "absolute z-30 flex -translate-x-1/2 flex-col items-center rounded-2xl";
            return loading || !n ? (
              <div key={stage} style={place} className={base}>
                {content}
              </div>
            ) : (
              <button
                key={stage}
                type="button"
                onClick={() => onSelect(stage)}
                aria-label={`${n.label}: ${n.count} opportunities. Open stage details`}
                style={place}
                className={cn(
                  base,
                  "group cursor-pointer outline-none transition-transform duration-300 hover:scale-[1.05] focus-visible:ring-2 focus-visible:ring-brand/60",
                )}
              >
                {content}
              </button>
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
