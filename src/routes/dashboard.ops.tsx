/**
 * Phase 7 — Lead Engine Operations Dashboard
 *
 * Internal engineering-only page at /dashboard/ops.
 * Gated by `user.internalRole IN ('engineer', 'admin')`.
 *
 * Sections:
 *   1. Live Operations  — currently running jobs, tasks, workers, queue depths
 *   2. Overview KPIs    — jobs today, avg runtime, time-to-first-lead, leads/min
 *   3. Worker Fleet     — per-worker concurrency, memory, active browsers
 *   4. Queue Monitor    — pg-boss queue state breakdown
 *   5. Performance      — time-series charts (recharts)
 *   6. Failure Analysis — failure category breakdown
 *   7. Job History      — recent completed runs
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Globe,
  Layers,
  Loader2,
  MonitorPlay,
  RefreshCcw,
  Server,
  TrendingUp,
  Users,
  Zap,
  XCircle,
  ChevronRight,
  Bug,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useMe, useOpsStats, useOpsHistory } from "@/hooks/use-mast-api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/ops")({
  head: () => ({
    meta: [{ title: "Ops Dashboard — Mast Engineering" }],
  }),
  component: OpsDashboard,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || ms === 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#22c55e",
  completed_partial: "#f59e0b",
  failed: "#ef4444",
  cancelled: "#6b7280",
  running: "#3b82f6",
};

const RANGE_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

// ── Components ───────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  color = "text-brand",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 flex flex-col gap-2 group hover:border-brand/40 transition-colors duration-300">
      <div className="absolute inset-0 bg-gradient-to-br from-brand/3 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center">
          <Icon className={cn("size-4", color)} />
        </div>
      </div>
      <p className={cn("text-3xl font-bold tracking-tight", color)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SectionHeader({ title, icon: Icon }: { title: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon className="size-4 text-brand" />
      <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">{title}</h2>
    </div>
  );
}

function LivePulse() {
  return (
    <span className="relative flex size-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full size-2 bg-emerald-500" />
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
      : status === "completed"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : status === "failed"
      ? "bg-red-500/10 text-red-400 border-red-500/20"
      : "bg-amber-500/10 text-amber-400 border-amber-500/20";
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border", color)}>
      {status}
    </span>
  );
}

function WorkerCard({ w }: { w: NonNullable<ReturnType<typeof useOpsStats>["data"]>["worker_utilization"]["browser_pool"][0] }) {
  const isStale = w.seconds_since_heartbeat > 90;
  const memPct = w.free_memory_mb > 0 ? Math.min(100, Math.round((w.active_browsers / Math.max(1, w.effective_concurrency)) * 100)) : 0;

  return (
    <div className={cn("rounded-xl border p-4 flex flex-col gap-3 text-sm", isStale ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card")}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("w-2 h-2 rounded-full", isStale ? "bg-amber-400" : "bg-emerald-400")} />
          <span className="font-mono text-xs text-foreground truncate max-w-[180px]" title={w.id}>{w.id}</span>
        </div>
        <span className="text-[10px] text-muted-foreground">{w.seconds_since_heartbeat}s ago</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-bold text-brand">{w.active_tasks}</p>
          <p className="text-[10px] text-muted-foreground">active tasks</p>
        </div>
        <div>
          <p className="text-lg font-bold text-blue-400">{w.active_browsers}</p>
          <p className="text-[10px] text-muted-foreground">browsers</p>
        </div>
        <div>
          <p className="text-lg font-bold text-purple-400">{w.free_memory_mb}MB</p>
          <p className="text-[10px] text-muted-foreground">free mem</p>
        </div>
      </div>
      <div>
        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
          <span>concurrency utilization</span>
          <span>{w.active_tasks}/{w.effective_concurrency}</span>
        </div>
        <div className="h-1.5 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-brand rounded-full transition-all duration-700"
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>
      <div className="flex gap-3 text-[10px] text-muted-foreground">
        <span>🚀 {w.browser_launches} launches</span>
        <span>💥 {w.browser_crashes} crashes</span>
        <span>🔄 {w.python_subprocess_restarts} restarts</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function OpsDashboard() {
  const navigate = useNavigate();
  const { data: me, isLoading: authLoading } = useMe();
  const user = me?.user ?? null;
  const [rangeHours, setRangeHours] = useState(24);

  const isAuthorized = user?.internalRole === "engineer" || user?.internalRole === "admin";
  const enabled = !authLoading && !!user && isAuthorized;

  const { data: stats, isLoading: statsLoading, error: statsError, refetch, dataUpdatedAt } = useOpsStats(rangeHours, enabled);
  const { data: history, isLoading: histLoading } = useOpsHistory(rangeHours, enabled);

  // Auth / role check redirect
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate({ to: "/login" });
      return;
    }
    if (!isAuthorized) {
      navigate({ to: "/dashboard" });
    }
  }, [authLoading, user, isAuthorized, navigate]);

  if (authLoading || !user) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="flex-1 flex items-center justify-center text-center p-8">
        <div>
          <AlertTriangle className="size-12 text-amber-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold mb-2">Access Restricted</h1>
          <p className="text-muted-foreground text-sm">This page requires an engineering or admin role.</p>
        </div>
      </div>
    );
  }

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;

  // Derive aggregated queue totals for the queue monitor
  const queueMap: Record<string, Record<string, number>> = {};
  stats?.queues?.forEach((q) => {
    if (!queueMap[q.name]) queueMap[q.name] = {};
    queueMap[q.name][q.state] = q.count;
  });

  // Performance chart data — downsample to max 60 points
  const perfPoints = stats?.performance ?? [];
  const step = Math.max(1, Math.floor(perfPoints.length / 60));
  const chartData = perfPoints
    .filter((_, i) => i % step === 0)
    .map((p) => ({
      time: new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      workers: p.active_workers,
      browsers: p.active_browsers,
      queueTotal: p.queue_depth_discovery + p.queue_depth_enrich + p.queue_depth_score,
      memMb: p.avg_free_memory_mb,
    }));

  // Runtime distribution for history
  const runtimeBuckets: Record<string, number> = {
    "<30s": 0, "30s-2m": 0, "2-5m": 0, "5-15m": 0, ">15m": 0,
  };
  history?.forEach((j) => {
    const ms = j.runtime_ms ?? 0;
    if (ms < 30_000) runtimeBuckets["<30s"]++;
    else if (ms < 120_000) runtimeBuckets["30s-2m"]++;
    else if (ms < 300_000) runtimeBuckets["2-5m"]++;
    else if (ms < 900_000) runtimeBuckets["5-15m"]++;
    else runtimeBuckets[">15m"]++;
  });
  const runtimeData = Object.entries(runtimeBuckets).map(([name, count]) => ({ name, count }));

  // Failure pie chart data
  const f = stats?.failures;
  const failureData = f
    ? [
        { name: "Browser Crashes", value: f.browser_crashes, color: "#ef4444" },
        { name: "Nav Timeouts", value: f.navigation_timeouts, color: "#f97316" },
        { name: "Unreachable Sites", value: f.unreachable_websites, color: "#eab308" },
        { name: "IG Unavailable", value: f.instagram_unavailables, color: "#8b5cf6" },
        { name: "Validation Fails", value: f.validation_failures, color: "#6b7280" },
        { name: "Cancellations", value: f.user_cancellations, color: "#3b82f6" },
      ].filter((d) => d.value > 0)
    : [];

  const totalFailures = failureData.reduce((s, d) => s + d.value, 0);

  const live = stats?.live;
  const workers = stats?.worker_utilization?.browser_pool ?? [];
  const runningJobs = live?.running_jobs ?? [];
  const runningTasks = live?.running_tasks ?? [];
  const runningProcessing = live?.running_processing_tasks ?? [];

  return (
    <div className="flex-1 overflow-y-auto bg-background text-foreground">
      {/* Header */}
      <div
        className="sticky top-0 z-20 border-b border-border backdrop-blur-xl px-6 py-4 flex items-center justify-between"
        style={{ background: "oklch(0.12 0.02 265 / 0.95)" }}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand/15 flex items-center justify-center">
            <Bug className="size-4 text-brand" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-foreground">Lead Engine Operations</h1>
            <p className="text-[11px] text-muted-foreground">
              Internal engineering dashboard
              {lastUpdated && <span className="ml-2">· Updated {lastUpdated}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Range selector */}
          <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRangeHours(opt.value)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-all duration-150",
                  rangeHours === opt.value
                    ? "bg-brand text-background shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="w-8 h-8 rounded-lg border border-border bg-card flex items-center justify-center hover:border-brand/40 transition-colors"
          >
            <RefreshCcw className={cn("size-3.5 text-muted-foreground", statsLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="p-6 space-y-8 max-w-[1600px] mx-auto">

        {/* ── Error banner ──────────────────────────────────────────────── */}
        {statsError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 flex items-center gap-3">
            <XCircle className="size-5 text-red-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-400">Failed to load ops data</p>
              <p className="text-xs text-muted-foreground">{(statsError as Error).message}</p>
            </div>
          </div>
        )}

        {/* ── SECTION 1: Live Operations ─────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <LivePulse />
            <SectionHeader title="Live Operations" icon={Activity} />
          </div>

          {/* Live metrics row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <p className="text-3xl font-bold text-blue-400">{runningJobs.length}</p>
              <p className="text-xs text-muted-foreground mt-1">Running Jobs</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <p className="text-3xl font-bold text-purple-400">{runningTasks.length}</p>
              <p className="text-xs text-muted-foreground mt-1">Discovery Tasks</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <p className="text-3xl font-bold text-amber-400">{runningProcessing.length}</p>
              <p className="text-xs text-muted-foreground mt-1">Processing Tasks</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 text-center">
              <p className="text-3xl font-bold text-emerald-400">
                {stats?.worker_utilization?.active_workers ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Active Workers</p>
            </div>
          </div>

          {/* Running jobs table */}
          {runningJobs.length > 0 && (
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="bg-card/60 border-b border-border px-4 py-2">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Running Discovery Jobs</span>
              </div>
              <div className="divide-y divide-border/50">
                {runningJobs.map((job) => (
                  <div key={job.id} className="px-4 py-3 flex items-center gap-4 hover:bg-brand/3 transition-colors">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{job.niche}</p>
                      <p className="text-xs text-muted-foreground">{job.region} · {job.user_email}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-bold text-emerald-400">{job.delivered_count}/{job.requested_count}</p>
                      <p className="text-[10px] text-muted-foreground">leads</p>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-bold text-blue-400">{elapsed(job.elapsed_seconds)}</p>
                      <p className="text-[10px] text-muted-foreground">elapsed</p>
                    </div>
                    <div className="w-32">
                      <div className="h-1.5 bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-400 rounded-full transition-all"
                          style={{ width: `${Math.min(100, (job.delivered_count / Math.max(1, job.requested_count)) * 100)}%` }}
                        />
                      </div>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {runningJobs.length === 0 && !statsLoading && (
            <div className="rounded-xl border border-dashed border-border/50 p-6 text-center">
              <p className="text-sm text-muted-foreground">No discovery jobs currently running</p>
            </div>
          )}
        </section>

        {/* ── SECTION 2: Overview KPIs ───────────────────────────────── */}
        <section>
          <SectionHeader title="Overview" icon={TrendingUp} />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              icon={Zap}
              label={`Jobs (${RANGE_OPTIONS.find(o => o.value === rangeHours)?.label ?? rangeHours + "h"})`}
              value={fmtNum(stats?.overview?.jobs_today)}
              sub="discovery plans started"
              color="text-brand"
            />
            <KpiCard
              icon={Clock}
              label="Avg Runtime"
              value={fmtMs(stats?.overview?.avg_runtime_ms)}
              sub="per completed job"
              color="text-blue-400"
            />
            <KpiCard
              icon={CheckCircle2}
              label="Time to First Lead"
              value={fmtMs(stats?.overview?.avg_time_to_first_lead_ms)}
              sub="avg across jobs"
              color="text-emerald-400"
            />
            <KpiCard
              icon={Activity}
              label="Leads / Minute"
              value={fmtNum(stats?.overview?.leads_per_minute, 2)}
              sub="rolling 2h window"
              color="text-purple-400"
            />
          </div>
        </section>

        {/* ── SECTION 3: Worker Fleet ────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <SectionHeader title="Worker Fleet" icon={Server} />
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span>🧠 {fmtNum(stats?.worker_utilization?.total_free_memory_mb)}MB free memory</span>
              <span>⚡ {fmtNum(stats?.worker_utilization?.total_concurrency_cap)} concurrency cap</span>
            </div>
          </div>
          {workers.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {workers.map((w) => <WorkerCard key={w.id} w={w} />)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/50 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {statsLoading ? "Loading workers…" : "No active workers (heartbeat within 5 minutes)"}
              </p>
            </div>
          )}
        </section>

        {/* ── SECTION 4: Queue Monitor ───────────────────────────────── */}
        <section>
          <SectionHeader title="Queue Depths" icon={Layers} />
          {Object.keys(queueMap).length > 0 ? (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card/60">
                    <th className="px-4 py-2 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">Queue</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">created</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">active</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">completed</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {Object.entries(queueMap).map(([name, states]) => (
                    <tr key={name} className="hover:bg-brand/3 transition-colors">
                      <td className="px-4 py-2 font-mono text-xs text-foreground">{name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(states["created"] ?? 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-blue-400 font-medium">{fmtNum(states["active"] ?? 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-400">{fmtNum(states["completed"] ?? 0)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-red-400">{fmtNum(states["failed"] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/50 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {statsLoading ? "Loading queue data…" : "Queue data unavailable (pgboss schema access required)"}
              </p>
            </div>
          )}
        </section>

        {/* ── SECTION 5: Performance Charts ─────────────────────────── */}
        <section>
          <SectionHeader title="Performance History" icon={TrendingUp} />
          {chartData.length > 0 ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Worker & Browser activity */}
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4">Workers & Browsers</p>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colWorkers" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colBrowsers" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} />
                    <Tooltip
                      contentStyle={{ background: "oklch(0.18 0.025 265)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                    <Area type="monotone" dataKey="workers" name="Active Workers" stroke="#6366f1" fill="url(#colWorkers)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="browsers" name="Active Browsers" stroke="#3b82f6" fill="url(#colBrowsers)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Queue depth */}
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4">Total Queue Depth</p>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colQueue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} />
                    <Tooltip
                      contentStyle={{ background: "oklch(0.18 0.025 265)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    <Area type="monotone" dataKey="queueTotal" name="Queue Depth" stroke="#f59e0b" fill="url(#colQueue)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/50 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {statsLoading ? "Loading performance data…" : "No snapshot data yet — the worker records a snapshot every minute."}
              </p>
            </div>
          )}
        </section>

        {/* ── SECTION 6: Failure Analysis ─────────────────────────────── */}
        <section>
          <SectionHeader title="Failure Analysis" icon={AlertTriangle} />
          {totalFailures > 0 || (f && (f.failed_jobs_count > 0 || f.cancelled_jobs_count > 0)) ? (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              {/* Pie chart */}
              <div className="rounded-xl border border-border bg-card p-5 flex flex-col items-center">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4 self-start">Failure Breakdown</p>
                {totalFailures > 0 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={failureData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value">
                        {failureData.map((entry, index) => (
                          <Cell key={index} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: "oklch(0.18 0.025 265)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <p className="text-sm text-muted-foreground">No failures recorded</p>
                  </div>
                )}
                <div className="w-full space-y-1 mt-2">
                  {failureData.map((d) => (
                    <div key={d.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
                        <span className="text-muted-foreground">{d.name}</span>
                      </div>
                      <span className="font-bold tabular-nums" style={{ color: d.color }}>{d.value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Job outcome summary */}
              <div className="xl:col-span-2 rounded-xl border border-border bg-card p-5">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-4">Job Outcomes</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3 text-center">
                    <p className="text-2xl font-bold text-red-400">{fmtNum(f?.failed_jobs_count)}</p>
                    <p className="text-xs text-muted-foreground mt-1">Failed Jobs</p>
                  </div>
                  <div className="rounded-lg bg-zinc-500/5 border border-zinc-500/20 p-3 text-center">
                    <p className="text-2xl font-bold text-zinc-400">{fmtNum(f?.cancelled_jobs_count)}</p>
                    <p className="text-xs text-muted-foreground mt-1">Cancelled Jobs</p>
                  </div>
                </div>
                {/* Runtime distribution */}
                {runtimeData.some((d) => d.count > 0) && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold text-muted-foreground mb-3">Runtime Distribution</p>
                    <ResponsiveContainer width="100%" height={120}>
                      <BarChart data={runtimeData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#64748b" }} />
                        <YAxis tick={{ fontSize: 10, fill: "#64748b" }} />
                        <Tooltip
                          contentStyle={{ background: "oklch(0.18 0.025 265)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                        />
                        <Bar dataKey="count" name="Jobs" fill="#6366f1" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/50 p-8 text-center">
              {statsLoading ? (
                <p className="text-sm text-muted-foreground">Loading failure data…</p>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle2 className="size-8 text-emerald-400" />
                  <p className="text-sm font-medium text-emerald-400">No failures in this time window</p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── SECTION 7: Job History ────────────────────────────────── */}
        <section>
          <SectionHeader title="Job History" icon={Globe} />
          {history && history.length > 0 ? (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-card/60">
                    <th className="px-4 py-2 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider">Started</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">Requested</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">Delivered</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">Runtime</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">1st Lead</th>
                    <th className="px-4 py-2 text-right text-xs font-bold text-muted-foreground uppercase tracking-wider">Discovered</th>
                    <th className="px-4 py-2 text-center text-xs font-bold text-muted-foreground uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {history.slice(0, 50).map((j) => (
                    <tr key={j.id} className="hover:bg-brand/3 transition-colors">
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {new Date(j.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{j.requested_count}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-emerald-400 font-medium">{j.delivered_count}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtMs(j.runtime_ms)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtMs(j.time_to_first_lead_ms)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(j.businesses_discovered)}</td>
                      <td className="px-4 py-2 text-center">
                        <StatusBadge status={j.completion_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {history.length > 50 && (
                <div className="px-4 py-3 border-t border-border/50 text-center">
                  <p className="text-xs text-muted-foreground">Showing 50 of {history.length} runs</p>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/50 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {histLoading ? "Loading job history…" : "No job history yet in this time window."}
              </p>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
