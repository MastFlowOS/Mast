import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "@/components/mast/SiteNav";
import { SiteFooter } from "@/components/mast/SiteFooter";
import { CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "System Status — Mast" },
      { name: "description", content: "Mast platform operational status" },
    ],
  }),
  component: StatusPage,
});

const services = [
  { name: "API & Lead Generation", status: "operational" as const },
  { name: "Relationship Data & Focus", status: "operational" as const },
  { name: "Authentication", status: "operational" as const },
  { name: "Google Sheets Sync", status: "operational" as const },
  { name: "Email Enrichment", status: "operational" as const },
  { name: "Instagram Enrichment", status: "operational" as const },
];

const statusConfig = {
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
} as const;

function StatusPage() {
  const allOperational = services.every((s) => s.status === "operational");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />

      {/* Hero */}
      <section className="relative pt-24 pb-14 px-6 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.12] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_65%)]" />
        <div className="relative max-w-3xl mx-auto">
          <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold tracking-tight text-foreground">
            System Status
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Real-time operational status for all Mast services.
          </p>
        </div>
      </section>

      {/* Status content */}
      <section className="px-6 pb-24">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Overall banner */}
          <div
            className={`flex items-center gap-3 p-5 rounded-2xl border ${
              allOperational
                ? "bg-success/5 border-success/20 text-success"
                : "bg-warning/5 border-warning/20 text-warning"
            }`}
          >
            <CheckCircle2 className="size-5 shrink-0" />
            <div>
              <p className="text-sm font-semibold">
                {allOperational ? "All systems operational" : "Some systems are experiencing issues"}
              </p>
              <p className="text-xs opacity-70 mt-0.5">
                Last checked: {new Date().toLocaleString()}
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
                  className={`flex items-center justify-between px-5 py-4 ${
                    i < services.length - 1 ? "border-b border-border/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`size-2 rounded-full ${cfg.dot}`} />
                    <span className="text-sm font-medium text-foreground">{service.name}</span>
                  </div>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border ${cfg.badge}`}
                  >
                    {cfg.label}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground/60 pt-2">
            This is a placeholder status page. For incident notifications, sign up for updates at status@mast.so.
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
