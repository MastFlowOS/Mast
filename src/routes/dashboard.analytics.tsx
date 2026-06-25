import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  Bell,
  Brain,
  Globe2,
  HeartPulse,
  Instagram,
  Mail,
  Phone,
  Target,
  TrendingUp,
} from "lucide-react";
import type { ComponentType } from "react";
import type { Lead, PipelineStat } from "@/lib/api";
import { useAnalytics, useLeads, usePipelineStats } from "@/hooks/use-mast-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LEAD_STATUSES, NICHES, leadStatusLabel, normalizeLeadStatus } from "@/lib/lead-workspace";

export const Route = createFileRoute("/dashboard/analytics")({
  head: () => ({ meta: [{ title: "Analytics - Mast" }] }),
  component: AnalyticsPage,
});

const STATUS_COLORS: Record<string, string> = {
  new: "#60a5fa",
  priority: "#f59e0b",
  warm: "#eab308",
  contacted: "#fb923c",
  instagram_sent: "#818cf8",
  email_sent: "#38bdf8",
  contact_form_sent: "#22d3ee",
  replied: "#a78bfa",
  follow_up_due: "#f97316",
  interested: "#22c55e",
  meeting_booked: "#14b8a6",
  closed: "#10b981",
  dead: "#f87171",
};

const CHART_TOOLTIP_PROPS = {
  cursor: { fill: "color-mix(in oklab, var(--brand) 14%, transparent)" },
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid color-mix(in oklab, var(--brand) 34%, var(--border))",
    borderRadius: "10px",
    color: "var(--popover-foreground)",
    fontSize: 12,
    boxShadow: "var(--shadow-elevated)",
  },
  labelStyle: {
    color: "var(--brand)",
    fontWeight: 700,
  },
  itemStyle: {
    color: "var(--foreground)",
  },
} as const;

const CONTACTED_STATUSES = ["contacted", "instagram_sent", "email_sent", "contact_form_sent", "replied", "interested", "meeting_booked", "closed"];
const REPLY_STATUSES = ["replied", "interested", "meeting_booked", "closed"];
const INTERESTED_STATUSES = ["replied", "interested", "meeting_booked", "closed"];
const MEETING_STATUSES = ["meeting_booked", "closed"];

type PerformanceRow = {
  name: string;
  leads: number;
  replies: number;
  replyRate: number;
  conversionRate: number;
  color: string;
};

function AnalyticsPage() {
  const { data: summary, isLoading: summaryLoading } = useAnalytics();
  const { data: pipelineFromApi, isLoading: pipelineLoading } = usePipelineStats();
  const { data: leadsPayload } = useLeads({ limit: 1000 });
  const leads = normalizeLeads(leadsPayload);
  const pipelineStats = pipelineFromApi?.length ? pipelineFromApi : buildPipelineStats(leads);

  const pipelineData = pipelineStats
    .filter((item) => item.count > 0 && normalizeLeadStatus(item.status) !== "dead")
    .map((item) => ({
      name: leadStatusLabel(item.status),
      count: item.count,
      status: normalizeLeadStatus(item.status),
    }));

  const safeSummary = summary ?? {
    totalLeads: leads.length,
    contacted: leads.filter((lead) => CONTACTED_STATUSES.includes(normalizeLeadStatus(lead.status))).length,
    replied: leads.filter((lead) => normalizeLeadStatus(lead.status) === "replied").length,
    interested: leads.filter((lead) => normalizeLeadStatus(lead.status) === "interested").length,
    closed: leads.filter((lead) => normalizeLeadStatus(lead.status) === "closed").length,
    dead: leads.filter((lead) => normalizeLeadStatus(lead.status) === "dead").length,
    followupsDue: leads.filter((lead) => Boolean(lead.followUpAt)).length,
    messagesThisWeek: 0,
    replyRate: 0,
  };

  const leadHealth = buildLeadHealth(leads);
  const channelPerformance = buildChannelPerformance(leads);
  const nichePerformance = buildNichePerformance(leads).slice(0, 5);
  const regionPerformance = buildRegionPerformance(leads);
  const funnel = buildFunnel(leads, safeSummary.totalLeads);
  const insights = buildInsights({
    channelPerformance,
    leadHealth,
    nichePerformance,
    regionPerformance,
    leads,
  });

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">Progress signals, channel performance, and pipeline health.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Reply Rate" value={`${safeSummary.replyRate ?? 0}%`} icon={TrendingUp} loading={summaryLoading} />
        <MetricCard label="Messages This Week" value={safeSummary.messagesThisWeek} icon={Mail} loading={summaryLoading} />
        <MetricCard label="Follow-ups Due" value={safeSummary.followupsDue} icon={Bell} loading={summaryLoading} />
        <MetricCard label="Lead Health" value={`${leadHealth.healthy} healthy`} icon={HeartPulse} loading={summaryLoading && leads.length === 0} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Conversion Funnel</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading && leads.length === 0 ? (
              <div className="space-y-2">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10" />)}</div>
            ) : (
              <div className="space-y-4">
                {funnel.map((item, index) => (
                  <div key={item.label} className="space-y-2">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <div>
                        <span className="font-semibold text-foreground">{item.label}</span>
                        {index > 0 && <span className="ml-2 text-xs text-brand">{item.previousPct}% from previous</span>}
                      </div>
                      <span className="font-mono text-sm font-semibold">{item.value.toLocaleString()}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-brand transition-all"
                        style={{ width: `${item.totalPct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Brain className="size-4 text-brand" />
              AI Insights
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {insights.map((insight) => (
                <div key={insight.title} className="rounded-lg border border-border bg-background/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">{insight.title}</p>
                    <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand">
                      {insight.tone}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{insight.body}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Lead Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-4">
            <HealthPill label="Healthy" value={leadHealth.healthy} color="bg-success" />
            <HealthPill label="At Risk" value={leadHealth.atRisk} color="bg-warning" />
            <HealthPill label="Stale" value={leadHealth.stale} color="bg-orange-400" />
            <HealthPill label="Dead" value={leadHealth.dead} color="bg-destructive" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Channel Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="grid gap-3 sm:grid-cols-2">
              {channelPerformance.map((channel) => (
                <PerformanceTile key={channel.name} item={channel} />
              ))}
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={channelPerformance} margin={{ top: 10, right: 8, bottom: 10, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="color-mix(in oklab, var(--border) 70%, transparent)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} />
                  <Bar dataKey="leads" name="Leads" fill="color-mix(in oklab, var(--brand) 28%, var(--muted))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="replies" name="Replies" fill="var(--brand)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Niche Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <PerformanceList rows={nichePerformance} emptyText="No niche performance yet." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Region Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <PerformanceList rows={regionPerformance} emptyText="No regional performance yet." />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Leads by Status</CardTitle>
          </CardHeader>
          <CardContent>
            {pipelineLoading && leads.length === 0 ? (
              <Skeleton className="h-64" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={pipelineData} margin={{ top: 8, right: 8, bottom: 34, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="color-mix(in oklab, var(--border) 70%, transparent)" />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} angle={-28} textAnchor="end" interval={0} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip {...CHART_TOOLTIP_PROPS} />
                  <Bar dataKey="count" name="Leads" radius={[4, 4, 0, 0]}>
                    {pipelineData.map((entry) => (
                      <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? "#94a3b8"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Reply Rate by Region</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={regionPerformance} margin={{ top: 8, right: 8, bottom: 24, left: 0 }}>
                <CartesianGrid vertical={false} stroke="color-mix(in oklab, var(--border) 70%, transparent)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip {...CHART_TOOLTIP_PROPS} formatter={(value, name) => [`${value}%`, name]} />
                <Bar dataKey="replyRate" name="Reply Rate" fill="var(--brand)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value: string | number;
  icon: ComponentType<{ className?: string }>;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          <div className="grid size-8 place-items-center rounded-lg border border-brand/20 bg-brand/10">
            <Icon className="size-4 text-brand" />
          </div>
        </div>
        {loading ? <Skeleton className="mt-4 h-8 w-20" /> : <p className="mt-4 text-2xl font-bold">{value}</p>}
      </CardContent>
    </Card>
  );
}

function HealthPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-4">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${color}`} />
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-bold">{value.toLocaleString()}</p>
    </div>
  );
}

function PerformanceTile({ item }: { item: PerformanceRow }) {
  const Icon = channelIcon(item.name);
  return (
    <div className="rounded-lg border border-border bg-background/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg border border-brand/20 bg-brand/10">
            <Icon className="size-4 text-brand" />
          </div>
          <p className="text-sm font-semibold">{item.name}</p>
        </div>
        <span className="text-xs font-bold text-brand">{item.replyRate}%</span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <StatBlock label="Leads" value={item.leads} />
        <StatBlock label="Replies" value={item.replies} />
        <StatBlock label="Reply Rate" value={`${item.replyRate}%`} />
      </div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold">{typeof value === "number" ? value.toLocaleString() : value}</p>
    </div>
  );
}

function PerformanceList({ rows, emptyText }: { rows: PerformanceRow[]; emptyText: string }) {
  if (!rows.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.name} className="rounded-lg border border-border bg-background/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-semibold">{row.name}</p>
            <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 text-xs font-bold text-brand">
              {row.replyRate}% reply
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
            <StatBlock label="Leads" value={row.leads} />
            <StatBlock label="Replies" value={row.replies} />
            <StatBlock label="Conversion" value={`${row.conversionRate}%`} />
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand" style={{ width: `${row.replyRate}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined) {
  return Array.isArray(payload) ? payload : payload?.leads ?? [];
}

function buildPipelineStats(leads: Lead[]): PipelineStat[] {
  const counts = new Map<string, number>();
  for (const status of LEAD_STATUSES) counts.set(status.value, 0);
  for (const lead of leads) {
    const status = normalizeLeadStatus(lead.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([status, count]) => ({ status, count, label: leadStatusLabel(status) }));
}

function buildFunnel(leads: Lead[], totalFromSummary: number) {
  const generated = totalFromSummary || leads.length;
  const contacted = leads.filter((lead) => CONTACTED_STATUSES.includes(normalizeLeadStatus(lead.status)) || Boolean(lead.lastContactedAt)).length;
  const interested = leads.filter((lead) => INTERESTED_STATUSES.includes(normalizeLeadStatus(lead.status))).length;
  const meeting = leads.filter((lead) => MEETING_STATUSES.includes(normalizeLeadStatus(lead.status))).length;
  const closed = leads.filter((lead) => normalizeLeadStatus(lead.status) === "closed").length;
  const rows = [
    { label: "Generated", value: generated },
    { label: "Contacted", value: contacted },
    { label: "Interested", value: interested },
    { label: "Meeting", value: meeting },
    { label: "Closed", value: closed },
  ];

  return rows.map((row, index) => {
    const previous = index === 0 ? row.value : rows[index - 1].value;
    return {
      ...row,
      previousPct: previous ? Math.round((row.value / previous) * 100) : 0,
      totalPct: generated ? Math.round((row.value / generated) * 100) : 0,
    };
  });
}

function buildLeadHealth(leads: Lead[]) {
  return leads.reduce(
    (counts, lead) => {
      const status = normalizeLeadStatus(lead.status);
      if (status === "dead") {
        counts.dead += 1;
        return counts;
      }

      if (["replied", "interested", "meeting_booked", "closed"].includes(status)) {
        counts.healthy += 1;
        return counts;
      }

      const lastSignal = lead.lastContactedAt ?? lead.updatedAt ?? lead.createdAt;
      const age = daysSince(lastSignal);
      if (age >= 30) counts.stale += 1;
      else if (age >= 14 || status === "follow_up_due") counts.atRisk += 1;
      else counts.healthy += 1;

      return counts;
    },
    { healthy: 0, atRisk: 0, stale: 0, dead: 0 },
  );
}

function buildChannelPerformance(leads: Lead[]): PerformanceRow[] {
  const channels = [
    { name: "Email", color: "#38bdf8", hasLead: (lead: Lead) => Boolean(lead.email), sent: (status: string) => status === "email_sent" },
    { name: "Phone", color: "#a78bfa", hasLead: (lead: Lead) => Boolean(lead.phone), sent: (status: string) => status === "contacted" },
    { name: "Instagram", color: "#818cf8", hasLead: (lead: Lead) => Boolean(lead.instagramHandle), sent: (status: string) => status === "instagram_sent" },
    { name: "Website/Form", color: "#22d3ee", hasLead: (lead: Lead) => Boolean(lead.website), sent: (status: string) => status === "contact_form_sent" },
  ];

  return channels.map((channel) => {
    const channelLeads = leads.filter(channel.hasLead);
    const replies = channelLeads.filter((lead) => {
      const status = normalizeLeadStatus(lead.status);
      return REPLY_STATUSES.includes(status) || channel.sent(status);
    }).length;
    const closed = channelLeads.filter((lead) => normalizeLeadStatus(lead.status) === "closed").length;
    return {
      name: channel.name,
      leads: channelLeads.length,
      replies,
      replyRate: percentage(replies, channelLeads.length),
      conversionRate: percentage(closed, channelLeads.length),
      color: channel.color,
    };
  });
}

function buildNichePerformance(leads: Lead[]): PerformanceRow[] {
  return Array.from(groupLeads(leads, (lead) => nicheLabel(lead.niche)).entries())
    .map(([name, group]) => performanceRow(name, group, "#a78bfa"))
    .filter((row) => row.leads > 0)
    .sort((a, b) => b.replyRate - a.replyRate || b.replies - a.replies || b.leads - a.leads);
}

function buildRegionPerformance(leads: Lead[]): PerformanceRow[] {
  const regionOrder = ["North America", "Europe", "Asia", "Africa", "Oceania"];
  const grouped = groupLeads(leads, (lead) => regionLabel(lead.location));
  return regionOrder
    .map((region) => performanceRow(region, grouped.get(region) ?? [], "#a78bfa"))
    .filter((row) => row.leads > 0);
}

function performanceRow(name: string, leads: Lead[], color: string): PerformanceRow {
  const replies = leads.filter((lead) => REPLY_STATUSES.includes(normalizeLeadStatus(lead.status))).length;
  const closed = leads.filter((lead) => normalizeLeadStatus(lead.status) === "closed").length;
  return {
    name,
    leads: leads.length,
    replies,
    replyRate: percentage(replies, leads.length),
    conversionRate: percentage(closed, leads.length),
    color,
  };
}

function buildInsights({
  channelPerformance,
  leadHealth,
  nichePerformance,
  regionPerformance,
  leads,
}: {
  channelPerformance: PerformanceRow[];
  leadHealth: ReturnType<typeof buildLeadHealth>;
  nichePerformance: PerformanceRow[];
  regionPerformance: PerformanceRow[];
  leads: Lead[];
}) {
  const bestChannel = [...channelPerformance].sort((a, b) => b.replyRate - a.replyRate || b.replies - a.replies)[0];
  const bestNiche = nichePerformance[0];
  const bestRegion = [...regionPerformance].sort((a, b) => b.replyRate - a.replyRate || b.replies - a.replies)[0];
  const recentWins = leads.filter((lead) => {
    const status = normalizeLeadStatus(lead.status);
    return REPLY_STATUSES.includes(status) && daysSince(lead.updatedAt) <= 7;
  }).length;

  return [
    {
      title: bestNiche ? `${bestNiche.name} is pulling ahead` : "Pick a niche to compare",
      body: bestNiche
        ? `${bestNiche.replyRate}% reply rate across ${bestNiche.leads.toLocaleString()} leads. Keep new prospecting focused here until another niche beats it.`
        : "Add niche data to leads so Mast can show which segments deserve more outreach.",
      tone: "Niche",
    },
    {
      title: bestChannel ? `${bestChannel.name} is your strongest channel` : "Channels need more data",
      body: bestChannel
        ? `${bestChannel.replies.toLocaleString()} replies from ${bestChannel.leads.toLocaleString()} leads. Prioritize follow-ups here before adding volume elsewhere.`
        : "Send outreach across email, phone, Instagram, and forms to compare real reply rates.",
      tone: "Channel",
    },
    {
      title: `${(leadHealth.atRisk + leadHealth.stale).toLocaleString()} leads need attention`,
      body: leadHealth.stale > 0
        ? `${leadHealth.stale.toLocaleString()} stale leads have gone quiet for 30+ days. Re-engage or mark them dead to keep forecasts clean.`
        : `${leadHealth.atRisk.toLocaleString()} leads are approaching stale. Schedule follow-ups before momentum drops.`,
      tone: "Health",
    },
    {
      title: recentWins > 0 ? "Positive trend this week" : "No positive trend yet",
      body: recentWins > 0
        ? `${recentWins.toLocaleString()} leads moved into reply, interest, meeting, or closed stages in the last 7 days.`
        : bestRegion
          ? `${bestRegion.name} has the best regional signal at ${bestRegion.replyRate}%. Test more leads there to confirm.`
          : "Start by contacting the freshest leads and watch for replies in the next 7 days.",
      tone: recentWins > 0 ? "Trend" : "Next",
    },
  ];
}

function groupLeads(leads: Lead[], getKey: (lead: Lead) => string) {
  const groups = new Map<string, Lead[]>();
  for (const lead of leads) {
    const key = getKey(lead);
    groups.set(key, [...(groups.get(key) ?? []), lead]);
  }
  return groups;
}

function nicheLabel(niche?: string | null) {
  if (!niche) return "Uncategorized";
  const normalized = niche.trim();
  const direct = NICHES.find((item) => item.value === normalized || item.label.toLowerCase() === normalized.toLowerCase());
  if (direct) return direct.label;
  return normalized
    .replace(/_/g, " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function regionLabel(location?: string | null) {
  const value = (location ?? "").toLowerCase();
  if (!value.trim()) return "North America";
  if (value.includes("europe") || /\b(uk|france|germany|italy|spain|netherlands|poland|ireland|portugal)\b/.test(value)) return "Europe";
  if (value.includes("asia") || /\b(india|china|japan|singapore|korea|uae|philippines|thailand)\b/.test(value)) return "Asia";
  if (value.includes("africa") || /\b(egypt|nigeria|kenya|south africa|morocco|ghana)\b/.test(value)) return "Africa";
  if (value.includes("oceania") || /\b(australia|new zealand)\b/.test(value)) return "Oceania";
  return "North America";
}

function percentage(value: number, total: number) {
  return total ? Math.round((value / total) * 100) : 0;
}

function daysSince(date?: string | null) {
  if (!date) return 999;
  const value = new Date(date).getTime();
  if (Number.isNaN(value)) return 999;
  return Math.max(0, Math.floor((Date.now() - value) / 86_400_000));
}

function channelIcon(name: string) {
  if (name === "Email") return Mail;
  if (name === "Phone") return Phone;
  if (name === "Instagram") return Instagram;
  if (name === "Website/Form") return Globe2;
  if (name === "Lead Health") return HeartPulse;
  if (name === "AI Insights") return Brain;
  if (name === "Conversion") return Target;
  return Activity;
}
