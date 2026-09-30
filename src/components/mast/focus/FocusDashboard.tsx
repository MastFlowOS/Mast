import { useMemo } from "react";
import { useAccount, useFollowups, useLeads, useMe, useXp } from "@/hooks/use-mast-api";
import { useFocusProgress } from "@/hooks/use-focus-progress";
import { useDailyGoals } from "@/hooks/use-daily-goals";
import { buildFocusSnapshot, getNextMilestone, type FocusContext } from "@/lib/focus";
import { planCan } from "@/lib/dailyGoals";
import { summarizeDailyGoals, toPriorityGoals } from "@/lib/focusDailyGoals";
import { getPlan } from "@/lib/plans";
import type { FollowupWithLead, Lead } from "@/lib/api";
import { FocusDailyGoals } from "@/components/mast/focus/FocusDailyGoals";
import {
  FocusGreeting,
  FocusPrimaryHero,
  FocusStack,
  FocusMomentum,
  FocusMilestoneJourney,
  FocusSignal,
  FocusWeeklyPulse,
  FocusEmptyState,
  type FocusTodayContext,
} from "@/components/mast/focus/FocusSections";

// Stable fallbacks so the memoized context only changes when real data does.
const NO_FOLLOWUPS: FollowupWithLead[] = [];

export function FocusDashboard() {
  const { data: auth, isLoading: authLoading } = useMe();
  const { data: account, isLoading: accountLoading } = useAccount();
  const { data: leadsPayload, isLoading: leadsLoading, isSuccess: leadsLoaded } = useLeads({ limit: 1000 });
  const {
    data: followups = NO_FOLLOWUPS,
    isLoading: followupsLoading,
    isSuccess: followupsLoaded,
  } = useFollowups({ limit: 1000 });
  // Persistent XP total only (`profiles.xp`). Never used to derive daily progress.
  const { data: xpTotal = 0 } = useXp();

  const firstName = auth?.user?.fullName?.split(/\s+/)[0] || "MAST";
  const leads = useMemo(() => normalizeLeads(leadsPayload), [leadsPayload]);

  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyLimit =
    account?.dailyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).dailyLeadLimit : 20);
  const monthlyRemaining = account?.monthlyUsage?.remaining ?? null;
  const plan = account?.subscription?.plan ?? auth?.user?.plan ?? "free";

  // Today's Goals: the persisted Daily Goals system is the only goal source.
  // Never generate from a half-loaded workspace: a Free plan has no follow-up
  // capability (that query legitimately errors), any other plan must have
  // loaded its follow-ups.
  const followupsSettled = followupsLoaded || (!followupsLoading && !planCan(plan, "mission"));
  const workspaceReady =
    !authLoading && !accountLoading && !leadsLoading && leadsLoaded && !followupsLoading && followupsSettled;

  const {
    dateKey,
    status: goalsStatus,
    goals: dailyGoals,
    diagnostic: goalsDiagnostic,
    refetch: retryGoals,
  } = useDailyGoals({
    ready: workspaceReady,
    plan,
    leads,
    followups,
    dailyUsed,
    dailyLimit,
    monthlyRemaining,
  });
  const goalSummary = useMemo(() => summarizeDailyGoals(dailyGoals), [dailyGoals]);
  const priorityGoals = useMemo(() => toPriorityGoals(dailyGoals), [dailyGoals]);

  const ctx: FocusContext = useMemo(
    () => ({
      leads,
      followups,
      dailyDiscoverUsed: dailyUsed,
      dailyDiscoverLimit: dailyLimit,
      monthlyRemaining,
      plan,
      xp: xpTotal,
      goalsClaimedToday: goalSummary.claimedCount,
    }),
    [leads, followups, dailyUsed, dailyLimit, monthlyRemaining, plan, xpTotal, goalSummary.claimedCount],
  );

  const snapshot = useMemo(
    () => buildFocusSnapshot(firstName, ctx, priorityGoals),
    [firstName, ctx, priorityGoals],
  );
  const primaryRecommendation = snapshot.primaryRecommendation;
  const weeklyPulse = snapshot.weeklyPulse;

  const {
    xp,
    currentMilestone,
    nextMilestone,
    milestonePct,
    isLoading: progressLoading,
    claimGoal,
    claimingGoalIds,
    leveledUpTier,
  } = useFocusProgress(dateKey);

  // Compact today context for the right side of the First Viewport Hero
  const todayContext: FocusTodayContext = useMemo(
    () => ({
      readyToClaimCount: goalSummary.readyToClaimCount,
      totalGoalsCount: goalSummary.total,
      prioritiesCount: snapshot.focusStack.length,
      availableXp: goalSummary.availableXp,
      currentXp: xp,
      dailyDiscoverUsed: dailyUsed,
      dailyDiscoverLimit: dailyLimit,
    }),
    [goalSummary, snapshot.focusStack.length, xp, dailyUsed, dailyLimit],
  );

  const loading = authLoading || leadsLoading || followupsLoading || progressLoading;

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
              goalsClaimedToday={goalSummary.claimedCount}
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
                <FocusDailyGoals
                  status={goalsStatus}
                  goals={dailyGoals}
                  diagnostic={goalsDiagnostic}
                  claimingGoalIds={claimingGoalIds}
                  onClaim={claimGoal}
                  onRetry={retryGoals}
                />
              </div>
              <div className="focus-grid-col-right">
                <FocusMomentum events={snapshot.momentum} />
              </div>
            </div>

            {/* 5. MILESTONE JOURNEY (Physical Mountain Route Progression & Environment) */}
            <FocusMilestoneJourney
              xp={xp}
              currentName={currentMilestone.name}
              nextName={nextMilestone?.name ?? null}
              progressPct={milestonePct}
              leveledUpTier={leveledUpTier}
              period={snapshot.greeting.period}
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
          margin-bottom: 1.25rem;
          align-items: stretch;
        }

        .focus-goals-momentum-grid {
          grid-template-columns: 1.35fr 1fr;
          align-items: start;
        }

        .focus-intelligence-grid {
          grid-template-columns: 1.15fr 0.85fr;
          margin-bottom: 0;
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
        <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: "1.5rem", marginBottom: "1.25rem", alignItems: "start" }}>
          <div className="mast-skeleton" style={{ height: "12rem", borderRadius: "14px" }} />
          <div className="mast-skeleton" style={{ height: "7rem", borderRadius: "14px" }} />
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
