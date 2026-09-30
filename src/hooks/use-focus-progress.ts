import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { addNotification } from "@/lib/notifications";
import { getCurrentMilestone, getNextMilestone, milestoneProgress } from "@/lib/focus";
import type { DailyGoalInstance } from "@/lib/dailyGoals";
import { isDailyGoalComplete } from "@/lib/focusDailyGoals";
import { useXp } from "@/hooks/use-mast-api";
import { useClaimDailyGoal } from "@/hooks/use-daily-goals";
import { bumpMilestoneBadge, flyXpToMilestone } from "@/lib/xp-fly";

/**
 * Drives the Focus page's XP total + milestone progression and the Daily Goal
 * claim interaction.
 *
 * XP lives in `profiles.xp` (persistent total only). Daily Goals are claimed by
 * explicit user action through `claimDailyGoal`, which awards the XP stored on
 * the persisted `daily_goals` row exactly once — the client never sends an XP
 * amount. `claimGoal` sequences: claim mutation -> XP-fly-to-counter animation
 * -> milestone counter/progress bump.
 *
 * A claim ONLY flips that goal to claimed. The board is never edited: the row
 * stays visible, keeps its position, and nothing replaces it.
 */
export function useFocusProgress(dateKey: string) {
  const { data: xp = 0, isLoading: xpLoading } = useXp();
  const claimMutation = useClaimDailyGoal(dateKey);

  const [claimingGoalIds, setClaimingGoalIds] = useState<Set<string>>(new Set());
  // Bumped every time a claim lands, so <FocusMilestones> can key a
  // one-shot bump animation off of it without needing its own XP-diff logic.
  const [xpBumpTick, setXpBumpTick] = useState(0);
  // Set while a milestone-tier level-up animation should be playing.
  const [leveledUpTier, setLeveledUpTier] = useState<string | null>(null);

  const inFlightRef = useRef<Set<string>>(new Set());

  const finishClaiming = useCallback((goalId: string) => {
    inFlightRef.current.delete(goalId);
    setClaimingGoalIds((prev) => {
      const next = new Set(prev);
      next.delete(goalId);
      return next;
    });
  }, []);

  const claimGoal = useCallback(
    (goal: DailyGoalInstance, cardEl: HTMLElement | null) => {
      if (!isDailyGoalComplete(goal)) return;
      if (goal.claimed) return;
      if (inFlightRef.current.has(goal.id)) return;

      inFlightRef.current.add(goal.id);
      setClaimingGoalIds((prev) => new Set(prev).add(goal.id));

      claimMutation.mutate(goal, {
        onSuccess: async ({ xp: newXp, awarded }) => {
          if (!awarded) {
            // Already claimed elsewhere (another tab/device) — the row is now
            // marked claimed; nothing new to celebrate or animate.
            finishClaiming(goal.id);
            return;
          }

          toast.success("Goal Completed", {
            description: `You finished: ${goal.title}`,
            duration: 5000,
          });
          addNotification({
            icon: "Target",
            iconColor: "text-emerald-400",
            iconBg: "bg-emerald-400/10 border-emerald-400/20",
            title: "Goal Completed",
            body: `${goal.title} +${goal.xp} XP`,
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
                description: `+${goal.xp} XP. You reached ${nextMilestone.name}.`,
                duration: 6000,
              });
              addNotification({
                icon: "Trophy",
                iconColor: "text-brand",
                iconBg: "bg-brand/10 border-brand/20",
                title: "Milestone Reached",
                body: `You reached ${nextMilestone.name}.`,
                category: "notifyAnnouncements",
              });
            }, 200);
            window.setTimeout(() => setLeveledUpTier(null), 2200);
          }

          finishClaiming(goal.id);
        },
        onError: () => {
          finishClaiming(goal.id);
          toast.error("Couldn't claim that goal", {
            description: "Please try again in a moment.",
          });
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [claimMutation.mutate, finishClaiming],
  );

  return {
    xp,
    currentMilestone: getCurrentMilestone(xp),
    nextMilestone: getNextMilestone(xp),
    milestonePct: milestoneProgress(xp),
    isLoading: xpLoading,
    claimGoal,
    claimingGoalIds,
    xpBumpTick,
    leveledUpTier,
  };
}
