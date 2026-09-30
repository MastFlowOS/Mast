/**
 * FOCUS ↔ DAILY GOALS integration (Phase 2). Pure and I/O-injected.
 *
 * Focus renders exactly the persisted set of 4 Daily Goals for the user's LOCAL
 * calendar day. This module holds the framework-free parts of that contract so
 * they can be tested without React or Supabase:
 *
 *   loadOrCreateDailyGoals   fetch today's persisted set; only if none exists,
 *                            generate + persist it once; always return the
 *                            authoritative rows
 *   planProgressWrites       which goals need a (monotonic) progress write, from
 *                            ONE shared evidence snapshot
 *   toPriorityGoals          adapter so the Focus priority waterfall reads the
 *                            same persisted goals (no legacy goal generator)
 *
 * Nothing here derives goals from `progression_events`, `profiles.xp`, or the
 * legacy progression counters.
 */
import type { FocusGoalInput } from "@/lib/focus-priorities";
import {
  DAILY_GOAL_COUNT,
  generateDailyGoals,
  localDateKey,
  reconcileDailyGoals,
  type BuildDailyGoalsInput,
  type DailyGoalDraft,
  type DailyGoalInstance,
  type GoalEvidence,
  type InsufficientGoalsDiagnostic,
} from "@/lib/dailyGoals";

// ─── Load / create ───────────────────────────────────────────────────────────

export type DailyGoalsLoadResult =
  | { kind: "ready"; goals: DailyGoalInstance[] }
  | { kind: "insufficient"; diagnostic: InsufficientGoalsDiagnostic };

export type DailyGoalsIo = {
  getDailyGoals: (goalDate: string) => Promise<DailyGoalInstance[]>;
  ensureDailyGoals: (goalDate: string, drafts: DailyGoalDraft[]) => Promise<DailyGoalInstance[]>;
};

/** Stable presentation order: the persisted slot. Never re-sorted by progress. */
export const orderBySlot = (goals: readonly DailyGoalInstance[]): DailyGoalInstance[] =>
  [...goals].sort((a, b) => a.slot - b.slot);

/**
 * 1. Fetch today's persisted goals for the local date.
 * 2. If they exist, return exactly those — never generate again.
 * 3. If none exist, run generateDailyGoals once. Only a full set of 4 is
 *    persisted (ensureDailyGoals is race-safe and returns the winner's rows).
 * 4. INSUFFICIENT_LEGITIMATE_GOALS persists nothing and reports the diagnostic.
 *
 * `now` decides the local date, so the goal date and the generated drafts can
 * never disagree.
 */
export async function loadOrCreateDailyGoals(opts: {
  now: Date;
  input: Omit<BuildDailyGoalsInput, "now">;
  io: DailyGoalsIo;
}): Promise<DailyGoalsLoadResult> {
  const { now, input, io } = opts;
  const dateKey = localDateKey(now);

  const existing = await io.getDailyGoals(dateKey);
  if (existing.length === DAILY_GOAL_COUNT) {
    return { kind: "ready", goals: orderBySlot(existing) };
  }
  if (existing.length > 0) {
    // ensure_daily_goals is atomic, so a partial set means something is wrong.
    // Never render 1–3 goals and never try to "top up" a persisted day.
    throw new Error(
      `Expected ${DAILY_GOAL_COUNT} daily goals for ${dateKey}, found ${existing.length}.`,
    );
  }

  const generated = generateDailyGoals({ ...input, now });
  if (!generated.ok) return { kind: "insufficient", diagnostic: generated };

  const persisted = await io.ensureDailyGoals(dateKey, generated.goals);
  if (persisted.length !== DAILY_GOAL_COUNT) {
    throw new Error(
      `Expected ${DAILY_GOAL_COUNT} persisted daily goals for ${dateKey}, got ${persisted.length}.`,
    );
  }
  return { kind: "ready", goals: orderBySlot(persisted) };
}

// ─── Progress ────────────────────────────────────────────────────────────────

export const isDailyGoalComplete = (g: Pick<DailyGoalInstance, "status" | "progress" | "target">) =>
  g.status === "completed" || g.progress >= g.target;

export const dailyGoalRemaining = (g: Pick<DailyGoalInstance, "progress" | "target">) =>
  Math.max(0, g.target - g.progress);

/** Distinct evidence windows. Goals of one day share a single windowStart, so this is normally 1. */
export function distinctWindowStarts(goals: readonly DailyGoalInstance[]): string[] {
  return Array.from(new Set(goals.map((g) => g.metadata.windowStart))).sort();
}

export type ProgressWrite = { id: string; progress: number };

/**
 * Which goals need setDailyGoalProgress, evaluated against shared evidence
 * keyed by windowStart. Each goal runs its OWN completion predicate (via its
 * definition); results are capped at target and never move backwards.
 */
export function planProgressWrites(
  goals: readonly DailyGoalInstance[],
  evidenceByWindow: ReadonlyMap<string, GoalEvidence>,
): ProgressWrite[] {
  const writes: ProgressWrite[] = [];
  for (const goal of goals) {
    const evidence = evidenceByWindow.get(goal.metadata.windowStart);
    if (!evidence) continue;
    const [plan] = reconcileDailyGoals([goal], evidence);
    if (plan.changed && plan.progress > goal.progress)
      writes.push({ id: goal.id, progress: plan.progress });
  }
  return writes;
}

/** Replace one goal in place (same slot, same position) with its updated row. */
export function replaceGoal(
  goals: readonly DailyGoalInstance[],
  next: DailyGoalInstance,
): DailyGoalInstance[] {
  return goals.map((g) =>
    g.id === next.id ? { ...g, ...next, claimed: next.claimed || g.claimed } : g,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function summarizeDailyGoals(goals: readonly DailyGoalInstance[]) {
  const completed = goals.filter(isDailyGoalComplete);
  const claimable = completed.filter((g) => !g.claimed);
  return {
    total: goals.length,
    completedCount: completed.length,
    claimedCount: goals.filter((g) => g.claimed).length,
    readyToClaimCount: claimable.length,
    /** XP still available to earn/claim today, straight from the persisted rows. */
    availableXp: goals.filter((g) => !g.claimed).reduce((sum, g) => sum + g.xp, 0),
  };
}

// ─── Focus priority adapter ──────────────────────────────────────────────────

/**
 * The Focus priority waterfall (hero / stack) needs to know about claimable and
 * nearly-finished goals. It reads the SAME persisted Daily Goals, and routes
 * with each goal's persisted action metadata.
 */
export function toPriorityGoals(goals: readonly DailyGoalInstance[]): {
  goals: FocusGoalInput[];
  claimedGoalIds: string[];
} {
  return {
    goals: goals.map((g) => ({
      id: g.id,
      label: g.title,
      target: g.target,
      current: g.progress,
      xp: g.xp,
      category: g.family === "discovery" ? "discover" : g.family,
      to: g.metadata.actionTo,
    })),
    claimedGoalIds: goals.filter((g) => g.claimed).map((g) => g.id),
  };
}

// ─── Local midnight ──────────────────────────────────────────────────────────

/** Milliseconds from `now` to the next LOCAL midnight (DST-safe: built from local date parts). */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}
