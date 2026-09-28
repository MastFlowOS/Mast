import { useMemo } from "react";
import {
  useAccount,
  useAnalytics,
  useCompletedGoalIds,
  useExecutiveBriefing,
  useFollowups,
  useLeads,
  useMe,
  useProgressionEventTotals,
  useWeeklyIntelligence,
} from "@/hooks/use-mast-api";
import { useFocusProgress } from "@/hooks/use-focus-progress";
import { usePermissions } from "@/hooks/use-permissions";
import {
  buildFocusSnapshot,
  isGoalComplete,
  type FocusContext,
  type FocusPrimaryRecommendation,
} from "@/lib/focus";
import { getPlan } from "@/lib/plans";
import type { Lead } from "@/lib/api";
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

export function FocusDashboard() {
  const { data: auth, isLoading: authLoading } = useMe();
  const { data: account } = useAccount();
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics();
  const { data: leadsPayload, isLoading: leadsLoading } = useLeads({ limit: 1000 });
  const { data: followups = [], isLoading: followupsLoading } = useFollowups({ limit: 1000 });
  const { data: completedGoalIds = [], isLoading: completedGoalsLoading } = useCompletedGoalIds();
  const { data: progressionEvents = {}, isLoading: progressionEventsLoading } =
    useProgressionEventTotals();
  const { permissions } = usePermissions();

  const canBriefing = permissions.can("executiveBriefings");
  const canWeekly = permissions.can("weeklyIntelligence");
  const { data: aiBriefing } = useExecutiveBriefing(canBriefing);
  const { data: aiWeekly } = useWeeklyIntelligence(canWeekly);

  const firstName = auth?.user?.fullName?.split(/\s+/)[0] || "MAST";
  const leads = normalizeLeads(leadsPayload);

  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyLimit =
    account?.dailyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).dailyLeadLimit : 20);
  const plan = account?.subscription?.plan ?? auth?.user?.plan ?? "free";

  const ctx: FocusContext = useMemo(
    () => ({
      leads,
      followups,
      analytics: analytics ?? {
        totalLeads: 0,
        contacted: 0,
        replied: 0,
        followupsDue: 0,
        messagesThisWeek: 0,
        replyRate: 0,
      },
      dailyDiscoverUsed: dailyUsed,
      dailyDiscoverLimit: dailyLimit,
      plan,
      completedGoalIds,
      progressionEvents,
    }),
    [leads, followups, analytics, dailyUsed, dailyLimit, plan, completedGoalIds, progressionEvents],
  );

  const snapshot = useMemo(() => buildFocusSnapshot(firstName, ctx), [firstName, ctx]);

  // Executive briefing override for primary recommendation if available
  const primaryRecommendation: FocusPrimaryRecommendation | null = useMemo(() => {
    if (
      canBriefing &&
      aiBriefing &&
      Array.isArray(aiBriefing.priorities) &&
      aiBriefing.priorities.length > 0
    ) {
      return {
        id: "ai-briefing-primary",
        category: "EXECUTIVE AI BRIEFING",
        headline: aiBriefing.priorities[0],
        description: aiBriefing.summary,
        whyNow: "Synthesized by Executive Intelligence from your recent cross-channel momentum.",
        metrics: [
          { label: "source", value: "Executive AI" },
          { label: "urgency", value: "Immediate" },
          { label: "est. time", value: "~10 min" },
        ],
        actionLabel: "Open Relationships",
        to: "/dashboard/relationships",
        tone: aiBriefing.tone,
      };
    }
    return snapshot.primaryRecommendation;
  }, [canBriefing, aiBriefing, snapshot.primaryRecommendation]);

  // Weekly pulse summary override if AI intelligence is enabled
  const weeklyPulse = useMemo(() => {
    if (canWeekly && aiWeekly && aiWeekly.reflection) {
      return {
        ...snapshot.weeklyPulse,
        summary: aiWeekly.reflection,
      };
    }
    return snapshot.weeklyPulse;
  }, [canWeekly, aiWeekly, snapshot.weeklyPulse]);

  const {
    visibleGoals,
    xp,
    currentMilestone,
    nextMilestone,
    milestonePct,
    isLoading: progressLoading,
    claimGoal,
    claimedGoalIds,
    claimingGoalIds,
    exitingGoalIds,
    leveledUpTier,
  } = useFocusProgress(snapshot.goals);

  // Compact today context for the right side of the First Viewport Hero
  const todayContext: FocusTodayContext = useMemo(() => {
    const completedGoalsCount = visibleGoals.filter((g) => isGoalComplete(g)).length;
    const availableXp = visibleGoals.reduce((sum, g) => sum + g.xp, 0);
    return {
      completedGoalsCount,
      totalGoalsCount: visibleGoals.length,
      prioritiesCount: snapshot.focusStack.length,
      availableXp,
      currentXp: xp,
    };
  }, [visibleGoals, snapshot.focusStack.length, xp]);

  const loading =
    authLoading ||
    analyticsLoading ||
    leadsLoading ||
    followupsLoading ||
    completedGoalsLoading ||
    progressionEventsLoading ||
    progressLoading;

  if (loading) {
    return <FocusLoading />;
  }

  // Clear state check
  const isAllClear = snapshot.isClear && !primaryRecommendation;

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
              goalsCompleted={snapshot.goals.filter((g) => completedGoalIds.includes(g.id)).length}
              totalGoals={snapshot.goals.length}
              xpEarned={xp}
            />
            <div className="focus-paired-grid">
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

            {/* 4. PAIRED GRID: TODAY'S GOALS + MOMENTUM */}
            <div className="focus-paired-grid">
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
            <div className="focus-paired-grid">
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
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 2rem 5rem;
          overflow-x: hidden;
        }

        .focus-composition-stack {
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .focus-paired-grid {
          display: grid;
          grid-template-columns: 1.15fr 0.85fr;
          gap: 1.5rem;
          margin-bottom: 2rem;
          align-items: stretch;
        }

        .focus-grid-col-left,
        .focus-grid-col-right {
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        @media (max-width: 960px) {
          .focus-paired-grid {
            grid-template-columns: 1fr;
            gap: 1.75rem;
          }
        }

        @media (max-width: 768px) {
          .focus-main-content {
            padding: 0 1.25rem 3.5rem;
          }
        }

        @media (max-width: 640px) {
          .focus-main-content {
            padding: 0 0.875rem 3rem;
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
        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: "1.5rem", marginBottom: "2rem" }}>
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
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 2rem 5rem;
        }
        @media (max-width: 768px) {
          .focus-main-content {
            padding: 0 1.25rem 3.5rem;
          }
        }
      `}</style>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined): Lead[] {
  return Array.isArray(payload) ? payload : (payload?.leads ?? []);
}
