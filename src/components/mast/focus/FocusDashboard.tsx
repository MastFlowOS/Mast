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
import { buildFocusSnapshot, type FocusContext, type FocusRecommendation } from "@/lib/focus";
import { getPlan } from "@/lib/plans";
import type { Lead } from "@/lib/api";
import {
  FocusDiscoverCta,
  FocusGoals,
  FocusGreeting,
  FocusMilestones,
  FocusRecommendations,
  FocusWeeklyReview,
} from "@/components/mast/focus/FocusSections";

export function FocusDashboard() {
  const { data: auth, isLoading: authLoading } = useMe();
  const { data: account } = useAccount();
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics();
  const { data: leadsPayload, isLoading: leadsLoading } = useLeads({ limit: 1000 });
  const { data: followups = [], isLoading: followupsLoading } = useFollowups({ limit: 1000 });
  const { data: completedGoalIds = [], isLoading: completedGoalsLoading } = useCompletedGoalIds();
  const { data: progressionEvents = {}, isLoading: progressionEventsLoading } = useProgressionEventTotals();
  const { permissions } = usePermissions();

  // AI Executive Briefing / Weekly Intelligence (Premium — Part 3 Phase 8).
  // Only fetched for plans that actually have the capability; everyone else
  // keeps the existing rule-based "Today's Briefing" / "Weekly Intelligence"
  // panels exactly as before.
  const canBriefing = permissions.can("executiveBriefings");
  const canWeekly = permissions.can("weeklyIntelligence");
  const { data: aiBriefing } = useExecutiveBriefing(canBriefing);
  const { data: aiWeekly } = useWeeklyIntelligence(canWeekly);

  const firstName = auth?.user?.fullName?.split(/\s+/)[0] || "there";
  const leads = normalizeLeads(leadsPayload);

  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyLimit = account?.dailyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).dailyLeadLimit : 20);
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

  // When a real AI Executive Briefing is available, present it through the
  // exact same <FocusRecommendations> panel — one recommendation card per
  // priority — instead of the rule-based list. Falls back to the rule-based
  // recommendations while loading or for non-Premium plans, so nothing
  // regresses.
  //
  // aiBriefing.priorities is guaranteed to be an array by the backend
  // (src/server/routes/intelligence.ts normalizes every AI-generated field
  // before it's ever cached or returned) — Array.isArray is checked here
  // too because a TS type only holds at compile time, not for whatever a
  // network response actually contains at runtime (e.g. an older cached
  // frontend bundle talking to a backend build from before that
  // normalization existed). This is not blanket optional-chaining: it's
  // the one field this panel actually depends on being an array.
  const recommendations: FocusRecommendation[] = useMemo(() => {
    if (!canBriefing || !aiBriefing) return snapshot.recommendations;
    const priorities = Array.isArray(aiBriefing.priorities) ? aiBriefing.priorities : [];
    if (priorities.length === 0) return snapshot.recommendations;
    return priorities.map((priority, index) => ({
      id: `ai-briefing-${index}`,
      title: priority,
      description: aiBriefing.summary,
      actionLabel: "Open Relationships",
      to: "/dashboard/relationships",
      priority: 100 - index,
      tone: aiBriefing.tone,
    }));
  }, [canBriefing, aiBriefing, snapshot.recommendations]);

  // Same idea for Weekly Intelligence — real numbers stay (snapshot.weeklyMetrics
  // is already computed from actual analytics), only the reflective text
  // becomes AI-generated for Premium. Same runtime-array guard as above.
  const aiFocusForNextWeek = Array.isArray(aiWeekly?.focusForNextWeek) ? aiWeekly!.focusForNextWeek : [];
  const weeklySummary = canWeekly && aiWeekly ? aiWeekly.reflection : snapshot.weeklySummary;
  const weeklyRecommendation = canWeekly && aiWeekly && aiFocusForNextWeek.length > 0
    ? aiFocusForNextWeek[0]
    : snapshot.weeklyRecommendation;

  const {
    visibleGoals,
    xp,
    currentMilestone,
    nextMilestone,
    milestonePct,
    isLoading: progressLoading,
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

  return (
    <div className="focus-page-root animate-page-enter">
      {/* Ambient background glow */}
      <div className="focus-ambient-glow" aria-hidden="true" />

      {/* ════════════════════════════════════════════════════════════════
          SECTION 1 — HERO
          Full-bleed, vertically + horizontally centered greeting.
          ════════════════════════════════════════════════════════════════ */}
      <section className="focus-hero">
        <FocusGreeting
          period={snapshot.greeting.period}
          name={firstName}
          subtitle={snapshot.greeting.subtitle}
        />
      </section>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 2 — AI BRIEFING
          Two-column: Weekly Intelligence (reflective) | Today's Briefing (the brain).
          ════════════════════════════════════════════════════════════════ */}
      <section className="focus-briefing">
        <div className="focus-briefing-grid">
          <FocusWeeklyReview
            metrics={snapshot.weeklyMetrics}
            summary={weeklySummary}
            recommendation={weeklyRecommendation}
          />
          <FocusRecommendations recommendations={recommendations} />
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════════════
          SECTION 3 — PROGRESS
          Milestone journey stretches wide, goals beneath, CTA to close.
          ════════════════════════════════════════════════════════════════ */}
      <section className="focus-progress">
        <FocusMilestones
          xp={xp}
          currentName={currentMilestone.name}
          nextName={nextMilestone?.name ?? null}
          progressPct={milestonePct}
        />

        <FocusGoals goals={visibleGoals} />

        <FocusDiscoverCta />
      </section>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          overflow: hidden;
        }

        .focus-ambient-glow {
          position: fixed;
          top: -20vh;
          left: 50%;
          transform: translateX(-50%);
          width: 60vw;
          height: 40vh;
          background: radial-gradient(
            ellipse at 50% 0%,
            color-mix(in oklab, var(--brand) 10%, transparent) 0%,
            transparent 70%
          );
          pointer-events: none;
          z-index: 0;
        }

        /* ── Hero section: tall, centered both axes ── */
        .focus-hero {
          position: relative;
          z-index: 1;
          min-height: min(62vh, 560px);
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 4rem 2rem 2rem;
        }

        /* ── Briefing section ── */
        .focus-briefing {
          position: relative;
          z-index: 1;
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 2rem 5rem;
        }

        .focus-briefing-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
          align-items: stretch;
        }

        /* ── Progress section: wide milestone bar, then goals, then CTA ── */
        .focus-progress {
          position: relative;
          z-index: 1;
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 2rem 6rem;
          display: flex;
          flex-direction: column;
          gap: 2.5rem;
        }

        @media (max-width: 880px) {
          .focus-briefing-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 680px) {
          .focus-hero {
            min-height: auto;
            padding: 3rem 1.25rem 2.5rem;
          }
          .focus-briefing {
            padding: 0 1.25rem 3.5rem;
          }
          .focus-progress {
            padding: 0 1.25rem 4rem;
            gap: 2rem;
          }
        }
      `}</style>
    </div>
  );
}

function FocusLoading() {
  return (
    <div className="focus-page-root">
      <section className="focus-hero">
        <div style={{ width: "100%", maxWidth: "520px" }}>
          <div className="mast-skeleton" style={{ height: "0.75rem", width: "30%", borderRadius: "8px", margin: "0 auto 1.5rem" }} />
          <div className="mast-skeleton" style={{ height: "3.5rem", width: "80%", borderRadius: "12px", margin: "0 auto 1rem" }} />
          <div className="mast-skeleton" style={{ height: "1rem", width: "60%", borderRadius: "8px", margin: "0 auto" }} />
        </div>
      </section>

      <div className="focus-briefing">
        <div className="focus-briefing-grid">
          <div className="mast-skeleton" style={{ height: "20rem", borderRadius: "18px" }} />
          <div className="mast-skeleton" style={{ height: "20rem", borderRadius: "18px" }} />
        </div>
      </div>

      <div className="focus-progress">
        <div className="mast-skeleton" style={{ height: "12rem", borderRadius: "18px" }} />
        <div className="mast-skeleton" style={{ height: "10rem", borderRadius: "16px" }} />
      </div>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
        }
        .focus-hero {
          min-height: min(62vh, 560px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4rem 2rem 2rem;
        }
        .focus-briefing {
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 2rem 5rem;
        }
        .focus-briefing-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
        }
        .focus-progress {
          max-width: 1080px;
          margin: 0 auto;
          padding: 0 2rem 6rem;
          display: flex;
          flex-direction: column;
          gap: 2.5rem;
        }
        @media (max-width: 880px) {
          .focus-briefing-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 680px) {
          .focus-hero { min-height: auto; padding: 3rem 1.25rem 2.5rem; }
          .focus-briefing { padding: 0 1.25rem 3.5rem; }
          .focus-progress { padding: 0 1.25rem 4rem; gap: 2rem; }
        }
      `}</style>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined): Lead[] {
  return Array.isArray(payload) ? payload : payload?.leads ?? [];
}
