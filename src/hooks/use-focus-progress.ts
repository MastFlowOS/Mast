import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { addNotification } from "@/lib/notifications";
import {
  getCurrentMilestone,
  getNextMilestone,
  isGoalComplete,
  milestoneProgress,
  pickCelebration,
  type FocusGoal,
} from "@/lib/focus";
import { useAwardGoalXp, useCompletedGoalIds, useGoalClaims, useXp } from "@/hooks/use-mast-api";
import { bumpMilestoneBadge, flyXpToMilestone } from "@/lib/xp-fly";

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** How long the exit animation (fade + collapse) plays before a claimed goal is removed from the DOM. */
const EXIT_MS = 380;

/**
 * Drives the Focus page's XP + milestone progression.
 *
 * XP lives in `profiles.xp` in Supabase; which goals have already been
 * awarded today lives in the `goal_completions` table. Both are fetched via
 * React Query and mutated through `award_goal_xp`, a Postgres function that
 * awards XP for a given goal/day exactly once no matter how many times it's
 * called — so refreshes, extra tabs, and other devices can never
 * double-award or lose progress (enforced server-side; this hook's
 * `claimingGoalIds` guard just avoids firing redundant network requests
 * while a click is already in flight).
 *
 * XP is claimed by explicit user action (clicking a completed goal card),
 * not automatically the instant a goal crosses its target. `claimGoal`
 * sequences: award mutation -> XP-fly-to-counter animation -> milestone
 * counter/progress bump -> card exit animation -> removal from the visible
 * list (which lets the next generated goal, already present once
 * `completedGoalIds` includes this goal's id, take its place).
 */
export function useFocusProgress(goals: FocusGoal[]) {
  const today = todayKey();
  const { data: xp = 0, isLoading: xpLoading } = useXp();
  const { data: claimedToday = [], isLoading: claimsLoading } = useGoalClaims(today);
  const { data: completedGoalIds = [], isLoading: completedLoading } = useCompletedGoalIds();
  const awardGoalXp = useAwardGoalXp();

  const [dismissedGoals, setDismissedGoals] = useState<Set<string>>(new Set());
  const [claimingGoalIds, setClaimingGoalIds] = useState<Set<string>>(new Set());
  const [exitingGoalIds, setExitingGoalIds] = useState<Set<string>>(new Set());
  // Bumped every time a claim lands, so <FocusMilestones> can key a
  // one-shot bump animation off of it without needing its own XP-diff logic.
  const [xpBumpTick, setXpBumpTick] = useState(0);
  // Set while a milestone-tier level-up animation should be playing.
  const [leveledUpTier, setLeveledUpTier] = useState<string | null>(null);

  const claimedSet = useMemo(
    () => new Set([...claimedToday, ...completedGoalIds]),
    [claimedToday, completedGoalIds],
  );

  const inFlightRef = useRef<Set<string>>(new Set());

  function settleGoal(goalId: string) {
    setExitingGoalIds((prev) => new Set(prev).add(goalId));
    window.setTimeout(() => {
      setDismissedGoals((prev) => new Set(prev).add(goalId));
      setExitingGoalIds((prev) => {
        const next = new Set(prev);
        next.delete(goalId);
        return next;
      });
    }, EXIT_MS);
  }

  const claimGoal = useCallback(
    (goal: FocusGoal, cardEl: HTMLElement | null) => {
      if (!isGoalComplete(goal)) return;
      if (claimedSet.has(goal.id)) return;
      if (inFlightRef.current.has(goal.id)) return;

      inFlightRef.current.add(goal.id);
      setClaimingGoalIds((prev) => new Set(prev).add(goal.id));

      awardGoalXp.mutate(
        { goalId: goal.id, date: today, xp: goal.xp },
        {
          onSuccess: async ({ xp: newXp, awarded }) => {
            if (!awarded) {
              // Already claimed elsewhere (another tab/device) — just settle
              // the card out of the way, nothing new to celebrate or animate.
              inFlightRef.current.delete(goal.id);
              setClaimingGoalIds((prev) => {
                const next = new Set(prev);
                next.delete(goal.id);
                return next;
              });
              settleGoal(goal.id);
              return;
            }

            toast.success("Goal Completed", {
              description: pickCelebration(goal),
              duration: 5000,
            });
            addNotification({
              icon: "Target",
              iconColor: "text-emerald-400",
              iconBg: "bg-emerald-400/10 border-emerald-400/20",
              title: "Goal Completed",
              body: `${goal.label} +${goal.xp} XP`,
              category: "notifyAnnouncements",
            });

            const prevXp = newXp - goal.xp;
            const prevMilestone = getCurrentMilestone(prevXp);
            const nextMilestone = getCurrentMilestone(newXp);
            const milestoneLeveledUp = prevMilestone.id !== nextMilestone.id;

            // Let the flying XP pill actually travel before the counter/bar update.
            await flyXpToMilestone(cardEl, goal.xp);

            setXpBumpTick((tick) => tick + 1);
            bumpMilestoneBadge();

            if (milestoneLeveledUp) {
              setLeveledUpTier(nextMilestone.id);
              window.setTimeout(() => {
                toast("Milestone Reached", {
                  description: `+${goal.xp} XP. New milestone completed: ${nextMilestone.name}.`,
                  duration: 6000,
                });
                addNotification({
                  icon: "Trophy",
                  iconColor: "text-brand",
                  iconBg: "bg-brand/10 border-brand/20",
                  title: "Milestone Reached",
                  body: `${nextMilestone.name} completed. Rewards are being prepared.`,
                  category: "notifyAnnouncements",
                });
              }, 200);
              window.setTimeout(() => setLeveledUpTier(null), 2200);
            }

            inFlightRef.current.delete(goal.id);
            setClaimingGoalIds((prev) => {
              const next = new Set(prev);
              next.delete(goal.id);
              return next;
            });
            settleGoal(goal.id);
          },
          onError: () => {
            inFlightRef.current.delete(goal.id);
            setClaimingGoalIds((prev) => {
              const next = new Set(prev);
              next.delete(goal.id);
              return next;
            });
            toast.error("Couldn't claim that goal", {
              description: "Please try again in a moment.",
            });
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [claimedSet, today],
  );

  const visibleGoals = goals.filter((goal) => !dismissedGoals.has(goal.id));

  return {
    xp,
    visibleGoals,
    currentMilestone: getCurrentMilestone(xp),
    nextMilestone: getNextMilestone(xp),
    milestonePct: milestoneProgress(xp),
    isLoading: xpLoading || claimsLoading || completedLoading,
    claimGoal,
    claimedGoalIds: claimedSet,
    claimingGoalIds,
    exitingGoalIds,
    xpBumpTick,
    leveledUpTier,
  };
}
