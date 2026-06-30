import type { Account, AnalyticsSummary, Lead } from "@/lib/api";
import { normalizeLeadStatus } from "@/lib/lead-workspace";

export type DiscoverInsight = {
  id: string;
  title: string;
  reason: string;
  tone: "brand" | "warning" | "success" | "neutral";
};

export type DiscoverInsightsContext = {
  leads: Lead[];
  analytics: AnalyticsSummary;
  account: Account;
};

function isContacted(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return !["discovered", "ready", "new"].includes(status) || Boolean(lead.lastContactedAt);
}

function hasReplied(lead: Lead) {
  const status = normalizeLeadStatus(lead.status);
  return ["conversation", "replied", "interested", "meeting", "proposal", "negotiation", "closed_won", "meeting_booked"].includes(status);
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

export function buildDiscoverInsights(ctx: DiscoverInsightsContext): DiscoverInsight[] {
  const { leads, analytics, account } = ctx;
  const insights: DiscoverInsight[] = [];

  const monthlyUsed = account.monthlyUsage.used;
  const monthlyLimit = account.monthlyUsage.limit;
  const monthlyRemaining = account.monthlyUsage.remaining;
  const dailyUsed = account.dailyUsage.used;
  const dailyLimit = account.dailyUsage.limit;

  if (leads.length === 0) {
    insights.push({
      id: "getting-started",
      title: "Your discovery profile is ready — start with a focused batch of 10–15 businesses.",
      reason: "Smaller first sessions let Mast learn which niches and regions perform best for your outreach style.",
      tone: "brand",
    });
    insights.push({
      id: "channel-tip",
      title: "Email and phone together give you the widest verified reach.",
      reason: "Most users see the fastest first replies when both channels are loaded into the workspace upfront.",
      tone: "neutral",
    });
    if (monthlyRemaining > 0) {
      insights.push({
        id: "allowance",
        title: `You have ${monthlyRemaining.toLocaleString()} discoveries available this month on your ${account.subscription.name} plan.`,
        reason: "Your allowance resets automatically — no action needed to keep discovering.",
        tone: "success",
      });
    }
    return insights.slice(0, 4);
  }

  const niches = nicheStats(leads);
  const regions = regionStats(leads);

  const nichePerformance = Array.from(niches.entries())
    .filter(([, s]) => s.contacted >= 2)
    .map(([niche, s]) => ({
      niche,
      rate: replyRate(s.contacted, s.replied),
      meetings: s.meetings,
      contacted: s.contacted,
    }))
    .sort((a, b) => b.rate - a.rate || b.meetings - a.meetings);

  if (nichePerformance.length > 0) {
    const best = nichePerformance[0];
    if (best.rate > 0) {
      insights.push({
        id: "top-niche-reply",
        title: `${best.niche} generated your highest reply rate (${best.rate}%) among contacted businesses.`,
        reason: `${best.contacted} businesses contacted — continuing in this vertical aligns with what's already working.`,
        tone: "success",
      });
    }
  }

  const meetingLeaders = Array.from(niches.entries())
    .filter(([, s]) => s.meetings > 0)
    .sort((a, b) => b[1].meetings - a[1].meetings);

  if (meetingLeaders.length > 0) {
    const [niche, stats] = meetingLeaders[0];
    insights.push({
      id: "top-niche-meeting",
      title: `${niche} has produced your highest meeting conversion (${stats.meetings} booked).`,
      reason: "Meeting-ready niches are strong signals — doubling down here often shortens your sales cycle.",
      tone: "brand",
    });
  }

  const regionPerformance = Array.from(regions.entries())
    .filter(([, s]) => s.total >= 5)
    .map(([region, s]) => ({
      region,
      total: s.total,
      rate: replyRate(s.contacted, s.replied),
      contacted: s.contacted,
      replied: s.replied,
    }));

  const silentRegions = regionPerformance.filter((r) => r.contacted >= 5 && r.replied === 0);
  if (silentRegions.length > 0) {
    const worst = silentRegions.sort((a, b) => b.total - a.total)[0];
    insights.push({
      id: "silent-region",
      title: `You've discovered ${worst.total} businesses in ${worst.region} without receiving a reply.`,
      reason: "Zero replies after sustained outreach often means the region or messaging angle needs adjusting — not that the market is closed.",
      tone: "warning",
    });
  }

  const bestRegion = regionPerformance
    .filter((r) => r.replied > 0)
    .sort((a, b) => b.rate - a.rate)[0];
  if (bestRegion && bestRegion.rate >= 10) {
    insights.push({
      id: "top-region",
      title: `${bestRegion.region} is your strongest territory with a ${bestRegion.rate}% reply rate.`,
      reason: `${bestRegion.replied} replies from ${bestRegion.contacted} contacted — geographic focus here compounds results.`,
      tone: "success",
    });
  }

  const recentLeads = leads.filter((l) => isWithinDays(l.createdAt, 30));
  const priorLeads = leads.filter((l) => !isWithinDays(l.createdAt, 30) && isWithinDays(l.createdAt, 60));
  const recentContacted = recentLeads.filter(isContacted).length;
  const recentReplied = recentLeads.filter(hasReplied).length;
  const priorContacted = priorLeads.filter(isContacted).length;
  const priorReplied = priorLeads.filter(hasReplied).length;
  const recentRate = replyRate(recentContacted, recentReplied);
  const priorRate = replyRate(priorContacted, priorReplied);

  if (recentContacted >= 5 && priorContacted >= 5) {
    if (recentRate > priorRate + 5) {
      insights.push({
        id: "reply-trend-up",
        title: `Reply rate climbed to ${recentRate}% this month — up from ${priorRate}% last month.`,
        reason: "Your outreach rhythm is improving. Maintaining current niche and channel choices should keep momentum.",
        tone: "success",
      });
    } else if (recentRate < priorRate - 5) {
      insights.push({
        id: "reply-trend-down",
        title: `Reply rate dipped to ${recentRate}% this month from ${priorRate}% previously.`,
        reason: "A fresh region or niche mix often breaks plateaus — consider shifting one parameter at a time.",
        tone: "warning",
      });
    }
  }

  if (monthlyUsed > 0 && monthlyLimit > 0) {
    const dayOfMonth = new Date().getDate();
    const dailyAvg = monthlyUsed / dayOfMonth;
    if (dailyAvg > 0) {
      const daysUntilLimit = Math.ceil(monthlyRemaining / dailyAvg);
      if (daysUntilLimit <= 10 && daysUntilLimit > 0) {
        insights.push({
          id: "usage-pace",
          title: `You're on track to reach your monthly discovery allowance within ${daysUntilLimit} day${daysUntilLimit === 1 ? "" : "s"}.`,
          reason: `${monthlyRemaining.toLocaleString()} discoveries remaining at your current pace of ~${Math.round(dailyAvg)}/day.`,
          tone: daysUntilLimit <= 5 ? "warning" : "neutral",
        });
      }
    }
  }

  if (dailyUsed === 0 && dailyLimit > 0) {
    insights.push({
      id: "daily-unused",
      title: `You haven't discovered any businesses today — ${dailyLimit} still available.`,
      reason: "Consistent daily discovery keeps your pipeline warm and gives Mast more data to refine recommendations.",
      tone: "brand",
    });
  }

  if (analytics.followupsDue > 3 && insights.length < 5) {
    insights.push({
      id: "pipeline-balance",
      title: `${analytics.followupsDue} follow-ups are waiting — balance discovery with pipeline nurture.`,
      reason: "The highest-performing teams alternate between fresh discovery and working existing conversations.",
      tone: "neutral",
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: "keep-going",
      title: "Your discovery patterns look balanced — keep refining based on reply signals.",
      reason: `${analytics.totalLeads} businesses in pipeline with a ${analytics.replyRate}% overall reply rate.`,
      tone: "brand",
    });
  }

  return insights.sort((a, b) => {
    const toneOrder = { warning: 4, success: 3, brand: 2, neutral: 1 };
    return toneOrder[b.tone] - toneOrder[a.tone];
  }).slice(0, 5);
}
