import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUpRight, TrendingUp, Mail, Target, Activity, BarChart2 } from "lucide-react";
import { useAccount, useAnalytics, useLeads, useMe } from "@/hooks/use-mast-api";
import { getPlan } from "@/lib/plans";
import type { Lead } from "@/lib/api";

export const Route = createFileRoute("/dashboard/")(
  {
    component: DashboardHome,
  }
);

function DashboardHome() {
  const navigate = useNavigate();
  const { data: auth } = useMe();
  const { data: account } = useAccount();
  const { data: analytics } = useAnalytics();
  const { data: leadsPayload } = useLeads({ limit: 5, sort: "createdAt", order: "desc" });

  const leads = normalizeLeads(leadsPayload);
  const firstName = auth?.user?.fullName?.split(/\s+/)[0] || "there";
  const planName = account?.subscription.name ?? (auth?.user ? getPlan(auth.user.plan).name : "Free");

  const monthlyUsed = account?.monthlyUsage?.used ?? auth?.user?.monthlyLeadsUsed ?? 0;
  const monthlyLimit = account?.monthlyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).monthlyLeadLimit : 300);
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);
  const monthlyProgress = monthlyLimit > 0 ? Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100)) : 0;

  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyLimit = account?.dailyUsage?.limit ?? (auth?.user ? getPlan(auth.user.plan).dailyLeadLimit : 20);
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const dailyProgress = dailyLimit > 0 ? Math.min(100, Math.round((dailyUsed / dailyLimit) * 100)) : 0;

  const summary = analytics ?? {
    totalLeads: 0,
    contacted: 0,
    replied: 0,
    interested: 0,
    closed: 0,
    dead: 0,
    followupsDue: 0,
    messagesThisWeek: 0,
    replyRate: 0,
  };

  // Determine if there is any outreach activity to display
  const hasOutreachActivity =
    summary.messagesThisWeek > 0 || summary.contacted > 0 || summary.replied > 0;

  return (
    <div className="p-8 space-y-8 max-w-7xl">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Welcome back, {firstName}
          </h1>
          <p className="text-sm text-muted-foreground">
            Your multi-channel pipeline — verified emails, phones, websites, and
            Instagram profiles.
          </p>
        </div>
        <Link
          to="/dashboard/leads"
          className="bg-brand text-brand-foreground px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-dark shadow-brand inline-flex items-center gap-2"
        >
          Generate Leads <ArrowUpRight className="size-4" />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KPI
          label="Monthly Leads"
          value={`${monthlyRemaining.toLocaleString()} / ${monthlyLimit.toLocaleString()}`}
          hint={`${planName} Plan`}
          icon={Target}
          progress={monthlyProgress}
        />
        <KPI
          label="Replies"
          value={summary.replied.toLocaleString()}
          hint={`${summary.messagesThisWeek} messages this week`}
          icon={Mail}
          trend
        />
        <KPI
          label="Reply Rate"
          value={`${summary.replyRate}%`}
          hint={`${summary.contacted.toLocaleString()} contacted`}
          icon={TrendingUp}
          trend
        />
        <KPI
          label="Pipeline"
          value={summary.totalLeads.toLocaleString()}
          hint={`${summary.followupsDue} follow-ups due`}
          icon={Activity}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">Recent Leads</h2>
            <Link
              to="/dashboard/crm"
              className="text-xs font-semibold text-brand hover:text-brand-dark"
            >
              View all →
            </Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-background/40 border-b border-border">
                <tr>
                  <Th>Company</Th>
                  <Th>Region</Th>
                  <Th>Niche</Th>
                  <Th>Score</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l, i) => (
                  <tr
                    key={l.name}
                    onClick={() => {
                      navigate(`/dashboard/leads/${l.rawLead.id}`);
                    }}
                    className={`${i < leads.length - 1 ? "border-b border-border/50" : ""} hover:bg-muted/40 transition-colors cursor-pointer`}
                  >
                    <td className="p-3.5 font-medium">{l.name}</td>
                    <td className="p-3.5 text-muted-foreground">{l.region}</td>
                    <td className="p-3.5 text-muted-foreground">{l.niche}</td>
                    <td className="p-3.5">
                      <Score n={l.score} />
                    </td>
                    <td className="p-3.5 text-right">
                      <span className={badge(l.status)}>{l.status}</span>
                    </td>
                  </tr>
                ))}
                {leads.length === 0 && (
                  <tr>
                    <td
                      className="p-5 text-sm text-muted-foreground"
                      colSpan={5}
                    >
                      No leads yet. Generate your first batch to fill the
                      pipeline.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-6 flex flex-col">
          <h2 className="font-bold mb-1">Subscription</h2>
          <p className="text-xs text-muted-foreground">
            Your current plan & usage
          </p>
          <div className="mt-5 flex items-baseline gap-2">
            <span className="text-3xl font-bold">{planName}</span>
            <span className="text-sm text-muted-foreground">
              ${account?.subscription.priceMonthly ?? 0}/mo
            </span>
          </div>
          <div className="mt-6 space-y-4 text-sm flex-1">
            <UsageBar
              label="Monthly Leads used"
              cur={monthlyUsed}
              max={Math.max(1, monthlyLimit)}
            />
            <UsageBar
              label="Daily Leads used"
              cur={dailyUsed}
              max={Math.max(1, dailyLimit)}
            />
            <UsageBar
              label="Leads delivered"
              cur={summary.totalLeads}
              max={Math.max(1, monthlyLimit)}
            />
            <UsageBar
              label="Replies"
              cur={summary.replied}
              max={Math.max(
                1,
                summary.contacted || summary.totalLeads || 1
              )}
            />
            <UsageBar
              label="Closed"
              cur={summary.closed}
              max={Math.max(1, summary.totalLeads || 1)}
            />
          </div>
          <Link
            to="/dashboard/subscription"
            className="mt-6 w-full text-center bg-foreground text-background py-2.5 rounded-lg text-sm font-semibold hover:bg-foreground/90"
          >
            Manage subscription
          </Link>
        </div>
      </div>

      {/* Outreach Analytics — only shown when there is data */}
      <div className="bg-card border border-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-bold">Outreach Analytics</h2>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Last 7 days
          </span>
        </div>

        {hasOutreachActivity ? (
          <BarChart />
        ) : (
          <OutreachEmptyState />
        )}
      </div>
    </div>
  );
}

function OutreachEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="size-14 rounded-2xl bg-brand/10 border border-brand/20 grid place-items-center mb-4">
        <BarChart2 className="size-6 text-brand" />
      </div>
      <h3 className="font-semibold text-base mb-1">No outreach activity yet</h3>
      <p className="text-sm text-muted-foreground max-w-xs mb-5">
        Generate leads and start outreach to see performance analytics here.
      </p>
      <Link
        to="/dashboard/leads"
        className="inline-flex items-center gap-2 bg-brand text-brand-foreground px-4 py-2 rounded-lg text-sm font-semibold hover:bg-brand-dark shadow-brand"
      >
        Generate Leads <ArrowUpRight className="size-4" />
      </Link>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined) {
  const rows = Array.isArray(payload) ? payload : payload?.leads ?? [];
  return rows.map((lead) => ({
    name: lead.businessName,
    region: lead.location ?? "—",
    niche: lead.niche ?? "—",
    score:
      lead.priority === "high" ? 96 : lead.priority === "normal" ? 78 : 68,
    status: statusLabel(lead.status),
    rawLead: lead,
  }));
}

function statusLabel(status: string) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function badge(s: string) {
  const base =
    "px-2 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wider";
  if (s === "New") return `${base} bg-brand/10 text-brand border-brand/20`;
  if (s === "Replied")
    return `${base} bg-success/10 text-success border-success/20`;
  return `${base} bg-blue-500/10 text-blue-400 border-blue-500/20`;
}

function Th({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: boolean;
}) {
  return (
    <th
      className={`p-3.5 font-semibold text-muted-foreground text-[11px] uppercase tracking-wider ${right ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Score({ n }: { n: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-brand" style={{ width: `${n}%` }} />
      </div>
      <span className="text-xs text-muted-foreground font-mono">{n}</span>
    </div>
  );
}

function KPI({
  label,
  value,
  hint,
  icon: Icon,
  progress,
  trend,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  progress?: number;
  trend?: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold">
          {label}
        </p>
        <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center">
          <Icon className="size-4 text-brand" />
        </div>
      </div>
      <p className="mt-4 text-2xl font-bold">{value}</p>
      <p
        className={`mt-1 text-xs ${trend ? "text-success font-medium" : "text-muted-foreground"}`}
      >
        {hint}
      </p>
      {progress !== undefined && (
        <div className="mt-3 h-1 w-full bg-border rounded-full overflow-hidden">
          <div className="h-full bg-brand" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

function UsageBar({
  label,
  cur,
  max,
}: {
  label: string;
  cur: number;
  max: number;
}) {
  const pct = Math.round((cur / max) * 100);
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">
          {cur.toLocaleString()} / {max.toLocaleString()}
        </span>
      </div>
      <div className="mt-2 h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BarChart() {
  const data = [42, 65, 38, 80, 95, 60, 110];
  const max = Math.max(...data);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="flex items-end gap-3 h-44">
      {data.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-2">
          <div className="w-full bg-background rounded-md relative h-full flex items-end">
            <div
              className="w-full bg-gradient-to-t from-brand to-brand/40 rounded-md"
              style={{ height: `${(v / max) * 100}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground font-medium">
            {days[i]}
          </span>
        </div>
      ))}
    </div>
  );
}
