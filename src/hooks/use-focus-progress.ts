import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getCurrentMilestone,
  getNextMilestone,
  isGoalComplete,
  milestoneProgress,
  pickCelebration,
  XP_PER_GOAL,
  type FocusGoal,
} from "@/lib/focus";

const STORAGE_KEY = "mast-focus-progress";

type FocusProgressState = {
  xp: number;
  celebratedGoals: Record<string, string>;
  lastXpDate: string;
};

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readProgress(): FocusProgressState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { xp: 0, celebratedGoals: {}, lastXpDate: todayKey() };
    const parsed = JSON.parse(raw) as FocusProgressState;
    if (parsed.lastXpDate !== todayKey()) {
      return { ...parsed, celebratedGoals: {}, lastXpDate: todayKey() };
    }
    return parsed;
  } catch {
    return { xp: 0, celebratedGoals: {}, lastXpDate: todayKey() };
  }
}

function writeProgress(state: FocusProgressState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function useFocusProgress(goals: FocusGoal[]) {
  const [progress, setProgress] = useState<FocusProgressState>(() => readProgress());
  const [dismissedGoals, setDismissedGoals] = useState<Set<string>>(new Set());
  const previousXpRef = useRef(progress.xp);
  const celebratedRef = useRef(progress.celebratedGoals);

  useEffect(() => {
    const day = todayKey();
    const newlyCompleted: FocusGoal[] = [];

    for (const goal of goals) {
      if (!isGoalComplete(goal)) continue;
      if (celebratedRef.current[goal.id] === day) continue;
      newlyCompleted.push(goal);
    }

    if (newlyCompleted.length === 0) return;

    const nextCelebrated = { ...celebratedRef.current };
    for (const goal of newlyCompleted) {
      nextCelebrated[goal.id] = day;
      toast.success("🎉 Congratulations!", {
        description: pickCelebration(goal.id),
        duration: 5000,
      });
      window.setTimeout(() => {
        setDismissedGoals((prev) => new Set(prev).add(goal.id));
      }, 2400);
    }

    const xpGain = newlyCompleted.length * XP_PER_GOAL;
    const nextXp = progress.xp + xpGain;
    const nextState = {
      xp: nextXp,
      celebratedGoals: nextCelebrated,
      lastXpDate: day,
    };

    celebratedRef.current = nextCelebrated;
    writeProgress(nextState);
    setProgress(nextState);

    const prevMilestone = getCurrentMilestone(previousXpRef.current);
    const nextMilestone = getCurrentMilestone(nextXp);
    if (prevMilestone.id !== nextMilestone.id) {
      window.setTimeout(() => {
        toast("🏆 Milestone unlocked", {
          description: `You've reached ${nextMilestone.name}. ${nextMilestone.reward}.`,
          duration: 6000,
        });
      }, 800);
    }
    previousXpRef.current = nextXp;
  }, [goals, progress.xp]);

  const visibleGoals = goals.filter((goal) => !dismissedGoals.has(goal.id));

  return {
    xp: progress.xp,
    visibleGoals,
    currentMilestone: getCurrentMilestone(progress.xp),
    nextMilestone: getNextMilestone(progress.xp),
    milestonePct: milestoneProgress(progress.xp),
  };
}
