import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { getBackendBaseUrl } from "@/lib/api";

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "System Status — Mast" },
      { name: "description", content: "Mast platform operational status" },
    ],
  }),
  component: StatusPage,
});

type ServiceStatus = "operational" | "degraded" | "outage" | "checking";

interface ServiceItem {
  name: string;
  detail: string;
  status: ServiceStatus;
}

interface HealthResponse {
  ok?: boolean;
  timestamp?: string;
  checks?: {
    api?: boolean;
    database?: boolean;
    aiConfigured?: boolean;
    inboxCryptoConfigured?: boolean;
  };
}

const statusConfig: Record<ServiceStatus, { label: string; dot: string; badge: string }> = {
  operational: {
    label: "Operational",
    dot: "bg-success",
    badge: "bg-success/10 text-success border-success/20",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-warning",
    badge: "bg-warning/10 text-warning border-warning/20",
  },
  outage: {
    label: "Outage",
    dot: "bg-destructive",
    badge: "bg-destructive/10 text-destructive border-destructive/20",
  },
  checking: {
    label: "Checking",
    dot: "bg-muted-foreground animate-pulse",
    badge: "bg-muted/40 text-muted-foreground border-border/60",
  },
};

function buildServices(health: HealthResponse | null, errorMsg: string | null, loading: boolean): ServiceItem[] {
  if (loading && !health) {
    return [
      { name: "API Gateway & Lead Discovery", detail: "Checking backend health...", status: "checking" },
      { name: "Database, CRM & Authentication", detail: "Checking Postgres connectivity...", status: "checking" },
      { name: "AI Outreach & Intelligence", detail: "Checking AI provider status...", status: "checking" },
      { name: "Reply Observation & Notifications", detail: "Checking inbox & realtime pipeline...", status: "checking" },
    ];
  }

  if (errorMsg || !health) {
    return [
      {
        name: "API Gateway & Lead Discovery",
        detail: errorMsg || "Gateway unreachable",
        status: "outage",
      },
      {
        name: "Database, CRM & Authentication",
        detail: "Cannot verify while gateway is unreachable",
        status: "degraded",
      },
      {
        name: "AI Outreach & Intelligence",
        detail: "Cannot verify while gateway is unreachable",
        status: "degraded",
      },
      {
        name: "Reply Observation & Notifications",
        detail: "Cannot verify while gateway is unreachable",
        status: "degraded",
      },
    ];
  }

  const checks = health.checks ?? {};
  const apiUp = checks.api ?? true;
  const dbUp = checks.database ?? Boolean(health.ok);
  const aiUp = checks.aiConfigured ?? false;
  const inboxUp = dbUp && (checks.inboxCryptoConfigured ?? false);

  return [
    {
      name: "API Gateway & Lead Discovery",
      detail: apiUp ? "Express gateway responding normally" : "Gateway error",
      status: apiUp ? "operational" : "outage",
    },
    {
      name: "Database, CRM & Authentication",
      detail: dbUp ? "Supabase Postgres queries responding" : "Database connection check failed",
      status: dbUp ? "operational" : "outage",
    },
    {
      name: "AI Outreach & Intelligence",
      detail: aiUp ? "AI provider configured and ready" : "AI provider key not configured on this server",
      status: aiUp ? "operational" : "degraded",
    },
    {
      name: "Reply Observation & Notifications",
      detail: inboxUp
        ? "IMAP encryption & notification pipeline ready"
        : dbUp
          ? "SMTP/IMAP encryption key not configured"
          : "Waiting on database connectivity",
      status: inboxUp ? "operational" : "degraded",
    },
  ];
}

function StatusPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const baseUrl = getBackendBaseUrl()?.replace(/\/+$/, "") || "";
    const endpoint = baseUrl ? `${baseUrl}/health` : "/health";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(endpoint, { signal: controller.signal });
      clearTimeout(timer);
      const data = (await res.json().catch(() => null)) as HealthResponse | null;
      if (!data) {
        throw new Error(`Unexpected response (HTTP ${res.status})`);
      }
      setHealth(data);
      setLastChecked(data.timestamp ? new Date(data.timestamp).toLocaleString() : new Date().toLocaleString());
    } catch (err) {
      setHealth(null);
      setErrorMsg(err instanceof Error ? err.message : "Could not reach Mast API");
      setLastChecked(new Date().toLocaleString());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const services = buildServices(health, errorMsg, loading);
  const hasOutage = services.some((s) => s.status === "outage");
  const hasDegraded = services.some((s) => s.status === "degraded");
  const allOperational = !loading && services.every((s) => s.status === "operational");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />

      {/* Hero */}
      <section className="relative pt-24 pb-14 px-6 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.12] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />
        <div className="relative max-w-3xl mx-auto flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold tracking-tight text-foreground">
              System Status
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Live operational checks from the Mast API gateway and database.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-border/70 bg-card hover:bg-muted text-xs font-semibold text-foreground transition-colors disabled:opacity-60 self-start sm:self-auto"
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </button>
        </div>
      </section>

      {/* Status content */}
      <section className="px-6 pb-24">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Overall banner */}
          <div
            className={`flex items-center gap-3 p-5 rounded-2xl border ${
              loading && !health
                ? "bg-muted/20 border-border/60 text-muted-foreground"
                : hasOutage
                  ? "bg-destructive/5 border-destructive/20 text-destructive"
                  : allOperational
                    ? "bg-success/5 border-success/20 text-success"
                    : "bg-warning/5 border-warning/20 text-warning"
            }`}
          >
            {loading && !health ? (
              <Loader2 className="size-5 shrink-0 animate-spin" />
            ) : hasOutage ? (
              <XCircle className="size-5 shrink-0" />
            ) : hasDegraded ? (
              <AlertTriangle className="size-5 shrink-0" />
            ) : (
              <CheckCircle2 className="size-5 shrink-0" />
            )}
            <div>
              <p className="text-sm font-semibold">
                {loading && !health
                  ? "Checking live system status..."
                  : hasOutage
                    ? "System disruption detected"
                    : hasDegraded
                      ? "Core systems operational — optional services degraded"
                      : "All systems operational"}
              </p>
              <p className="text-xs opacity-70 mt-0.5">
                Last checked: {lastChecked ?? "Checking..."}
              </p>
            </div>
          </div>

          {/* Service list */}
          <div className="bg-card border border-border/60 rounded-2xl overflow-hidden">
            {services.map((service, i) => {
              const cfg = statusConfig[service.status];
              return (
                <div
                  key={service.name}
                  className={`flex items-center justify-between gap-4 px-5 py-4 ${
                    i < services.length - 1 ? "border-b border-border/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`size-2 rounded-full shrink-0 ${cfg.dot}`} />
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-foreground block">{service.name}</span>
                      <span className="text-xs text-muted-foreground block truncate">{service.detail}</span>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border shrink-0 ${cfg.badge}`}
                  >
                    {cfg.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
