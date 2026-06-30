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

      {/* ════════════════════════════════════════════════════════════════
          SECTION 1 — HERO
          Full-bleed, vertically + horizontally centered greeting.
          ════════════════════════════════════════════════════════════════ */}
      <section className="focus-hero">
        <FocusGreeting
          emoji={snapshot.greeting.emoji}
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
            summary={snapshot.weeklySummary}
            recommendation={snapshot.weeklyRecommendation}
          />
          <FocusRecommendations recommendations={snapshot.recommendations} />
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
