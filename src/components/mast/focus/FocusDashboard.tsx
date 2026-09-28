import { useMemo } from "react";
import {
  useAccount,
  useCompletedGoalIds,
  useFollowups,
  useGoalClaims,
  useLeads,
  useMe,
  useProgressionEventTotals,
  useXp,
} from "@/hooks/use-mast-api";
import { todayKey, useFocusProgress } from "@/hooks/use-focus-progress";
import {
  buildFocusSnapshot,
  getNextMilestone,
  isGoalComplete,
  type FocusContext,
} from "@/lib/focus";
import { getPlan } from "@/lib/plans";
import type { FollowupWithLead, Lead } from "@/lib/api";
import type { ProgressionEventTotals } from "@/lib/progression";
import {
  FocusGreeting,
  FocusPrimaryHero,
  FocusStack,
  FocusGoals,
  FocusMomentum,
  FocusMilestoneJourney,
  FocusSignal,
  FocusWeeklyPulse,
  FocusEmptyState,
  type FocusTodayContext,
} from "@/components/mast/focus/FocusSections";

// Stable fallbacks so the memoized context only changes when real data does.
const NO_FOLLOWUPS: FollowupWithLead[] = [];
const NO_IDS: string[] = [];
const NO_EVENTS: ProgressionEventTotals = {};

export function FocusDashboard() {
  const { data: auth, isLoading: authLoading } = useMe();
  const { data: account } = useAccount();
  const { data: leadsPayload, isLoading: leadsLoading } = useLeads({ limit: 1000 });
  const { data: followups = NO_FOLLOWUPS, isLoading: followupsLoading } = useFollowups({ limit: 1000 });
  const { data: completedGoalIds = NO_IDS, isLoading: completedGoalsLoading } = useCompletedGoalIds();
  const { data: progressionEvents = NO_EVENTS, isLoading: progressionEventsLoading } =
    useProgressionEventTotals();
  // Same query keys as useFocusProgress, so React Query shares the requests.
  const { data: xpTotal = 0 } = useXp();
  const { data: claimedToday = NO_IDS } = useGoalClaims(todayKey());

  const firstName = auth?.user?.fullName?.split(/\s+/)[0] || "MAST";
  const leads = useMemo(() => normalizeLeads(leadsPayload), [leadsPayload]);

  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyLimit =
    account?.dailyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).dailyLeadLimit : 20);
  const monthlyRemaining = account?.monthlyUsage?.remaining ?? null;
  const plan = account?.subscription?.plan ?? auth?.user?.plan ?? "free";

  const ctx: FocusContext = useMemo(
    () => ({
      leads,
      followups,
      dailyDiscoverUsed: dailyUsed,
      dailyDiscoverLimit: dailyLimit,
      monthlyRemaining,
      plan,
      completedGoalIds,
      progressionEvents,
      xp: xpTotal,
      goalsClaimedToday: claimedToday.length,
    }),
    [
      leads,
      followups,
      dailyUsed,
      dailyLimit,
      monthlyRemaining,
      plan,
      completedGoalIds,
      progressionEvents,
      xpTotal,
      claimedToday,
    ],
  );

  const snapshot = useMemo(() => buildFocusSnapshot(firstName, ctx), [firstName, ctx]);
  const primaryRecommendation = snapshot.primaryRecommendation;
  const weeklyPulse = snapshot.weeklyPulse;

  const {
    visibleGoals,
    xp,
    currentMilestone,
    nextMilestone,
    milestonePct,
    isLoading: progressLoading,
    claimGoal,
    claimedGoalIds,
    claimedTodayCount,
    claimingGoalIds,
    exitingGoalIds,
    leveledUpTier,
  } = useFocusProgress(snapshot.goals);

  // Compact today context for the right side of the First Viewport Hero
  const todayContext: FocusTodayContext = useMemo(() => {
    const readyToClaimCount = visibleGoals.filter(
      (g) => isGoalComplete(g) && !claimedGoalIds.has(g.id),
    ).length;
    const availableXp = visibleGoals
      .filter((g) => !claimedGoalIds.has(g.id))
      .reduce((sum, g) => sum + g.xp, 0);
    return {
      readyToClaimCount,
      totalGoalsCount: visibleGoals.length,
      prioritiesCount: snapshot.focusStack.length,
      availableXp,
      currentXp: xp,
      dailyDiscoverUsed: dailyUsed,
      dailyDiscoverLimit: dailyLimit,
    };
  }, [visibleGoals, claimedGoalIds, snapshot.focusStack.length, xp, dailyUsed, dailyLimit]);

  const loading =
    authLoading ||
    leadsLoading ||
    followupsLoading ||
    completedGoalsLoading ||
    progressionEventsLoading ||
    progressLoading;

  if (loading) {
    return <FocusLoading />;
  }

  // Clear state: no priority survived the waterfall.
  const isAllClear = snapshot.isClear;
  const nextTier = getNextMilestone(xp);

  return (
    <div className="focus-page-root animate-page-enter">
      <main className="focus-main-content">
        {/* 1. WELCOME (Compact header) */}
        <FocusGreeting
          period={snapshot.greeting.period}
          name={firstName}
          subtitle={snapshot.greeting.subtitle}
        />

        {isAllClear ? (
          /* EMPTY STATE ("YOU'RE CLEAR.") */
          <>
            <FocusEmptyState
              goalsClaimedToday={claimedTodayCount}
              xp={xp}
              nextTierName={nextTier?.name ?? null}
              xpToNextTier={nextTier ? Math.max(0, nextTier.xpRequired - xp) : 0}
            />
            <div className="focus-paired-grid focus-intelligence-grid">
              <FocusSignal signal={snapshot.signal} />
              <FocusWeeklyPulse pulse={weeklyPulse} />
            </div>
          </>
        ) : (
          /* STRUCTURED COMMAND COMPOSITION */
          <div className="focus-composition-stack">
            {/* 2. YOUR FOCUS (Dominant Composed Module: Left Recommendation + Right TODAY) */}
            <FocusPrimaryHero
              recommendation={primaryRecommendation}
              todayContext={todayContext}
            />

            {/* 3. FOCUS STACK (3 Editorial Priorities in Coherent Surface) */}
            <FocusStack priorities={snapshot.focusStack} />

            {/* 4. PAIRED GRID: TODAY'S GOALS (~60%) + RECENT ACTIVITY (~40%) */}
            <div className="focus-paired-grid focus-goals-momentum-grid">
              <div className="focus-grid-col-left">
                <FocusGoals
                  goals={visibleGoals}
                  onClaim={claimGoal}
                  claimedGoalIds={claimedGoalIds}
                  claimingGoalIds={claimingGoalIds}
                  exitingGoalIds={exitingGoalIds}
                />
              </div>
              <div className="focus-grid-col-right">
                <FocusMomentum events={snapshot.momentum} />
              </div>
            </div>

            {/* 5. MILESTONE JOURNEY (Full-width progression line) */}
            <FocusMilestoneJourney
              xp={xp}
              currentName={currentMilestone.name}
              nextName={nextMilestone?.name ?? null}
              progressPct={milestonePct}
              leveledUpTier={leveledUpTier}
            />

            {/* 6. PAIRED GRID: MAST SIGNAL + WEEKLY PULSE (Compact Intelligence Region) */}
            <div className="focus-paired-grid focus-intelligence-grid">
              <div className="focus-grid-col-left">
                <FocusSignal signal={snapshot.signal} />
              </div>
              <div className="focus-grid-col-right">
                <FocusWeeklyPulse pulse={weeklyPulse} />
              </div>
            </div>
          </div>
        )}
      </main>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          width: 100%;
          background: var(--background, #0c0f17);
          overflow-x: hidden;
        }

        .focus-main-content {
          position: relative;
          z-index: 1;
          max-width: 1400px;
          margin: 0 auto;
          padding: 1.5rem 2.25rem 5rem;
          overflow-x: hidden;
        }

        .focus-composition-stack {
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .focus-paired-grid {
          display: grid;
          gap: 1.5rem;
          margin-bottom: 2rem;
          align-items: stretch;
        }

        .focus-goals-momentum-grid {
          grid-template-columns: 1.35fr 1fr;
        }

        .focus-intelligence-grid {
          grid-template-columns: 1.15fr 0.85fr;
        }

        .focus-grid-col-left,
        .focus-grid-col-right {
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        @media (max-width: 1024px) {
          .focus-paired-grid {
            grid-template-columns: 1fr !important;
            gap: 1.5rem;
          }
        }

        @media (max-width: 768px) {
          .focus-main-content {
            padding: 1rem 1.25rem 3.5rem;
          }
        }

        @media (max-width: 640px) {
          .focus-main-content {
            padding: 0.75rem 0.875rem 3rem;
          }
        }
      `}</style>
    </div>
  );
}

function FocusLoading() {
  return (
    <div className="focus-page-root">
      <div className="focus-main-content" style={{ paddingTop: "1.5rem" }}>
        {/* Greeting Skeleton */}
        <div style={{ marginBottom: "1.75rem" }}>
          <div
            className="mast-skeleton"
            style={{ height: "0.75rem", width: "130px", borderRadius: "4px", marginBottom: "0.625rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "2rem", width: "300px", borderRadius: "8px", marginBottom: "0.35rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "0.875rem", width: "380px", borderRadius: "4px" }}
          />
        </div>

        {/* Hero Composed Module Skeleton */}
        <div
          className="mast-skeleton"
          style={{ height: "16rem", width: "100%", borderRadius: "16px", marginBottom: "2rem" }}
        />

        {/* Focus Stack Skeleton */}
        <div style={{ marginBottom: "2rem" }}>
          <div
            className="mast-skeleton"
            style={{ height: "0.875rem", width: "150px", borderRadius: "4px", marginBottom: "0.875rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "11rem", width: "100%", borderRadius: "14px" }}
          />
        </div>

        {/* Paired Grid Skeleton: Goals + Momentum */}
        <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: "1.5rem", marginBottom: "2rem" }}>
          <div className="mast-skeleton" style={{ height: "12rem", borderRadius: "14px" }} />
          <div className="mast-skeleton" style={{ height: "12rem", borderRadius: "14px" }} />
        </div>

        {/* Milestone Skeleton */}
        <div className="mast-skeleton" style={{ height: "8rem", width: "100%", borderRadius: "14px" }} />
      </div>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          width: 100%;
          background: var(--background, #0c0f17);
        }
        .focus-main-content {
          max-width: 1400px;
          margin: 0 auto;
          padding: 1.5rem 2.25rem 5rem;
        }
        @media (max-width: 768px) {
          .focus-main-content {
            padding: 1rem 1.25rem 3.5rem;
          }
        }
        @media (max-width: 640px) {
          .focus-main-content {
            padding: 0.75rem 0.875rem 3rem;
          }
        }
      `}</style>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined): Lead[] {
  return Array.isArray(payload) ? payload : (payload?.leads ?? []);
}
