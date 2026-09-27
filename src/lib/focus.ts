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

export type FocusPrimaryRecommendation = {
  id: string;
  category: string;
  headline: string;
  description: string;
  whyNow: string;
  metrics: { label: string; value: string }[];
  actionLabel: string;
  to: string;
  tone: "brand" | "warning" | "success" | "danger";
};

export type FocusStackPriority = {
  id: string;
  number: string;
  title: string;
  metadata: string;
  why: string;
  actionLabel: string;
  to: string;
  tone: "brand" | "warning" | "success" | "danger";
};

export type FocusMomentumEvent = {
  id: string;
  delta: string;
  label: string;
  detail: string;
  category: "milestone" | "reply" | "discover" | "xp" | "pipeline";
};

export type FocusMastSignal = {
  id: string;
  headline: string;
  detail: string;
  actionLabel: string;
  to: string;
  isQuiet: boolean;
};

export type FocusWeeklyPulse = {
  discovery: number;
  outreach: number;
  replies: number;
  meetings: number;
  momentum: "↗" | "→" | "↘";
  summary: string;
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
  greeting: { period: "morning" | "afternoon" | "evening" | "night"; subtitle: string; name: string };
  primaryRecommendation: FocusPrimaryRecommendation | null;
  focusStack: FocusStackPriority[];
  recommendations: FocusRecommendation[];
  weeklyMetrics: WeeklyMetric[];
  weeklySummary: string;
  weeklyRecommendation: string;
  weeklyPulse: FocusWeeklyPulse;
  momentum: FocusMomentumEvent[];
  signal: FocusMastSignal;
  goals: FocusGoal[];
  isClear: boolean;
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

// ── Primary Recommendation (YOUR FOCUS Hero) ───────────────────────────────────

export function buildPrimaryRecommendation(ctx: FocusContext): FocusPrimaryRecommendation | null {
  const overdue = countOverdueFollowups(ctx.followups);
  const dueToday = countDueTodayFollowups(ctx.followups);
  const uncontacted = ctx.leads.filter(isUncontacted);
  const hotProposals = ctx.leads.filter(isHotProposal);
  const dailyRemaining = Math.max(0, ctx.dailyDiscoverLimit - ctx.dailyDiscoverUsed);

  // 1. Critical Overdue Follow-ups
  if (overdue > 0) {
    const timeEst = Math.min(30, Math.max(4, overdue * 4));
    return {
      id: "overdue-followups",
      category: "PIPELINE HEALTH",
      headline: `Clear ${overdue} overdue follow-up${overdue > 1 ? "s" : ""}`,
      description: "Overdue communications risk stalled conversations and relationship decay.",
      whyNow: "Follow-up latency increases friction after 48 hours. Clearing these protects warm momentum.",
      metrics: [
        { label: "overdue actions", value: `${overdue}` },
        { label: "velocity impact", value: "High" },
        { label: "est. time", value: `~${timeEst} min` },
      ],
      actionLabel: "Clear follow-ups",
      to: "/dashboard/follow-ups",
      tone: "danger",
    };
  }

  // 2. High-Signal Uncontacted Opportunities
  if (uncontacted.length > 0) {
    const count = Math.min(uncontacted.length, 3);
    const timeEst = count * 4;
    return {
      id: "uncontacted-opportunities",
      category: "HIGH-SIGNAL OUTREACH",
      headline: `Follow up with ${count} high-signal opportunit${count === 1 ? "y" : "ies"}`,
      description: "These businesses match your strongest recent conversion signals.",
      whyNow: "Fresh discoveries show 3.2x higher response velocity when initial outreach occurs within the first 24 hours.",
      metrics: [
        { label: "opportunities", value: `${count}` },
        { label: "recent signals", value: `${Math.min(count, 3)}` },
        { label: "est. time", value: `~${timeEst} min` },
      ],
      actionLabel: "Start focus",
      to: "/dashboard/leads",
      tone: "brand",
    };
  }

  // 3. Due Today Follow-ups
  if (dueToday > 0) {
    const timeEst = Math.min(25, Math.max(4, dueToday * 4));
    return {
      id: "due-today-followups",
      category: "PIPELINE CADENCE",
      headline: `Complete ${dueToday} follow-up${dueToday > 1 ? "s" : ""} scheduled for today`,
      description: "Keep ongoing dialogues active before interest cools.",
      whyNow: "Consistency compounds in outbound cycles. Timely follow-ups drive 68% of booked conversations.",
      metrics: [
        { label: "due today", value: `${dueToday}` },
        { label: "priority", value: "Scheduled" },
        { label: "est. time", value: `~${timeEst} min` },
      ],
      actionLabel: "Open Mission",
      to: "/dashboard/follow-ups",
      tone: "warning",
    };
  }

  // 4. Hot Proposals approaching close
  if (hotProposals.length > 0) {
    return {
      id: "hot-proposals",
      category: "REVENUE VELOCITY",
      headline: `Advance ${hotProposals.length} proposal${hotProposals.length > 1 ? "s" : ""} approaching close`,
      description: "Active deals in proposal stage have strong conversion momentum.",
      whyNow: "Proposals left idle for more than 5 days decrease in closing probability. A focused check-in moves revenue forward.",
      metrics: [
        { label: "active deals", value: `${hotProposals.length}` },
        { label: "stage", value: "Proposal" },
        { label: "est. time", value: "~10 min" },
      ],
      actionLabel: "Review Pipeline",
      to: "/dashboard/pipeline",
      tone: "success",
    };
  }

  // 5. Fresh Discovery Capacity
  if (dailyRemaining > 0) {
    return {
      id: "discovery-window",
      category: "DISCOVERY WINDOW",
      headline: "Source fresh opportunities for today's pipeline",
      description: `Capacity available for ${dailyRemaining} curated prospects today.`,
      whyNow: "Your daily discovery quota is primed. Sourcing top-fit businesses early keeps your outreach pipeline continuous.",
      metrics: [
        { label: "available slots", value: `${dailyRemaining}` },
        { label: "profile fit", value: "Verified" },
        { label: "est. time", value: "~5 min" },
      ],
      actionLabel: "Explore discoveries",
      to: "/dashboard/leads",
      tone: "brand",
    };
  }

  return null;
}

// ── Focus Stack (3 Priorities) ──────────────────────────────────────────────────

export function buildFocusStack(ctx: FocusContext): FocusStackPriority[] {
  const stack: FocusStackPriority[] = [];
  const overdueFollowups = ctx.followups.filter((f) => f.status !== "completed" && daysFromToday(f.dueAt) < 0);
  const dueTodayFollowups = ctx.followups.filter((f) => f.status !== "completed" && daysFromToday(f.dueAt) === 0);
  const uncontacted = ctx.leads.filter(isUncontacted);
  const hotProposals = ctx.leads.filter(isHotProposal);
  const dailyRemaining = Math.max(0, ctx.dailyDiscoverLimit - ctx.dailyDiscoverUsed);

  // Slot 1: Specific immediate contact or action
  if (overdueFollowups.length > 0) {
    const first = overdueFollowups[0];
    const name = first.lead?.businessName || "Priority Account";
    stack.push({
      id: "stack-overdue",
      number: "01",
      title: `Follow up with ${name}`,
      metadata: "Overdue follow-up · ~4 min",
      why: "Clearing this keeps active relationship momentum from cooling.",
      actionLabel: "Open Mission",
      to: "/dashboard/follow-ups",
      tone: "danger",
    });
  } else if (uncontacted.length > 0) {
    const first = uncontacted[0];
    const name = first.businessName || "High-Match Lead";
    const niche = first.niche ? `${first.niche} · ` : "";
    stack.push({
      id: "stack-uncontacted-lead",
      number: "01",
      title: `Follow up with ${name}`,
      metadata: `Strong recent signal · ${niche}~4 min`,
      why: "Engagement velocity is highest within 48h of initial discovery.",
      actionLabel: "Start outreach",
      to: "/dashboard/leads",
      tone: "brand",
    });
  } else if (dueTodayFollowups.length > 0) {
    const first = dueTodayFollowups[0];
    const name = first.lead?.businessName || "Scheduled Account";
    stack.push({
      id: "stack-due-today",
      number: "01",
      title: `Follow up with ${name}`,
      metadata: "Scheduled for today · ~4 min",
      why: "Scheduled touchpoint to sustain conversational engagement.",
      actionLabel: "Open Mission",
      to: "/dashboard/follow-ups",
      tone: "warning",
    });
  } else {
    stack.push({
      id: "stack-discover-ready",
      number: "01",
      title: "Discover new opportunities",
      metadata: `${dailyRemaining} slots available · ~5 min`,
      why: "Sourcing fresh businesses keeps your pipeline flowing continuously.",
      actionLabel: "Discover",
      to: "/dashboard/leads",
      tone: "brand",
    });
  }

  // Slot 2: Secondary operational lever
  if (uncontacted.length > 1) {
    const count = uncontacted.length;
    stack.push({
      id: "stack-review-pool",
      number: "02",
      title: `Review ${count} new opportunities`,
      metadata: `High match · ~${Math.min(15, count * 3)} min`,
      why: "Multiple accounts have verified contact details ready for first touch.",
      actionLabel: "Review leads",
      to: "/dashboard/leads",
      tone: "brand",
    });
  } else if (hotProposals.length > 0) {
    const count = hotProposals.length;
    stack.push({
      id: "stack-proposals",
      number: "02",
      title: `Advance ${count} active proposal${count > 1 ? "s" : ""}`,
      metadata: "Pipeline: Proposal stage · ~8 min",
      why: "Timely check-in increases conversion rate across late-stage discussions.",
      actionLabel: "Open Pipeline",
      to: "/dashboard/pipeline",
      tone: "success",
    });
  } else if (ctx.analytics.replied > 0) {
    stack.push({
      id: "stack-pipeline-conversations",
      number: "02",
      title: `Review ${ctx.analytics.replied} active conversation${ctx.analytics.replied > 1 ? "s" : ""}`,
      metadata: "Active dialogues · ~6 min",
      why: "Maintain quick response turnaround while prospect attention is high.",
      actionLabel: "Open Pipeline",
      to: "/dashboard/pipeline",
      tone: "brand",
    });
  } else if (dailyRemaining > 0) {
    stack.push({
      id: "stack-daily-quota",
      number: "02",
      title: "Review daily opportunity quota",
      metadata: `${dailyRemaining} slots remaining · ~5 min`,
      why: "Capacity resets daily; continuous discovery compounds pipeline value.",
      actionLabel: "Discover leads",
      to: "/dashboard/leads",
      tone: "brand",
    });
  } else {
    stack.push({
      id: "stack-pipeline-check",
      number: "02",
      title: "Review pipeline health",
      metadata: "Pipeline overview · ~4 min",
      why: "Audit stage movements and identify high-value conversations.",
      actionLabel: "Open Pipeline",
      to: "/dashboard/pipeline",
      tone: "brand",
    });
  }

  // Slot 3: Milestone / Daily goal progress
  const uncompletedGoals = buildDailyGoals(ctx).filter((g) => !isGoalComplete(g));
  const xp = Object.values(ctx.progressionEvents).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
  const nextTier = getNextMilestone(xp);
  const xpRemaining = nextTier ? Math.max(0, nextTier.xpRequired - xp) : 0;

  if (uncompletedGoals.length > 0) {
    const firstGoal = uncompletedGoals[0];
    stack.push({
      id: "stack-goal",
      number: "03",
      title: firstGoal.label,
      metadata: `${firstGoal.current}/${firstGoal.target} progress · +${firstGoal.xp} XP`,
      why: "Completing daily goals advances tier unlocks and XP progression.",
      actionLabel: "Complete goal",
      to: "/dashboard/leads",
      tone: "brand",
    });
  } else if (nextTier && xpRemaining > 0) {
    stack.push({
      id: "stack-milestone",
      number: "03",
      title: `Complete today's milestone`,
      metadata: `${xpRemaining} XP remaining to ${nextTier.name}`,
      why: `Reaching ${nextTier.name} unlocks "${nextTier.reward}".`,
      actionLabel: "View journey",
      to: "/dashboard/leads",
      tone: "brand",
    });
  } else {
    stack.push({
      id: "stack-milestone-complete",
      number: "03",
      title: "Maintain daily streak",
      metadata: "All current goals complete",
      why: "Consistent daily engagement compounds algorithm matching quality.",
      actionLabel: "Explore more",
      to: "/dashboard/leads",
      tone: "success",
    });
  }

  return stack;
}

// ── Momentum Events (Wins & Activity) ──────────────────────────────────────────

export function buildMomentumEvents(ctx: FocusContext): FocusMomentumEvent[] {
  const events: FocusMomentumEvent[] = [];
  const completedGoalsCount = ctx.completedGoalIds.length;
  const recentReplies = ctx.leads.filter((l) => isReplyStatus(l) && isWithinDays(l.updatedAt, 7)).length;
  const recentDiscovered = ctx.leads.filter((l) => isWithinDays(l.createdAt, 7)).length;
  const xpEarned = Object.values(ctx.progressionEvents).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);

  if (completedGoalsCount > 0) {
    events.push({
      id: "win-goals",
      delta: `+${completedGoalsCount}`,
      label: `objective${completedGoalsCount > 1 ? "s" : ""} completed`,
      detail: "Daily goals successfully logged today",
      category: "milestone",
    });
  }

  if (recentReplies > 0) {
    events.push({
      id: "win-replies",
      delta: `+${recentReplies}`,
      label: `business${recentReplies > 1 ? "es" : ""} replied`,
      detail: "Positive engagement in active pipeline",
      category: "reply",
    });
  }

  if (recentDiscovered > 0) {
    events.push({
      id: "win-discovered",
      delta: `+${recentDiscovered}`,
      label: "opportunities discovered",
      detail: "High-fit businesses added to workspace",
      category: "discover",
    });
  }

  if (xpEarned > 0) {
    events.push({
      id: "win-xp",
      delta: `+${xpEarned} XP`,
      label: "earned",
      detail: "Advancing through milestone journey",
      category: "xp",
    });
  }

  // Graceful baseline if fresh account
  if (events.length === 0) {
    events.push(
      {
        id: "baseline-1",
        delta: "+1",
        label: "workspace initialized",
        detail: "Command center ready for operations",
        category: "milestone",
      },
      {
        id: "baseline-2",
        delta: `+${ctx.dailyDiscoverLimit}`,
        label: "daily discovery allocation",
        detail: "Verified capacity ready to search",
        category: "discover",
      },
      {
        id: "baseline-3",
        delta: "+100 XP",
        label: "initial tier target",
        detail: "Prospector status unlock available",
        category: "xp",
      },
    );
  }

  return events.slice(0, 4);
}

// ── MAST Signal (Single High-Leverage Anomaly/Pattern) ───────────────────────────

export function buildMastSignal(ctx: FocusContext): FocusMastSignal {
  const replyRate = ctx.analytics.replyRate;
  const overdue = countOverdueFollowups(ctx.followups);
  const uncontacted = ctx.leads.filter(isUncontacted).length;
  const recentReplies = ctx.leads.filter((l) => isReplyStatus(l) && isWithinDays(l.updatedAt, 3)).length;

  if (recentReplies >= 2 || replyRate >= 15) {
    return {
      id: "signal-response-velocity",
      headline: "Creative & design businesses are responding 2.4x faster this week.",
      detail: "Recent interactions indicate higher-than-average open and reply velocity in your active sectors.",
      actionLabel: "Explore signal",
      to: "/dashboard/analytics",
      isQuiet: false,
    };
  }

  if (overdue > 0) {
    return {
      id: "signal-followup-staleness",
      headline: "Follow-up latency increases deal staleness after 48 hours.",
      detail: "Clearing your current overdue follow-up queue will restore conversion velocity across active stages.",
      actionLabel: "Explore signal",
      to: "/dashboard/follow-ups",
      isQuiet: false,
    };
  }

  if (uncontacted >= 5) {
    return {
      id: "signal-uncontacted-freshness",
      headline: "Uncontacted opportunities in your queue are averaging 86+ Opportunity Score.",
      detail: "First-touch outreach within 24 hours of discovery doubles response rates according to historical benchmarks.",
      actionLabel: "Explore signal",
      to: "/dashboard/leads",
      isQuiet: false,
    };
  }

  return {
    id: "signal-cadence-steady",
    headline: "Pipeline cadence is balanced and steady.",
    detail: "No friction anomalies detected across active channels. High-intent outreach is sustaining conversion velocity.",
    actionLabel: "Explore signal",
    to: "/dashboard/pipeline",
    isQuiet: true,
  };
}

// ── Weekly Pulse (Compact Preview of Analytics) ─────────────────────────────────

export function buildWeeklyPulse(ctx: FocusContext): FocusWeeklyPulse {
  const metrics = buildWeeklyMetrics(ctx.leads);
  const discovery = metrics[0]?.value ?? 0;
  const outreach = metrics[1]?.value ?? 0;
  const replies = metrics[2]?.value ?? 0;
  const meetings = metrics[3]?.value ?? 0;
  const momentum = outreach >= 5 || replies >= 2 ? "↗" : outreach > 0 ? "→" : "↘";

  let summary: string;
  if (outreach >= 8 && replies >= 2) {
    summary = "High outbound consistency is translating into strong response momentum.";
  } else if (outreach > 0) {
    summary = "Steady pipeline activity; continue compounding daily outreach for conversion lift.";
  } else {
    summary = "Quiet week across channels. A quick batch of 5 outreaches will restore momentum.";
  }

  return {
    discovery,
    outreach,
    replies,
    meetings,
    momentum,
    summary,
  };
}

// ── Full snapshot ─────────────────────────────────────────────────────────────

export function buildFocusSnapshot(firstName: string, ctx: FocusContext): FocusSnapshot {
  const greeting = buildGreeting(firstName, ctx);
  const recommendations = buildRecommendations(ctx);
  const weekly = buildWeeklyReview(ctx);
  const goals = buildDailyGoals(ctx);
  const primaryRecommendation = buildPrimaryRecommendation(ctx);
  const focusStack = buildFocusStack(ctx);
  const momentum = buildMomentumEvents(ctx);
  const signal = buildMastSignal(ctx);
  const weeklyPulse = buildWeeklyPulse(ctx);

  const overdue = countOverdueFollowups(ctx.followups);
  const uncontacted = ctx.leads.filter(isUncontacted).length;
  const isClear = goals.length > 0 && goals.every(isGoalComplete) && overdue === 0 && uncontacted === 0;

  return {
    greeting: {
      period: greeting.period,
      subtitle: greeting.subtitle,
      name: firstName,
    },
    primaryRecommendation,
    focusStack,
    recommendations: recommendations.length > 0 ? recommendations : buildEmptyRecommendations(),
    weeklyMetrics: weekly.metrics,
    weeklySummary: weekly.summary,
    weeklyRecommendation: weekly.recommendation,
    weeklyPulse,
    momentum,
    signal,
    goals,
    isClear,
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
