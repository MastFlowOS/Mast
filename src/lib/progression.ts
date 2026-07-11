import type { FollowupWithLead, Lead } from "@/lib/api";
import { isRelationshipLead, normalizeLeadStatus } from "@/lib/lead-workspace";
import type { PlanId } from "@/lib/plans";

export type ProgressionMetric =
  | "opportunities_discovered"
  | "businesses_contacted"
  | "relationships_created"
  | "meetings_booked"
  | "pipeline_moves"
  | "followups_completed"
  | "notes_added"
  | "ai_actions"
  | "exports_completed"
  | "searches_performed"
  | "regions_searched"
  | "industries_searched"
  | "relationships_reviewed"
  | "executive_briefings"
  | "weekly_intelligence"
  | "opportunity_insights";

export type GoalDifficulty = "easy" | "medium" | "hard" | "very_hard";

export type GoalCategory =
  | "discover"
  | "outreach"
  | "relationships"
  | "pipeline"
  | "mission"
  | "ai"
  | "data"
  | "search"
  | "intelligence";

export type ProgressionEventTotals = Partial<Record<ProgressionMetric, number>>;

export type GoalDefinition = {
  key: string;
  category: GoalCategory;
  metric: ProgressionMetric;
  label: (target: number) => string;
  targets: number[];
  difficulty: GoalDifficulty;
  minPlan: PlanId;
  weight: number;
  /**
   * Whether a real, wired application action currently increments this
   * goal's metric. Goals whose metric has no event source anywhere in the
   * app must be marked `false` so they're excluded from generation — a
   * goal a user can never complete should never be shown. Defaults to
   * `true` when omitted.
   */
  implemented?: boolean;
};

export type GeneratedGoal = {
  id: string;
  definitionKey: string;
  category: GoalCategory;
  metric: ProgressionMetric;
  label: string;
  target: number;
  current: number;
  xp: number;
  difficulty: GoalDifficulty;
};

export type ProgressionContext = {
  plan: PlanId;
  leads: Lead[];
  followups: FollowupWithLead[];
  eventTotals: ProgressionEventTotals;
  completedGoalIds: string[];
  activeGoalCount?: number;
};

export const XP_BY_DIFFICULTY: Record<GoalDifficulty, number> = {
  easy: 25,
  medium: 50,
  hard: 100,
  very_hard: 250,
};

const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  premium: 3,
};

export const GOAL_DEFINITIONS: GoalDefinition[] = [
  {
    key: "discover",
    category: "discover",
    metric: "opportunities_discovered",
    label: (target) => `Discover ${target} opportunities`,
    targets: [10, 20, 35, 60, 100, 150, 225],
    difficulty: "easy",
    minPlan: "free",
    weight: 100,
  },
  {
    key: "contact",
    category: "outreach",
    metric: "businesses_contacted",
    label: (target) => `Contact ${target} businesses`,
    targets: [5, 10, 18, 30, 50, 80, 125],
    difficulty: "medium",
    minPlan: "free",
    weight: 98,
  },
  {
    key: "relationships",
    category: "relationships",
    metric: "relationships_created",
    label: (target) => `Save ${target} relationships`,
    targets: [5, 12, 25, 45, 75, 120],
    difficulty: "easy",
    minPlan: "free",
    weight: 88,
  },
  {
    key: "search-industries",
    category: "search",
    metric: "industries_searched",
    label: (target) => `Search ${target} industries`,
    targets: [2, 4, 8, 12, 20],
    difficulty: "easy",
    minPlan: "free",
    weight: 76,
  },
  {
    key: "search-regions",
    category: "search",
    metric: "regions_searched",
    label: (target) => `Search ${target} regions`,
    targets: [2, 5, 10, 16, 25],
    difficulty: "medium",
    minPlan: "starter",
    weight: 74,
  },
  {
    key: "exports",
    category: "data",
    metric: "exports_completed",
    label: (target) => `Export data ${target} time${target === 1 ? "" : "s"}`,
    targets: [1, 3, 6, 10, 16],
    difficulty: "easy",
    minPlan: "free",
    weight: 58,
  },
  {
    key: "ai-actions",
    category: "ai",
    metric: "ai_actions",
    label: (target) => `Use AI ${target} time${target === 1 ? "" : "s"}`,
    targets: [3, 8, 15, 30, 50, 80],
    difficulty: "medium",
    minPlan: "starter",
    weight: 70,
  },
  {
    key: "followups",
    category: "mission",
    metric: "followups_completed",
    label: (target) => `Complete ${target} Mission follow-ups`,
    targets: [3, 8, 15, 30, 50, 80],
    difficulty: "medium",
    minPlan: "starter",
    weight: 90,
  },
  {
    key: "pipeline",
    category: "pipeline",
    metric: "pipeline_moves",
    label: (target) => `Move ${target} opportunities through Pipeline`,
    targets: [5, 10, 20, 40, 70, 110],
    difficulty: "hard",
    minPlan: "pro",
    weight: 84,
  },
  {
    key: "meetings",
    category: "pipeline",
    metric: "meetings_booked",
    label: (target) => `Book ${target} meeting${target === 1 ? "" : "s"}`,
    targets: [1, 3, 6, 10, 18, 30],
    difficulty: "hard",
    minPlan: "pro",
    weight: 86,
  },
  {
    key: "notes",
    category: "relationships",
    metric: "notes_added",
    label: (target) => `Add ${target} relationship notes`,
    targets: [5, 12, 25, 45, 75],
    difficulty: "easy",
    minPlan: "free",
    weight: 66,
  },
  {
    key: "relationship-review",
    category: "relationships",
    metric: "relationships_reviewed",
    label: (target) => `Review ${target} relationships`,
    targets: [5, 15, 35, 60],
    difficulty: "medium",
    minPlan: "free",
    weight: 62,
    // No UI action anywhere records `relationships_reviewed`. Excluded from
    // generation until a real "review" action is wired up. See audit §5/§10.
    implemented: false,
  },
  {
    key: "executive-briefings",
    category: "intelligence",
    metric: "executive_briefings",
    label: (target) => `Complete ${target} executive briefing${target === 1 ? "" : "s"}`,
    targets: [1, 3, 6, 10],
    difficulty: "very_hard",
    minPlan: "premium",
    weight: 80,
    // The Executive Briefing panel (dashboard.pipeline.tsx) is a passive,
    // auto-generated summary with no discrete "complete" action — nothing
    // records `executive_briefings`. Excluded from generation for now.
    implemented: false,
  },
  {
    key: "weekly-intelligence",
    category: "intelligence",
    metric: "weekly_intelligence",
    label: (target) => `Review ${target} Weekly Intelligence report${target === 1 ? "" : "s"}`,
    targets: [1, 3, 6, 12],
    difficulty: "hard",
    minPlan: "premium",
    weight: 78,
    // Same situation as executive-briefings: the Weekly Intelligence panel
    // is passively rendered, nothing records `weekly_intelligence`.
    implemented: false,
  },
  {
    key: "opportunity-insights",
    category: "intelligence",
    metric: "opportunity_insights",
    label: (target) => `Complete ${target} Opportunity Insight${target === 1 ? "" : "s"}`,
    targets: [3, 8, 16, 30],
    difficulty: "hard",
    minPlan: "premium",
    weight: 72,
    // No "Opportunity Insights" feature exists yet in the app beyond
    // marketing copy — nothing records `opportunity_insights`.
    implemented: false,
  },
];

// Both sets are only ever checked against the output of `normalizeLeadStatus`
// (see `buildProgressionCounters` below), which always returns one of the 8
// canonical `LeadStatus` values. Only canonical values belong here — legacy
// strings like "outreach" or "meeting" are translated to their canonical
// form by `normalizeLeadStatus` before they'd ever reach these sets.
const CONTACTED_STATUSES = new Set([
  "email_sent",
  "instagram_sent",
  "called",
  "replied",
  "meeting_booked",
  "closed",
]);

const PIPELINE_STATUSES = new Set([
  "replied",
  "meeting_booked",
  "closed",
]);

export function canUseGoalDefinition(plan: PlanId, definition: GoalDefinition) {
  return PLAN_RANK[plan] >= PLAN_RANK[definition.minPlan];
}

export function goalId(definition: GoalDefinition, target: number) {
  return `${definition.key}:${target}`;
}

function plateauGoalId(definition: GoalDefinition, target: number, cycle: number) {
  return `${definition.key}:${target}:cycle:${cycle}`;
}

function getPlateauCycle(definition: GoalDefinition, target: number, completed: Set<string>) {
  let cycle = completed.has(goalId(definition, target)) ? 1 : 0;
  for (const id of completed) {
    const match = id.match(new RegExp(`^${definition.key}:${target}:cycle:(\\d+)$`));
    if (match) cycle = Math.max(cycle, Number(match[1]));
  }
  return cycle;
}

export function buildProgressionCounters(ctx: Omit<ProgressionContext, "completedGoalIds" | "activeGoalCount">): Record<ProgressionMetric, number> {
  const leads = ctx.leads;
  const eventTotals = ctx.eventTotals;
  const leadStatuses = leads.map((lead) => normalizeLeadStatus(lead.status));

  const derived: Record<ProgressionMetric, number> = {
    opportunities_discovered: leads.length,
    businesses_contacted: leads.filter((lead) => CONTACTED_STATUSES.has(normalizeLeadStatus(lead.status)) || Boolean(lead.lastContactedAt)).length,
    // A "relationship" is a lead the user has deliberately brought into
    // their workspace — manually added, imported, or a Discover result
    // they've since engaged with — not just any row in `leads` (which
    // would make this identical to `opportunities_discovered`). See
    // `isRelationshipLead` for the exact rule and audit Priority 3.
    relationships_created: leads.filter((lead) => isRelationshipLead(lead)).length,
    meetings_booked: leadStatuses.filter((status) => status === "meeting_booked").length,
    pipeline_moves: leadStatuses.filter((status) => PIPELINE_STATUSES.has(status)).length,
    followups_completed: ctx.followups.filter((followup) => followup.status === "completed").length,
    notes_added: leads.filter((lead) => Boolean(lead.notes?.trim())).length,
    ai_actions: 0,
    exports_completed: 0,
    searches_performed: 0,
    regions_searched: 0,
    industries_searched: 0,
    relationships_reviewed: 0,
    executive_briefings: 0,
    weekly_intelligence: 0,
    opportunity_insights: 0,
  };

  for (const metric of Object.keys(derived) as ProgressionMetric[]) {
    derived[metric] = Math.max(derived[metric], eventTotals[metric] ?? 0);
  }

  return derived;
}

export function generateProgressionGoals(ctx: ProgressionContext): GeneratedGoal[] {
  const counters = buildProgressionCounters(ctx);
  const completed = new Set(ctx.completedGoalIds);
  const activeCount = ctx.activeGoalCount ?? 4;
  const selected: GeneratedGoal[] = [];
  const usedCategories = new Set<GoalCategory>();

  const candidates = GOAL_DEFINITIONS
    .filter((definition) => definition.implemented !== false && canUseGoalDefinition(ctx.plan, definition))
    .map((definition) => {
      const capped = definition.targets.at(-1)!;
      const nextUncompletedTarget = definition.targets.find((item) => !completed.has(goalId(definition, item)));
      if (nextUncompletedTarget) {
        return {
          definition,
          id: goalId(definition, nextUncompletedTarget),
          target: nextUncompletedTarget,
          current: Math.min(counters[definition.metric] ?? 0, nextUncompletedTarget),
        };
      }

      const plateauCycle = getPlateauCycle(definition, capped, completed);
      const previousTotal = plateauCycle * capped;
      const current = Math.max(0, (counters[definition.metric] ?? 0) - previousTotal);
      return {
        definition,
        id: plateauGoalId(definition, capped, plateauCycle + 1),
        target: capped,
        current: Math.min(current, capped),
      };
    })
    .sort((a, b) => {
      const aComplete = a.current >= a.target ? 1 : 0;
      const bComplete = b.current >= b.target ? 1 : 0;
      if (aComplete !== bComplete) return bComplete - aComplete;
      const aPct = a.current / a.target;
      const bPct = b.current / b.target;
      if (Math.abs(aPct - bPct) > 0.001) return bPct - aPct;
      return b.definition.weight - a.definition.weight;
    });

  for (const candidate of candidates) {
    if (selected.length >= activeCount) break;
    if (usedCategories.has(candidate.definition.category) && selected.length < Math.min(3, activeCount)) continue;
    selected.push(materializeGoal(candidate.definition, candidate.target, candidate.current, candidate.id));
    usedCategories.add(candidate.definition.category);
  }

  for (const candidate of candidates) {
    if (selected.length >= activeCount) break;
    if (selected.some((goal) => goal.definitionKey === candidate.definition.key)) continue;
    selected.push(materializeGoal(candidate.definition, candidate.target, candidate.current, candidate.id));
  }

  return selected;
}

function materializeGoal(definition: GoalDefinition, target: number, current: number, id = goalId(definition, target)): GeneratedGoal {
  return {
    id,
    definitionKey: definition.key,
    category: definition.category,
    metric: definition.metric,
    label: definition.label(target),
    target,
    current,
    xp: XP_BY_DIFFICULTY[definition.difficulty],
    difficulty: definition.difficulty,
  };
}

export function progressionGoalProgress(goal: Pick<GeneratedGoal, "current" | "target">) {
  if (goal.target <= 0) return 100;
  return Math.min(100, Math.round((goal.current / goal.target) * 100));
}

export function isProgressionGoalComplete(goal: Pick<GeneratedGoal, "current" | "target">) {
  return goal.current >= goal.target;
}

export function pickGoalCelebration(goal: GeneratedGoal) {
  const categoryMessages: Record<GoalCategory, string[]> = {
    discover: ["Fresh opportunities unlocked. Your market map is getting sharper."],
    outreach: ["Outreach goal complete. Real conversations start here."],
    relationships: ["Relationship momentum banked. The workspace just got stronger."],
    pipeline: ["Pipeline moved. That is the kind of progress that compounds."],
    mission: ["Mission accomplished. Follow-up discipline is doing its work."],
    ai: ["AI assist complete. Smart leverage, nicely used."],
    data: ["Export complete. Your data is working beyond the dashboard."],
    search: ["Search goal complete. New territory, new signals."],
    intelligence: ["Intelligence goal complete. Strategy just got clearer."],
  };
  const messages = categoryMessages[goal.category];
  return `${messages[Math.floor(Math.random() * messages.length)]} +${goal.xp} XP`;
}
