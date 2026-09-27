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
  FocusMomentumMilestone,
  FocusSignal,
  FocusWeeklyPulse,
  FocusEmptyState,
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
      {/* Ambient background glow */}
      <div className="focus-ambient-glow" aria-hidden="true" />

      <main className="focus-main-content">
        {/* 1. WELCOME */}
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
            <FocusWeeklyPulse pulse={weeklyPulse} />
          </>
        ) : (
          /* STANDARD COMMAND HIERARCHY */
          <>
            {/* 2. YOUR FOCUS (Dominant Hero Module) */}
            <FocusPrimaryHero recommendation={primaryRecommendation} />

            {/* 3. FOCUS STACK (3 Priorities) */}
            <FocusStack priorities={snapshot.focusStack} />

            {/* 4. TODAY'S GOALS (Single Coherent Module) */}
            <FocusGoals
              goals={visibleGoals}
              onClaim={claimGoal}
              claimedGoalIds={claimedGoalIds}
              claimingGoalIds={claimingGoalIds}
              exitingGoalIds={exitingGoalIds}
            />

            {/* 5. MOMENTUM + MILESTONE (Two Columns) */}
            <FocusMomentumMilestone
              events={snapshot.momentum}
              xp={xp}
              currentName={currentMilestone.name}
              nextName={nextMilestone?.name ?? null}
              progressPct={milestonePct}
              leveledUpTier={leveledUpTier}
            />

            {/* 6. MAST SIGNAL (Compact Intelligence Module) */}
            <FocusSignal signal={snapshot.signal} />

            {/* 7. WEEKLY PULSE (Compact Preview of Analytics) */}
            <FocusWeeklyPulse pulse={weeklyPulse} />
          </>
        )}
      </main>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          width: 100%;
          background: var(--color-background, #0c0b10);
        }

        .focus-ambient-glow {
          position: fixed;
          top: -15vh;
          left: 50%;
          transform: translateX(-50%);
          width: min(80vw, 920px);
          height: 35vh;
          background: radial-gradient(
            ellipse at 50% 0%,
            rgba(168, 85, 247, 0.08) 0%,
            transparent 70%
          );
          pointer-events: none;
          z-index: 0;
        }

        .focus-main-content {
          position: relative;
          z-index: 1;
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

function FocusLoading() {
  return (
    <div className="focus-page-root">
      <div className="focus-main-content" style={{ paddingTop: "2rem" }}>
        {/* Greeting Skeleton */}
        <div style={{ marginBottom: "2rem" }}>
          <div
            className="mast-skeleton"
            style={{ height: "0.75rem", width: "140px", borderRadius: "4px", marginBottom: "0.75rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "2.25rem", width: "320px", borderRadius: "8px", marginBottom: "0.5rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "1rem", width: "420px", borderRadius: "4px" }}
          />
        </div>

        {/* Hero Module Skeleton */}
        <div
          className="mast-skeleton"
          style={{ height: "17rem", width: "100%", borderRadius: "20px", marginBottom: "2rem" }}
        />

        {/* Focus Stack Skeleton */}
        <div style={{ marginBottom: "2.25rem" }}>
          <div
            className="mast-skeleton"
            style={{ height: "1rem", width: "160px", borderRadius: "4px", marginBottom: "1rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "3.5rem", width: "100%", borderRadius: "8px", marginBottom: "0.5rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "3.5rem", width: "100%", borderRadius: "8px", marginBottom: "0.5rem" }}
          />
          <div
            className="mast-skeleton"
            style={{ height: "3.5rem", width: "100%", borderRadius: "8px" }}
          />
        </div>

        {/* Goals Skeleton */}
        <div
          className="mast-skeleton"
          style={{ height: "12rem", width: "100%", borderRadius: "14px", marginBottom: "2rem" }}
        />

        {/* Momentum & Milestone Skeleton */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
          <div className="mast-skeleton" style={{ height: "11rem", borderRadius: "14px" }} />
          <div className="mast-skeleton" style={{ height: "11rem", borderRadius: "14px" }} />
        </div>
      </div>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          width: 100%;
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
