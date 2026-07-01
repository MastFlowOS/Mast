import type { Account, AnalyticsSummary, Lead } from "@/lib/api";
import { normalizeLeadStatus } from "@/lib/lead-workspace";

export type DiscoverInsight = {
  id: string;
  /** The strategic recommendation — what the user should do next. */
  title: string;
  /** The reasoning behind the recommendation — not statistics, but logic. */
  reason: string;
  tone: "brand" | "warning" | "success" | "neutral";
  /** Confidence label shown as a badge. */
  confidence: "High Confidence" | "Recommended" | "Worth Testing" | "Watch Closely";
  /** Label for the action button, e.g. "Continue Discovering →" */
  actionLabel: string;
  /** Where the action navigates. A relative path or a named route key. */
  actionHref: string;
};

export type DiscoverInsightsContext = {
  leads: Lead[];
  analytics: AnalyticsSummary;
  account: Account;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isContacted(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return !["discovered", "ready", "new"].includes(status) || Boolean(lead.lastContactedAt);
}

function hasReplied(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return [
    "conversation",
    "replied",
    "interested",
    "meeting",
    "proposal",
    "negotiation",
    "closed_won",
    "meeting_booked",
  ].includes(status);
}

function hasMeeting(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return ["meeting", "proposal", "negotiation", "closed_won", "meeting_booked"].includes(status);
}

function isWithinDays(date: string | null | undefined, days: number) {
  if (!date) return false;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return false;
  return value.getTime() >= Date.now() - days * 86_400_000;
}

function extractRegion(location: string | null | undefined): string | null {
  if (!location) return null;
  const regions = ["North America", "South America", "Europe", "Asia", "Africa", "Oceania", "Global"];
  for (const r of regions) {
    if (location.includes(r)) return r;
  }
  const parts = location.split(",").map((p) => p.trim());
  return parts[parts.length - 1] || location;
}

function nicheStats(leads: Lead[]) {
  const map = new Map<string, { total: number; contacted: number; replied: number; meetings: number }>();
  for (const lead of leads) {
    const niche = lead.niche?.split(",")[0]?.trim() || "General";
    const entry = map.get(niche) ?? { total: 0, contacted: 0, replied: 0, meetings: 0 };
    entry.total++;
    if (isContacted(lead)) entry.contacted++;
    if (hasReplied(lead)) entry.replied++;
    if (hasMeeting(lead)) entry.meetings++;
    map.set(niche, entry);
  }
  return map;
}

function regionStats(leads: Lead[]) {
  const map = new Map<string, { total: number; contacted: number; replied: number }>();
  for (const lead of leads) {
    const region = extractRegion(lead.location) ?? "Unknown";
    const entry = map.get(region) ?? { total: 0, contacted: 0, replied: 0 };
    entry.total++;
    if (isContacted(lead)) entry.contacted++;
    if (hasReplied(lead)) entry.replied++;
    map.set(region, entry);
  }
  return map;
}

function replyRate(contacted: number, replied: number) {
  return contacted > 0 ? Math.round((replied / contacted) * 100) : 0;
}

// ─── Insight scoring — higher = higher priority ──────────────────────────────

type ScoredInsight = DiscoverInsight & { score: number };

function score(insight: DiscoverInsight, value: number): ScoredInsight {
  return { ...insight, score: value };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function buildDiscoverInsights(ctx: DiscoverInsightsContext): DiscoverInsight[] {
  const { leads, analytics, account } = ctx;
  const candidates: ScoredInsight[] = [];

  const monthlyRemaining = account.monthlyUsage.remaining;
  const dailyUsed = account.dailyUsage.used;
  const dailyLimit = account.dailyUsage.limit;
  const monthlyUsed = account.monthlyUsage.used;
  const monthlyLimit = account.monthlyUsage.limit;

  // ── Case: brand new user ────────────────────────────────────────────────────
  if (leads.length === 0) {
    candidates.push(
      score(
        {
          id: "getting-started-focus",
          title: "I'd start with a focused batch of 10–15 businesses in one niche.",
          reason:
            "Smaller first sessions give MAST enough signal to identify what actually works for your outreach style before you scale up.",
          tone: "brand",
          confidence: "Recommended",
          actionLabel: "Start Discovering →",
          actionHref: "#launch",
        },
        100
      )
    );

    candidates.push(
      score(
        {
          id: "getting-started-channels",
          title: "Enable both email and phone for your first session.",
          reason:
            "Teams that load both channels from the start see faster first replies — you double your surface area without any extra effort.",
          tone: "neutral",
          confidence: "Worth Testing",
          actionLabel: "Enable Phone →",
          actionHref: "#channels",
        },
        80
      )
    );

    if (monthlyRemaining > 0) {
      candidates.push(
        score(
          {
            id: "getting-started-capacity",
            title: `Now is a good time to run your first discovery — you have full capacity available.`,
            reason:
              "Your allowance is untouched. There's no better moment to establish your baseline before the month gets busy.",
            tone: "success",
            confidence: "Recommended",
            actionLabel: "Launch Session →",
            actionHref: "#launch",
          },
          70
        )
      );
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ score: _s, ...insight }) => insight);
  }

  // ─── Derived data ─────────────────────────────────────────────────────────

  const niches = nicheStats(leads);
  const regions = regionStats(leads);

  const nichePerformance = Array.from(niches.entries())
    .filter(([, s]) => s.contacted >= 2)
    .map(([niche, s]) => ({
      niche,
      rate: replyRate(s.contacted, s.replied),
      meetings: s.meetings,
      contacted: s.contacted,
      replied: s.replied,
    }))
    .sort((a, b) => b.rate - a.rate || b.meetings - a.meetings);

  const regionPerformance = Array.from(regions.entries())
    .filter(([, s]) => s.total >= 5)
    .map(([region, s]) => ({
      region,
      total: s.total,
      rate: replyRate(s.contacted, s.replied),
      contacted: s.contacted,
      replied: s.replied,
    }));

  const recentLeads = leads.filter((l) => isWithinDays(l.createdAt, 30));
  const priorLeads = leads.filter((l) => !isWithinDays(l.createdAt, 30) && isWithinDays(l.createdAt, 60));
  const recentContacted = recentLeads.filter(isContacted).length;
  const recentReplied = recentLeads.filter(hasReplied).length;
  const priorContacted = priorLeads.filter(isContacted).length;
  const priorReplied = priorLeads.filter(hasReplied).length;
  const recentRate = replyRate(recentContacted, recentReplied);
  const priorRate = replyRate(priorContacted, priorReplied);

  // ── 1. Best-performing niche → continue doubling down ─────────────────────
  if (nichePerformance.length > 0) {
    const best = nichePerformance[0];
    if (best.rate > 0) {
      candidates.push(
        score(
          {
            id: "top-niche-continue",
            title: `I'd continue with ${best.niche} as your primary focus today.`,
            reason:
              `It's consistently produced your strongest reply rate across ${best.contacted} businesses — ` +
              `that pattern tends to hold when you stay consistent with the same niche.`,
            tone: "success",
            confidence: "High Confidence",
            actionLabel: "Continue Discovering →",
            actionHref: "#launch",
          },
          90 + best.rate
        )
      );
    }

    // Worst-performing niche with enough data → suggest pausing it
    const worst = nichePerformance[nichePerformance.length - 1];
    if (
      nichePerformance.length >= 2 &&
      worst.rate === 0 &&
      worst.contacted >= 5 &&
      worst.niche !== nichePerformance[0].niche
    ) {
      candidates.push(
        score(
          {
            id: "weak-niche-pause",
            title: `I'd pause ${worst.niche} for now and redirect that energy elsewhere.`,
            reason:
              `After reaching out to ${worst.contacted} businesses there without a reply, ` +
              `the messaging or market fit likely needs rethinking before investing more sessions.`,
            tone: "warning",
            confidence: "Recommended",
            actionLabel: "Switch Niche →",
            actionHref: "#niches",
          },
          75
        )
      );
    }
  }

  // ── 2. Meeting-generating niche → strong signal, reinforce it ─────────────
  const meetingLeaders = Array.from(niches.entries())
    .filter(([, s]) => s.meetings > 0)
    .sort((a, b) => b[1].meetings - a[1].meetings);

  if (meetingLeaders.length > 0) {
    const [niche, stats] = meetingLeaders[0];
    // Only surface this if it's different from the top reply-rate niche
    const alreadySurfaced = nichePerformance[0]?.niche === niche && candidates.some((c) => c.id === "top-niche-continue");
    if (!alreadySurfaced) {
      candidates.push(
        score(
          {
            id: "meeting-niche-reinforce",
            title: `I recommend focusing your next session on ${niche} — it's your highest-converting vertical.`,
            reason:
              `${stats.meetings} meeting${stats.meetings > 1 ? "s" : ""} booked from this niche. ` +
              `When a vertical converts to meetings, adding more volume compounds quickly.`,
            tone: "brand",
            confidence: "High Confidence",
            actionLabel: "Open Pipeline →",
            actionHref: "/dashboard/pipeline",
          },
          88
        )
      );
    }
  }

  // ── 3. Silent region → redirect effort ────────────────────────────────────
  const silentRegions = regionPerformance.filter((r) => r.contacted >= 5 && r.replied === 0);
  if (silentRegions.length > 0) {
    const worst = silentRegions.sort((a, b) => b.total - a.total)[0];
    const bestAlt = regionPerformance.filter((r) => r.replied > 0).sort((a, b) => b.rate - a.rate)[0];
    const altText = bestAlt ? ` Your time is likely better spent in ${bestAlt.region}.` : "";
    candidates.push(
      score(
        {
          id: "silent-region-redirect",
          title: `I'd pause ${worst.region} for now.${altText}`,
          reason:
            `After ${worst.total} businesses discovered there without a reply, the return isn't justifying the effort. ` +
            `A region switch often resets momentum faster than adjusting messaging alone.`,
          tone: "warning",
          confidence: "Recommended",
          actionLabel: "Switch Region →",
          actionHref: "#regions",
        },
        82
      )
    );
  }

  // ── 4. Best region → lean in ───────────────────────────────────────────────
  const bestRegion = regionPerformance.filter((r) => r.replied > 0).sort((a, b) => b.rate - a.rate)[0];
  if (bestRegion && bestRegion.rate >= 10) {
    candidates.push(
      score(
        {
          id: "top-region-lean-in",
          title: `I'd keep your discovery focused on ${bestRegion.region} for the next few sessions.`,
          reason:
            `It's outperforming your other territories and geographic consistency tends to build compounding reply momentum. ` +
            `Now is a good time to go deeper rather than spread thinner.`,
          tone: "success",
          confidence: "High Confidence",
          actionLabel: "Continue Discovering →",
          actionHref: "#launch",
        },
        78
      )
    );
  }

  // ── 5. Reply trend improving → sustain momentum ───────────────────────────
  if (recentContacted >= 5 && priorContacted >= 5) {
    if (recentRate > priorRate + 5) {
      candidates.push(
        score(
          {
            id: "reply-trend-up",
            title: "Your outreach is gaining momentum — don't change what's working.",
            reason:
              `Reply rates have climbed over the past 30 days. ` +
              `This is the right time to increase session volume and let the momentum carry.`,
            tone: "success",
            confidence: "High Confidence",
            actionLabel: "Launch Session →",
            actionHref: "#launch",
          },
          85
        )
      );
    } else if (recentRate < priorRate - 5) {
      candidates.push(
        score(
          {
            id: "reply-trend-down",
            title: "I'd mix in a new niche or region for your next session.",
            reason:
              `Outreach performance has declined compared to last month. ` +
              `Changing one variable — either the vertical or the territory — usually breaks a plateau faster than refining the same approach.`,
            tone: "warning",
            confidence: "Watch Closely",
            actionLabel: "Apply Recommendation →",
            actionHref: "#niches",
          },
          80
        )
      );
    }
  }

  // ── 6. Follow-ups piling up → balance pipeline before discovering more ────
  if (analytics.followupsDue > 3) {
    candidates.push(
      score(
        {
          id: "pipeline-balance",
          title: `Before your next discovery run, I'd work through your open follow-ups.`,
          reason:
            `There are ${analytics.followupsDue} conversations waiting — letting those cool off while adding more businesses tends to dilute focus. ` +
            `The best teams close the loop before opening new ones.`,
          tone: "neutral",
          confidence: "Recommended",
          actionLabel: "Review Businesses →",
          actionHref: "/dashboard/pipeline",
        },
        analytics.followupsDue >= 10 ? 95 : 72
      )
    );
  }

  // ── 7. Daily allowance untouched → prompt a session ─────────────────────
  if (dailyUsed === 0 && dailyLimit > 0) {
    candidates.push(
      score(
        {
          id: "daily-unused",
          title: "Now is a good time to run a discovery session — your daily capacity is fresh.",
          reason:
            "Consistent daily discovery keeps your pipeline warm. A quick 10-business session today gives MAST fresh signals to sharpen tomorrow's recommendations.",
          tone: "brand",
          confidence: "Recommended",
          actionLabel: "Start Discovering →",
          actionHref: "#launch",
        },
        68
      )
    );
  }

  // ── 8. Usage pace warning — running low ──────────────────────────────────
  if (monthlyUsed > 0 && monthlyLimit > 0) {
    const dayOfMonth = new Date().getDate();
    const dailyAvg = monthlyUsed / dayOfMonth;
    if (dailyAvg > 0) {
      const daysUntilLimit = Math.ceil(monthlyRemaining / dailyAvg);
      if (daysUntilLimit <= 5 && daysUntilLimit > 0) {
        candidates.push(
          score(
            {
              id: "usage-pace-critical",
              title: `It's worth prioritizing your highest-performing niches for the rest of this month.`,
              reason:
                `At your current pace, you'll reach your monthly limit in about ${daysUntilLimit} day${daysUntilLimit === 1 ? "" : "s"}. ` +
                `Make the remaining capacity count by targeting what's already proven to convert.`,
              tone: "warning",
              confidence: "Watch Closely",
              actionLabel: "Open Mission →",
              actionHref: "/dashboard/pipeline",
            },
            88
          )
        );
      }
    }
  }

  // ── 9. Healthy pipeline, no specific signals — general strategic nudge ────
  if (candidates.length === 0) {
    candidates.push(
      score(
        {
          id: "keep-refining",
          title: "I think your current discovery approach is working — keep refining based on reply signals.",
          reason:
            "Your pipeline looks balanced. The next step is adding more volume in your best-performing niche to generate the data needed for sharper future recommendations.",
          tone: "brand",
          confidence: "Worth Testing",
          actionLabel: "Continue Discovering →",
          actionHref: "#launch",
        },
        50
      )
    );
  }

  // Return top 3 by score
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score: _s, ...insight }) => insight);
}
