/**
 * Pure model for the Pipeline "Flow" view: everything the briefing, health strip,
 * flow ribbon and sales coach display is derived here from the stage counts and
 * the leads list, so the numbers are consistent across the page and the UI
 * components stay presentational.
 */
import type { Lead } from "@/lib/api";
import { getStageForStatus, type FlowStage } from "@/lib/lead-workspace";

export const STAGE_ORDER: FlowStage[] = ["new", "contacted", "replied", "meeting", "won"];

export const STAGE_SHORT: Record<FlowStage, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting",
  won: "Closed",
};

/** Purple → blue → cyan → green progression through the flow. */
export const STAGE_COLOR: Record<FlowStage, string> = {
  new: "#8b5cf6",
  contacted: "#4f6bff",
  replied: "#2f9bff",
  meeting: "#22d3c5",
  won: "#34d399",
};

const DAY = 24 * 60 * 60 * 1000;
/** A lead in conversation with no update for this long is "stalled"… */
export const STALLED_DAYS = 3;
/** …and "overdue" once it has been quiet this long. */
export const OVERDUE_DAYS = 7;

export type FlowAlert = { kind: "bottleneck" | "low" | "good"; title: string; sub: string };

export type FlowNode = {
  stage: FlowStage;
  label: string;
  color: string;
  count: number;
  /** % of leads that reached this stage which went on to reach the next one. */
  toNextPct: number | null;
  nextLabel: string | null;
  alert: FlowAlert | null;
};

export type FlowHealth = {
  total: number;
  active: number;
  stalled: number;
  overdue: number;
  won: number;
  conversionPct: number;
  /** New opportunities, last 30 days vs the 30 before; null if there is no prior data. */
  totalTrendPct: number | null;
};

export type PipelineFlowModel = {
  nodes: FlowNode[];
  health: FlowHealth;
  needAttention: number;
  highPotential: number;
  upcomingMeetings: number;
  newWaiting: number;
  bottleneckStage: FlowStage | null;
  /** Per-stage "stalled or overdue" counts. */
  idleByStage: Record<FlowStage, number>;
};

const emptyCounts = (): Record<FlowStage, number> => ({ new: 0, contacted: 0, replied: 0, meeting: 0, won: 0 });

export function countByStage(leads: readonly Lead[]): Record<FlowStage, number> {
  const c = emptyCounts();
  for (const l of leads) c[getStageForStatus(l.status)]++;
  return c;
}

export function buildPipelineFlowModel(
  stageCounts: Record<FlowStage, number>,
  leads: readonly Lead[],
  now = Date.now(),
): PipelineFlowModel {
  const total = STAGE_ORDER.reduce((n, s) => n + stageCounts[s], 0);

  // reached[i] = leads that got to stage i or further
  const reached = STAGE_ORDER.map((_, i) => STAGE_ORDER.slice(i).reduce((n, s) => n + stageCounts[s], 0));
  const toNext = STAGE_ORDER.map((_, i) =>
    i < STAGE_ORDER.length - 1 && reached[i] > 0 ? Math.round((reached[i + 1] / reached[i]) * 100) : null,
  );

  // Idle time only matters for leads actually in conversation (not fresh, not closed).
  const idleByStage = emptyCounts();
  let stalled = 0;
  let overdue = 0;
  let highPotential = 0;
  let upcomingMeetings = 0;
  for (const l of leads) {
    const stage = getStageForStatus(l.status);
    if (stage === "meeting") upcomingMeetings++;
    if (stage === "new" || stage === "won") continue;
    const idle = (now - new Date(l.updatedAt).getTime()) / DAY;
    if (idle >= OVERDUE_DAYS) {
      overdue++;
      idleByStage[stage]++;
    } else if (idle >= STALLED_DAYS) {
      stalled++;
      idleByStage[stage]++;
    } else if (stage === "replied") {
      highPotential++;
    }
  }
  const closed = stageCounts.won;
  const active = Math.max(0, total - closed - stalled - overdue);

  // Alerts — at most one per stage; bottleneck > low conversion > good momentum.
  const alerts: (FlowAlert | null)[] = STAGE_ORDER.map(() => null);

  let bottleneckIdx = -1;
  STAGE_ORDER.forEach((s, i) => {
    if (idleByStage[s] > 0 && (bottleneckIdx < 0 || idleByStage[s] > idleByStage[STAGE_ORDER[bottleneckIdx]])) bottleneckIdx = i;
  });
  if (bottleneckIdx >= 0) {
    alerts[bottleneckIdx] = {
      kind: "bottleneck",
      title: "Bottleneck",
      sub: `${idleByStage[STAGE_ORDER[bottleneckIdx]]} stalled (${STALLED_DAYS}+ days)`,
    };
  }

  // Sample size guard so one lead doesn't read as a 0% / 100% trend.
  const sampled = (i: number) => toNext[i] !== null && reached[i] >= 5;
  let lowIdx = -1;
  for (let i = 0; i < STAGE_ORDER.length - 1; i++) {
    if (!sampled(i) || alerts[i]) continue;
    if ((toNext[i] as number) < 35 && (lowIdx < 0 || (toNext[i] as number) < (toNext[lowIdx] as number))) lowIdx = i;
  }
  if (lowIdx >= 0) {
    alerts[lowIdx] = { kind: "low", title: "Low conversion", sub: `${toNext[lowIdx]}% to next stage` };
  }

  let goodIdx = -1;
  for (let i = 0; i < STAGE_ORDER.length - 1; i++) {
    if (!sampled(i) || alerts[i]) continue;
    if ((toNext[i] as number) >= 50 && (goodIdx < 0 || (toNext[i] as number) > (toNext[goodIdx] as number))) goodIdx = i;
  }
  if (goodIdx >= 0) {
    alerts[goodIdx] = { kind: "good", title: "Good momentum", sub: `${toNext[goodIdx]}% move forward` };
  }

  const nodes: FlowNode[] = STAGE_ORDER.map((stage, i) => ({
    stage,
    label: STAGE_SHORT[stage],
    color: STAGE_COLOR[stage],
    count: stageCounts[stage],
    toNextPct: i < STAGE_ORDER.length - 1 ? toNext[i] : total > 0 ? Math.round((closed / total) * 100) : 0,
    nextLabel: i < STAGE_ORDER.length - 1 ? STAGE_SHORT[STAGE_ORDER[i + 1]] : null,
    alert: alerts[i],
  }));

  // New-opportunity trend: last 30 days vs the 30 before it (only if createdAt supports it).
  const cur = leads.filter((l) => now - new Date(l.createdAt).getTime() <= 30 * DAY).length;
  const prev = leads.filter((l) => {
    const age = now - new Date(l.createdAt).getTime();
    return age > 30 * DAY && age <= 60 * DAY;
  }).length;

  return {
    nodes,
    health: {
      total,
      active,
      stalled,
      overdue,
      won: closed,
      conversionPct: total > 0 ? Math.round((closed / total) * 100) : 0,
      totalTrendPct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
    },
    needAttention: stalled + overdue,
    highPotential,
    upcomingMeetings,
    newWaiting: stageCounts.new,
    bottleneckStage: bottleneckIdx >= 0 ? STAGE_ORDER[bottleneckIdx] : null,
    idleByStage,
  };
}
