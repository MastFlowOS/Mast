/**
 * DAILY GOALS — engine (Phase 1.5: expand + harden the goal pool).
 *
 * MAST shows EXACTLY 4 Daily Goals every local calendar day.
 * This module is PURE (no React, no Supabase, no clock except the
 * injected `now`) so selection, planning, and progress are deterministic
 * and testable.
 *
 *   day opens → load persisted set → (none?) buildDailyGoalDrafts() → persist
 *   during day → computeGoalProgress() from durable records → monotonic write
 *   next day  → new local goal date → new set of exactly 4
 *
 * Nothing here is a counter over `progression_events`. Every goal owns its
 * completion predicate, computed from the durable record type that
 * represents exactly that action (leads, lead_activities, lead_followups,
 * scrape_jobs). One user action therefore cannot advance an unrelated goal.
 *
 * Capability source of truth: `PLAN_CAPABILITIES` (permissions.ts) plus
 * `isDiscoveryModeAllowed` (config/plans.ts). Never plan names.
 */
import type { FollowupWithLead, Lead } from "@/lib/api";
import { isDiscoveryModeAllowed } from "@/config/plans";
import { GENUINE_SEND_TYPES } from "@/lib/outreach/continuity/read";
import { parseGeoScope } from "@/lib/geo/scope";
import { isDiscoveredLead } from "@/lib/lead-provenance";
import { normalizeLeadStatus } from "@/lib/lead-workspace";
import { selectContactedWithoutFollowup, selectOpenFollowups } from "@/lib/focus-priorities";
import { PLAN_CAPABILITIES, type FeatureId } from "@/lib/permissions";
import type { PlanId } from "@/lib/plans";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GoalFamily =
  | "discovery"
  | "outreach"
  | "relationships"
  | "workspace"
  | "follow_through";

export const GOAL_FAMILIES: readonly GoalFamily[] = [
  "discovery",
  "outreach",
  "relationships",
  "workspace",
  "follow_through",
];

/** Exactly 4 goals per local day — product contract. */
export const DAILY_GOAL_COUNT = 4;

/**
 * Families that may hold TWO slots, and only as these specific pairs, because
 * the two objectives are genuinely different work:
 * 1. Clearing existing due commitments vs creating new commitments.
 * 2. Contacting never-contacted prospects vs reconnecting with quiet past relationships.
 * Everything else: strictly one per family.
 */
export const PAIRABLE: ReadonlyArray<readonly [string, string]> = [
  ["follow_through.clear_due", "follow_through.schedule_next_steps"],
  ["outreach.start_conversations", "outreach.reconnect"],
];

export type GoalAction = { to: string; label: string };

/** Result of an eligibility check: the goal is possible today with this target. */
export type Eligibility = {
  target: number;
  /** Higher = earlier slot and wins family contention. State-driven. */
  priority: number;
  /** Frozen id snapshot the predicate is evaluated against (specific eligible set). */
  snapshotIds?: string[];
  /**
   * True when eligibility leans on leads a same-day discovery goal will
   * deliver (cold start). Dropped again if no discovery goal is selected.
   */
  projected?: boolean;
};

export type EligibilityState = {
  plan: PlanId;
  can: (feature: FeatureId) => boolean;
  now: Date;
  dateKey: string;
  leads: Lead[];
  followups: FollowupWithLead[];
  /** Remaining daily discovery allowance; null = unknown (server enforces). */
  dailyRemaining: number | null;
  /** Remaining monthly discovery allowance; null = unknown. */
  monthlyRemaining: number | null;
  /** Leads a selected same-day discovery goal is expected to add (0 on first pass). */
  projectedDiscoveryYield: number;
};

/** Durable evidence, all restricted by the caller to `>= windowStart` unless stated. */
export type GoalEvidence = {
  leads: Lead[];
  followups: FollowupWithLead[];
  /** lead_activities of a genuine-send type with timestamp >= windowStart. */
  genuineSends: { leadId: number | string; type: string; timestamp: string }[];
  /** Lead ids (stringified) that already had a genuine send BEFORE windowStart. */
  priorSendLeadIds: ReadonlySet<string>;
  /** lead_activities `note_added` with timestamp >= windowStart. */
  notes: { leadId: number | string; timestamp: string }[];
  /** scrape_jobs created >= windowStart. */
  discoveryJobs: { createdAt: string; region: string; resultsCount: number; status: string }[];
  /** ISO country codes the user searched BEFORE windowStart. */
  priorSearchedCountryCodes: ReadonlySet<string>;
};

export type GoalInstanceMetadata = {
  /** ISO instant the goal was generated; only actions at/after it count. */
  windowStart: string;
  actionTo: string;
  actionLabel: string;
  completionExplanation: string;
  snapshotIds?: string[];
  projected?: boolean;
};

export type DailyGoalDraft = {
  slot: number;
  goalDate: string;
  definitionId: string;
  family: GoalFamily;
  title: string;
  description: string;
  target: number;
  progress: 0;
  status: "active";
  xp: number;
  plan: PlanId;
  metadata: GoalInstanceMetadata;
};

/** A persisted daily_goals row as the client sees it. */
export type DailyGoalInstance = Omit<DailyGoalDraft, "progress" | "status"> & {
  id: string;
  progress: number;
  status: "active" | "completed";
  createdAt: string;
  completedAt: string | null;
  /** True once XP has been claimed (goal_completions row exists). */
  claimed?: boolean;
};

export type DailyGoalDefinition = {
  id: string;
  family: GoalFamily;
  minPlan: PlanId;
  /** Capability that must be enabled; checked in addition to `minPlan`. */
  capability?: FeatureId;
  xp: number;
  action: GoalAction;
  title: (target: number) => string;
  description: (target: number) => string;
  completion: (target: number) => string;
  eligibility: (state: EligibilityState) => Eligibility | null;
  /** Deterministic progress (uncapped); caller caps at target and enforces monotonicity. */
  progress: (goal: { target: number; metadata: GoalInstanceMetadata }, evidence: GoalEvidence) => number;
};

// ─── Small helpers ───────────────────────────────────────────────────────────

const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, pro: 2, premium: 3 };

/** Local calendar date key (YYYY-MM-DD) — NEVER UTC. */
export function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Whole local calendar days from `now` to `iso` (negative = past). DST-safe. */
export function localDayDiff(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? NaN : t;
}

export const atOrAfter = (iso: string | null | undefined, windowStart: string) => {
  const t = ms(iso);
  return !Number.isNaN(t) && t >= ms(windowStart);
};

/** FNV-1a — stable per-day variety without randomness. Returns 0..(mod-1). */
function stableHash(input: string, mod: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % mod;
}

export function planCan(plan: PlanId, feature: FeatureId): boolean {
  return PLAN_CAPABILITIES[plan]?.includes(feature) ?? false;
}

export function canUseGoalDefinition(plan: PlanId, def: Pick<DailyGoalDefinition, "minPlan" | "capability">): boolean {
  if (PLAN_RANK[plan] < PLAN_RANK[def.minPlan]) return false;
  return def.capability ? planCan(plan, def.capability) : true;
}

export const isDead = (l: Lead) => normalizeLeadStatus(l.status) === "dead";
export const isUntouched = (l: Lead) => normalizeLeadStatus(l.status) === "new" && !l.lastContactedAt;

/** Untouched lead with at least one channel the user's plan can actually use. */
export function isReachable(l: Lead, can: (f: FeatureId) => boolean): boolean {
  if (l.email?.trim() || l.phone?.trim()) return true; // email + phone: every plan
  if (can("instagramChannel") && l.instagramHandle?.trim()) return true;
  if (can("websiteChannel") && l.website?.trim()) return true;
  return false;
}

export function untouchedReachable(s: EligibilityState): Lead[] {
  return s.leads.filter((l) => !isDead(l) && isUntouched(l) && isReachable(l, s.can));
}

export function discoveryHeadroom(s: EligibilityState): number {
  return Math.min(s.dailyRemaining ?? Number.POSITIVE_INFINITY, s.monthlyRemaining ?? Number.POSITIVE_INFINITY);
}

const DISCOVER_BASE_TARGET: Record<PlanId, number> = { free: 10, starter: 15, pro: 25, premium: 25 };
const MIN_DISCOVER_TARGET = 5;

/**
 * Coordinated allowance: Discovery takes headroom minus manual adds reservation (2),
 * ensuring the day's goals never compete for impossible allowance.
 */
export function discoverTarget(s: EligibilityState, reservedForManual = 2): number | null {
  const headroom = discoveryHeadroom(s);
  if (headroom < MIN_DISCOVER_TARGET) return null; // cap effectively exhausted → impossible today
  const effective = headroom === Number.POSITIVE_INFINITY ? headroom : Math.max(MIN_DISCOVER_TARGET, headroom - reservedForManual);
  if (effective < MIN_DISCOVER_TARGET) return MIN_DISCOVER_TARGET;
  const capped = Math.min(DISCOVER_BASE_TARGET[s.plan], Math.floor(effective));
  return Math.max(MIN_DISCOVER_TARGET, Math.floor(capped / 5) * 5);
}

/**
 * Coordinated allowance: Manual Add Relationship consumes allowance (1 per lead).
 * Its target is capped by remaining allowance so it never promises more adds than can be made.
 */
export function addRelationshipTarget(s: EligibilityState): number | null {
  const headroom = discoveryHeadroom(s);
  if (headroom <= 0) return null;
  return headroom === Number.POSITIVE_INFINITY ? 2 : Math.max(1, Math.min(2, Math.floor(headroom)));
}

export const distinctCount = (ids: Iterable<string | number>) => new Set(Array.from(ids, String)).size;

// ─── Definitions ─────────────────────────────────────────────────────────────

export const DAILY_GOAL_DEFINITIONS: readonly DailyGoalDefinition[] = [
  // ── DISCOVERY ─────────────────────────────────────────────────────────────
  {
    id: "discovery.discover_new",
    family: "discovery",
    minPlan: "free",
    capability: "localSearch",
    xp: 25,
    action: { to: "/dashboard/leads", label: "Open Discover" },
    title: (t) => `Discover ${t} new opportunities`,
    description: (t) => `Run a search and bring ${t} new businesses into your workspace today.`,
    completion: (t) => `${t} new businesses were delivered to your workspace by Discover.`,
    eligibility: (s) => {
      const target = discoverTarget(s);
      if (target === null) return null;
      const supply = untouchedReachable(s).length;
      // Low backlog of workable leads → discovery is the day's top need.
      const priority = (supply < 10 ? 75 : 45) + stableHash(`${s.dateKey}|discover`, 5);
      return { target, priority };
    },
    // Discover-sourced leads only (manual entries are a different goal).
    progress: (g, ev) =>
      distinctCount(
        ev.leads.filter((l) => isDiscoveredLead(l) && atOrAfter(l.createdAt, g.metadata.windowStart)).map((l) => l.id),
      ),
  },
  {
    id: "discovery.explore_country",
    family: "discovery",
    minPlan: "starter",
    capability: "regionalSearch", // Starter+ = country / global search (Free is local/US only)
    xp: 50,
    action: { to: "/dashboard/leads", label: "Search a new country" },
    title: () => "Explore a new country",
    description: () => "Search a country you have not searched before and get results back.",
    completion: () => "A search in a country you had never searched returned results.",
    eligibility: (s) => {
      if (discoveryHeadroom(s) < MIN_DISCOVER_TARGET) return null; // needs discovery allowance left today
      return { target: 1, priority: 40 + stableHash(`${s.dateKey}|explore`, 20) };
    },
    progress: (g, ev) => {
      const fresh = new Set<string>();
      for (const job of ev.discoveryJobs) {
        if (!atOrAfter(job.createdAt, g.metadata.windowStart)) continue;
        if (!(job.resultsCount > 0)) continue; // a search that found nothing explored nothing
        const scope = parseGeoScope(job.region ?? "");
        if (scope.invalid.length > 0) continue;
        // Global / continent tokens are not "a country"; only explicit countries count.
        for (const c of scope.countries) if (!ev.priorSearchedCountryCodes.has(c.code)) fresh.add(c.code);
      }
      return fresh.size;
    },
  },

  // ── OUTREACH ──────────────────────────────────────────────────────────────
  {
    id: "outreach.start_conversations",
    family: "outreach",
    minPlan: "free",
    xp: 50,
    action: { to: "/dashboard/relationships", label: "Open Relationships" },
    title: (t) => `Make first contact with ${t} ${t === 1 ? "business" : "businesses"}`,
    description: (t) => `Reach out to ${t} ${t === 1 ? "business" : "businesses"} you have never contacted.`,
    completion: (t) => `${t} ${t === 1 ? "business" : "businesses"} you had never contacted received a real email, DM, call or form message.`,
    eligibility: (s) => {
      const untouched = untouchedReachable(s);
      const real = untouched.length;
      const supply = real + s.projectedDiscoveryYield;
      if (supply < 1) return null;

      const isRanked = isDiscoveryModeAllowed(s.plan, "instant_pool_ranked");
      let snapshotIds: string[] | undefined;
      let priority = 70 + Math.min(15, Math.floor(real / 2));

      // For Pro/Premium, prioritize ranked opportunities if available (Section 7)
      if (isRanked && real >= 3) {
        const scored = untouched
          .filter((l) => typeof l.opportunityScore === "number" && Number.isFinite(l.opportunityScore))
          .sort((a, b) => (b.opportunityScore as number) - (a.opportunityScore as number) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
        if (scored.length >= 3) {
          const chosen = scored.slice(0, Math.min(5, scored.length));
          snapshotIds = chosen.map((l) => String(l.id));
          priority = 85;
        }
      }

      const target = snapshotIds ? snapshotIds.length : Math.min(5, Math.max(1, supply));
      return {
        target,
        priority,
        ...(snapshotIds ? { snapshotIds } : {}),
        projected: real < 1,
      };
    },
    // Distinct leads whose FIRST-EVER genuine send happened after windowStart.
    progress: (g, ev) => {
      const snapshotSet = g.metadata.snapshotIds ? new Set(g.metadata.snapshotIds) : null;
      const first = new Set<string>();
      for (const send of ev.genuineSends) {
        if (!(GENUINE_SEND_TYPES as readonly string[]).includes(send.type)) continue;
        if (!atOrAfter(send.timestamp, g.metadata.windowStart)) continue;
        const id = String(send.leadId);
        if (snapshotSet && !snapshotSet.has(id)) continue;
        if (!ev.priorSendLeadIds.has(id)) first.add(id);
      }
      return first.size;
    },
  },
  {
    id: "outreach.reconnect",
    family: "outreach",
    minPlan: "free",
    xp: 50,
    action: { to: "/dashboard/relationships", label: "Reconnect with contacts" },
    title: (t) => `Reconnect with ${t} ${t === 1 ? "contact" : "contacts"}`,
    description: (t) => `Reach out to ${t} ${t === 1 ? "business" : "businesses"} you contacted before that went quiet.`,
    completion: (t) => `${t} previously-contacted ${t === 1 ? "business received" : "businesses received"} a fresh follow-up message.`,
    eligibility: (s) => {
      // Must have genuine previous contact before windowStart (recorded in lastContactedAt)
      const contacted = s.leads.filter((l) => !isDead(l) && Boolean(l.lastContactedAt) && isReachable(l, s.can));
      if (contacted.length < 1) return null;
      // Prioritize quiet contacts (7+ days since contact)
      const quiet = contacted.filter((l) => {
        const diff = localDayDiff(l.lastContactedAt, s.now);
        return diff !== null && -diff >= 7;
      });
      const pool = quiet.length >= 1 ? quiet : contacted;
      const target = Math.min(3, pool.length);
      const priority = 65 + (quiet.length >= 2 ? 15 : 0) + stableHash(`${s.dateKey}|reconnect`, 5);
      return { target, priority };
    },
    // Distinct leads that had genuine contact BEFORE windowStart and received a new genuine send since.
    progress: (g, ev) => {
      const reconnected = new Set<string>();
      for (const send of ev.genuineSends) {
        if (!(GENUINE_SEND_TYPES as readonly string[]).includes(send.type)) continue;
        if (!atOrAfter(send.timestamp, g.metadata.windowStart)) continue;
        const id = String(send.leadId);
        if (ev.priorSendLeadIds.has(id)) reconnected.add(id);
      }
      return reconnected.size;
    },
  },

  // ── RELATIONSHIPS ─────────────────────────────────────────────────────────
  {
    id: "relationships.add_relationship",
    family: "relationships",
    minPlan: "free",
    capability: "relationships",
    xp: 25,
    action: { to: "/dashboard/relationships", label: "Add a relationship" },
    title: (t) => `Add ${t} ${t === 1 ? "relationship" : "relationships"} yourself`,
    description: (t) => `Use Add Relationship to enter ${t} ${t === 1 ? "person or business" : "people or businesses"} you already know or met.`,
    completion: (t) => `${t} ${t === 1 ? "relationship was" : "relationships were"} added manually through Add Relationship.`,
    eligibility: (s) => {
      const target = addRelationshipTarget(s);
      if (target === null || target < 1) return null;
      return { target, priority: 50 + (s.leads.length < 5 ? 20 : 0) };
    },
    // Manual entries only. Discover leads are a different goal.
    progress: (g, ev) =>
      distinctCount(
        ev.leads
          .filter((l) => (l.source ?? "").trim().toLowerCase() === "manual" && atOrAfter(l.createdAt, g.metadata.windowStart))
          .map((l) => l.id),
      ),
  },

  // ── WORKSPACE ─────────────────────────────────────────────────────────────
  {
    id: "workspace.add_context",
    family: "workspace",
    minPlan: "free",
    capability: "relationships",
    xp: 25,
    action: { to: "/dashboard/relationships", label: "Add notes" },
    title: (t) => `Add context to ${t} ${t === 1 ? "relationship" : "relationships"}`,
    description: (t) => `Write a note on ${t} ${t === 1 ? "relationship" : "relationships"}: what they need, what you learned, what is next.`,
    completion: (t) => `Notes were saved on ${t} different ${t === 1 ? "relationship" : "relationships"}.`,
    eligibility: (s) => {
      const live = s.leads.filter((l) => !isDead(l));
      const supply = live.length + s.projectedDiscoveryYield;
      if (supply < 1) return null;
      const contactedNoNotes = live.filter((l) => l.lastContactedAt && !l.notes?.trim()).length;
      return {
        target: Math.min(3, supply),
        priority: 45 + (contactedNoNotes >= 3 ? 10 : 0),
        projected: live.length < 1,
      };
    },
    // Distinct leads with a saved note (note_added activity) since windowStart.
    progress: (g, ev) => distinctCount(ev.notes.filter((n) => atOrAfter(n.timestamp, g.metadata.windowStart)).map((n) => n.leadId)),
  },

  // ── FOLLOW-THROUGH (Starter+: `mission`) ──────────────────────────────────
  {
    id: "follow_through.clear_due",
    family: "follow_through",
    minPlan: "starter",
    capability: "mission",
    xp: 50,
    action: { to: "/dashboard/follow-ups", label: "Open Follow-ups" },
    title: (t) => `Clear ${t} due ${t === 1 ? "follow-up" : "follow-ups"}`,
    description: (t) => `You have follow-ups due or overdue. Complete ${t} of them today.`,
    completion: (t) => `${t} follow-ups that were due or overdue this morning were completed.`,
    eligibility: (s) => {
      // MUST NOT exist without genuinely due/overdue follow-ups (local day).
      const due = selectOpenFollowups(s.followups, s.leads, s.now).filter((f) => f.days <= 0);
      if (due.length === 0) return null;
      const hasOverdue = due.some((f) => f.days < 0);
      return {
        target: Math.min(5, due.length),
        priority: hasOverdue ? 100 : 85,
        snapshotIds: due.slice(0, 50).map((f) => String(f.followup.id)),
      };
    },
    // Only follow-ups that were due at generation time, completed since.
    progress: (g, ev) => {
      const set = new Set(g.metadata.snapshotIds ?? []);
      return distinctCount(
        ev.followups
          .filter((f) => set.has(String(f.id)) && f.status === "completed" && atOrAfter(f.completedAt ?? f.updatedAt, g.metadata.windowStart))
          .map((f) => f.id),
      );
    },
  },
  {
    id: "follow_through.schedule_next_steps",
    family: "follow_through",
    minPlan: "starter",
    capability: "mission",
    xp: 50,
    action: { to: "/dashboard/relationships", label: "Schedule next steps" },
    title: (t) => `Schedule ${t} next ${t === 1 ? "step" : "steps"}`,
    description: (t) => `Pick ${t} businesses you already contacted and put a follow-up on the calendar.`,
    completion: (t) => `Follow-ups were scheduled for ${t} businesses you had already contacted.`,
    eligibility: (s) => {
      const waiting = selectContactedWithoutFollowup(s.leads, s.followups, s.now).length;
      if (waiting < 1) return null;
      return { target: Math.min(3, waiting), priority: 60 + Math.min(20, waiting * 2) };
    },
    // Follow-up ROWS created since windowStart, one per distinct contacted lead.
    progress: (g, ev) => {
      const leadById = new Map(ev.leads.map((l) => [String(l.id), l]));
      return distinctCount(
        ev.followups
          .filter((f) => atOrAfter(f.createdAt, g.metadata.windowStart))
          .filter((f) => Boolean((f.lead ?? leadById.get(String(f.leadId)))?.lastContactedAt))
          .map((f) => f.leadId),
      );
    },
  },
];

const DEFINITION_BY_ID = new Map(DAILY_GOAL_DEFINITIONS.map((d) => [d.id, d]));
export const getGoalDefinition = (id: string) => DEFINITION_BY_ID.get(id);

// ─── Legacy audit (the original 15 definitions) ──────────────────────────────

export type LegacyDisposition = "retained" | "transformed" | "removed" | "deferred";

export const LEGACY_GOAL_AUDIT: ReadonlyArray<{
  key: string;
  metric: string;
  disposition: LegacyDisposition;
  becomes: string | null;
  reason: string;
}> = [
  { key: "discover", metric: "opportunities_discovered", disposition: "transformed", becomes: "discovery.discover_new", reason: "Counted ALL leads ever; now counts Discover deliveries since the goal was issued, capped by remaining daily allowance." },
  { key: "contact", metric: "businesses_contacted", disposition: "transformed", becomes: "outreach.start_conversations", reason: "Single definition for first outreach to untouched leads (prioritizes ranked leads on Pro/Premium)." },
  { key: "relationships", metric: "relationships_created", disposition: "transformed", becomes: "relationships.add_relationship", reason: "Fired on bulk import and 'Save to pipeline'; now only the manual Add Relationship action, coordinated with allowance." },
  { key: "search-industries", metric: "industries_searched", disposition: "removed", becomes: null, reason: "Pure app-usage counter, cross-counted from one Discover call; the real objective is covered by discovery goals." },
  { key: "search-regions", metric: "regions_searched", disposition: "transformed", becomes: "discovery.explore_country", reason: "Was a search counter; now one meaningful act: results from a country never searched before (Starter+)." },
  { key: "exports", metric: "exports_completed", disposition: "removed", becomes: null, reason: "'Click Export N times' is not a meaningful objective (export is also a CSV-with-.xlsx-name stub)." },
  { key: "ai-actions", metric: "ai_actions", disposition: "removed", becomes: null, reason: "Counted draft generation, which is not an outcome; outreach is measured by real sends." },
  { key: "followups", metric: "followups_completed", disposition: "transformed", becomes: "follow_through.clear_due", reason: "Unbounded 'complete N' could depend on future due dates; now exists only when follow-ups are due/overdue today and targets that snapshot." },
  { key: "pipeline", metric: "pipeline_moves", disposition: "deferred", becomes: null, reason: "Board drag calls updateLead with no activity record and overlaps outreach statuses; needs a pipeline_stage_moved event first." },
  { key: "meetings", metric: "meetings_booked", disposition: "removed", becomes: null, reason: "Outcome depends on another person's behaviour and is set by a manual status flip." },
  { key: "notes", metric: "notes_added", disposition: "transformed", becomes: "workspace.add_context", reason: "Counted leads with any note text (incl. imports); now distinct leads with a note saved since the goal was issued." },
  { key: "relationship-review", metric: "relationships_reviewed", disposition: "removed", becomes: null, reason: "Never had an event source (already disabled in the legacy catalog)." },
  { key: "executive-briefings", metric: "executive_briefings", disposition: "deferred", becomes: null, reason: "Passive auto-generated panel; no discrete user action to verify." },
  { key: "weekly-intelligence", metric: "weekly_intelligence", disposition: "deferred", becomes: null, reason: "Passive panel; no discrete user action to verify." },
  { key: "opportunity-insights", metric: "opportunity_insights", disposition: "deferred", becomes: null, reason: "Insight is generated on view; there is no user action to verify." },
];

// ─── Generation & Diagnostics ────────────────────────────────────────────────

export type BuildDailyGoalsInput = {
  plan: PlanId;
  now: Date;
  leads: Lead[];
  followups: FollowupWithLead[];
  dailyDiscoverUsed?: number | null;
  dailyDiscoverLimit?: number | null;
  monthlyRemaining?: number | null;
};

type Candidate = { def: DailyGoalDefinition; el: Eligibility; tie: number };

function collectCandidates(state: EligibilityState): Candidate[] {
  const out: Candidate[] = [];
  for (const def of DAILY_GOAL_DEFINITIONS) {
    if (!canUseGoalDefinition(state.plan, def)) continue; // plan / capability gate FIRST
    const el = def.eligibility(state);
    if (!el || !(el.target >= 1)) continue; // impossible today
    out.push({ def, el, tie: stableHash(`${state.dateKey}|${def.id}`, 1000) });
  }
  return out;
}

const byPriority = (a: Candidate, b: Candidate) =>
  b.el.priority - a.el.priority || a.tie - b.tie || a.def.id.localeCompare(b.def.id);

function select(candidates: Candidate[]): Candidate[] {
  const main = [...candidates].sort(byPriority);
  const picked: Candidate[] = [];
  const families = new Set<GoalFamily>();

  // Pass 1 — objective diversity: one goal per family.
  for (const c of main) {
    if (picked.length >= DAILY_GOAL_COUNT) break;
    if (families.has(c.def.family)) continue;
    picked.push(c);
    families.add(c.def.family);
  }
  // Pass 2 — only allow-listed genuinely-distinct pairs may double up a family.
  for (const c of main) {
    if (picked.length >= DAILY_GOAL_COUNT) break;
    if (picked.includes(c)) continue;
    const partner = picked.find((p) => p.def.family === c.def.family);
    if (
      partner &&
      PAIRABLE.some(
        ([a, b]) =>
          (a === partner.def.id && b === c.def.id) ||
          (b === partner.def.id && a === c.def.id),
      )
    ) {
      picked.push(c);
    }
  }
  return picked.sort(byPriority);
}

export type InsufficientGoalsDiagnostic = {
  ok: false;
  code: "INSUFFICIENT_LEGITIMATE_GOALS";
  reason: string;
  availableCount: number;
  drafts: DailyGoalDraft[];
  exhaustedFamilies: GoalFamily[];
  missingMechanics: string[];
};

export type DailyGoalGenerationResult =
  | {
      ok: true;
      goals: DailyGoalDraft[];
      drafts: DailyGoalDraft[];
    }
  | InsufficientGoalsDiagnostic;

export class DailyGoalGenerationError extends Error {
  readonly diagnostic: InsufficientGoalsDiagnostic;
  constructor(diagnostic: InsufficientGoalsDiagnostic) {
    super(diagnostic.reason);
    this.name = "DailyGoalGenerationError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Builds candidate drafts with diagnostic reporting.
 * Evaluates active work, growth goals, and fallback mechanisms.
 */
export function generateDailyGoals(input: BuildDailyGoalsInput): DailyGoalGenerationResult {
  const dateKey = localDateKey(input.now);
  const limit = input.dailyDiscoverLimit ?? null;
  const dailyRemaining = limit === null || limit <= 0 ? null : Math.max(0, limit - (input.dailyDiscoverUsed ?? 0));
  const base: EligibilityState = {
    plan: input.plan,
    can: (f) => planCan(input.plan, f),
    now: input.now,
    dateKey,
    leads: input.leads,
    followups: input.followups,
    dailyRemaining,
    monthlyRemaining: input.monthlyRemaining ?? null,
    projectedDiscoveryYield: 0,
  };

  // Pass A: real state only.
  let picked = select(collectCandidates(base));

  // Cold start: let a same-day discovery goal "supply" outreach/context goals,
  // but only keep them if a discovery goal is really selected.
  const discoveryCandidate = collectCandidates(base).find((c) => c.def.family === "discovery");
  if (picked.length < DAILY_GOAL_COUNT && discoveryCandidate) {
    const yieldEstimate = discoveryCandidate.el.target;
    const projected = select(collectCandidates({ ...base, projectedDiscoveryYield: yieldEstimate }));
    const hasDiscovery = projected.some((c) => c.def.family === "discovery");
    const valid = hasDiscovery ? projected : select(collectCandidates(base));
    if (valid.length > picked.length) picked = valid;
  }

  const windowStart = input.now.toISOString();
  const drafts: DailyGoalDraft[] = picked.map((c, i) => ({
    slot: i + 1,
    goalDate: dateKey,
    definitionId: c.def.id,
    family: c.def.family,
    title: c.def.title(c.el.target),
    description: c.def.description(c.el.target),
    target: c.el.target,
    progress: 0 as const,
    status: "active" as const,
    xp: c.def.xp,
    plan: input.plan,
    metadata: {
      windowStart,
      actionTo: c.def.action.to,
      actionLabel: c.def.action.label,
      completionExplanation: c.def.completion(c.el.target),
      ...(c.el.snapshotIds ? { snapshotIds: c.el.snapshotIds } : {}),
      ...(c.el.projected ? { projected: true } : {}),
    },
  }));

  if (drafts.length === DAILY_GOAL_COUNT) {
    return { ok: true, goals: drafts, drafts };
  }

  // Section 16: If exactly 4 cannot be found, provide machine-readable diagnostics
  const pickedFamilies = new Set(picked.map((c) => c.def.family));
  const exhaustedFamilies = GOAL_FAMILIES.filter((f) => !pickedFamilies.has(f));
  const missingMechanics: string[] = [];

  if (exhaustedFamilies.includes("discovery")) {
    missingMechanics.push("Discovery allowance is exhausted or capped for today.");
  }
  if (exhaustedFamilies.includes("relationships")) {
    missingMechanics.push("Manual relationships capability unavailable or allowance exhausted.");
  }
  if (exhaustedFamilies.includes("outreach")) {
    missingMechanics.push("No reachable untouched or quiet contacts available in workspace.");
  }
  if (exhaustedFamilies.includes("workspace")) {
    missingMechanics.push("No active leads available to attach notes/context to.");
  }
  if (exhaustedFamilies.includes("follow_through")) {
    missingMechanics.push(input.plan === "free" ? "Plan lacks 'mission' follow-through capability." : "No due follow-ups or contacted leads awaiting scheduling.");
  }

  return {
    ok: false,
    code: "INSUFFICIENT_LEGITIMATE_GOALS",
    reason: `Only ${drafts.length} of ${DAILY_GOAL_COUNT} legitimate goals could be formed. Exhausted families: ${exhaustedFamilies.join(", ")}.`,
    availableCount: drafts.length,
    drafts,
    exhaustedFamilies,
    missingMechanics,
  };
}

/**
 * Builds today's set of exactly 4 goals. Pure and deterministic for a given input.
 * In supported states (cold start, active workspaces across all plans), guarantees exactly 4.
 * If an unsupported degenerate state cannot form 4, throws DailyGoalGenerationError with
 * diagnostics so incomplete sets are never silently persisted.
 */
export function buildDailyGoalDrafts(input: BuildDailyGoalsInput): DailyGoalDraft[] {
  const result = generateDailyGoals(input);
  if (result.ok) {
    return result.goals;
  }
  throw new DailyGoalGenerationError(result);
}

// ─── Progress ────────────────────────────────────────────────────────────────

/**
 * Progress for one persisted goal from durable evidence. Deterministic,
 * capped at target, and MONOTONIC against what was already stored — a
 * deleted lead or a later status change can never un-complete a goal.
 */
export function computeGoalProgress(
  goal: Pick<DailyGoalInstance, "definitionId" | "target" | "progress" | "status" | "metadata">,
  evidence: GoalEvidence,
): number {
  if (goal.status === "completed") return goal.target;
  const def = DEFINITION_BY_ID.get(goal.definitionId);
  if (!def) return goal.progress;
  const raw = def.progress({ target: goal.target, metadata: goal.metadata }, evidence);
  return Math.min(goal.target, Math.max(goal.progress, Math.max(0, Math.floor(raw))));
}

/** Instances whose progress should be written back (changed, and never downward). */
export function reconcileDailyGoals(goals: DailyGoalInstance[], evidence: GoalEvidence) {
  return goals.map((g) => {
    const next = computeGoalProgress(g, evidence);
    return { goal: g, progress: next, changed: next !== g.progress, completes: next >= g.target && g.status !== "completed" };
  });
}

export const goalPercent = (g: Pick<DailyGoalInstance, "progress" | "target">) =>
  g.target <= 0 ? 100 : Math.min(100, Math.round((g.progress / g.target) * 100));

// ─── Plan matrix (generated from the definitions, so docs cannot drift) ──────

export function planMatrix() {
  const plans: PlanId[] = ["free", "starter", "pro", "premium"];
  return DAILY_GOAL_DEFINITIONS.map((d) => ({
    goal: d.id,
    family: d.family,
    xp: d.xp,
    plans: Object.fromEntries(plans.map((p) => [p, canUseGoalDefinition(p, d)])) as Record<PlanId, boolean>,
  }));
}
