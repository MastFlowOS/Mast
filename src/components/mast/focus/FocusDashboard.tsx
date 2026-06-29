import { useMemo } from "react";
import { useAccount, useAnalytics, useFollowups, useLeads, useMe } from "@/hooks/use-mast-api";
import { useFocusProgress } from "@/hooks/use-focus-progress";
import { buildFocusSnapshot, type FocusContext } from "@/lib/focus";
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

  const firstName = auth?.user?.fullName?.split(/\s+/)[0] || "there";
  const leads = normalizeLeads(leadsPayload);
  const loading = authLoading || analyticsLoading || leadsLoading || followupsLoading;

  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyLimit = account?.dailyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).dailyLeadLimit : 20);

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
    }),
    [leads, followups, analytics, dailyUsed, dailyLimit],
  );

  const snapshot = useMemo(() => buildFocusSnapshot(firstName, ctx), [firstName, ctx]);
  const { visibleGoals, xp, currentMilestone, nextMilestone, milestonePct } = useFocusProgress(snapshot.goals);

  if (loading) {
    return <FocusLoading />;
  }

  return (
    <div className="focus-page-root animate-page-enter">
      {/* Ambient background glow */}
      <div className="focus-ambient-glow" aria-hidden="true" />

      <div className="focus-content-column">
        {/* ── Greeting ── */}
        <FocusGreeting
          emoji={snapshot.greeting.emoji}
          period={snapshot.greeting.period}
          name={firstName}
          subtitle={snapshot.greeting.subtitle}
        />

        {/* ── Separator line ── */}
        <div className="focus-divider" />

        {/* ── Today's Briefing (Recommendations) ── */}
        <FocusRecommendations recommendations={snapshot.recommendations} />

        {/* ── Weekly Intelligence ── */}
        <FocusWeeklyReview
          metrics={snapshot.weeklyMetrics}
          summary={snapshot.weeklySummary}
          recommendation={snapshot.weeklyRecommendation}
        />

        {/* ── Goals + Milestones side-by-side on wide, stacked on narrow ── */}
        <div className="focus-lower-grid">
          <FocusGoals goals={visibleGoals} />
          <FocusMilestones
            xp={xp}
            currentName={currentMilestone.name}
            nextName={nextMilestone?.name ?? null}
            progressPct={milestonePct}
          />
        </div>

        {/* ── CTA ── */}
        <FocusDiscoverCta />
      </div>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          padding: 3.5rem 2rem 5rem;
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

        .focus-content-column {
          position: relative;
          z-index: 1;
          max-width: 760px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .focus-divider {
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent,
            color-mix(in oklab, var(--border) 80%, transparent) 30%,
            color-mix(in oklab, var(--border) 80%, transparent) 70%,
            transparent
          );
          margin: 3rem 0;
        }

        .focus-lower-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
          margin-top: 3rem;
        }

        @media (max-width: 680px) {
          .focus-page-root {
            padding: 2rem 1.25rem 4rem;
          }
          .focus-lower-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

function FocusLoading() {
  return (
    <div className="focus-page-root">
      <div className="focus-content-column">
        {/* Greeting skeleton */}
        <div style={{ paddingTop: "0.5rem" }}>
          <div className="mast-skeleton" style={{ height: "2.75rem", width: "55%", borderRadius: "12px", marginBottom: "0.875rem" }} />
          <div className="mast-skeleton" style={{ height: "1rem", width: "75%", borderRadius: "8px" }} />
        </div>

        <div className="focus-divider" />

        {/* Recommendations skeleton */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div className="mast-skeleton" style={{ height: "1.25rem", width: "35%", borderRadius: "8px", marginBottom: "0.5rem" }} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="mast-skeleton" style={{ height: "5.5rem", borderRadius: "16px" }} />
          ))}
        </div>

        {/* Weekly skeleton */}
        <div style={{ marginTop: "3rem" }}>
          <div className="mast-skeleton" style={{ height: "12rem", borderRadius: "16px" }} />
        </div>

        {/* Lower grid skeleton */}
        <div className="focus-lower-grid" style={{ marginTop: "3rem" }}>
          <div className="mast-skeleton" style={{ height: "14rem", borderRadius: "16px" }} />
          <div className="mast-skeleton" style={{ height: "14rem", borderRadius: "16px" }} />
        </div>
      </div>

      <style>{`
        .focus-page-root {
          position: relative;
          min-height: 100%;
          padding: 3.5rem 2rem 5rem;
        }
        .focus-content-column {
          max-width: 760px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
        }
        .focus-divider {
          height: 1px;
          background: linear-gradient(
            90deg,
            transparent,
            color-mix(in oklab, var(--border) 80%, transparent) 30%,
            color-mix(in oklab, var(--border) 80%, transparent) 70%,
            transparent
          );
          margin: 3rem 0;
        }
        .focus-lower-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.5rem;
        }
        @media (max-width: 680px) {
          .focus-page-root { padding: 2rem 1.25rem 4rem; }
          .focus-lower-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined): Lead[] {
  return Array.isArray(payload) ? payload : payload?.leads ?? [];
}
