import type { FollowupWithLead, Lead } from "@/lib/api";
import { normalizeLeadStatus } from "@/lib/lead-workspace";
import type { PlanId } from "@/lib/plans";
import {
  generateProgressionGoals,
  isProgressionGoalComplete,
  pickGoalCelebration,
  progressionGoalProgress,
  type GeneratedGoal,
  type ProgressionEventTotals,
} from "@/lib/progression";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FocusRecommendation = {
  id: string;
  title: string;
  description: string;
  actionLabel: string;
  to: string;
  priority: number;
  tone: "brand" | "warning" | "success" | "danger";
};

export type FocusGoal = GeneratedGoal;

export type WeeklyMetric = {
  label: string;
  value: number;
};

export type MilestoneTier = {
  id: string;
  name: string;
  xpRequired: number;
  reward: string;
};

export type FocusContext = {
  leads: Lead[];
  followups: FollowupWithLead[];
  analytics: {
    totalLeads: number;
    contacted: number;
    replied: number;
    followupsDue: number;
    messagesThisWeek: number;
    replyRate: number;
  };
  dailyDiscoverUsed: number;
  dailyDiscoverLimit: number;
  plan: PlanId;
  completedGoalIds: string[];
  progressionEvents: ProgressionEventTotals;
};

export type FocusSnapshot = {
  greeting: { period: "morning" | "afternoon" | "evening" | "night"; subtitle: string };
  recommendations: FocusRecommendation[];
  weeklyMetrics: WeeklyMetric[];
  weeklySummary: string;
  weeklyRecommendation: string;
  goals: FocusGoal[];
};

// ── Milestone tiers ───────────────────────────────────────────────────────────

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

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function isToday(date: string | null | undefined) {
  if (!date) return false;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  return startOfDay(value).getTime() === startOfDay(new Date()).getTime();
}

function isWithinDays(date: string | null | undefined, days: number) {
  if (!date) return false;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  return value.getTime() >= Date.now() - days * 86_400_000;
}

function daysFromToday(date: string | null | undefined) {
  if (!date) return 999;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return 999;
  const today = startOfDay(new Date());
  const day = startOfDay(value);
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

// ── Lead analysis ─────────────────────────────────────────────────────────────

function isUncontacted(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return (status === "discovered" || status === "ready") && !lead.lastContactedAt;
}

function isHotProposal(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return status === "proposal" || status === "negotiation";
}

function isReplyStatus(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return ["conversation", "meeting", "proposal", "negotiation", "closed_won"].includes(status);
}

function countOverdueFollowups(followups: FollowupWithLead[]) {
  return followups.filter((f) => f.status !== "completed" && daysFromToday(f.dueAt) < 0).length;
}

function countDueTodayFollowups(followups: FollowupWithLead[]) {
  return followups.filter((f) => f.status !== "completed" && daysFromToday(f.dueAt) === 0).length;
}

function countCompletedFollowupsToday(followups: FollowupWithLead[]) {
  return followups.filter(
    (f) => f.status === "completed" && isToday(f.completedAt ?? f.updatedAt),
  ).length;
}

// ── Greeting ──────────────────────────────────────────────────────────────────

export function buildGreeting(firstName: string, ctx: FocusContext) {
  const hour = new Date().getHours();
  let period: "morning" | "afternoon" | "evening" | "night";

  if (hour >= 7 && hour < 14) {
    period = "morning";
  } else if (hour >= 14 && hour < 19) {
    period = "afternoon";
  } else if (hour >= 19 && hour < 24) {
    period = "evening";
  } else {
    period = "night";
  }

  const uncontacted = ctx.leads.filter(isUncontacted).length;
  const overdue = countOverdueFollowups(ctx.followups);
  const dueToday = countDueTodayFollowups(ctx.followups);
  const recentReplies = ctx.leads.filter(
    (l) => isReplyStatus(l) && isWithinDays(l.updatedAt, 1),
  ).length;

  let subtitle: string;

  if (overdue > 0) {
    subtitle =
      overdue === 1
        ? "One follow-up is overdue — let's clear it before anything else."
        : `${overdue} follow-ups are overdue. Let's finish these before lunch.`;
  } else if (recentReplies > 0) {
    subtitle =
      recentReplies === 1
        ? "A company replied while you were away."
        : `${recentReplies} companies replied while you were away.`;
  } else if (uncontacted > 0) {
    subtitle =
      uncontacted === 1
        ? "You have 1 opportunity waiting for outreach."
        : `You have ${uncontacted} opportunities waiting for outreach.`;
  } else if (dueToday + overdue > 3) {
    subtitle = "Today looks busy — let's build some momentum.";
  } else if (ctx.analytics.totalLeads === 0) {
    subtitle = "Ready for another great day? Let's discover your first opportunities.";
  } else if (ctx.analytics.messagesThisWeek === 0) {
    subtitle = "Everything is under control. Ready to discover new opportunities?";
  } else {
    subtitle = "Looks like we're building momentum. What should we tackle today?";
  }

  return { period, subtitle, name: firstName };
}

// ── Recommendations ───────────────────────────────────────────────────────────

export function buildRecommendations(ctx: FocusContext): FocusRecommendation[] {
  const items: FocusRecommendation[] = [];
  const uncontacted = ctx.leads.filter(isUncontacted).length;
  const overdue = countOverdueFollowups(ctx.followups);
  const dueToday = countDueTodayFollowups(ctx.followups);
  const hotProposals = ctx.leads.filter(isHotProposal).length;
  const recentDiscoveries = ctx.leads.filter((l) => isWithinDays(l.createdAt, 1)).length;
  const dailyRemaining = Math.max(0, ctx.dailyDiscoverLimit - ctx.dailyDiscoverUsed);

  if (uncontacted > 0) {
    items.push({
      id: "uncontacted",
      title:
        uncontacted === 1
          ? "1 business hasn't been contacted yet."
          : `${uncontacted} businesses haven't been contacted yet.`,
      description: "Start outreach while these opportunities are still fresh.",
      actionLabel: "Open Workspace",
      to: "/dashboard/leads",
      priority: 90,
      tone: "brand",
    });
  }

  if (overdue > 0) {
    items.push({
      id: "overdue-followups",
      title:
        overdue === 1
          ? "One follow-up is overdue."
          : `${overdue} follow-ups are overdue.`,
      description: "Clearing these protects pipeline momentum.",
      actionLabel: "Open Mission",
      to: "/dashboard/follow-ups",
      priority: 100,
      tone: "danger",
    });
  } else if (dueToday > 0) {
    items.push({
      id: "due-today",
      title:
        dueToday === 1
          ? "One follow-up is due today."
          : `${dueToday} follow-ups are due today.`,
      description: "Let's finish these follow-ups before lunch.",
      actionLabel: "Open Mission",
      to: "/dashboard/follow-ups",
      priority: 85,
      tone: "warning",
    });
  }

  if (hotProposals > 0) {
    items.push({
      id: "hot-proposals",
      title:
        hotProposals === 1
          ? "One proposal has a high chance of closing this week."
          : `${hotProposals} proposals have a high chance of closing this week.`,
      description: "A focused push here could move revenue forward.",
      actionLabel: "Open Pipeline",
      to: "/dashboard/pipeline",
      priority: 80,
      tone: "success",
    });
  }

  if (dailyRemaining > 0 && recentDiscoveries < 5) {
    items.push({
      id: "discover",
      title: `Discover found room for ${dailyRemaining} more opportunities today.`,
      description: "Fresh companies similar to your best performers are waiting.",
      actionLabel: "Review Opportunities",
      to: "/dashboard/leads",
      priority: 70,
      tone: "brand",
    });
  }

  if (ctx.analytics.replied > 0 && ctx.analytics.followupsDue > 0) {
    items.push({
      id: "pipeline-review",
      title: `${ctx.analytics.replied} active conversations need your attention.`,
      description: "Keep reply momentum going with a quick pipeline review.",
      actionLabel: "Open Pipeline",
      to: "/dashboard/pipeline",
      priority: 60,
      tone: "brand",
    });
  }

  return items.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

export function buildEmptyRecommendations(): FocusRecommendation[] {
  return [
    {
      id: "all-clear",
      title: "Everything is up to date.",
      description: "Perfect time to discover new opportunities.",
      actionLabel: "Discover",
      to: "/dashboard/leads",
      priority: 1,
      tone: "success",
    },
  ];
}

// ── Weekly review ─────────────────────────────────────────────────────────────

export function buildWeeklyMetrics(leads: Lead[]): WeeklyMetric[] {
  return [
    {
      label: "Opportunities discovered",
      value: leads.filter((l) => isWithinDays(l.createdAt, 7)).length,
    },
    {
      label: "Outreach sent",
      value: leads.filter((l) => isWithinDays(l.lastContactedAt, 7)).length,
    },
    {
      label: "Replies received",
      value: leads.filter((l) => isReplyStatus(l) && isWithinDays(l.updatedAt, 7)).length,
    },
    {
      label: "Meetings booked",
      value: leads.filter(
        (l) => normalizeLeadStatus(l.status) === "meeting" && isWithinDays(l.updatedAt, 7),
      ).length,
    },
    {
      label: "Deals closed",
      value: leads.filter(
        (l) => normalizeLeadStatus(l.status) === "closed_won" && isWithinDays(l.updatedAt, 7),
      ).length,
    },
  ];
}

export function buildWeeklyReview(ctx: FocusContext) {
  const metrics = buildWeeklyMetrics(ctx.leads);
  const outreach = metrics[1]?.value ?? 0;
  const replies = metrics[2]?.value ?? 0;
  const discovered = metrics[0]?.value ?? 0;
  const replyRate = ctx.analytics.replyRate;

  let summary: string;
  let recommendation: string;

  if (outreach >= 10 && replyRate >= 15) {
    summary = `Excellent work this week. Your outreach consistency is strong and reply quality is improving.`;
    recommendation = "Double down on the conversations that are already warm.";
  } else if (outreach >= 5) {
    summary = `Solid week — ${outreach} outreach actions logged with a ${replyRate}% reply rate.`;
    recommendation = "A few more follow-ups today could convert interest into meetings.";
  } else if (discovered >= 10 && outreach === 0) {
    summary = `You've been discovering but quiet on outreach. ${discovered} new opportunities are waiting.`;
    recommendation = "Contact five opportunities today to restart pipeline momentum.";
  } else if (outreach === 0 && ctx.analytics.totalLeads === 0) {
    summary = "Your week is a blank canvas — a great time to build your first pipeline.";
    recommendation = "Discover 15 opportunities and send your first outreach today.";
  } else if (outreach < 3) {
    summary = "You've been quieter than usual. Small consistent actions compound fast.";
    recommendation = "Following up with just five opportunities today could restart pipeline momentum.";
  } else {
    summary = `${replies} repl${replies === 1 ? "y" : "ies"} this week — steady progress on a growing pipeline.`;
    recommendation = "Keep today's mission clear and finish what's already in motion.";
  }

  return { metrics, summary, recommendation };
}

// ── Daily goals ───────────────────────────────────────────────────────────────

export function buildDailyGoals(ctx: FocusContext): FocusGoal[] {
  return generateProgressionGoals({
    plan: ctx.plan,
    leads: ctx.leads,
    followups: ctx.followups,
    completedGoalIds: ctx.completedGoalIds,
    eventTotals: ctx.progressionEvents,
    activeGoalCount: 4,
  });
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

// ── Full snapshot ─────────────────────────────────────────────────────────────

export function buildFocusSnapshot(firstName: string, ctx: FocusContext): FocusSnapshot {
  const greeting = buildGreeting(firstName, ctx);
  const recommendations = buildRecommendations(ctx);
  const weekly = buildWeeklyReview(ctx);
  const goals = buildDailyGoals(ctx);

  return {
    greeting: {
      period: greeting.period,
      subtitle: greeting.subtitle,
    },
    recommendations: recommendations.length > 0 ? recommendations : buildEmptyRecommendations(),
    weeklyMetrics: weekly.metrics,
    weeklySummary: weekly.summary,
    weeklyRecommendation: weekly.recommendation,
    goals,
  };
}

export function goalProgress(goal: FocusGoal) {
  return progressionGoalProgress(goal);
}

export function isGoalComplete(goal: FocusGoal) {
  return isProgressionGoalComplete(goal);
}

export function pickCelebration(goal: FocusGoal) {
  return pickGoalCelebration(goal);
}
