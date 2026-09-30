import type { FollowupWithLead, Lead } from "@/lib/api";
import { isDiscoveredLead, isUntouchedDiscoveredLead } from "@/lib/lead-provenance";
import {
  collectFocusPriorities,
  plural,
  selectContactedWithoutFollowup,
  selectFocusStack,
  selectOpenFollowups,
  type FocusGoalInput,
  type FocusPriority,
} from "@/lib/focus-priorities";
import type { PlanId } from "@/lib/plans";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tone = "brand" | "warning" | "success" | "danger";

export type FocusPrimaryRecommendation = {
  id: string;
  category: string;
  headline: string;
  description: string;
  whyNow: string;
  metrics: { label: string; value: string }[];
  actionLabel: string;
  to: string;
  /** Optional in-page anchor (e.g. the Goals module). */
  hash?: string;
  tone: Tone;
};

export type FocusStackPriority = {
  id: string;
  number: string;
  title: string;
  metadata: string;
  why: string;
  actionLabel: string;
  to: string;
  hash?: string;
  tone: Tone;
};

export type FocusMomentumEvent = {
  id: string;
  delta: string;
  label: string;
  detail: string;
  category: "milestone" | "discover" | "outreach" | "followup" | "xp";
};

/**
 * MAST Signal. There is no anomaly detection in the app, so this is either a
 * concrete data-backed observation or an intentional quiet state
 * (`isQuiet`, no action).
 */
export type FocusMastSignal = {
  id: string;
  headline: string;
  detail: string;
  actionLabel: string | null;
  to: string | null;
  isQuiet: boolean;
};

export type FocusWeeklyPulse = {
  /** What the numbers count, e.g. "Last 7 days". */
  basisLabel: string;
  tiles: { label: string; value: number }[];
  summary: string;
};

export type MilestoneTier = {
  id: string;
  name: string;
  xpRequired: number;
  /** Display label only. No reward is implemented; never present it as unlocked. */
  reward: string;
};

export type FocusContext = {
  leads: Lead[];
  followups: FollowupWithLead[];
  dailyDiscoverUsed: number;
  dailyDiscoverLimit: number;
  /** Remaining monthly discovery allowance; null when unknown. */
  monthlyRemaining: number | null;
  plan: PlanId;
  /** `profiles.xp` (persistent XP total only — never used to derive daily progress). */
  xp: number;
  /** Persisted Daily Goals claimed today (`daily_goals.claimed_at`). */
  goalsClaimedToday: number;
  /** Injectable clock for tests. */
  now?: Date;
};

export type FocusSnapshot = {
  greeting: { period: "morning" | "afternoon" | "evening" | "night"; subtitle: string; name: string };
  primaryRecommendation: FocusPrimaryRecommendation | null;
  focusStack: FocusStackPriority[];
  weeklyPulse: FocusWeeklyPulse;
  momentum: FocusMomentumEvent[];
  signal: FocusMastSignal;
  isClear: boolean;
};

// ── Milestone tiers ───────────────────────────────────────────────────────────
// `reward` strings are labels only: no reward is implemented, so the UI must
// not present them as unlockable benefits.

export const MILESTONE_TIERS: MilestoneTier[] = [
  { id: "explorer", name: "Explorer", xpRequired: 0, reward: "Unlocked at signup" },
  { id: "prospector", name: "Prospector", xpRequired: 100, reward: "Bonus discovery insights" },
  { id: "closer", name: "Closer", xpRequired: 250, reward: "Follow-up priority boost" },
  { id: "rainmaker", name: "Rainmaker", xpRequired: 500, reward: "Premium discovery day" },
  { id: "operator", name: "Operator", xpRequired: 800, reward: "AI outreach boost" },
  { id: "growth_master", name: "Growth Master", xpRequired: 1200, reward: "Bonus leads pack" },
  { id: "revenue_architect", name: "Revenue Architect", xpRequired: 1800, reward: "Seasonal badge unlock" },
];

// ── Date helpers ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function isWithinDays(date: string | null | undefined, days: number, now: Date) {
  if (!date) return false;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  const t = value.getTime();
  return t <= now.getTime() && t >= now.getTime() - days * DAY_MS;
}

function clock(ctx: FocusContext) {
  return ctx.now ?? new Date();
}

/** Mission follow-ups are a Starter+ feature; Free has none. */
function followupsAvailable(plan: PlanId) {
  return plan !== "free";
}

// ── Priorities (single source for hero, stack, greeting, clear state) ─────────

export function buildFocusPriorities(
  ctx: FocusContext,
  goals: FocusGoalInput[] = [],
  claimedGoalIds: string[] = [],
): FocusPriority[] {
  const nextTier = getNextMilestone(ctx.xp);
  return collectFocusPriorities({
    leads: ctx.leads,
    followups: ctx.followups,
    goals,
    claimedGoalIds,
    xp: ctx.xp,
    nextTier: nextTier ? { name: nextTier.name, xpRequired: nextTier.xpRequired } : null,
    dailyRemaining: Math.max(0, ctx.dailyDiscoverLimit - ctx.dailyDiscoverUsed),
    monthlyRemaining: ctx.monthlyRemaining,
    followupsAvailable: followupsAvailable(ctx.plan),
    now: clock(ctx),
  });
}

// ── Greeting ──────────────────────────────────────────────────────────────────

export type GreetingPeriod = "morning" | "afternoon" | "evening" | "night";

export function getTimeOfDayPeriod(now: Date = new Date()): GreetingPeriod {
  const hour = now.getHours();
  if (hour >= 7 && hour < 14) {
    return "morning";
  } else if (hour >= 14 && hour < 19) {
    return "afternoon";
  } else if (hour >= 19 && hour < 24) {
    return "evening";
  } else {
    return "night";
  }
}

export function buildGreeting(firstName: string, ctx: FocusContext, priorities?: FocusPriority[]) {
  const now = clock(ctx);
  const period = getTimeOfDayPeriod(now);

  const list = priorities ?? buildFocusPriorities(ctx);
  const top = list[0];
  let subtitle: string;

  switch (top?.kind) {
    case "followup_overdue": {
      const overdue = selectOpenFollowups(ctx.followups, ctx.leads, now).filter((f) => f.days < 0).length;
      subtitle =
        overdue === 1
          ? "One follow-up is overdue. Let's clear it first."
          : `${overdue} follow-ups are overdue. Let's start with the oldest.`;
      break;
    }
    case "followup_due_today":
      subtitle = "You have a follow-up due today.";
      break;
    case "schedule_followup":
      subtitle = "You contacted a business without scheduling a follow-up.";
      break;
    case "silent_contact":
      subtitle = "Some businesses you contacted have no recorded reply yet.";
      break;
    case "review_opportunities": {
      const n = ctx.leads.filter(isUntouchedDiscoveredLead).length;
      subtitle = `You have ${n} discovered ${plural(n, "opportunity", "opportunities")} waiting for outreach.`;
      break;
    }
    case "goal_claim":
      subtitle = "A completed goal is ready to claim.";
      break;
    case "goal_near":
      subtitle = "You're close to finishing a goal.";
      break;
    case "xp_milestone":
      subtitle = "You're close to your next milestone.";
      break;
    case "discover":
      subtitle =
        ctx.leads.length === 0
          ? "Ready to discover your first opportunities?"
          : "Your queue is light. Ready to find new opportunities?";
      break;
    default:
      subtitle = "You're all caught up.";
  }

  return { period, subtitle, name: firstName };
}

// ── Milestone helpers ─────────────────────────────────────────────────────────

export function getCurrentMilestone(xp: number) {
  let current = MILESTONE_TIERS[0];
  for (const tier of MILESTONE_TIERS) {
    if (xp >= tier.xpRequired) current = tier;
  }
  return current;
}

export function getNextMilestone(xp: number) {
  return MILESTONE_TIERS.find((tier) => tier.xpRequired > xp) ?? null;
}

export function milestoneProgress(xp: number) {
  const current = getCurrentMilestone(xp);
  const next = getNextMilestone(xp);
  if (!next) return 100;
  const span = next.xpRequired - current.xpRequired;
  const progress = xp - current.xpRequired;
  return Math.min(100, Math.round((progress / span) * 100));
}


// ── Primary Recommendation (YOUR FOCUS hero) ───────────────────────────────────

export function buildPrimaryRecommendation(priorities: FocusPriority[]): FocusPrimaryRecommendation | null {
  const top = priorities[0];
  if (!top) return null;
  return {
    id: top.id,
    category: top.hero.category,
    headline: top.hero.headline,
    description: top.hero.description,
    whyNow: top.hero.whyNow,
    metrics: top.hero.metrics,
    actionLabel: top.hero.actionLabel,
    to: top.hero.to,
    hash: top.hero.hash,
    tone: top.tone,
  };
}

// ── Focus Stack (secondary priorities, diverse, never padded) ──────────────────

export function buildFocusStack(priorities: FocusPriority[]): FocusStackPriority[] {
  return selectFocusStack(priorities).map((p, index) => ({
    id: `stack-${p.id}`,
    number: String(index + 1).padStart(2, "0"),
    title: p.stack.title,
    metadata: p.stack.metadata,
    why: p.stack.why,
    actionLabel: p.stack.actionLabel,
    to: p.stack.to,
    hash: p.stack.hash,
    tone: p.tone,
  }));
}

// ── Recent activity (labelled "Momentum" only where it means something) ────────
// Every line counts events with a real timestamp inside a stated window. There
// is no streak: activity history per day is not available from the loaded data
// (`lastContactedAt` keeps only each lead's latest contact).

export function buildMomentumEvents(ctx: FocusContext): FocusMomentumEvent[] {
  const now = clock(ctx);
  const events: FocusMomentumEvent[] = [];

  if (ctx.goalsClaimedToday > 0) {
    events.push({
      id: "activity-goals-today",
      delta: `+${ctx.goalsClaimedToday}`,
      label: `${plural(ctx.goalsClaimedToday, "goal")} claimed today`,
      detail: "Claimed from your Focus goals",
      category: "milestone",
    });
  }

  const contacted = ctx.leads.filter((l) => isWithinDays(l.lastContactedAt, 7, now)).length;
  if (contacted > 0) {
    events.push({
      id: "activity-contacted",
      delta: `+${contacted}`,
      label: `${plural(contacted, "business", "businesses")} contacted`,
      detail: "Last contact within the past 7 days",
      category: "outreach",
    });
  }

  const followupsDone = followupsAvailable(ctx.plan)
    ? ctx.followups.filter((f) => f.status === "completed" && isWithinDays(f.completedAt, 7, now)).length
    : 0;
  if (followupsDone > 0) {
    events.push({
      id: "activity-followups",
      delta: `+${followupsDone}`,
      label: `${plural(followupsDone, "follow-up")} completed`,
      detail: "Completed in the past 7 days",
      category: "followup",
    });
  }

  const discovered = ctx.leads.filter((l) => isDiscoveredLead(l) && isWithinDays(l.createdAt, 7, now)).length;
  if (discovered > 0) {
    events.push({
      id: "activity-discovered",
      delta: `+${discovered}`,
      label: `${plural(discovered, "opportunity", "opportunities")} discovered`,
      detail: "Delivered by Discover in the past 7 days",
      category: "discover",
    });
  }

  return events.slice(0, 4);
}

// ── MAST Signal ────────────────────────────────────────────────────────────────
// Concrete, human-readable observations derived directly from verified data.
// If no meaningful pattern or data exists, returns an intentional quiet state.

export function buildMastSignal(ctx?: FocusContext): FocusMastSignal {
  if (!ctx || ctx.leads.length === 0) {
    return {
      id: "signal-quiet",
      headline: "NO NOTABLE SIGNAL",
      detail: "No meaningful pattern detected yet.",
      actionLabel: null,
      to: null,
      isQuiet: true,
    };
  }

  const now = clock(ctx);

  // 1. Follow-ups overdue
  const openFollowups = selectOpenFollowups(ctx.followups, ctx.leads, now);
  const overdue = openFollowups.filter((f) => f.days < 0);
  if (overdue.length > 0) {
    const n = overdue.length;
    return {
      id: "signal-overdue-followups",
      headline: `${n} ${plural(n, "follow-up is", "follow-ups are")} overdue`,
      detail: "Scheduled dates have passed without recorded activity.",
      actionLabel: "Clear in Mission",
      to: "/dashboard/follow-ups",
      isQuiet: false,
    };
  }

  // 2. Follow-ups due today
  const dueToday = openFollowups.filter((f) => f.days === 0);
  if (dueToday.length > 0) {
    const n = dueToday.length;
    return {
      id: "signal-due-today-followups",
      headline: `${n} ${plural(n, "follow-up is", "follow-ups are")} due today`,
      detail: "Scheduled outreach for today needs attention in your pipeline.",
      actionLabel: "Open Mission",
      to: "/dashboard/follow-ups",
      isQuiet: false,
    };
  }

  // 3. Contacted leads without follow-up
  const contactedWithoutFollowup = selectContactedWithoutFollowup(ctx.leads, ctx.followups, now);
  if (contactedWithoutFollowup.length > 0) {
    const n = contactedWithoutFollowup.length;
    return {
      id: "signal-contacted-no-action",
      headline: `${n} contacted ${plural(n, "lead has", "leads have")} no next action`,
      detail: "Outreach was sent but no follow-up date has been scheduled.",
      actionLabel: "View in Relationships",
      to: "/dashboard/relationships",
      isQuiet: false,
    };
  }

  // 4. Discovery activity dominance (backed by real weekly pulse data)
  const pulse = buildWeeklyPulse(ctx);
  const discovered = pulse.tiles.find((t) => t.label === "Discovered")?.value ?? 0;
  const contacted = pulse.tiles.find((t) => t.label === "Contacted")?.value ?? 0;
  const followupsDone = pulse.tiles.find((t) => t.label === "Follow-ups done")?.value ?? 0;
  if (discovered > 5 && discovered > (contacted + followupsDone) * 2) {
    return {
      id: "signal-discovery-momentum",
      headline: "Most of your recent activity came from discovery",
      detail: `${discovered} opportunities were discovered in the last 7 days.`,
      actionLabel: "Review opportunities",
      to: "/dashboard/relationships",
      isQuiet: false,
    };
  }

  // Fallback to intentional quiet state
  return {
    id: "signal-quiet",
    headline: "NO NOTABLE SIGNAL",
    detail: "No meaningful pattern detected yet.",
    actionLabel: null,
    to: null,
    isQuiet: true,
  };
}

// ── Weekly Pulse (compact, basis stated) ───────────────────────────────────────
// Time basis: the last 7 days, using each record's own timestamp.
//  - Discovered: Discover-delivered leads created in the window
//  - Added: manual / CSV leads created in the window
//  - Contacted: leads whose latest recorded contact is in the window
//  - Follow-ups done: follow-ups completed in the window (Starter+)
// Replies and meetings are not included: no reply or meeting date is recorded.

export function buildWeeklyPulse(ctx: FocusContext): FocusWeeklyPulse {
  const now = clock(ctx);
  const created = ctx.leads.filter((l) => isWithinDays(l.createdAt, 7, now));
  const discovered = created.filter(isDiscoveredLead).length;
  const added = created.length - discovered;
  const contacted = ctx.leads.filter((l) => isWithinDays(l.lastContactedAt, 7, now)).length;
  const hasFollowups = followupsAvailable(ctx.plan);
  const followupsDone = hasFollowups
    ? ctx.followups.filter((f) => f.status === "completed" && isWithinDays(f.completedAt, 7, now)).length
    : 0;

  const tiles = [
    { label: "Discovered", value: discovered },
    { label: "Added", value: added },
    { label: "Contacted", value: contacted },
    ...(hasFollowups ? [{ label: "Follow-ups done", value: followupsDone }] : []),
  ];

  const total = discovered + added + contacted + followupsDone;
  const summary =
    total === 0
      ? "No activity recorded in the last 7 days."
      : "Counts use each record's latest recorded date within the last 7 days.";

  return { basisLabel: "Last 7 days", tiles, summary };
}

// ── Full snapshot ─────────────────────────────────────────────────────────────

export function buildFocusSnapshot(
  firstName: string,
  ctx: FocusContext,
  /** Today's persisted Daily Goals, adapted by `toPriorityGoals`. Empty until they load. */
  dailyGoals: {
    goals: FocusGoalInput[];
    claimedGoalIds: string[];
  } = { goals: [], claimedGoalIds: [] },
): FocusSnapshot {
  const priorities = buildFocusPriorities(ctx, dailyGoals.goals, dailyGoals.claimedGoalIds);
  const greeting = buildGreeting(firstName, ctx, priorities);

  return {
    greeting: {
      period: greeting.period,
      subtitle: greeting.subtitle,
      name: firstName,
    },
    primaryRecommendation: buildPrimaryRecommendation(priorities),
    focusStack: buildFocusStack(priorities),
    weeklyPulse: buildWeeklyPulse(ctx),
    momentum: buildMomentumEvents(ctx),
    signal: buildMastSignal(ctx),
    isClear: priorities.length === 0,
  };
}
