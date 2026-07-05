import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { useState } from "react";
import { addNotification } from "@/lib/notifications";
import {
  CheckCircle2,
  Sun,
  Calendar,
  Clock,
  AlertTriangle,
  Bot,
  Zap,
  Mail,
  Phone,
  Instagram,
  Globe2,
  Check,
  X,
  XCircle,
  CreditCard,
  Lock,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import { PLANS, getPlan, type PlanId, type PlanConfig } from "@/lib/plans";
import { useAccount, useChangePlan, useLeads } from "@/hooks/use-mast-api";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard/subscription")({
  head: () => ({ meta: [{ title: "Subscription — Mast" }] }),
  component: Subscription,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format ISO timestamp as "Xh Ym" or "X days" remaining */
function formatTimeUntil(iso?: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "soon";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) {
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

/** Map subscription status to style badges */
function getStatusBadge(status?: string) {
  const normalized = (status ?? "active").toLowerCase();
  switch (normalized) {
    case "trial":
      return {
        label: "Trial",
        className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
      };
    case "expired":
      return {
        label: "Expired",
        className: "bg-destructive/10 text-destructive border-destructive/20",
      };
    case "past_due":
      return {
        label: "Past Due",
        className: "bg-amber-500/10 text-amber-500 border-amber-500/20",
      };
    case "active":
    default:
      return {
        label: "Active",
        className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
      };
  }
}

/** Map features unlocked or lost during plan change */
function getPlanImpact(currentPlan: PlanId, targetPlan: PlanId): {
  type: "upgrade" | "downgrade" | "change";
  features: string[];
} {
  const currentPlanConfig = getPlan(currentPlan);
  const targetPlanConfig = getPlan(targetPlan);

  const isUpgrade = targetPlanConfig.priceMonthly > currentPlanConfig.priceMonthly;
  const isDowngrade = targetPlanConfig.priceMonthly < currentPlanConfig.priceMonthly;

  if (isUpgrade) {
    let features: string[] = [];
    if (targetPlan === "starter") {
      features = [
        "Mission Follow-ups to track interactions",
        "More daily opportunities (100 Opportunities / Day cap)",
        "AI Discovery Recommendations",
        "Instagram Profiles",
        "Regional Search",
      ];
    } else if (targetPlan === "pro") {
      features = [
        "Full Pipeline workspace",
        "Business Websites",
        "AI Pipeline Coaching & Recommendations",
        "Higher discovery limits (400 Opportunities / Day cap)",
        "3 Team Seats",
      ];
    } else if (targetPlan === "premium") {
      features = [
        "AI Executive Briefings",
        "Weekly Intelligence",
        "AI Opportunity Insights",
        "Unlimited Team Seats",
        "Highest discovery limits (1,000 Opportunities / Day cap)",
      ];
    }
    return { type: "upgrade", features };
  } else if (isDowngrade) {
    let features: string[] = [];
    if (targetPlan === "free") {
      features = [
        "Mission Follow-ups",
        "Instagram Profiles",
        "AI Discovery Recommendations",
        "Regional Search",
        "Daily opportunity discovery above 20 Opportunities / Day",
      ];
    } else if (targetPlan === "starter") {
      features = [
        "Full Pipeline workspace",
        "Business Websites",
        "AI Pipeline Coaching & Recommendations",
        "High daily caps (above 100 Opportunities / Day)",
        "Additional team seats (reduces to 1 Team Seat)",
      ];
    } else if (targetPlan === "pro") {
      features = [
        "AI Executive Briefings",
        "Weekly Intelligence",
        "AI Opportunity Insights",
        "Unlimited Team Seats (reduces to 3 Team Seats)",
      ];
    }
    return { type: "downgrade", features };
  }

  return { type: "change", features: [] };
}

// ─── Component ────────────────────────────────────────────────────────────────

function Subscription() {
  const { data: account } = useAccount();
  const { data: leadsPayload } = useLeads({ limit: 1000 });
  const changePlan = useChangePlan();

  const [previewPlanId, setPreviewPlanId] = useState<PlanId | null>(null);

  const currentPlan = account?.subscription.plan ?? "free";
  const planConfig = getPlan(currentPlan);
  const currentPlanName = account?.subscription.name ?? planConfig.name;
  const price = account?.subscription.priceMonthly ?? planConfig.priceMonthly;
  const subscriptionStatus = account?.subscription.status ?? "active";

  // Daily usage
  const dailyLimit = planConfig.dailyLeadLimit;
  const dailyUsed = account?.dailyUsage?.used ?? 0;
  const dailyRemaining = account?.dailyUsage?.remaining ?? Math.max(0, dailyLimit - dailyUsed);
  const dailyResetsAt = account?.dailyUsage?.resetsAt;
  const dailyPct = dailyLimit > 0 ? Math.min(100, Math.round((dailyUsed / dailyLimit) * 100)) : 0;
  const dailyAtLimit = dailyUsed >= dailyLimit;

  // Monthly usage
  const monthlyLimit = planConfig.monthlyLeadLimit;
  const monthlyUsed = account?.monthlyUsage?.used ?? account?.credits.used ?? 0;
  const monthlyRemaining = account?.monthlyUsage?.remaining ?? account?.credits.remaining ?? 0;
  const monthlyResetsAt = account?.monthlyUsage?.resetsAt ?? account?.subscription.billingPeriodEndsAt;
  const monthlyPct = monthlyLimit > 0 ? Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100)) : 0;
  const monthlyAtLimit = monthlyUsed >= monthlyLimit;

  // Normalized leads list
  const leads = Array.isArray(leadsPayload) ? leadsPayload : leadsPayload?.leads ?? [];
  const emailLeadsCount = leads.filter((l) => !!l.email).length;
  const phoneLeadsCount = leads.filter((l) => !!l.phone).length;
  const igLeadsCount = leads.filter((l) => !!l.instagramHandle).length;
  const websiteLeadsCount = leads.filter((l) => !!l.website).length;

  // Daily Reset Timer fallback (time until tomorrow 00:00:00 UTC)
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  const fallbackResetsAt = tomorrow.toISOString();
  const resetTimerString = formatTimeUntil(dailyResetsAt ?? fallbackResetsAt);

  // Monthly Reset Date
  const monthlyResetString = monthlyResetsAt
    ? new Date(monthlyResetsAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : new Date(Date.now() + 30 * 24 * 3600 * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

  const badge = getStatusBadge(subscriptionStatus);

  const selectPlan = (plan: PlanId) => {
    if (plan === currentPlan) return;
    setPreviewPlanId(plan);
  };

  const handleConfirmPlanChange = async () => {
    if (!previewPlanId) return;
    const targetId = previewPlanId;
    setPreviewPlanId(null);
    try {
      await changePlan.mutateAsync(targetId);
      toast.success("Plan updated successfully");
      
      addNotification({
        icon: "ArrowUpCircle",
        iconColor: "text-brand",
        iconBg: "bg-brand/10 border-brand/20",
        title: "Plan Upgraded",
        body: `Your workspace has been successfully migrated to the ${targetId.toUpperCase()} plan.`,
        category: "notifyPlanChanges",
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not update plan"
      );
    }
  };

  const previewPlan = PLANS.find((p) => p.id === previewPlanId);
  const impact = previewPlanId ? getPlanImpact(currentPlan, previewPlanId) : null;

  return (
    <div className="p-8 max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Subscription</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your plan, billing details, and daily usage.
        </p>
      </div>

      {/* ── Current Plan & Payment Method Grid ────────────────────── */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Subscription Info Card */}
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
              <div>
                <span className="text-xs font-bold text-brand uppercase tracking-widest block">
                  Current Plan
                </span>
                <div className="flex items-center gap-3 mt-1.5">
                  <p className="text-3xl font-bold">{currentPlanName}</p>
                  <span
                    className={cn(
                      "px-2.5 py-0.5 text-[10px] rounded-full border font-bold uppercase tracking-wider",
                      badge.className
                    )}
                  >
                    {badge.label}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  ${price}/month · Next billing reset on {monthlyResetString}
                </p>
              </div>
              <div className="text-left md:text-right">
                <button
                  disabled
                  className="px-4 py-2 rounded-lg border border-border text-xs font-semibold bg-background/50 text-muted-foreground cursor-not-allowed transition-colors"
                >
                  Cancel Plan
                </button>
                <p className="text-[10px] text-muted-foreground/70 mt-1.5 md:ml-auto max-w-[220px]">
                  Cancellation will become available once billing is connected.
                </p>
              </div>
            </div>

            {/* Usage cards inside Current Plan summary */}
            <div className="grid md:grid-cols-2 gap-4 mt-6">
              <UsageCard
                icon={Sun}
                title="Today's opportunities"
                used={dailyUsed}
                limit={dailyLimit}
                remaining={dailyRemaining}
                pct={dailyPct}
                atLimit={dailyAtLimit}
                resetLabel={`Daily Reset: ${resetTimerString}`}
                primary
              />

              <UsageCard
                icon={Calendar}
                title="This month's opportunities"
                used={monthlyUsed}
                limit={monthlyLimit}
                remaining={monthlyRemaining}
                pct={monthlyPct}
                atLimit={monthlyAtLimit}
                resetLabel={`Monthly Reset: ${monthlyResetString}`}
                warn={monthlyPct >= 80 && !monthlyAtLimit}
              />
            </div>
          </div>
        </div>

        {/* Payment Method Card */}
        <div className="lg:col-span-1 bg-card border border-border rounded-2xl p-6 flex flex-col justify-between">
          <div className="space-y-4">
            <h2 className="font-bold text-base flex items-center gap-2">
              <CreditCard className="size-4.5 text-brand shrink-0" />
              Payment Method
            </h2>


            {currentPlan === "free" ? (
              <div className="rounded-xl border border-border/80 bg-background/30 p-6 text-center flex flex-col justify-center items-center h-[170px]">
                <Lock className="size-6 text-muted-foreground/60 mb-2 shrink-0" />
                <p className="text-sm font-semibold text-muted-foreground">
                  No payment method connected
                </p>
                <p className="text-[10px] text-muted-foreground/70 mt-1 max-w-[180px]">
                  Upgrade to a paid plan to connect a billing method.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-xl border border-border bg-background/50">
                  <div className="flex items-center gap-3">
                    <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
                      <CreditCard className="size-4.5 text-brand shrink-0" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-semibold">Visa ending in 4242</p>
                        <span className="text-[8px] font-bold bg-emerald-500/10 text-emerald-400 px-1 py-0.25 rounded border border-emerald-500/20 uppercase tracking-wider">
                          Primary
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">Expires 12 / 2027</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-[11px] bg-background/30 rounded-xl p-3 border border-border/50">
                  <div>
                    <span className="text-muted-foreground block text-[9px] uppercase font-bold tracking-wider">
                      Billing Status
                    </span>
                    <span className="font-semibold text-foreground mt-0.5 block capitalize">
                      {subscriptionStatus}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-[9px] uppercase font-bold tracking-wider">
                      Next Invoice
                    </span>
                    <span className="font-semibold text-foreground mt-0.5 block">
                      {monthlyResetString}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {currentPlan !== "free" && (
            <button className="mt-4 w-full py-2 rounded-lg border border-border bg-background/80 hover:bg-card text-xs font-semibold transition-colors cursor-pointer">
              Update Billing Details
            </button>
          )}
        </div>
      </div>

      {/* ── Plan Grid ───────────────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-bold">Change plan</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Select a plan that fits your opportunity discovery volume and workflow.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLANS.map((p) => {
          const current = p.id === currentPlan;
          return (
            <PlanCard
              key={p.id}
              plan={p}
              current={current}
              onSelect={() => selectPlan(p.id)}
              isPending={changePlan.isPending}
              currentPlan={currentPlan}
            />
          );
        })}
      </div>

      {/* ── Usage Breakdown Section ────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-bold">Usage by Contact Channel</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Opportunity volume breakdown categorized by available contact channel.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <ChannelUsageCard
          label="Email Opportunities"
          count={emailLeadsCount}
          color="bg-sky-500"
          icon={Mail}
        />
        <ChannelUsageCard
          label="Phone Opportunities"
          count={phoneLeadsCount}
          color="bg-purple-500"
          icon={Phone}
        />
        <ChannelUsageCard
          label="Instagram Opportunities"
          count={igLeadsCount}
          color="bg-pink-500"
          icon={Instagram}
        />
        <ChannelUsageCard
          label="Website Opportunities"
          count={websiteLeadsCount}
          color="bg-teal-500"
          icon={Globe2}
        />
      </div>

      {/* ── Why Users Upgrade Section ────────────────────────────── */}
      <div className="bg-card border border-border rounded-2xl p-6">
        <h2 className="text-lg font-bold text-center mb-6">Why Users Upgrade</h2>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="p-4 rounded-xl border border-border bg-background/30">
            <h3 className="font-bold text-sm text-brand mb-2">Why Upgrade to Starter</h3>
            <ul className="space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Mission Follow-ups
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Instagram Profiles
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> AI Discovery Recommendations
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Regional Search
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> 100 Opportunities / Day (1,500 / Month)
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> 1 Team Seat
              </li>
            </ul>
          </div>

          <div className="p-4 rounded-xl border border-border bg-background/30">
            <h3 className="font-bold text-sm text-brand mb-2">Why Upgrade to Pro</h3>
            <ul className="space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Pipeline
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Business Websites
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> AI Pipeline Coaching & Recommendations
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> 3 Team Seats
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> 400 Opportunities / Day (6,000 / Month)
              </li>
            </ul>
          </div>

          <div className="p-4 rounded-xl border border-border bg-background/30">
            <h3 className="font-bold text-sm text-brand mb-2">Why Upgrade to Premium</h3>
            <ul className="space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> AI Executive Briefings
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Weekly Intelligence
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> AI Opportunity Insights
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> Unlimited Team Seats
              </li>
              <li className="flex items-start gap-1.5">
                <span className="text-brand font-bold shrink-0">✓</span> 1,000 Opportunities / Day (25,000 / Month)
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── Plan Comparison Tool ────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-bold">Compare Plans</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Detailed comparison of features, channels, limits, and capabilities across all plans.
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-background/50">
              <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                Feature
              </th>
              {PLANS.map((p) => (
                <th key={p.id} className="p-4 font-bold text-foreground text-sm">
                  <div className="flex items-center gap-1.5">
                    {p.name}
                    {p.id === currentPlan && (
                      <span className="text-[9px] font-bold bg-brand/10 text-brand px-1.5 py-0.5 rounded border border-brand/20 uppercase tracking-wider">
                        Current
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {/* Daily Limit */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase flex items-center gap-1.5">
                <Sun className="size-3.5 shrink-0" /> Daily Limit
              </td>
              <td className="p-4 text-foreground font-semibold">20 / Day</td>
              <td className="p-4 text-foreground font-semibold">100 / Day</td>
              <td className="p-4 text-foreground font-semibold">400 / Day</td>
              <td className="p-4 text-foreground font-semibold">1,000 / Day</td>
            </tr>
            {/* Monthly Limit */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase flex items-center gap-1.5">
                <Calendar className="size-3.5 shrink-0" /> Monthly Limit
              </td>
              <td className="p-4 text-foreground/80">300 / Month</td>
              <td className="p-4 text-foreground/80">1,500 / Month</td>
              <td className="p-4 text-foreground/80">6,000 / Month</td>
              <td className="p-4 text-foreground/80">25,000 / Month</td>
            </tr>
            {/* Search Coverage */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase">
                Search Coverage
              </td>
              <td className="p-4 text-foreground/80">Local</td>
              <td className="p-4 text-foreground/80">Regional</td>
              <td className="p-4 text-foreground/80">Regional</td>
              <td className="p-4 text-foreground/80">Regional</td>
            </tr>
            {/* Contact Channels — icon-based */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase">
                Contact Channels
              </td>
              {/* Free: Email + Phone */}
              <td className="p-4">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 text-sky-400" title="Business Email" />
                  <Phone className="size-4 text-purple-400" title="Business Phone" />
                </span>
              </td>
              {/* Starter: + Instagram */}
              <td className="p-4">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 text-sky-400" title="Business Email" />
                  <Phone className="size-4 text-purple-400" title="Business Phone" />
                  <Instagram className="size-4 text-pink-400" title="Instagram Profile" />
                </span>
              </td>
              {/* Pro: + Website */}
              <td className="p-4">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 text-sky-400" title="Business Email" />
                  <Phone className="size-4 text-purple-400" title="Business Phone" />
                  <Instagram className="size-4 text-pink-400" title="Instagram Profile" />
                  <Globe2 className="size-4 text-teal-400" title="Business Website" />
                </span>
              </td>
              {/* Premium: all */}
              <td className="p-4">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 text-sky-400" title="Business Email" />
                  <Phone className="size-4 text-purple-400" title="Business Phone" />
                  <Instagram className="size-4 text-pink-400" title="Instagram Profile" />
                  <Globe2 className="size-4 text-teal-400" title="Business Website" />
                </span>
              </td>
            </tr>
            {/* AI Features */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase flex items-center gap-1.5">
                <Bot className="size-3.5 shrink-0" /> AI Features
              </td>
              {/* Free */}
              <td className="p-4">
                <ul className="space-y-1">
                  {["AI Discovery", "AI Message Templates"].map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-foreground/80">
                      <Bot className="size-3 shrink-0 text-brand/60" />{f}
                    </li>
                  ))}
                </ul>
              </td>
              {/* Starter */}
              <td className="p-4">
                <ul className="space-y-1">
                  {["AI Discovery", "AI Recommendations"].map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-foreground/80">
                      <Bot className="size-3 shrink-0 text-brand/60" />{f}
                    </li>
                  ))}
                </ul>
              </td>
              {/* Pro */}
              <td className="p-4">
                <ul className="space-y-1">
                  {["AI Pipeline Coaching"].map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-foreground/80">
                      <Bot className="size-3 shrink-0 text-brand/60" />{f}
                    </li>
                  ))}
                </ul>
              </td>
              {/* Premium */}
              <td className="p-4">
                <ul className="space-y-1">
                  {["Executive Briefings", "Weekly Intelligence", "Opportunity Insights"].map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-foreground/80">
                      <Bot className="size-3 shrink-0 text-brand/60" />{f}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
            {/* Relationships */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase">
                Relationships
              </td>
              <td className="p-4 text-foreground/80">✔</td>
              <td className="p-4 text-foreground/80">✔</td>
              <td className="p-4 text-foreground/80">✔ + Pipeline</td>
              <td className="p-4 text-foreground/80">✔ + Pipeline</td>
            </tr>
            {/* Mission Follow-ups */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase">
                Mission Follow-ups
              </td>
              <td className="p-4"><XCircle className="size-4 text-border" /></td>
              <td className="p-4"><CheckCircle2 className="size-4 text-emerald-400" /></td>
              <td className="p-4"><CheckCircle2 className="size-4 text-emerald-400" /></td>
              <td className="p-4"><CheckCircle2 className="size-4 text-emerald-400" /></td>
            </tr>
            {/* Import / Export */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase">
                Import / Export
              </td>
              <td className="p-4 text-foreground/80">CSV</td>
              <td className="p-4 text-foreground/80">CSV</td>
              <td className="p-4 text-foreground/80">CSV</td>
              <td className="p-4 text-foreground/80">CSV</td>
            </tr>
            {/* Team Seats */}
            <tr className="hover:bg-background/20 transition-colors">
              <td className="p-4 font-semibold text-muted-foreground text-xs uppercase">
                Team Seats
              </td>
              <td className="p-4 text-foreground/80">1 Seat</td>
              <td className="p-4 text-foreground/80">1 Seat</td>
              <td className="p-4 text-foreground/80">3 Seats</td>
              <td className="p-4 text-foreground/80">Unlimited</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Impact Confirmation Dialog ───────────────────────────── */}
      <Dialog
        open={previewPlanId !== null}
        onOpenChange={(open) => !open && setPreviewPlanId(null)}
      >
        <DialogContent className="max-w-md border border-border bg-card text-foreground rounded-2xl shadow-elevated">
          {previewPlanId && (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl font-bold tracking-tight">
                  {impact?.type === "upgrade"
                    ? `Upgrade to ${previewPlan?.name}?`
                    : impact?.type === "downgrade"
                      ? `Downgrade to ${previewPlan?.name}?`
                      : `Switch to ${previewPlan?.name}?`}
                </DialogTitle>
                <DialogDescription className="text-sm text-muted-foreground mt-1.5">
                  {impact?.type === "upgrade"
                    ? "You will unlock the following capabilities:"
                    : impact?.type === "downgrade"
                      ? "You will lose access to the following capabilities:"
                      : `Do you want to switch to the ${previewPlan?.name} plan?`}
                </DialogDescription>
              </DialogHeader>

              {impact && impact.features.length > 0 && (
                <div className="my-4 py-3 border-y border-border/50">
                  <ul className="space-y-3">
                    {impact.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm">
                        {impact.type === "upgrade" ? (
                          <Check className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                          <X className="size-4 text-rose-500 shrink-0 mt-0.5" />
                        )}
                        <span className="text-foreground/90 font-medium">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <DialogFooter className="mt-6 flex flex-row justify-end gap-2">
                <button
                  onClick={() => setPreviewPlanId(null)}
                  className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-background/80 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmPlanChange}
                  className="px-4 py-2 rounded-lg bg-brand text-brand-foreground hover:bg-brand-dark text-sm font-semibold transition-colors btn-press cursor-pointer"
                >
                  Continue
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function UsageCard({
  icon: Icon,
  title,
  used,
  limit,
  remaining,
  pct,
  atLimit,
  resetLabel,
  primary = false,
  warn = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  used: number;
  limit: number;
  remaining: number;
  pct: number;
  atLimit: boolean;
  resetLabel: string;
  primary?: boolean;
  warn?: boolean;
}) {
  const barColor = atLimit
    ? "bg-destructive"
    : warn
      ? "bg-amber-500"
      : "bg-brand";

  return (
    <div
      className={cn(
        "rounded-xl border p-5 transition-all",
        atLimit
          ? "border-destructive/40 bg-destructive/5"
          : warn
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-border bg-background/50"
      )}
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon
          className={cn(
            "size-4 shrink-0",
            atLimit ? "text-destructive" : warn ? "text-amber-500" : "text-brand"
          )}
        />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {primary && (
          <span className="ml-auto text-[9px] font-bold bg-brand/10 text-brand px-1.5 py-0.5 rounded uppercase tracking-wider border border-brand/20">
            Primary
          </span>
        )}
      </div>

      {atLimit ? (
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle
            className={cn("size-4 shrink-0", primary ? "text-destructive" : "text-amber-500")}
          />
          <span className="font-bold text-sm">
            {primary ? "Daily limit reached" : "Monthly limit reached"}
          </span>
        </div>
      ) : (
        <p className="text-2xl font-bold mb-1">
          {used.toLocaleString()}{" "}
          <span className="text-sm text-muted-foreground font-normal">
            / {limit.toLocaleString()}
          </span>
        </p>
      )}

      <div className="h-1.5 w-full bg-border rounded-full overflow-hidden mb-2">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="size-4 shrink-0" />
          {resetLabel}
        </span>
        {!atLimit && (
          <span className="font-medium text-foreground">
            {remaining.toLocaleString()} left
          </span>
        )}
      </div>
    </div>
  );
}

function ChannelUsageCard({
  label,
  count,
  color,
  icon: Icon,
}: {
  label: string;
  count: number;
  color: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 relative overflow-hidden group">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center shrink-0">
          <Icon className="size-4 text-brand shrink-0" />
        </div>
      </div>
      <p className="text-2xl font-bold mb-2">{count.toLocaleString()}</p>

      {/* Visual progress scale bar */}
      <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${Math.min(100, count > 0 ? Math.max(10, (count / 20) * 100) : 0)}%` }}
        />
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  current,
  onSelect,
  isPending,
  currentPlan,
}: {
  plan: PlanConfig;
  current: boolean;
  onSelect: () => void;
  isPending: boolean;
  currentPlan: PlanId;
}) {
  const currentPlanConfig = getPlan(currentPlan);

  // Determine button text
  let buttonText = "";
  if (current) {
    buttonText = "Current Plan";
  } else if (currentPlan === "free") {
    buttonText = `Upgrade to ${plan.name}`;
  } else {
    // Paid User
    const isUpgrade = plan.priceMonthly > currentPlanConfig.priceMonthly;
    const isDowngrade = plan.priceMonthly < currentPlanConfig.priceMonthly;
    if (isUpgrade) {
      buttonText = "Upgrade Plan";
    } else if (isDowngrade) {
      buttonText = "Downgrade Plan";
    } else {
      buttonText = "Change Plan";
    }
  }

  return (
    <div
      className={cn(
        "relative flex flex-col justify-between h-full bg-card rounded-2xl p-6 transition-all",
        current
          ? "border-2 border-brand shadow-brand"
          : "border border-border card-hover"
      )}
    >
      {plan.id === "premium" && (
        <span className="absolute -top-3 right-6 bg-brand text-brand-foreground text-[10px] font-bold px-3 py-1 rounded-full border border-brand/20 uppercase tracking-wider shadow-sm">
          Best Value
        </span>
      )}

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
            {plan.name}
          </span>
          {current && (
            <span className="text-[10px] font-bold bg-brand/15 text-brand px-2 py-0.5 rounded border border-brand/20 uppercase tracking-wider">
              Current
            </span>
          )}
        </div>

        <p className="mt-3 text-3xl font-bold">
          {plan.price}
          <span className="text-sm text-muted-foreground font-normal">/mo</span>
        </p>

        {/* Daily / monthly limits highlighted */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-background border border-border p-2.5 text-center">
            <Sun className="size-4 text-brand mx-auto mb-1 shrink-0" />
            <p className="text-xs font-bold text-foreground">
              {plan.dailyLeadLimit.toLocaleString()}
            </p>
            <p className="text-[10px] text-muted-foreground">Opportunities / Day</p>
          </div>
          <div className="rounded-lg bg-background border border-border p-2.5 text-center">
            <Calendar className="size-4 text-brand mx-auto mb-1 shrink-0" />
            <p className="text-xs font-bold text-foreground">
              {plan.monthlyLeadLimit.toLocaleString()}
            </p>
            <p className="text-[10px] text-muted-foreground">Opportunities / Month</p>
          </div>
        </div>

        <ul className="mt-5 space-y-2 text-sm text-muted-foreground font-medium">
          {/* AI access row */}
          <li className="flex items-start gap-2">
            <Bot className="size-4 text-brand shrink-0 mt-0.5" />
            <span className="text-foreground/80">
              {aiLabel(plan.id)}
            </span>
          </li>
          {/* Remaining features */}
          {plan.features
            .filter(
              (f) =>
                !f.toLowerCase().includes("opportunities") &&
                !f.toLowerCase().includes("ai")
            )
            .map((f) => (
              <li key={f} className="flex items-start gap-2 text-foreground/80">
                <CheckCircle2 className="size-4 text-brand shrink-0 mt-0.5" />
                {f}
              </li>
            ))}
        </ul>
      </div>

      <button
        onClick={onSelect}
        className={cn(
          "mt-6 w-full py-2.5 rounded-lg font-semibold text-sm transition-colors",
          current
            ? "border border-border text-muted-foreground cursor-not-allowed bg-background/50"
            : "bg-brand text-brand-foreground hover:bg-brand-dark cursor-pointer btn-press"
        )}
        disabled={current || isPending}
      >
        {current ? "Current Plan" : buttonText}
      </button>
    </div>
  );
}

function aiLabel(planId: PlanId): string {
  switch (planId) {
    case "free":
      return "AI-Assisted Opportunity Discovery";
    case "starter":
      return "AI Discovery Recommendations";
    case "pro":
      return "AI Pipeline Coaching & Recommendations";
    case "premium":
      return "AI Executive Briefings, Weekly Intelligence & AI Opportunity Insights";
    default:
      return "";
  }
}
