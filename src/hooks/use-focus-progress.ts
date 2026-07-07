import { useEffect, useRef, useState } from "react";
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

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Drives the Focus page's XP + milestone progression.
 *
 * There is no local or localStorage state here beyond transient UI (which
 * goal rows have animated out this session). XP lives in `profiles.xp` in
 * Supabase; which goals have already been awarded today lives in the
 * `goal_completions` table. Both are fetched via React Query and mutated
 * through `award_goal_xp`, a Postgres function that awards XP for a given
 * goal/day exactly once no matter how many times it's called — so
 * refreshes, extra tabs, and other devices can never double-award or lose
 * progress.
 */
export function useFocusProgress(goals: FocusGoal[]) {
  const today = todayKey();
  const { data: xp = 0, isLoading: xpLoading } = useXp();
  const { data: claimedToday = [], isLoading: claimsLoading } = useGoalClaims(today);
  const { data: completedGoalIds = [], isLoading: completedLoading } = useCompletedGoalIds();
  const awardGoalXp = useAwardGoalXp();

  const [dismissedGoals, setDismissedGoals] = useState<Set<string>>(new Set());
  // Goal ids we've already attempted to award this session — guards against
  // firing duplicate mutations while one is still in flight. The real
  // duplicate-award protection lives server-side; this is just to avoid
  // redundant network calls.
  const attemptedRef = useRef<Set<string>>(new Set());
  const claimedSet = new Set([...claimedToday, ...completedGoalIds]);

  useEffect(() => {
    for (const goal of goals) {
      if (!isGoalComplete(goal)) continue;
      if (claimedSet.has(goal.id)) continue;
      if (attemptedRef.current.has(goal.id)) continue;

      attemptedRef.current.add(goal.id);

      awardGoalXp.mutate(
        { goalId: goal.id, date: today, xp: goal.xp },
        {
          onSuccess: ({ xp: newXp, awarded }) => {
            if (!awarded) return; // Already claimed elsewhere — nothing new to celebrate.

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
            window.setTimeout(() => {
              setDismissedGoals((prev) => new Set(prev).add(goal.id));
            }, 2400);

            const prevXp = newXp - goal.xp;
            const prevMilestone = getCurrentMilestone(prevXp);
            const nextMilestone = getCurrentMilestone(newXp);
            if (prevMilestone.id !== nextMilestone.id) {
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
              }, 800);
            }
          },
          onError: () => {
            // Allow a retry on the next data change instead of getting stuck.
            attemptedRef.current.delete(goal.id);
          },
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, today, claimedToday.join(","), completedGoalIds.join(",")]);

  const visibleGoals = goals.filter((goal) => !dismissedGoals.has(goal.id));

  return {
    xp,
    visibleGoals,
    currentMilestone: getCurrentMilestone(xp),
    nextMilestone: getNextMilestone(xp),
    milestonePct: milestoneProgress(xp),
    isLoading: xpLoading || claimsLoading || completedLoading,
  };
}
