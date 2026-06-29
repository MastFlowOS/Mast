import { createFileRoute } from "@tanstack/react-router";
import {
  FileText,
  Plug,
  CalendarDays,
  CheckCircle2,
  ArrowUpCircle,
  RefreshCw,
  UserPlus,
  CreditCard,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useAccount } from "@/hooks/use-mast-api";
import { getPlan } from "@/lib/plans";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/billing")({
  head: () => ({ meta: [{ title: "Billing — Mast" }] }),
  component: Billing,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getRenewalLabel(
  renewalDate: string | null,
  isConnected: boolean
): string {
  if (renewalDate) return formatDate(renewalDate);
  if (!isConnected) return "Billing Not Connected";
  return "Not Available";
}

function getStatusBadge(status?: string) {
  const s = (status ?? "active").toLowerCase();
  switch (s) {
    case "trial":
      return { label: "Trial", className: "bg-blue-500/10 text-blue-400 border-blue-500/20" };
    case "cancelled":
      return { label: "Cancelled", className: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" };
    case "expired":
      return { label: "Expired", className: "bg-destructive/10 text-destructive border-destructive/20" };
    case "past_due":
      return { label: "Past Due", className: "bg-amber-500/10 text-amber-500 border-amber-500/20" };
    case "active":
    default:
      return { label: "Active", className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" };
  }
}

// ─── Plan benefits map ────────────────────────────────────────────────────────

const PLAN_BENEFITS: Record<string, string[]> = {
  free: [
    "10 leads / day",
    "300 leads / month",
    "Email + Website data",
    "CSV Export",
    "No AI personalization",
  ],
  starter: [
    "50 leads / day",
    "1,500 leads / month",
    "Relationship data layer",
    "Limited AI",
    "CSV Export",
  ],
  pro: [
    "200 leads / day",
    "6,000 leads / month",
    "Full pipeline workspace",
    "API Access",
    "Multi-region Search",
  ],
  premium: [
    "833 leads / day",
    "25,000 leads / month",
    "Premium Pool",
    "Full AI",
    "Team Access",
  ],
};

// ─── Activity Timeline helpers ────────────────────────────────────────────────

type TimelineEvent = {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  label: string;
  description: string;
  date: string | null;
};

function buildTimeline(
  account: ReturnType<typeof useAccount>["data"]
): TimelineEvent[] {
  if (!account) return [];

  const events: TimelineEvent[] = [];
  const subscriptionStartedAt =
    account.subscription.billingPeriodStartedAt ?? null;
  const planConfig = getPlan(account.subscription.plan);
  const price = account.subscription.priceMonthly;

  // 1. Account Created (always shown — no reliable createdAt from API)
  events.push({
    id: "account-created",
    icon: UserPlus,
    iconClass: "text-brand",
    label: "Account Created",
    description: `Welcome, ${account.user.fullName || account.user.email}. Your Mast account is active.`,
    date: null,
  });

  // 2. Subscription Created — shown when billing period start is known
  if (subscriptionStartedAt) {
    events.push({
      id: "subscription-created",
      icon: CheckCircle2,
      iconClass: "text-emerald-400",
      label: "Subscription Created",
      description: `${account.subscription.name} plan billing period started.`,
      date: subscriptionStartedAt,
    });
  }

  // 3. Plan Upgraded — only for paid plans
  if (account.subscription.plan !== "free" && subscriptionStartedAt) {
    const isUpgrade = price > 0;
    if (isUpgrade) {
      events.push({
        id: "plan-upgraded",
        icon: ArrowUpCircle,
        iconClass: "text-emerald-400",
        label: "Plan Upgraded",
        description: `Upgraded to ${planConfig.name} at $${price}/month.`,
        date: subscriptionStartedAt,
      });
    }
  }

  // 4. Current Plan Activated — always shown as the newest event
  events.push({
    id: "plan-activated",
    icon: Zap,
    iconClass: "text-brand",
    label: "Current Plan Activated",
    description: `${account.subscription.name} is your active plan${price > 0 ? ` · $${price}/month` : " · Free tier"}.`,
    // Place after any billing period event so it sorts to the top
    date: account.subscription.billingPeriodEndsAt
      ? new Date(
          new Date(account.subscription.billingPeriodEndsAt).getTime() - 1
        ).toISOString()
      : subscriptionStartedAt
        ? new Date(
            new Date(subscriptionStartedAt).getTime() + 1
          ).toISOString()
        : null,
  });

  // Sort: most recent first, null dates go to bottom
  return events.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

function Billing() {
  const { data: account, isLoading } = useAccount();

  const currentPlan = account?.subscription.plan ?? "free";
  const planConfig = getPlan(currentPlan);
  const planName = account?.subscription.name ?? planConfig.name;
  const price = account?.subscription.priceMonthly ?? planConfig.priceMonthly;
  const status = account?.subscription.status ?? "active";
  const renewalDate = account?.subscription.billingPeriodEndsAt ?? null;
  const badge = getStatusBadge(status);

  // Billing provider is not yet connected — this flag will flip when integrated
  const billingConnected = false;

  const renewalLabel = getRenewalLabel(renewalDate, billingConnected);
  const benefits = PLAN_BENEFITS[currentPlan] ?? PLAN_BENEFITS["free"];
  const timeline = buildTimeline(account);

  // Billing health: good standing when status is active/trial and no billing issues
  const isGoodStanding = ["active", "trial"].includes(status.toLowerCase());

  return (
    <div className="p-8 max-w-5xl space-y-8">
      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Subscription status, payment provider, and invoice history.
        </p>
      </div>

      {/* ── Billing Summary ── */}
      <section>
        <h2 className="text-base font-bold mb-3">Billing Summary</h2>
        <div className="bg-card border border-border rounded-2xl p-6">
          {isLoading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 w-40 bg-border rounded" />
              <div className="h-4 w-28 bg-border rounded" />
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* Current Plan */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">
                  Current Plan
                </span>
                <p className="font-bold text-lg leading-tight">{planName}</p>
              </div>

              {/* Monthly Price */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">
                  Monthly Price
                </span>
                <p className="font-bold text-lg leading-tight">
                  {price === 0 ? "Free" : `$${price} / mo`}
                </p>
              </div>

              {/* Status */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">
                  Status
                </span>
                <span
                  className={cn(
                    "inline-flex items-center px-2.5 py-0.5 text-[10px] rounded-full border font-bold uppercase tracking-wider",
                    badge.className
                  )}
                >
                  {badge.label}
                </span>
              </div>

              {/* Renewal Date — never bare dash */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">
                  Renewal Date
                </span>
                <p
                  className={cn(
                    "font-bold text-sm leading-tight flex items-center gap-1.5",
                    renewalDate ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  <CalendarDays className="size-4 shrink-0" />
                  {renewalLabel}
                </p>
              </div>
            </div>
          )}

          {/* ── Billing Health Indicator ── */}
          {!isLoading && (
            <div className="mt-6 pt-5 border-t border-border/60">
              <div
                className={cn(
                  "inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg border",
                  isGoodStanding
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                )}
              >
                <ShieldCheck className="size-3.5" />
                {isGoodStanding
                  ? "Account In Good Standing · No Outstanding Charges"
                  : "Account Requires Attention"}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Your Plan Includes ── */}
      <section>
        <h2 className="text-base font-bold mb-3">Your Plan Includes</h2>
        <div className="bg-card border border-border rounded-2xl p-6">
          {isLoading ? (
            <div className="animate-pulse space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-4 w-48 bg-border rounded" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {benefits.map((benefit) => (
                <div key={benefit} className="flex items-center gap-2.5">
                  <CheckCircle2 className="size-4 text-brand shrink-0" />
                  <span className="text-sm font-medium">{benefit}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Payment Provider ── */}
      <section>
        <h2 className="text-base font-bold mb-3">Payment Provider</h2>
        <div className="bg-card border border-border rounded-2xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
            {/* Provider info */}
            <div className="flex items-start gap-4">
              <div className="size-10 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
                <Plug className="size-5 text-brand" />
              </div>
              <div>
                <p className="font-bold text-sm">Billing Provider</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="size-1.5 rounded-full bg-zinc-500 inline-block" />
                  <span className="text-xs text-muted-foreground">
                    Not Connected
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Supported providers:{" "}
                  <span className="text-foreground font-medium">
                    Stripe · Paddle · PayPal
                  </span>
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Billing integration coming soon.
                </p>
              </div>
            </div>

            {/* Connect button — disabled until integration exists */}
            <div className="flex flex-col items-start sm:items-end gap-1.5 shrink-0">
              <button
                disabled
                id="billing-connect-btn"
                className="px-5 py-2 rounded-lg border border-border text-sm font-semibold bg-background/50 text-muted-foreground cursor-not-allowed transition-colors"
                title="Billing integration coming soon"
              >
                <CreditCard className="inline size-4 mr-2 -mt-0.5" />
                Connect Billing
              </button>
              <p className="text-[10px] text-muted-foreground/70">
                Integration not yet available.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Invoices ── */}
      <section>
        <h2 className="text-base font-bold mb-3">Invoices</h2>
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-border flex items-center justify-between">
            <h3 className="font-semibold text-sm">Invoice History</h3>
            <FileText className="size-4 text-muted-foreground" />
          </div>

          {/* Empty state */}
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="size-12 rounded-2xl bg-border/40 grid place-items-center mb-4">
              <FileText className="size-6 text-muted-foreground/60" />
            </div>
            <p className="font-semibold text-sm text-foreground">
              No invoices available.
            </p>
            <p className="text-xs text-muted-foreground mt-1.5 max-w-xs">
              Invoices will appear here after successful payments once a billing
              provider is connected.
            </p>
          </div>
        </div>
      </section>

      {/* ── Activity Timeline ── */}
      <section>
        <h2 className="text-base font-bold mb-3">Account Activity</h2>
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-border flex items-center justify-between">
            <h3 className="font-semibold text-sm">Timeline</h3>
            <RefreshCw className="size-4 text-muted-foreground" />
          </div>

          {isLoading ? (
            <div className="p-6 space-y-4 animate-pulse">
              {[1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <div className="size-8 rounded-full bg-border shrink-0" />
                  <div className="space-y-2 flex-1 pt-1">
                    <div className="h-3 w-32 bg-border rounded" />
                    <div className="h-3 w-56 bg-border rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : timeline.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                No account activity to display yet.
              </p>
            </div>
          ) : (
            <ol className="p-6 space-y-0">
              {timeline.map((event, i) => {
                const Icon = event.icon;
                const isLast = i === timeline.length - 1;
                return (
                  <li key={event.id} className="flex gap-4">
                    {/* Icon + connector line */}
                    <div className="flex flex-col items-center shrink-0">
                      <div
                        className={cn(
                          "size-8 rounded-full border grid place-items-center shrink-0",
                          "bg-background border-border"
                        )}
                      >
                        <Icon className={cn("size-4", event.iconClass)} />
                      </div>
                      {!isLast && (
                        <div className="w-px flex-1 bg-border/50 mt-1 mb-1 min-h-[24px]" />
                      )}
                    </div>

                    {/* Content */}
                    <div className={cn("pb-6", isLast && "pb-0")}>
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold">
                          {event.label}
                        </span>
                        {event.date && (
                          <span className="text-[10px] text-muted-foreground">
                            {formatDate(event.date)}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {event.description}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
