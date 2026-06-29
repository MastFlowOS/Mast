import { useMemo } from "react";
import { useAccount, useAnalytics, useFollowups, useLeads, useMe } from "@/hooks/use-mast-api";
import { useFocusProgress } from "@/hooks/use-focus-progress";
import { buildFocusSnapshot, type FocusContext } from "@/lib/focus";
import { getPlan } from "@/lib/plans";
import type { Lead } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
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
    <div className="mx-auto max-w-3xl space-y-12 p-8 animate-page-enter">
      <FocusGreeting
        emoji={snapshot.greeting.emoji}
        period={snapshot.greeting.period}
        name={firstName}
        subtitle={snapshot.greeting.subtitle}
      />

      <FocusRecommendations recommendations={snapshot.recommendations} />

      <FocusWeeklyReview
        metrics={snapshot.weeklyMetrics}
        summary={snapshot.weeklySummary}
        recommendation={snapshot.weeklyRecommendation}
      />

      <FocusGoals goals={visibleGoals} />

      <FocusMilestones
        xp={xp}
        currentName={currentMilestone.name}
        nextName={nextMilestone?.name ?? null}
        progressPct={milestonePct}
      />

      <FocusDiscoverCta />
    </div>
  );
}

function FocusLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <Skeleton className="h-16 w-2/3 rounded-xl" />
      <Skeleton className="h-6 w-full max-w-lg rounded-lg" />
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-2xl" />
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined): Lead[] {
  return Array.isArray(payload) ? payload : payload?.leads ?? [];
}
