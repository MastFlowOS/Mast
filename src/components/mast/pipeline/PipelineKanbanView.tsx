/**
 * Presentational pieces of the Pipeline "Kanban" view: executive briefing banner, filter bar,
 * the five stage columns with opportunity cards, and the AI Sales Coach side panel.
 *
 * Everything here is driven by props (the route owns data, filters and mutations) and by the
 * shared pipelineFlowModel, so the numbers match the Flow view exactly.
 */
import { useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CalendarCheck,
  ChevronDown,
  Clock,
  Inbox,
  LayoutGrid,
  List,
  MessageSquare,
  MoreHorizontal,
  Search,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { Lead } from "@/lib/api";
import { FLOW_STAGES, type FlowStage } from "@/lib/lead-workspace";
import { cn } from "@/lib/utils";
import { countryOf, SCORE_BANDS, sourceLabel, timeAgo, type ScoreBand } from "./kanbanHelpers";
import type { FlowNode } from "./pipelineFlowModel";

/* ─────────────────────────────── helpers ─────────────────────────────── */

const surface = "rounded-2xl border border-white/[0.08] bg-[#080c22]/80";

const LOGO_TONES: [string, string][] = [
  ["#8b5cf6", "#4f46e5"],
  ["#f97316", "#ea580c"],
  ["#0ea5e9", "#2563eb"],
  ["#14b8a6", "#0f766e"],
  ["#ec4899", "#be185d"],
  ["#f59e0b", "#b45309"],
  ["#22c55e", "#15803d"],
  ["#64748b", "#334155"],
];

function logoFor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials = ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
  return { initials, tone: LOGO_TONES[h % LOGO_TONES.length] };
}

const STAGE_ICON = {
  new: Sparkles,
  contacted: Send,
  replied: MessageSquare,
  meeting: CalendarCheck,
  won: Trophy,
} as const;
const STAGE_NICHE = (n?: string | null) =>
  n ? n.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";

/* ─────────────────────────── Executive briefing ─────────────────────────── */

export function KanbanBriefing({
  headline,
  body,
  total,
  totalTrendPct,
  conversionPct,
  highPotential,
  needAttention,
  onClose,
  onViewAttention,
  onViewPotential,
}: {
  headline: string;
  body: string;
  total: number;
  totalTrendPct: number | null;
  conversionPct: number;
  highPotential: number;
  needAttention: number;
  onClose: () => void;
  onViewAttention: () => void;
  onViewPotential: () => void;
}) {
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-brand/40 px-6 py-5 shadow-[0_0_44px_-22px_var(--brand)]"
      style={{
        background:
          "linear-gradient(100deg, rgba(88,60,200,0.30) 0%, rgba(20,22,70,0.55) 38%, rgba(8,12,34,0.85) 100%)",
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss briefing"
        className="absolute right-3 top-3 grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
      >
        <X className="size-4" />
      </button>

      <div className="grid items-center gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-5">
          <span
            aria-hidden="true"
            className="relative grid size-[76px] shrink-0 place-items-center text-brand"
          >
            <span className="absolute inset-0 rounded-full bg-brand/30 blur-2xl" />
            <Sparkles
              className="relative size-[60px] drop-shadow-[0_0_14px_var(--brand)]"
              strokeWidth={1.3}
            />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-medium text-foreground/90">
                AI Executive Briefing
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-1.5 py-px text-[10.5px] font-semibold text-success">
                <span className="size-1.5 rounded-full bg-success" /> Live
              </span>
            </div>
            <h2 className="mt-1.5 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
              {headline}
            </h2>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-y-4 border-t border-white/[0.08] pt-4 sm:grid-cols-4 sm:divide-x sm:divide-white/[0.08] xl:border-t-0 xl:pt-0">
          <Stat
            icon={<Inbox className="size-5" />}
            tint="#a5b4fc"
            value={total.toLocaleString()}
            label="Total"
          />
          <Stat
            icon={<TrendingUp className="size-5" />}
            tint="#2dd4a8"
            value={`${conversionPct}%`}
            label="Conversion"
            trend={totalTrendPct}
          />
          <Stat
            icon={<BarChart3 className="size-5" />}
            tint="#2dd4a8"
            value={String(highPotential)}
            label="High-potential"
            onClick={highPotential > 0 ? onViewPotential : undefined}
          />
          <Stat
            icon={<Clock className="size-5" />}
            tint="#f59e0b"
            value={String(needAttention)}
            label="Need attention"
            onClick={needAttention > 0 ? onViewAttention : undefined}
          />
        </div>
      </div>
    </section>
  );
}

function Stat({
  icon,
  tint,
  value,
  label,
  trend,
  onClick,
}: {
  icon: React.ReactNode;
  tint: string;
  value: string;
  label: string;
  trend?: number | null;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col items-center gap-2 px-2 text-center",
        onClick && "cursor-pointer rounded-xl transition-colors hover:bg-white/[0.03]",
      )}
    >
      <span
        aria-hidden="true"
        style={{ background: `${tint}22`, color: tint }}
        className="grid size-11 place-items-center rounded-full"
      >
        {icon}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-foreground">
          {value}
        </span>
        {trend != null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px] font-medium",
              trend >= 0 ? "text-success" : "text-destructive",
            )}
          >
            {trend >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {Math.abs(trend)}%
          </span>
        )}
      </span>
      <span className="-mt-1 whitespace-nowrap text-[11.5px] leading-none text-muted-foreground">
        {label}
      </span>
    </Tag>
  );
}

/* ───────────────────────────── Filter bar ───────────────────────────── */

function FilterSelect({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: { value: string; label: string }[];
}) {
  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label;
  const active = options[0]?.value !== value;
  return (
    <label
      className={cn(
        "relative inline-flex h-11 min-w-[128px] items-center rounded-xl border bg-white/[0.03] pl-3.5 pr-9 text-[13px] text-foreground/90 transition-colors hover:border-white/25",
        active ? "border-brand/50" : "border-white/10",
      )}
    >
      <span className="truncate">{current}</span>
      <ChevronDown className="pointer-events-none absolute right-3 size-4 text-muted-foreground" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#0a0d20] text-foreground">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export type Density = "comfortable" | "compact";

export function KanbanFilterBar({
  query,
  onQuery,
  source,
  onSource,
  sources,
  niche,
  onNiche,
  niches,
  score,
  onScore,
  activity,
  onActivity,
  density,
  onDensity,
  hasActiveFilters,
  onClear,
  hiddenPanels,
}: {
  query: string;
  onQuery: (v: string) => void;
  source: string;
  onSource: (v: string) => void;
  sources: string[];
  niche: string;
  onNiche: (v: string) => void;
  niches: string[];
  score: ScoreBand;
  onScore: (v: ScoreBand) => void;
  activity: string;
  onActivity: (v: string) => void;
  density: Density;
  onDensity: (v: Density) => void;
  hasActiveFilters: boolean;
  onClear: () => void;
  /** Buttons to bring back a dismissed briefing / coach panel. */
  hiddenPanels: { id: string; label: string; onClick: () => void }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <label className="flex h-11 min-w-[220px] flex-1 items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 text-muted-foreground focus-within:border-brand/50">
        <Search className="size-4 shrink-0" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search opportunities…"
          aria-label="Search board"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>

      <FilterSelect
        label="Filter by source"
        value={source}
        onChange={onSource}
        options={[
          { value: "all", label: "All sources" },
          ...sources.map((s) => ({ value: s, label: sourceLabel(s) ?? s })),
        ]}
      />
      <FilterSelect
        label="Filter by niche"
        value={niche}
        onChange={onNiche}
        options={[
          { value: "all", label: "All niches" },
          ...niches.map((n) => ({ value: n, label: STAGE_NICHE(n) })),
        ]}
      />
      <FilterSelect
        label="Filter by score"
        value={score}
        onChange={(v) => onScore(v as ScoreBand)}
        options={SCORE_BANDS.map((b) => ({ value: b.id, label: b.label }))}
      />
      <FilterSelect
        label="Filter by last activity"
        value={activity}
        onChange={onActivity}
        options={[
          { value: "all", label: "All time" },
          { value: "1", label: "Last 24 hours" },
          { value: "7", label: "Last 7 days" },
          { value: "30", label: "Last 30 days" },
        ]}
      />

      {hasActiveFilters && (
        <button
          type="button"
          onClick={onClear}
          className="h-11 cursor-pointer px-1.5 text-[12.5px] font-medium text-brand hover:underline"
        >
          Clear
        </button>
      )}

      {hiddenPanels.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={p.onClick}
          className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-brand/40 bg-brand/[0.1] px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-brand/[0.18]"
        >
          <Sparkles className="size-4 text-brand" /> {p.label}
        </button>
      ))}

      <div
        role="group"
        aria-label="Card density"
        className="flex h-11 items-center rounded-xl border border-white/10 bg-white/[0.03] p-1"
      >
        {(
          [
            ["comfortable", List, "Detailed cards"],
            ["compact", LayoutGrid, "Compact cards"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={density === id}
            title={label}
            onClick={() => onDensity(id)}
            className={cn(
              "grid size-9 cursor-pointer place-items-center rounded-lg transition-colors",
              density === id
                ? "bg-white/[0.09] text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" />
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── Board ─────────────────────────────── */

function ScoreRing({ score }: { score: number | null | undefined }) {
  const has = score != null;
  const v = has ? Math.max(0, Math.min(100, Math.round(score as number))) : 0;
  const color = !has ? "#64748b" : v >= 80 ? "#34d399" : v >= 60 ? "#4f6bff" : "#f59e0b";
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative grid size-[34px] shrink-0 place-items-center"
      title={has ? `Opportunity score ${v}` : "Not scored yet"}
      aria-label={has ? `Opportunity score ${v}` : "Not scored yet"}
    >
      <svg viewBox="0 0 38 38" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle
          cx="19"
          cy="19"
          r={r}
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="3"
        />
        {has && (
          <circle
            cx="19"
            cy="19"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(c * v) / 100} ${c}`}
            style={{ filter: `drop-shadow(0 0 3px ${color}99)` }}
          />
        )}
      </svg>
      <span className="relative text-[11px] font-semibold tabular-nums text-foreground">
        {has ? v : "–"}
      </span>
    </span>
  );
}

const tagCls =
  "rounded-md border border-white/[0.1] bg-white/[0.05] px-1.5 py-[3px] text-[10.5px] leading-none text-foreground/80";

function KanbanCard({
  lead,
  stage,
  color,
  density,
  dragging,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  lead: Lead;
  stage: FlowStage;
  color: string;
  density: Density;
  dragging: boolean;
  onOpen: () => void;
  onMove: (to: FlowStage) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const logo = logoFor(lead.businessName);
  const src = sourceLabel(lead.source);
  const country = countryOf(lead.location);
  const compact = density === "compact";
  const ago = timeAgo(lead.updatedAt);

  return (
    <article
      draggable
      tabIndex={0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{ ["--stage" as string]: color }}
      className={cn(
        "group cursor-grab select-none rounded-xl border border-white/[0.08] bg-[#0a0e28]/90 transition-all duration-200 active:cursor-grabbing",
        "hover:border-[color:var(--stage)]/60 hover:bg-[#0d1232] hover:shadow-[0_8px_24px_-14px_var(--stage)]",
        "focus-visible:border-[color:var(--stage)] focus-visible:outline-none",
        compact ? "p-2.5" : "p-3",
        dragging && "scale-[0.97] opacity-40",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          style={{ background: `linear-gradient(145deg, ${logo.tone[0]}, ${logo.tone[1]})` }}
          className={cn(
            "grid shrink-0 place-items-center rounded-xl text-[13px] font-bold text-white shadow-inner",
            compact ? "size-8" : "size-10",
          )}
        >
          {logo.initials}
        </span>
        <div className="min-w-0 flex-1">
          <h4
            title={lead.businessName}
            className="line-clamp-2 break-words text-[13px] font-semibold leading-tight text-foreground"
          >
            {lead.businessName}
          </h4>
          <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
            {STAGE_NICHE(lead.niche) ||
              (lead.instagramHandle ? `@${lead.instagramHandle.replace(/^@/, "")}` : "—")}
          </p>
        </div>
        <ScoreRing score={lead.opportunityScore} />
      </div>

      <div className={cn("flex items-center gap-2", compact ? "mt-2" : "mt-3")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${lead.businessName}`}
              onClick={(e) => e.stopPropagation()}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onOpen}>Open workspace</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
              Move to
            </DropdownMenuLabel>
            {FLOW_STAGES.filter((s) => s.value !== stage).map((s) => (
              <DropdownMenuItem key={s.value} onSelect={() => onMove(s.value)}>
                {s.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {!compact && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {src && <span className={cn(tagCls, "truncate")}>{src}</span>}
            {country && <span className={cn(tagCls, "shrink-0")}>{country}</span>}
          </div>
        )}
        {compact && <span className="flex-1" />}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {ago}
        </span>
      </div>
    </article>
  );
}

function MiniBars({ color, pct }: { color: string; pct: number }) {
  const fill = Math.max(0.3, Math.min(1, pct / 100));
  return (
    <span aria-hidden="true" className="flex h-[22px] items-end gap-[3px]">
      {[0.4, 0.68, 1].map((k, i) => (
        <span
          key={i}
          style={{
            height: Math.round(8 + 14 * k * (0.45 + 0.55 * fill)),
            background: color,
            opacity: 0.55 + i * 0.22,
            animationDelay: `${200 + i * 90}ms`,
          }}
          className="pf-bar w-[4px] rounded-[2px]"
        />
      ))}
    </span>
  );
}

export function KanbanColumn({
  node,
  count,
  leads,
  loading,
  shown,
  loadedTotal,
  density,
  draggingId,
  isOver,
  onShowMore,
  onViewAll,
  onOpenLead,
  onMoveLead,
  onDragStartLead,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  node: FlowNode;
  /** Header count (server-authoritative when the board is unfiltered). */
  count: number;
  /** Leads in this column that match the filters, already sorted. */
  leads: Lead[];
  loading: boolean;
  shown: number;
  loadedTotal: number;
  density: Density;
  draggingId: number | null;
  isOver: boolean;
  onShowMore: () => void;
  onViewAll: () => void;
  onOpenLead: (id: number) => void;
  onMoveLead: (id: number, to: FlowStage) => void;
  onDragStartLead: (id: number) => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}) {
  const c = node.color;
  const Icon = STAGE_ICON[node.stage];
  const visible = leads.slice(0, shown);
  const remaining = leads.length - visible.length;
  const isLast = node.nextLabel == null;

  return (
    <section
      aria-label={`${node.label} stage`}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDragLeave();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      style={{
        borderColor: `${c}${isOver ? "ff" : "66"}`,
        background: `linear-gradient(180deg, ${c}${isOver ? "26" : "14"} 0%, rgba(8,12,34,0.55) 55%)`,
        boxShadow: isOver ? `0 0 0 1px ${c}, 0 0 36px -10px ${c}` : `0 0 32px -22px ${c}`,
      }}
      className="flex min-w-0 flex-col rounded-2xl border transition-all duration-200"
    >
      <div
        className="rounded-t-2xl px-4 pb-3 pt-3.5"
        style={{ background: `linear-gradient(180deg, ${c}40, ${c}0d)` }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              style={{ background: `${c}38`, color: "#fff", boxShadow: `inset 0 0 0 1px ${c}80` }}
              className="grid size-9 shrink-0 place-items-center rounded-full"
            >
              <Icon className="size-[18px]" strokeWidth={1.9} />
            </span>
            <h3 className="truncate text-[15px] font-semibold text-foreground">{node.label}</h3>
          </div>
          <span
            style={{ background: `${c}40`, color: "#fff" }}
            className="rounded-lg px-2.5 py-1 text-[12.5px] font-semibold tabular-nums"
          >
            {count.toLocaleString()}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span
            style={{ color: c }}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold tabular-nums"
            title={
              isLast ? "Share of all opportunities that are closed" : `Move on to ${node.nextLabel}`
            }
          >
            {node.toNextPct ?? 0}%{!isLast && <ArrowRight className="size-3.5" />}
          </span>
          <MiniBars color={c} pct={node.toNextPct ?? 0} />
        </div>
      </div>

      <div className="flex min-h-[120px] flex-1 flex-col gap-2.5 p-2.5">
        {loading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-[92px] rounded-xl" />)
        ) : visible.length === 0 ? (
          <div className="grid flex-1 place-items-center rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {isOver ? "Drop to move here" : "No opportunities in this stage."}
            </p>
          </div>
        ) : (
          visible.map((lead) => (
            <KanbanCard
              key={lead.id}
              lead={lead}
              stage={node.stage}
              color={c}
              density={density}
              dragging={draggingId === lead.id}
              onOpen={() => onOpenLead(lead.id)}
              onMove={(to) => onMoveLead(lead.id, to)}
              onDragStart={() => onDragStartLead(lead.id)}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>

      {!loading && (remaining > 0 || count > loadedTotal) && (
        <div className="px-4 pb-3.5 pt-0.5">
          {remaining > 0 ? (
            <button
              type="button"
              onClick={onShowMore}
              style={{ color: c }}
              className="cursor-pointer text-[12.5px] font-medium hover:underline"
            >
              + {remaining.toLocaleString()} more opportunities
            </button>
          ) : (
            <button
              type="button"
              onClick={onViewAll}
              style={{ color: c }}
              className="cursor-pointer text-[12.5px] font-medium hover:underline"
            >
              View all {count.toLocaleString()} →
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The five columns; wide screens fit all five, narrower ones scroll sideways inside this container. */
export function KanbanBoard({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <div className="grid min-w-[1120px] grid-cols-5 items-stretch gap-3.5">{children}</div>
    </div>
  );
}

/* ───────────────────────────── AI Sales Coach ───────────────────────────── */

export type CoachInsight = {
  id: string;
  tone: "priority" | "growth" | "upcoming" | "next";
  title: string;
  body: string;
  action: string;
  onAction: () => void;
};
export type CoachAction = { id: number; name: string; reason: string; onOpen: () => void };
export type CoachStrategy = { id: string; title: string; body: string };
export type CoachSuggestion = {
  id: string;
  icon: "send" | "message" | "target";
  title: string;
  sub: string;
  onClick: () => void;
};
export type CoachTab = "insights" | "actions" | "strategy";

const INSIGHT_TONE = {
  priority: { color: "#f59e0b", icon: Clock },
  growth: { color: "#2dd4a8", icon: TrendingUp },
  upcoming: { color: "#8b5cf6", icon: CalendarCheck },
  next: { color: "#4f6bff", icon: Inbox },
} as const;
const SUGGESTION_ICON = { send: Send, message: MessageSquare, target: TrendingUp } as const;

export function KanbanCoachPanel({
  insights,
  actions,
  actionsTotal,
  strategy,
  suggestions,
  loading,
  onClose,
}: {
  insights: CoachInsight[];
  actions: CoachAction[];
  actionsTotal: number;
  strategy: CoachStrategy[];
  suggestions: CoachSuggestion[];
  loading: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<CoachTab>("insights");
  const tabs: { id: CoachTab; label: string }[] = [
    { id: "insights", label: "Insights" },
    { id: "actions", label: actionsTotal > 0 ? `Actions (${actionsTotal})` : "Actions" },
    { id: "strategy", label: "Strategy" },
  ];

  return (
    <aside className={cn(surface, "flex flex-col p-4")} aria-label="AI Sales Coach">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center text-brand drop-shadow-[0_0_12px_var(--brand)]"
          >
            <Sparkles className="size-8" strokeWidth={1.5} />
          </span>
          <h2 className="text-[17px] font-semibold text-foreground">AI Sales Coach</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AI Sales Coach"
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Coach sections"
        className="mt-4 flex gap-1 border-b border-white/[0.08]"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px cursor-pointer rounded-t-lg border-b-2 px-3.5 py-2 text-[12.5px] font-medium transition-colors",
              tab === t.id
                ? "border-brand bg-white/[0.05] text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3 2xl:grid-cols-1">
        {tab === "insights" &&
          (loading
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-[132px] rounded-xl" />)
            : insights.map((c) => {
                const t = INSIGHT_TONE[c.tone];
                const Icon = t.icon;
                return (
                  <article
                    key={c.id}
                    style={{
                      backgroundImage: `radial-gradient(120% 100% at 0% 0%, ${t.color}1a, transparent 62%)`,
                    }}
                    className="flex gap-3 rounded-xl border border-white/[0.08] bg-black/20 p-3"
                  >
                    <span
                      aria-hidden="true"
                      style={{ background: `${t.color}24`, color: t.color }}
                      className="grid size-11 shrink-0 place-items-center rounded-full"
                    >
                      <Icon className="size-[22px]" strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[14px] font-semibold leading-snug text-foreground">
                        {c.title}
                      </h3>
                      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                        {c.body}
                      </p>
                      <button
                        type="button"
                        onClick={c.onAction}
                        className="mt-3 inline-flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-brand/50 bg-brand/[0.14] px-2.5 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-brand/[0.24]"
                      >
                        <span className="whitespace-nowrap">{c.action}</span>{" "}
                        <ArrowRight className="size-4 shrink-0" />
                      </button>
                    </div>
                  </article>
                );
              }))}

        {tab === "actions" &&
          (actions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-muted-foreground">
              Nothing needs a follow-up right now.
            </p>
          ) : (
            <>
              {actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={a.onOpen}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/[0.08] bg-black/20 p-3 text-left transition-colors hover:border-white/25"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-full bg-[#f59e0b]/15 text-[#f59e0b]"
                  >
                    <Clock className="size-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-foreground">
                      {a.name}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {a.reason}
                    </span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
              {actionsTotal > actions.length && (
                <p className="text-center text-[11.5px] text-muted-foreground">
                  + {actionsTotal - actions.length} more need a follow-up
                </p>
              )}
            </>
          ))}

        {tab === "strategy" &&
          (strategy.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-muted-foreground">
              Strategy tips appear once there is pipeline activity to learn from.
            </p>
          ) : (
            strategy.map((s) => (
              <article
                key={s.id}
                className="rounded-xl border border-white/[0.08] bg-black/20 p-3.5"
              >
                <h3 className="text-[13.5px] font-semibold text-foreground">{s.title}</h3>
                <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{s.body}</p>
              </article>
            ))
          ))}
      </div>

      {suggestions.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-[12.5px] font-medium text-muted-foreground">
            Quick suggestions
          </h3>
          <div className="grid gap-2 md:grid-cols-3 2xl:grid-cols-1">
            {suggestions.map((s) => {
              const Icon = SUGGESTION_ICON[s.icon];
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={s.onClick}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-white/25 hover:bg-white/[0.04]"
                >
                  <Icon className="size-[18px] shrink-0 text-foreground/80" strokeWidth={1.7} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-foreground">
                      {s.title}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {s.sub}
                    </span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
