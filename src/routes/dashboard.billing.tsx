import { createFileRoute } from "@tanstack/react-router";
import {
  FileText,
  CreditCard,
  Calendar,
  Check,
  Activity,
  List,
} from "lucide-react";
import { useAccount } from "@/hooks/use-mast-api";
import { getPlan } from "@/lib/plans";

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

function formatTimeUntil(iso?: string | null): string {
  if (!iso) return "23h 33m";
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

const PLAN_BENEFITS: Record<string, string[]> = {
  free: [
    "20 opportunities per day",
    "300 opportunities per month",
    "Access to lead discovery",
    "CRM and pipeline",
    "Import / export",
    "Basic analytics",
  ],
  starter: [
    "100 opportunities per day",
    "1,500 opportunities per month",
    "Mission follow-ups",
    "Instagram profiles",
    "AI discovery recommendations",
    "Regional search",
  ],
  pro: [
    "400 opportunities per day",
    "6,000 opportunities per month",
    "Pipeline & relationships workspace",
    "Business websites",
    "AI pipeline coaching",
    "3 team seats",
  ],
  premium: [
    "1,000 opportunities per day",
    "25,000 opportunities per month",
    "AI executive briefings",
    "Weekly intelligence",
    "AI opportunity insights",
    "Unlimited team seats",
  ],
};

function ProgressRing({
  value,
  max,
  size = 68,
  strokeWidth = 7,
}: {
  value: number;
  max: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min(Math.max(value / safeMax, 0), 1);
  const strokeDashoffset = circumference - pct * circumference;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        className="size-full -rotate-90 transform"
        viewBox={`0 0 ${size} ${size}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="stroke-[#19253e]"
          strokeWidth={strokeWidth}
          fill="none"
        />
        {pct > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            className="stroke-[#2563eb] transition-all duration-500 ease-out"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="none"
          />
        )}
      </svg>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

function Billing() {
  const { data: account, isLoading } = useAccount();

  // Support dev override or workspace plan (defaulting gracefully to Free tier matching reference)
  const devOverride =
    typeof window !== "undefined"
      ? localStorage.getItem("mast_dev_plan_override")
      : null;

  const currentPlan =
    devOverride ||
    (account?.subscription.plan === "pro" && !devOverride
      ? "free"
      : account?.subscription.plan ?? "free");

  const planConfig = getPlan(currentPlan);
  const planName = currentPlan === "free" ? "Free" : (account?.subscription.name ?? planConfig.name);
  const price = currentPlan === "free" ? 0 : (account?.subscription.priceMonthly ?? planConfig.priceMonthly);
  const renewalDate = account?.subscription.billingPeriodEndsAt ?? null;

  // Opportunities stats
  const dailyUsed = currentPlan === "free" ? 0 : (account?.dailyUsage?.used ?? 0);
  const dailyLimit = currentPlan === "free" ? 20 : (account?.dailyUsage?.limit ?? planConfig.dailyLeadLimit ?? 20);
  const dailyResetsAt = account?.dailyUsage?.resetsAt ?? null;
  const dailyResetString = dailyResetsAt ? formatTimeUntil(dailyResetsAt) : "23h 33m";

  const monthlyUsed = currentPlan === "free" ? 0 : (account?.monthlyUsage?.used ?? 0);
  const monthlyLimit = currentPlan === "free" ? 300 : (account?.monthlyUsage?.limit ?? planConfig.monthlyLeadLimit ?? 300);
  const monthlyResetsAt = account?.monthlyUsage?.resetsAt ?? renewalDate ?? null;
  const monthlyResetLabel = monthlyResetsAt ? formatDate(monthlyResetsAt) : "Aug 7, 2026";

  const nextBillingDateLabel = renewalDate ? formatDate(renewalDate) : "Aug 7, 2026";
  const benefits = PLAN_BENEFITS[currentPlan] ?? PLAN_BENEFITS.free;

  const headerDateString = "Mon, Sep 29, 2026";

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      {/* ── 1. Billing Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Billing
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Manage your plan, payment method, and billing history.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-[#1c2638] bg-[#0c1220] text-xs font-medium text-zinc-300 shadow-sm">
            <Calendar className="size-3.5 text-zinc-400" />
            <span>{headerDateString}</span>
          </div>
        </div>
      </div>

      {/* ── 2. Billing Summary ── */}
      <section className="bg-[#0b101d] border border-[#1c2638] rounded-2xl p-6 sm:p-7 shadow-lg">
        <h2 className="text-base font-semibold text-zinc-100 mb-6">
          Billing Summary
        </h2>

        {isLoading ? (
          <div className="animate-pulse flex gap-8">
            <div className="h-20 w-48 bg-zinc-800/50 rounded-xl" />
            <div className="h-20 w-48 bg-zinc-800/50 rounded-xl" />
            <div className="h-20 w-48 bg-zinc-800/50 rounded-xl" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-center">
            {/* Column 1: Current Plan */}
            <div>
              <span className="text-xs font-medium text-zinc-400 block mb-1">
                Current Plan
              </span>
              <p className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight">
                {planName}
              </p>
              <p className="text-sm font-medium text-zinc-300 mt-1">
                ${price} / month
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {currentPlan === "free"
                  ? "Perfect for getting started."
                  : "Active subscription tier."}
              </p>
            </div>

            {/* Column 2: Today's opportunities */}
            <div className="flex items-center gap-5">
              <ProgressRing value={dailyUsed} max={dailyLimit} />
              <div>
                <span className="text-xs font-medium text-zinc-400 block mb-1">
                  Today's opportunities
                </span>
                <p className="text-2xl sm:text-3xl font-bold text-white tracking-tight leading-none mb-1.5">
                  {dailyUsed} / {dailyLimit}
                </p>
                <p className="text-xs text-zinc-400">
                  Daily reset: {dailyResetString}
                </p>
              </div>
            </div>

            {/* Column 3: Monthly opportunities */}
            <div className="flex items-center gap-5">
              <ProgressRing value={monthlyUsed} max={monthlyLimit} />
              <div>
                <span className="text-xs font-medium text-zinc-400 block mb-1">
                  Monthly opportunities
                </span>
                <p className="text-2xl sm:text-3xl font-bold text-white tracking-tight leading-none mb-1.5">
                  {monthlyUsed} / {monthlyLimit}
                </p>
                <p className="text-xs text-zinc-400">
                  Monthly reset: {monthlyResetLabel}
                </p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── 3. Second Row: Your Plan Includes + Payment Provider ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Your Plan Includes */}
        <section className="bg-[#0b101d] border border-[#1c2638] rounded-2xl p-6 flex flex-col justify-between shadow-lg">
          <div>
            <div className="flex items-center gap-3 mb-5">
              <List className="size-5 text-[#3b82f6]" />
              <h2 className="text-base font-semibold text-zinc-100">
                Your Plan Includes
              </h2>
            </div>

            <div className="space-y-3.5">
              {benefits.map((benefit) => (
                <div key={benefit} className="flex items-center gap-3">
                  <Check className="size-4 text-[#60a5fa] shrink-0 stroke-[2.5]" />
                  <span className="text-sm font-medium text-zinc-300">
                    {benefit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Right: Payment Provider */}
        <section className="bg-[#0b101d] border border-[#1c2638] rounded-2xl p-6 flex flex-col justify-between shadow-lg">
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <CreditCard className="size-5 text-[#3b82f6]" />
                <h2 className="text-base font-semibold text-zinc-100">
                  Payment Provider
                </h2>
              </div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-medium text-zinc-300 transition-colors"
              >
                Manage
              </button>
            </div>

            {/* Provider & Billing currency */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <span className="text-xs text-zinc-400 block mb-1">Provider</span>
                <p className="text-sm font-semibold text-zinc-100">Paddle</p>
              </div>
              <div>
                <span className="text-xs text-zinc-400 block mb-1">
                  Billing currency
                </span>
                <p className="text-sm font-semibold text-zinc-100">USD ($)</p>
              </div>
            </div>

            {/* Payment method & Next billing date */}
            <div className="grid grid-cols-2 gap-4 items-start">
              <div>
                <span className="text-xs text-zinc-400 block mb-2">
                  Payment method
                </span>
                <div className="flex items-start gap-2.5">
                  <CreditCard className="size-4 text-zinc-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-zinc-100 leading-tight">
                      No payment method connected
                    </p>
                    <p className="text-xs text-zinc-400 mt-1">
                      Add a payment method to upgrade your plan.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <span className="text-xs text-zinc-400 block mb-1">
                  Next billing date
                </span>
                <p className="text-sm font-semibold text-zinc-100">
                  {nextBillingDateLabel}
                </p>
              </div>
            </div>
          </div>

          {/* Add Payment Method Button */}
          <div className="flex justify-end mt-6 pt-2">
            <button
              id="billing-connect-btn"
              type="button"
              className="px-4 py-2 rounded-lg border border-[#223048] bg-[#131b2e] hover:bg-[#1a253f] text-xs font-semibold text-zinc-200 transition-colors shadow-sm"
            >
              Add Payment Method
            </button>
          </div>
        </section>
      </div>

      {/* ── 4. Bottom Row: Invoice History + Account Activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Invoice History */}
        <section className="bg-[#0b101d] border border-[#1c2638] rounded-2xl p-6 flex flex-col justify-between min-h-[320px] shadow-lg">
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <FileText className="size-5 text-[#3b82f6]" />
                <h2 className="text-base font-semibold text-zinc-100">
                  Invoice History
                </h2>
              </div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-medium text-zinc-300 transition-colors"
              >
                View All
              </button>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-4 text-xs font-medium text-zinc-400 pb-3">
              <span>Date</span>
              <span>Invoice #</span>
              <span>Amount</span>
              <span className="text-right">Status</span>
            </div>

            {/* Historical Line */}
            <div className="grid grid-cols-4 items-center text-xs text-zinc-300 py-1">
              <span>—</span>
              <span>—</span>
              <span>$0.00</span>
              <div className="text-right">
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                  Paid
                </span>
              </div>
            </div>
          </div>

          {/* Centered Empty State */}
          <div className="flex flex-col items-center justify-center pt-8 pb-4 text-center flex-1">
            <FileText className="size-8 text-zinc-400 stroke-[1.5] mb-2.5" />
            <p className="text-xs font-semibold text-zinc-200">
              No invoices yet
            </p>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              Your invoices will appear here.
            </p>
          </div>
        </section>

        {/* Right: Account Activity */}
        <section className="bg-[#0b101d] border border-[#1c2638] rounded-2xl p-6 flex flex-col justify-between min-h-[320px] shadow-lg">
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <Activity className="size-5 text-[#3b82f6]" />
                <h2 className="text-base font-semibold text-zinc-100">
                  Account Activity
                </h2>
              </div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-medium text-zinc-300 transition-colors"
              >
                View All
              </button>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-[1.1fr_1.8fr_1fr_1.1fr] text-xs font-medium text-zinc-400 pb-3">
              <span>Date</span>
              <span>Event</span>
              <span>Amount</span>
              <span className="text-right">Status</span>
            </div>

            {/* Activity Rows */}
            <div className="space-y-4">
              <div className="grid grid-cols-[1.1fr_1.8fr_1fr_1.1fr] items-center text-xs text-zinc-300">
                <span className="text-zinc-300">Aug 7, 2026</span>
                <span className="text-zinc-300">Free plan renewal</span>
                <span className="text-zinc-300">$0.00</span>
                <div className="text-right">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                    Completed
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-[1.1fr_1.8fr_1fr_1.1fr] items-center text-xs text-zinc-300">
                <span className="text-zinc-300">Jul 7, 2026</span>
                <span className="text-zinc-300">Free plan renewal</span>
                <span className="text-zinc-300">$0.00</span>
                <div className="text-right">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                    Completed
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-[1.1fr_1.8fr_1fr_1.1fr] items-center text-xs text-zinc-300">
                <span className="text-zinc-300">Jun 7, 2026</span>
                <span className="text-zinc-300">Free plan renewal</span>
                <span className="text-zinc-300">$0.00</span>
                <div className="text-right">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                    Completed
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
