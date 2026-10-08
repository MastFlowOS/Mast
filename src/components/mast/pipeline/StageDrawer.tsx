/**
 * Presentational right-side "Stage Context" drawer for the Pipeline Flow.
 *
 * This file only draws. Every number, row and activity item is computed by the route from the
 * Flow's own model (see `selectedStageData` in dashboard.pipeline.tsx) and passed in as props;
 * nothing is counted, estimated or invented here.
 *
 * Scrolling: the panel is exactly the viewport tall (`h-dvh`) and is a flex column. The header is a
 * fixed row; everything below it lives in ONE scroll container (`overflow-y-auto`, `min-h-0`), so
 * the last row/button is always reachable. Radix Dialog (modal) locks the page behind it.
 */
import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Briefcase,
  CalendarDays,
  Clock,
  FileText,
  Mail,
  MessageCircleMore,
  PenLine,
  Plus,
  Search,
  ShieldCheck,
  Send,
  StickyNote,
  Trophy,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Lead, StageActivityItem } from "@/lib/api";
import type { FlowStage } from "@/lib/lead-workspace";
import { FLOW_STAGES } from "@/lib/lead-workspace";
import { cn } from "@/lib/utils";
import { STAGES } from "./forestFlow";
import { scoreBandOf, timeAgo } from "./kanbanHelpers";
import {
  STAGE_ORDER,
  STALLED_DAYS,
  type FlowNode,
  type StageInsight,
  type StageValueSummary,
} from "./pipelineFlowModel";

const STAGE_ICON: Record<FlowStage, LucideIcon> = {
  new: FileText,
  contacted: Mail,
  replied: MessageCircleMore,
  meeting: CalendarDays,
  won: Trophy,
};

const ACTIVITY_ICON: Record<string, LucideIcon> = {
  opportunity_discovered: Search,
  company_analyzed: BarChart3,
  contact_verified: ShieldCheck,
  workspace_prepared: Briefcase,
  workspace_opened: Briefcase,
  ready_for_outreach: Send,
  email_sent: Mail,
  reply_received: MessageCircleMore,
  meeting_booked: CalendarDays,
  proposal_sent: FileText,
  deal_closed: Trophy,
  message_generated: PenLine,
  note_added: StickyNote,
  followup_scheduled: Clock,
  followup_completed: Clock,
  status_changed: ArrowRight,
};

const SCORE_TONE = {
  hot: "border-emerald-400/30 bg-emerald-400/15 text-emerald-300",
  good: "border-amber-400/30 bg-amber-400/15 text-amber-300",
  low: "border-rose-400/30 bg-rose-400/15 text-rose-300",
  unscored: "border-white/10 bg-white/[0.04] text-white/40",
} as const;

const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);

/** Domain when the lead has a website, otherwise the Instagram handle, otherwise the email. */
function contactLine(lead: Lead): string {
  if (lead.website) {
    try {
      const u = new URL(
        /^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`,
      );
      return u.hostname.replace(/^www\./, "");
    } catch {
      return lead.website;
    }
  }
  if (lead.instagramHandle) return `@${lead.instagramHandle.replace(/^@/, "")}`;
  return lead.email || "—";
}

export type StageDrawerProps = {
  stage: FlowStage | null;
  onClose: () => void;
  data: {
    node: FlowNode;
    count: number;
    conversionPct: number | null;
    nextLabel: string | null;
    value: StageValueSummary;
    insight: StageInsight;
    /** Stalled/overdue opportunities in this stage (only tracked for Contacted/Replied/Meeting). */
    idleCount: number;
    leads: Lead[];
  } | null;
  activity: StageActivityItem[] | undefined;
  activityLoading: boolean;
  leadNameById: Map<number, string>;
  onDiscover: () => void;
  onOpenLead: (lead: Lead) => void;
  onMoveLead: (lead: Lead, to: FlowStage) => void;
  onViewAll: () => void;
};

export function StageDrawer({
  stage,
  onClose,
  data,
  activity,
  activityLoading,
  leadNameById,
  onDiscover,
  onOpenLead,
  onMoveLead,
  onViewAll,
}: StageDrawerProps) {
  return (
    <DialogPrimitive.Root open={stage !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#02030a]/30 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="stage-drawer"
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[440px] flex-col overflow-hidden text-foreground outline-none sm:w-[420px] sm:rounded-l-[28px]",
            "border border-white/30 border-r-0 bg-[linear-gradient(155deg,rgba(255,255,255,0.14)_0%,rgba(120,100,255,0.16)_28%,rgba(30,40,120,0.20)_62%,rgba(8,10,30,0.34)_100%)] backdrop-blur-[34px] backdrop-saturate-[1.8]",
            "shadow-[-30px_0_90px_-24px_rgba(130,100,255,0.65),-2px_0_24px_-6px_rgba(140,170,255,0.45),inset_0_1px_0_rgba(255,255,255,0.35),inset_1px_0_0_rgba(255,255,255,0.22),inset_0_0_60px_rgba(255,255,255,0.04)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=closed]:duration-200 data-[state=open]:duration-300",
          )}
        >
          {data && stage ? (
            // key => a fresh tab + scroll position for every stage; nothing carries over.
            <DrawerBody
              key={stage}
              stage={stage}
              data={data}
              activity={activity}
              activityLoading={activityLoading}
              leadNameById={leadNameById}
              onDiscover={onDiscover}
              onOpenLead={onOpenLead}
              onMoveLead={onMoveLead}
              onViewAll={onViewAll}
            />
          ) : (
            <>
              <DialogPrimitive.Title className="sr-only">Stage context</DialogPrimitive.Title>
              <p className="p-6 text-sm text-white/60">Loading stage data…</p>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DrawerBody({
  stage,
  data,
  activity,
  activityLoading,
  leadNameById,
  onDiscover,
  onOpenLead,
  onMoveLead,
  onViewAll,
}: Omit<StageDrawerProps, "stage" | "data" | "onClose"> & {
  stage: FlowStage;
  data: NonNullable<StageDrawerProps["data"]>;
}) {
  const [tab, setTab] = useState<"opportunities" | "activity">("opportunities");
  const accent = STAGES[STAGE_ORDER.indexOf(stage)].color;
  const Icon = STAGE_ICON[stage];
  const { node, count, value } = data;

  // Reset the scroll position when the stage or tab changes.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scroller) scroller.scrollTop = 0;
  }, [scroller, tab, stage]);

  const conversionLabel = data.nextLabel ? `→ ${data.nextLabel}` : "Win rate";
  const metrics: { key: string; label: string; value: string; sub?: string; muted?: boolean }[] = [
    { key: "opportunities", label: "Opportunities", value: count.toLocaleString() },
    {
      key: "conversion",
      label: conversionLabel,
      value: data.conversionPct === null ? "—" : `${data.conversionPct}%`,
    },
    {
      key: "value",
      label: "Potential value",
      value: value.total === null ? "Unavailable" : money(value.total),
      sub: value.total === null ? undefined : `${value.valuedCount} of ${count} valued`,
      muted: value.total === null,
    },
    {
      key: "average",
      label: "Avg. opportunity",
      value: value.average === null ? "Unavailable" : money(value.average),
      muted: value.average === null,
    },
  ];

  return (
    <>
      {/* ── Header (fixed row, never scrolls away) ── */}
      <header className="relative shrink-0 border-b border-white/[0.14] bg-white/[0.05] px-5 pb-4 pt-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-28"
          style={{
            background: `radial-gradient(70% 100% at 20% 0%, ${accent}2e, transparent 70%)`,
          }}
        />
        <div className="relative flex items-start justify-between gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">
            Stage context
          </span>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-mr-1 -mt-1 grid size-8 cursor-pointer place-items-center rounded-full border border-white/30 bg-white/[0.10] text-white/85 backdrop-blur-md transition-colors hover:border-white/35 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="relative mt-3 flex items-center gap-3.5">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-2xl border"
            style={{
              borderColor: `${accent}`,
              background: `linear-gradient(155deg, ${accent}8c 0%, ${accent}33 45%, rgba(6,8,24,0.85) 100%)`,
              boxShadow: `0 0 22px ${accent}66, inset 0 0 12px ${accent}4d`,
            }}
          >
            <Icon
              className="size-6 text-white"
              strokeWidth={1.9}
              style={{ filter: `drop-shadow(0 0 4px ${accent})` }}
            />
          </span>
          <div className="min-w-0">
            <DialogPrimitive.Title className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-white">
              {node.label}
            </DialogPrimitive.Title>
            <p className="mt-0.5 text-[12.5px] text-white/60" data-testid="stage-count-line">
              {count.toLocaleString()} {count === 1 ? "opportunity" : "opportunities"}
            </p>
          </div>
        </div>
      </header>

      {/* ── Everything else scrolls inside this one container ── */}
      <div
        ref={setScroller}
        data-testid="stage-drawer-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-4 [scrollbar-color:rgba(255,255,255,0.25)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent"
      >
        {/* Metrics */}
        <div className="grid grid-cols-4 gap-2" data-testid="stage-metrics">
          {metrics.map((m) => (
            <div
              key={m.key}
              data-metric={m.key}
              className="min-w-0 rounded-xl border border-white/[0.18] bg-white/[0.08] px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_8px_20px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md"
            >
              <div
                data-metric-value
                className={cn(
                  "truncate font-semibold leading-none tabular-nums",
                  m.muted ? "text-[11px] text-white/45" : "text-[17px] text-white",
                )}
                style={
                  m.key === "conversion" && !m.muted
                    ? { color: accent, textShadow: `0 0 14px ${accent}66` }
                    : undefined
                }
              >
                {m.value}
              </div>
              <div className="mt-1.5 text-[10.5px] font-medium leading-tight text-white/55">
                {m.label}
              </div>
              {m.sub && (
                <div className="mt-0.5 text-[9.5px] leading-tight text-white/40">{m.sub}</div>
              )}
            </div>
          ))}
        </div>

        {/* Attention (only where idle time is actually tracked and something is idle) */}
        {data.idleCount > 0 && (
          <div
            data-testid="stage-attention"
            className="mt-3 flex items-center gap-3 rounded-xl border border-rose-300/35 bg-gradient-to-r from-rose-500/[0.22] to-rose-500/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-md px-3.5 py-2.5"
          >
            <Clock className="size-5 shrink-0 text-rose-300" strokeWidth={1.8} />
            <p className="text-[12.5px] leading-snug text-white/80">
              <span className="font-semibold text-white">
                {data.idleCount.toLocaleString()}{" "}
                {data.idleCount === 1 ? "opportunity" : "opportunities"}
              </span>{" "}
              {data.idleCount === 1 ? "hasn't" : "haven't"} moved in {STALLED_DAYS}+ days
            </p>
          </div>
        )}

        {/* Stage insight: computed from the Flow's own numbers, not AI-generated */}
        <section
          data-testid="stage-insight"
          className="mt-3 rounded-xl border border-white/[0.18] bg-white/[0.07] px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-md"
        >
          <h3
            className="text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: accent }}
          >
            Stage insight
          </h3>
          <p
            className={cn(
              "mt-1.5 text-[12.5px] leading-relaxed",
              data.insight.available ? "text-white/85" : "text-white/50",
            )}
          >
            {data.insight.text}
          </p>
        </section>

        {/* Actions: only what really exists. Moving a lead is done per row (Move). */}
        <div className="mt-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">
            Stage actions
          </h3>
          <button
            type="button"
            onClick={onDiscover}
            className="mt-2 inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#6d5cff,#4f6bff)] px-4 text-[13px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(99,102,255,0.9),inset_0_1px_0_rgba(255,255,255,0.25)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <Plus className="size-4" /> Discover
          </button>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Stage content"
          className="mt-5 flex gap-5 border-b border-white/[0.16]"
        >
          {(
            [
              ["opportunities", "Opportunities"],
              ["activity", "Activity"],
            ] as const
          ).map(([id, label]) => {
            const on = tab === id;
            return (
              <button
                key={id}
                id={`stage-tab-${id}`}
                role="tab"
                type="button"
                aria-selected={on}
                aria-controls={`stage-panel-${id}`}
                onClick={() => setTab(id)}
                className={cn(
                  "-mb-px cursor-pointer border-b-2 pb-2 text-[13px] font-medium transition-colors focus-visible:outline-none",
                  on ? "text-white" : "border-transparent text-white/50 hover:text-white/80",
                )}
                style={on ? { borderColor: accent } : undefined}
              >
                {label}
                {id === "opportunities" && (
                  <span className="ml-1.5 text-white/45">({count.toLocaleString()})</span>
                )}
              </button>
            );
          })}
        </div>

        {tab === "opportunities" ? (
          <div
            role="tabpanel"
            id="stage-panel-opportunities"
            aria-labelledby="stage-tab-opportunities"
            className="pt-2"
          >
            {data.leads.length === 0 ? (
              <p className="py-10 text-center text-[12.5px] text-white/50">
                No opportunities in this stage.
              </p>
            ) : (
              <>
                <p className="px-1 pb-1 text-[11px] text-white/45" data-testid="stage-list-count">
                  Recent opportunities ({data.leads.length} of {count})
                </p>
                <ul className="divide-y divide-white/[0.12]">
                  {data.leads.map((lead) => (
                    <OpportunityRow
                      key={lead.id}
                      lead={lead}
                      stage={stage}
                      onOpen={() => onOpenLead(lead)}
                      onMove={(to) => onMoveLead(lead, to)}
                    />
                  ))}
                </ul>
              </>
            )}
            <button
              type="button"
              onClick={onViewAll}
              className="mt-4 flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/30 bg-white/[0.10] text-[12.5px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] backdrop-blur-md transition-colors hover:border-white/50 hover:bg-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              View all opportunities <ArrowRight className="size-3.5" />
            </button>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="stage-panel-activity"
            aria-labelledby="stage-tab-activity"
            className="pt-3"
          >
            {activityLoading ? (
              <p className="py-8 text-center text-[12.5px] text-white/50">Loading activity…</p>
            ) : !activity || activity.length === 0 ? (
              <div className="py-10 text-center">
                <Activity className="mx-auto size-6 text-white/25" strokeWidth={1.6} />
                <p className="mt-2 text-[12.5px] text-white/50">
                  No recent activity recorded for opportunities in this stage.
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {activity.map((act) => {
                  const AIcon = ACTIVITY_ICON[act.type] ?? Activity;
                  return (
                    <li key={act.id} className="flex items-start gap-3 rounded-xl px-1.5 py-2.5">
                      <span
                        aria-hidden="true"
                        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border"
                        style={{
                          borderColor: `${accent}40`,
                          background: `${accent}1f`,
                          color: accent,
                        }}
                      >
                        <AIcon className="size-4" strokeWidth={1.9} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-white">
                          {leadNameById.get(act.leadId) ?? "Opportunity"}
                        </p>
                        <p className="mt-0.5 text-[12px] leading-snug text-white/60">
                          {act.description}
                        </p>
                      </div>
                      <time
                        dateTime={act.createdAt}
                        className="shrink-0 pt-0.5 text-[11px] tabular-nums text-white/40"
                      >
                        {timeAgo(act.createdAt)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function OpportunityRow({
  lead,
  stage,
  onOpen,
  onMove,
}: {
  lead: Lead;
  stage: FlowStage;
  onOpen: () => void;
  onMove: (to: FlowStage) => void;
}) {
  const band = scoreBandOf(lead.opportunityScore);
  const hasValue = typeof lead.estimatedValue === "number" && Number.isFinite(lead.estimatedValue);
  return (
    <li
      data-lead-row
      className="group flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-white/[0.10]"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${lead.businessName}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded-md"
      >
        <span className="min-w-0 flex-1">
          <span
            data-lead-name
            className="block truncate text-[13px] font-semibold leading-tight text-white"
          >
            {lead.businessName}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-white/45">
            {contactLine(lead)}
          </span>
        </span>
        {lead.opportunityScore != null && (
          <span
            className={cn(
              "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
              SCORE_TONE[band],
            )}
            title="Opportunity score"
          >
            {lead.opportunityScore}
          </span>
        )}
        {hasValue && (
          <span className="shrink-0 text-[12px] font-medium tabular-nums text-white/85">
            {money(lead.estimatedValue as number)}
          </span>
        )}
        <span className="w-12 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-white/40">
          {timeAgo(lead.updatedAt)}
        </span>
      </button>
      <select
        aria-label={`Move ${lead.businessName} to stage`}
        value={stage}
        onChange={(e) => onMove(e.target.value as FlowStage)}
        className="h-7 w-[88px] shrink-0 cursor-pointer rounded-md border border-white/25 bg-white/[0.08] px-1 text-[11px] text-white/75 outline-none [color-scheme:dark] hover:border-white/30 focus:border-white/40"
      >
        {FLOW_STAGES.map((s) => (
          <option key={s.value} value={s.value} className="bg-[#0b1020] text-slate-200">
            {s.label}
          </option>
        ))}
      </select>
    </li>
  );
}
