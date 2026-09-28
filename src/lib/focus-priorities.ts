import type { FollowupWithLead, Lead } from "./api";
import { normalizeLeadStatus } from "./lead-workspace.js";
import { isUntouchedDiscoveredLead } from "./lead-provenance.js";

/**
 * Focus decision logic ("what deserves my attention right now?").
 *
 * Everything here is a deterministic function of data the app really holds:
 * follow-ups (`lead_followups`), lead status / `lastContactedAt` /
 * `opportunityScore` / provenance, goal progress, XP and discovery capacity.
 *
 * It deliberately makes NO claim about replies (no reply events exist), stage
 * stalls, deal value, channel performance or anomalies. "Silent" only ever
 * means "no reply recorded by the user".
 *
 * Priority order (rank, lower wins):
 *   1 overdue / due-today follow-up
 *   2 contacted lead with no pending follow-up
 *   3 contacted lead with no recorded reply for a while
 *   4 untouched discovered opportunities
 *   5 goal ready to claim / nearly complete
 *   6 XP close to the next tier
 *   7 discovery (only when the attention backlog is empty)
 * Nothing left => clear state.
 */

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Days after last contact before "no recorded reply" counts as silence. */
export const SILENT_AFTER_DAYS = 7;
/** A goal is "nearly complete" at this completion ratio... */
export const NEAR_GOAL_RATIO = 0.6;
/** ...or when this few units remain. */
export const NEAR_GOAL_REMAINING = 3;
/** XP-to-next-tier at or below this is worth surfacing. */
export const NEAR_TIER_XP = 50;
/** Max secondary priorities shown under the primary one. */
export const MAX_STACK_ITEMS = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

export type FocusTone = "brand" | "warning" | "success" | "danger";

export type FocusPriorityKind =
  | "followup_overdue"
  | "followup_due_today"
  | "schedule_followup"
  | "silent_contact"
  | "review_opportunities"
  | "goal_claim"
  | "goal_near"
  | "xp_milestone"
  | "discover";

/** One candidate per family, so the stack can never repeat the same activity. */
export type FocusPriorityFamily =
  | "followup"
  | "schedule"
  | "silent"
  | "opportunities"
  | "progress"
  | "discover";

export type FocusGoalInput = {
  id: string;
  label: string;
  target: number;
  current: number;
  xp: number;
  category: string;
};

export type FocusPriorityInput = {
  leads: Lead[];
  followups: FollowupWithLead[];
  /** Currently generated goals (unclaimed targets). */
  goals: FocusGoalInput[];
  /** Every goal id already claimed. */
  claimedGoalIds: string[];
  xp: number;
  nextTier: { name: string; xpRequired: number } | null;
  dailyRemaining: number;
  /** null when the monthly allowance is unknown. */
  monthlyRemaining: number | null;
  /** Follow-ups (Mission) are a Starter+ feature. */
  followupsAvailable: boolean;
  now?: Date;
};

export type FocusPriority = {
  id: string;
  kind: FocusPriorityKind;
  family: FocusPriorityFamily;
  rank: number;
  tone: FocusTone;
  /** Set for goal priorities: the goal's category (used to avoid repeating it). */
  goalCategory?: string;
  hero: {
    category: string;
    headline: string;
    description: string;
    whyNow: string;
    metrics: { label: string; value: string }[];
    actionLabel: string;
    to: string;
    hash?: string;
  };
  stack: {
    title: string;
    metadata: string;
    why: string;
    actionLabel: string;
    to: string;
    hash?: string;
  };
};

// ── Date + text helpers ───────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole calendar days from `now` to `date` (negative = in the past). */
function calendarDaysFromNow(date: Date, now: Date) {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

export function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? one : many;
}

function daysText(n: number) {
  return `${n} ${plural(n, "day")}`;
}

function cleanName(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

function leadHref(leadId: number | string) {
  return `/dashboard/leads/${leadId}`;
}

function compareIds(a: number | string, b: number | string) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function validScore(lead: Lead): number | null {
  const score = lead.opportunityScore;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

const GOAL_ROUTES: Record<string, string> = {
  discover: "/dashboard/leads",
  search: "/dashboard/leads",
  outreach: "/dashboard/relationships",
  relationships: "/dashboard/relationships",
  ai: "/dashboard/relationships",
  pipeline: "/dashboard/pipeline",
  intelligence: "/dashboard/pipeline",
  mission: "/dashboard/follow-ups",
  data: "/dashboard/import",
};

function goalRoute(category: string) {
  return GOAL_ROUTES[category] ?? "/dashboard/leads";
}

// ── Signal extraction ─────────────────────────────────────────────────────────

function isOpenFollowup(f: FollowupWithLead) {
  return f.status !== "completed";
}

/** Statuses where the user is still waiting to hear back. */
const AWAITING_REPLY_STATUSES = new Set(["new", "email_sent", "instagram_sent", "called"]);

function leadOf(f: FollowupWithLead, leadById: Map<number, Lead>): Lead | undefined {
  return f.lead ?? leadById.get(f.leadId);
}

function isDeadLead(lead: Lead | undefined) {
  return lead ? normalizeLeadStatus(lead.status) === "dead" : false;
}

/**
 * Open follow-ups on live leads with a valid due date, most overdue first.
 * Follow-ups on leads marked `dead` are ignored.
 */
export function selectOpenFollowups(followups: FollowupWithLead[], leads: Lead[], now: Date) {
  const leadById = new Map(leads.map((l) => [l.id, l]));
  return followups
    .filter((f) => isOpenFollowup(f) && !isDeadLead(leadOf(f, leadById)))
    .map((f) => {
      const due = parseDate(f.dueAt);
      return due
        ? { followup: f, lead: leadOf(f, leadById), due, days: calendarDaysFromNow(due, now) }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.due.getTime() - b.due.getTime() || compareIds(a.followup.id, b.followup.id));
}

/**
 * Leads contacted by the user and still awaiting a reply, with no pending
 * follow-up. Needs a real `lastContactedAt` (otherwise the age is unknown).
 */
export function selectContactedWithoutFollowup(
  leads: Lead[],
  followups: FollowupWithLead[],
  now: Date,
) {
  const withOpenFollowup = new Set(followups.filter(isOpenFollowup).map((f) => f.leadId));
  return leads
    .map((lead) => {
      const contacted = parseDate(lead.lastContactedAt);
      if (!contacted) return null;
      if (!AWAITING_REPLY_STATUSES.has(normalizeLeadStatus(lead.status))) return null;
      if (withOpenFollowup.has(lead.id)) return null;
      const days = Math.max(0, -calendarDaysFromNow(contacted, now));
      return { lead, contacted, days };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

// ── Candidate builders ────────────────────────────────────────────────────────

function followupCandidate(input: FocusPriorityInput, now: Date): FocusPriority | null {
  const open = selectOpenFollowups(input.followups, input.leads, now);
  const overdue = open.filter((f) => f.days < 0);
  const dueToday = open.filter((f) => f.days === 0);

  if (overdue.length > 0) {
    const top = overdue[0];
    const name = cleanName(top.lead?.businessName);
    const overdueDays = Math.abs(top.days);
    const n = overdue.length;
    const est = Math.min(30, n * 3);
    return {
      id: "followup-overdue",
      kind: "followup_overdue",
      family: "followup",
      rank: 1,
      tone: "danger",
      hero: {
        category: "FOLLOW-UP",
        headline: name ? `Follow up with ${name}` : "Send your overdue follow-up",
        description:
          n > 1
            ? `Its follow-up is ${daysText(overdueDays)} overdue. ${n - 1} more ${plural(n - 1, "follow-up is", "follow-ups are")} overdue too.`
            : `Its follow-up is ${daysText(overdueDays)} overdue.`,
        whyNow:
          n > 1
            ? "This is your oldest open follow-up."
            : "The scheduled date for this follow-up has already passed.",
        metrics: [
          { label: "overdue", value: `${n} ${plural(n, "follow-up")}` },
          { label: "most overdue", value: `${daysText(overdueDays)}` },
          { label: "est. time", value: `~${est} min` },
        ],
        actionLabel: "Open Mission",
        to: "/dashboard/follow-ups",
      },
      stack: {
        title: name ? `Follow up with ${name}` : "Send your overdue follow-up",
        metadata: `${daysText(overdueDays)} overdue · ~3 min`,
        why: "Its scheduled follow-up date has passed.",
        actionLabel: "Open Mission",
        to: "/dashboard/follow-ups",
      },
    };
  }

  if (dueToday.length > 0) {
    const top = dueToday[0];
    const name = cleanName(top.lead?.businessName);
    const n = dueToday.length;
    return {
      id: "followup-due-today",
      kind: "followup_due_today",
      family: "followup",
      rank: 1,
      tone: "warning",
      hero: {
        category: "FOLLOW-UP",
        headline: name ? `Follow up with ${name}` : "Send your follow-up due today",
        description:
          n > 1
            ? `Its follow-up is due today. ${n - 1} more ${plural(n - 1, "follow-up is", "follow-ups are")} due today.`
            : "Its follow-up is due today.",
        whyNow: "It is scheduled for today and nothing is overdue.",
        metrics: [
          { label: "due today", value: `${n} ${plural(n, "follow-up")}` },
          { label: "overdue", value: "None" },
          { label: "est. time", value: `~${Math.min(30, n * 3)} min` },
        ],
        actionLabel: "Open Mission",
        to: "/dashboard/follow-ups",
      },
      stack: {
        title: name ? `Follow up with ${name}` : "Send your follow-up due today",
        metadata: "Due today · ~3 min",
        why: "It is scheduled for today.",
        actionLabel: "Open Mission",
        to: "/dashboard/follow-ups",
      },
    };
  }

  return null;
}

function scheduleCandidate(input: FocusPriorityInput, now: Date): FocusPriority | null {
  if (!input.followupsAvailable) return null;
  const all = selectContactedWithoutFollowup(input.leads, input.followups, now).filter(
    (x) => x.days < SILENT_AFTER_DAYS,
  );
  if (all.length === 0) return null;
  // Oldest contact first: it is the closest to going quiet.
  all.sort(
    (a, b) => a.contacted.getTime() - b.contacted.getTime() || compareIds(a.lead.id, b.lead.id),
  );
  const top = all[0];
  const name = cleanName(top.lead.businessName);
  const n = all.length;
  const subject = name ?? "a business";
  return {
    id: "schedule-followup",
    kind: "schedule_followup",
    family: "schedule",
    rank: 2,
    tone: "warning",
    hero: {
      category: "NEXT STEP",
      headline: name ? `Schedule a follow-up with ${name}` : "Schedule a follow-up",
      description: `You contacted ${subject}, but no follow-up is scheduled.`,
      whyNow:
        n > 1
          ? `${n} contacted businesses have no follow-up scheduled; this is the earliest contact.`
          : "A follow-up keeps a contacted business from slipping away.",
      metrics: [
        { label: "no follow-up", value: `${n} ${plural(n, "business", "businesses")}` },
        { label: "last contacted", value: top.days === 0 ? "Today" : `${daysText(top.days)} ago` },
        { label: "est. time", value: "~2 min" },
      ],
      actionLabel: "Open lead",
      to: leadHref(top.lead.id),
    },
    stack: {
      title: name ? `Schedule a follow-up with ${name}` : "Schedule a follow-up",
      metadata: `Contacted ${top.days === 0 ? "today" : `${daysText(top.days)} ago`} · ~2 min`,
      why: "It has no pending follow-up.",
      actionLabel: "Open lead",
      to: leadHref(top.lead.id),
    },
  };
}

function silentCandidate(input: FocusPriorityInput, now: Date): FocusPriority | null {
  const all = selectContactedWithoutFollowup(input.leads, input.followups, now).filter(
    (x) => x.days >= SILENT_AFTER_DAYS,
  );
  if (all.length === 0) return null;
  // Most recently contacted first: those are the warmest to nudge.
  all.sort(
    (a, b) => b.contacted.getTime() - a.contacted.getTime() || compareIds(a.lead.id, b.lead.id),
  );
  const top = all[0];
  const name = cleanName(top.lead.businessName);
  const n = all.length;
  return {
    id: "silent-contact",
    kind: "silent_contact",
    family: "silent",
    rank: 3,
    tone: "brand",
    hero: {
      category: "NO REPLY RECORDED",
      headline: name ? `Follow up with ${name}` : "Follow up on a quiet contact",
      description: `${name ?? "This business"} has had no recorded reply for ${daysText(top.days)} since your last contact.`,
      whyNow:
        n > 1
          ? `${n} contacted businesses have no recorded reply after ${SILENT_AFTER_DAYS}+ days; this is the most recent contact.`
          : "No reply has been recorded and no follow-up is scheduled.",
      metrics: [
        { label: "no recorded reply", value: `${n} ${plural(n, "business", "businesses")}` },
        { label: "since contact", value: daysText(top.days) },
        { label: "est. time", value: "~3 min" },
      ],
      actionLabel: "Open lead",
      to: leadHref(top.lead.id),
    },
    stack: {
      title: name ? `Follow up with ${name}` : "Follow up on a quiet contact",
      metadata: `No recorded reply · ${daysText(top.days)} · ~3 min`,
      why: "No reply is recorded and no follow-up is scheduled.",
      actionLabel: "Open lead",
      to: leadHref(top.lead.id),
    },
  };
}

function opportunitiesCandidate(input: FocusPriorityInput): FocusPriority | null {
  const untouched = input.leads.filter(isUntouchedDiscoveredLead);
  if (untouched.length === 0) return null;

  // Highest score first; unscored leads after scored ones; newest first.
  const ranked = [...untouched].sort((a, b) => {
    const sa = validScore(a);
    const sb = validScore(b);
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
    const ta = parseDate(a.createdAt)?.getTime() ?? 0;
    const tb = parseDate(b.createdAt)?.getTime() ?? 0;
    return tb - ta || compareIds(a.id, b.id);
  });

  const n = untouched.length;
  const scored = ranked.filter((l) => validScore(l) !== null);
  const topScore = scored.length > 0 ? Math.round(validScore(scored[0])!) : null;
  const top = ranked[0];
  const topName = cleanName(top.businessName);
  const est = Math.min(15, Math.max(3, n * 2));

  const headline =
    n === 1
      ? topName
        ? `Review ${topName}`
        : "Review 1 discovered opportunity"
      : `Review ${n} discovered opportunities`;

  let description: string;
  if (scored.length > 0) {
    description =
      n === 1
        ? `You haven't contacted it yet. Its opportunity score is ${topScore}.`
        : scored.length === n
          ? `You haven't contacted any of them yet. They all have opportunity scores; the highest is ${topScore}.`
          : `You haven't contacted any of them yet. ${scored.length} of ${n} have an opportunity score; the highest is ${topScore}.`;
  } else {
    description =
      n === 1 ? "You haven't contacted it yet." : "You haven't contacted any of them yet.";
  }

  const metrics: { label: string; value: string }[] = [
    { label: "not contacted", value: `${n} ${plural(n, "lead")}` },
    scored.length > 0
      ? { label: "top score", value: `${topScore}` }
      : { label: "opportunity score", value: "Not available" },
    { label: "est. time", value: `~${est} min` },
  ];

  const to = n === 1 ? leadHref(top.id) : "/dashboard/relationships";
  return {
    id: "review-opportunities",
    kind: "review_opportunities",
    family: "opportunities",
    rank: 4,
    tone: "brand",
    hero: {
      category: "DISCOVERED OPPORTUNITIES",
      headline,
      description,
      whyNow: "They came from Discover and are still waiting for a first touch.",
      metrics,
      actionLabel: n === 1 ? "Open lead" : "Review leads",
      to,
    },
    stack: {
      title: headline,
      metadata:
        scored.length > 0 ? `Top score ${topScore} · ~${est} min` : `Not contacted · ~${est} min`,
      why: "They are from Discover and haven't been contacted.",
      actionLabel: n === 1 ? "Open lead" : "Review leads",
      to,
    },
  };
}

function goalRemaining(g: FocusGoalInput) {
  return Math.max(0, g.target - g.current);
}

function goalCandidate(input: FocusPriorityInput): FocusPriority | null {
  const claimed = new Set(input.claimedGoalIds);
  const claimable = input.goals
    .filter((g) => g.target > 0 && g.current >= g.target && !claimed.has(g.id))
    .sort((a, b) => b.xp - a.xp || compareIds(a.id, b.id));

  const tierLeft = input.nextTier ? Math.max(0, input.nextTier.xpRequired - input.xp) : 0;

  if (claimable.length > 0) {
    const g = claimable[0];
    const more = claimable.length - 1;
    return {
      id: "goal-claim",
      kind: "goal_claim",
      family: "progress",
      rank: 5,
      tone: "success",
      goalCategory: g.category,
      hero: {
        category: "GOAL READY",
        headline: `Claim your reward for "${g.label}"`,
        description: `This goal is complete. Claiming it awards +${g.xp} XP.${more > 0 ? ` ${more} more ${plural(more, "goal is", "goals are")} ready too.` : ""}`,
        whyNow: "Completed goals only award XP once you claim them.",
        metrics: [
          { label: "progress", value: `${g.target} / ${g.target}` },
          { label: "reward", value: `+${g.xp} XP` },
          ...(input.nextTier && tierLeft > 0
            ? [{ label: `to ${input.nextTier.name}`, value: `${tierLeft} XP` }]
            : [{ label: "ready to claim", value: `${claimable.length}` }]),
        ],
        actionLabel: "Claim in Goals",
        to: "/dashboard",
        hash: "focus-goals",
      },
      stack: {
        title: `Claim "${g.label}"`,
        metadata: `Complete · +${g.xp} XP`,
        why: "The goal is finished; XP is awarded when you claim it.",
        actionLabel: "Claim in Goals",
        to: "/dashboard",
        hash: "focus-goals",
      },
    };
  }

  const near = input.goals
    .filter((g) => {
      if (g.target <= 0 || g.current <= 0 || g.current >= g.target) return false;
      if (claimed.has(g.id)) return false;
      return g.current / g.target >= NEAR_GOAL_RATIO || goalRemaining(g) <= NEAR_GOAL_REMAINING;
    })
    .sort(
      (a, b) =>
        b.current / b.target - a.current / a.target ||
        goalRemaining(a) - goalRemaining(b) ||
        b.xp - a.xp ||
        compareIds(a.id, b.id),
    );

  if (near.length === 0) return null;
  const g = near[0];
  const left = goalRemaining(g);
  const to = goalRoute(g.category);
  return {
    id: "goal-near",
    kind: "goal_near",
    family: "progress",
    rank: 5,
    tone: "brand",
    goalCategory: g.category,
    hero: {
      category: "GOAL PROGRESS",
      headline: `Finish "${g.label}"`,
      description: `You're ${g.current}/${g.target}. ${left} more to go for +${g.xp} XP.`,
      whyNow: "It is your closest goal to completion.",
      metrics: [
        { label: "progress", value: `${g.current} / ${g.target}` },
        { label: "remaining", value: `${left}` },
        { label: "reward", value: `+${g.xp} XP` },
      ],
      actionLabel: "Work on goal",
      to,
    },
    stack: {
      title: `Finish "${g.label}"`,
      metadata: `${g.current}/${g.target} · +${g.xp} XP`,
      why: `${left} more to complete it.`,
      actionLabel: "Work on goal",
      to,
    },
  };
}

function xpCandidate(input: FocusPriorityInput): FocusPriority | null {
  if (!input.nextTier) return null;
  const remaining = Math.max(0, input.nextTier.xpRequired - input.xp);
  if (remaining <= 0 || remaining > NEAR_TIER_XP) return null;

  // Only claim a goal can bridge the gap when a real goal is worth enough.
  const bridge = input.goals
    .filter((g) => g.xp >= remaining && g.current < g.target)
    .sort((a, b) => b.current / b.target - a.current / a.target || compareIds(a.id, b.id))[0];

  const description = bridge
    ? `Finishing "${bridge.label}" is worth +${bridge.xp} XP.`
    : "Completing goals awards XP toward it.";
  const to = bridge ? goalRoute(bridge.category) : "/dashboard";
  return {
    id: "xp-milestone",
    kind: "xp_milestone",
    family: "progress",
    rank: 6,
    tone: "brand",
    hero: {
      category: "MILESTONE",
      headline: `You're ${remaining} XP from ${input.nextTier.name}`,
      description,
      whyNow: `You have ${input.xp} XP; ${input.nextTier.name} starts at ${input.nextTier.xpRequired}.`,
      metrics: [
        { label: "XP remaining", value: `${remaining}` },
        { label: "next tier", value: input.nextTier.name },
        { label: "current XP", value: `${input.xp}` },
      ],
      actionLabel: bridge ? "Work on goal" : "View goals",
      to,
      ...(bridge ? {} : { hash: "focus-goals" }),
    },
    stack: {
      title: `${remaining} XP to ${input.nextTier.name}`,
      metadata: `${input.xp} XP now`,
      why: bridge
        ? `Finishing "${bridge.label}" would close the gap.`
        : "Goals award XP when claimed.",
      actionLabel: bridge ? "Work on goal" : "View goals",
      to,
      ...(bridge ? {} : { hash: "focus-goals" }),
    },
  };
}

function discoverCandidate(input: FocusPriorityInput): FocusPriority | null {
  if (input.dailyRemaining <= 0) return null;
  if (input.monthlyRemaining !== null && input.monthlyRemaining <= 0) return null;
  const total = input.leads.length;
  const first = total === 0;
  return {
    id: "discover-window",
    kind: "discover",
    family: "discover",
    rank: 7,
    tone: "brand",
    hero: {
      category: "DISCOVERY",
      headline: first
        ? "Discover your first opportunities"
        : "Your queue is light. Find new opportunities.",
      description: first
        ? "Your workspace has no leads yet."
        : "No follow-ups or uncontacted discoveries are waiting on you.",
      whyNow: "Nothing higher priority needs attention, and you still have discoveries available.",
      metrics: [
        { label: "discoveries left today", value: `${input.dailyRemaining}` },
        { label: "leads in workspace", value: `${total}` },
        { label: "est. time", value: "~5 min" },
      ],
      actionLabel: "Open Discover",
      to: "/dashboard/leads",
    },
    stack: {
      title: first ? "Discover your first opportunities" : "Find new opportunities",
      metadata: "Queue is light · ~5 min",
      why: "Nothing else is waiting on you.",
      actionLabel: "Open Discover",
      to: "/dashboard/leads",
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ordered, de-duplicated priorities (at most one per family). Index 0 is the
 * primary recommendation; the rest feed the Focus Stack. Empty = clear.
 */
export function collectFocusPriorities(input: FocusPriorityInput): FocusPriority[] {
  const now = input.now ?? new Date();
  const list: FocusPriority[] = [];
  const push = (p: FocusPriority | null) => {
    if (p) list.push(p);
  };

  push(input.followupsAvailable ? followupCandidate(input, now) : null);
  push(scheduleCandidate(input, now));
  push(silentCandidate(input, now));
  push(opportunitiesCandidate(input));

  const backlogEmpty = list.length === 0;

  const progress = goalCandidate(input) ?? xpCandidate(input);
  push(progress);

  // Discovery only competes when nothing needs attention, and never repeats a
  // discovery-flavoured goal that is already on the list.
  const goalIsDiscoveryFlavoured =
    progress?.goalCategory === "discover" || progress?.goalCategory === "search";
  if (backlogEmpty && !goalIsDiscoveryFlavoured) push(discoverCandidate(input));

  return list.sort((a, b) => a.rank - b.rank);
}

/** Secondary priorities after the primary: diverse by family, capped. */
export function selectFocusStack(priorities: FocusPriority[]): FocusPriority[] {
  const seen = new Set<FocusPriorityFamily>();
  if (priorities[0]) seen.add(priorities[0].family);
  const out: FocusPriority[] = [];
  for (const p of priorities.slice(1)) {
    if (seen.has(p.family)) continue;
    seen.add(p.family);
    out.push(p);
    if (out.length >= MAX_STACK_ITEMS) break;
  }
  return out;
}
