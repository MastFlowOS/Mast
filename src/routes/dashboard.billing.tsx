import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  FileText,
  CreditCard,
  Calendar,
  Check,
  Activity,
  List,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useAccount } from "@/hooks/use-mast-api";
import { getPlan } from "@/lib/plans";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

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

function getTimeUntilUtcMidnight(): string {
  const now = new Date();
  const tomorrowUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  );
  return formatTimeUntil(tomorrowUtc.toISOString());
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

type RealAccountEvent = {
  id: string;
  date: string;
  event: string;
  amount: string;
  status: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

type ModalType = "manage" | "add_payment" | "invoices_all" | "activity_all" | null;

function Billing() {
  const { data: account, isLoading } = useAccount();
  const [activeModal, setActiveModal] = useState<ModalType>(null);

  // Read real account plan (or dev override if set for testing)
  const devOverride =
    typeof window !== "undefined"
      ? localStorage.getItem("mast_dev_plan_override")
      : null;

  const currentPlan =
    devOverride || account?.subscription.plan || "free";

  const planConfig = getPlan(currentPlan);
  const planName = planConfig.name;
  const price = account?.subscription.priceMonthly ?? planConfig.priceMonthly;

  // Real opportunities stats from account
  const dailyUsed = account?.dailyUsage?.used ?? 0;
  const dailyLimit = account?.dailyUsage?.limit ?? planConfig.dailyLeadLimit ?? 20;
  const dailyResetsAt = account?.dailyUsage?.resetsAt ?? null;
  const dailyResetString = dailyResetsAt ? formatTimeUntil(dailyResetsAt) : getTimeUntilUtcMidnight();

  const monthlyUsed = account?.monthlyUsage?.used ?? 0;
  const monthlyLimit = account?.monthlyUsage?.limit ?? planConfig.monthlyLeadLimit ?? 300;
  const monthlyResetsAt = account?.monthlyUsage?.resetsAt ?? account?.subscription.billingPeriodEndsAt ?? null;
  const monthlyResetLabel = monthlyResetsAt ? formatDate(monthlyResetsAt) : "Unavailable";

  // Provider & next billing date (real state: no provider connected)
  const nextBillingDateLabel = account?.subscription.billingPeriodEndsAt
    ? formatDate(account.subscription.billingPeriodEndsAt)
    : "Unavailable";

  const benefits = PLAN_BENEFITS[currentPlan] ?? PLAN_BENEFITS.free;

  // Real date for header
  const headerDateString = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Real account activity events (only actual database/account events)
  const realEvents: RealAccountEvent[] = [];
  if (account?.subscription.billingPeriodStartedAt) {
    eventsPushHelper(realEvents, {
      id: "billing-started",
      date: formatDate(account.subscription.billingPeriodStartedAt),
      event: `${account.subscription.name} plan started`,
      amount: account.subscription.priceMonthly > 0 ? `$${account.subscription.priceMonthly}.00` : "$0.00",
      status: "Completed",
    });
  }
  if (account?.subscription.pendingPlanChange) {
    eventsPushHelper(realEvents, {
      id: "plan-pending",
      date: "Pending",
      event: `Scheduled change to ${account.subscription.pendingPlanChange.toUpperCase()}`,
      amount: "—",
      status: "Pending",
    });
  }

  function eventsPushHelper(arr: RealAccountEvent[], item: RealAccountEvent) {
    arr.push(item);
  }

  // Interactive handlers for controls
  const handleManageClick = () => {
    setActiveModal("manage");
    toast.error("Payment provider not connected", {
      description: "No payment gateway is currently connected to this workspace.",
    });
  };

  const handleAddPaymentClick = () => {
    setActiveModal("add_payment");
    toast.error("Payment provider not connected", {
      description: "A payment provider must be connected before adding payment methods.",
    });
  };

  const handleViewAllInvoices = () => {
    setActiveModal("invoices_all");
    toast.info("No invoices found", {
      description: "There are no invoice records for this workspace.",
    });
  };

  const handleViewAllActivity = () => {
    setActiveModal("activity_all");
    if (realEvents.length === 0) {
      toast.info("No account activity", {
        description: "No subscription or billing changes have been recorded yet.",
      });
    } else {
      toast.info("Account activity", {
        description: `Displaying ${realEvents.length} recorded event(s).`,
      });
    }
  };

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
                {price === 0
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
                id="billing-manage-btn"
                type="button"
                onClick={handleManageClick}
                className="px-3 py-1.5 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-medium text-zinc-300 transition-colors cursor-pointer"
              >
                Manage
              </button>
            </div>

            {/* Provider & Billing currency */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <span className="text-xs text-zinc-400 block mb-1">Provider</span>
                <p className="text-sm font-semibold text-zinc-300">
                  Not connected
                </p>
              </div>
              <div>
                <span className="text-xs text-zinc-400 block mb-1">
                  Billing currency
                </span>
                <p className="text-sm font-semibold text-zinc-400">
                  Unavailable
                </p>
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
                      Payment provider is not yet connected.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <span className="text-xs text-zinc-400 block mb-1">
                  Next billing date
                </span>
                <p className="text-sm font-semibold text-zinc-400">
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
              onClick={handleAddPaymentClick}
              className="px-4 py-2 rounded-lg border border-[#223048] bg-[#131b2e] hover:bg-[#1a253f] text-xs font-semibold text-zinc-200 transition-colors shadow-sm cursor-pointer"
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
                id="invoices-view-all-btn"
                type="button"
                onClick={handleViewAllInvoices}
                className="px-3 py-1.5 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-medium text-zinc-300 transition-colors cursor-pointer"
              >
                View All
              </button>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-4 text-xs font-medium text-zinc-400 pb-3 border-b border-[#1c2638]/50">
              <span>Date</span>
              <span>Invoice #</span>
              <span>Amount</span>
              <span className="text-right">Status</span>
            </div>
          </div>

          {/* Real Empty State - No fake invoices */}
          <div className="flex flex-col items-center justify-center py-12 text-center flex-1">
            <FileText className="size-8 text-zinc-500/70 stroke-[1.5] mb-2.5" />
            <p className="text-xs font-semibold text-zinc-200">
              No invoices yet
            </p>
            <p className="text-[11px] text-zinc-400 mt-0.5 max-w-xs leading-relaxed">
              Your invoices will appear here once payments are processed through a connected payment provider.
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
                id="activity-view-all-btn"
                type="button"
                onClick={handleViewAllActivity}
                className="px-3 py-1.5 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-medium text-zinc-300 transition-colors cursor-pointer"
              >
                View All
              </button>
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-[1.1fr_1.8fr_1fr_1.1fr] text-xs font-medium text-zinc-400 pb-3 border-b border-[#1c2638]/50">
              <span>Date</span>
              <span>Event</span>
              <span>Amount</span>
              <span className="text-right">Status</span>
            </div>

            {/* Real Activity Rows (if any exist) */}
            {realEvents.length > 0 && (
              <div className="space-y-4 mt-3">
                {realEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className="grid grid-cols-[1.1fr_1.8fr_1fr_1.1fr] items-center text-xs text-zinc-300"
                  >
                    <span>{ev.date}</span>
                    <span>{ev.event}</span>
                    <span>{ev.amount}</span>
                    <div className="text-right">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                        {ev.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Real Empty State when no activity exists - No fake renewals */}
          {realEvents.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center flex-1">
              <Activity className="size-8 text-zinc-500/70 stroke-[1.5] mb-2.5" />
              <p className="text-xs font-semibold text-zinc-200">
                No account activity yet
              </p>
              <p className="text-[11px] text-zinc-400 mt-0.5 max-w-xs leading-relaxed">
                Subscription events and plan updates will appear here once recorded on your account.
              </p>
            </div>
          )}
        </section>
      </div>

      {/* ── Informational Feedback Dialogs for Controls ── */}
      <Dialog
        open={activeModal !== null}
        onOpenChange={(open) => !open && setActiveModal(null)}
      >
        <DialogContent className="max-w-md border border-[#1c2638] bg-[#0c1220] text-zinc-100 rounded-2xl shadow-2xl">
          {activeModal === "manage" && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <CreditCard className="size-5 text-[#3b82f6]" />
                  <DialogTitle className="text-lg font-bold text-white">
                    Payment Provider Management
                  </DialogTitle>
                </div>
                <DialogDescription className="text-xs text-zinc-400">
                  Payment gateway integration status
                </DialogDescription>
              </DialogHeader>

              <div className="py-4 space-y-3">
                <div className="p-3.5 rounded-xl border border-amber-500/20 bg-amber-500/10 text-xs text-amber-300 flex items-start gap-2.5">
                  <AlertCircle className="size-4 shrink-0 mt-0.5 text-amber-400" />
                  <div>
                    <p className="font-semibold text-amber-200">
                      Provider Not Connected
                    </p>
                    <p className="mt-0.5 text-amber-300/80 leading-relaxed">
                      There is currently no payment provider (such as Stripe or Paddle) connected to this Mast workspace.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Payment management, credit card updates, and subscription billing controls will become available once a payment provider integration is connected.
                </p>
              </div>

              <DialogFooter className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="px-4 py-2 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
                >
                  Close
                </button>
              </DialogFooter>
            </>
          )}

          {activeModal === "add_payment" && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <CreditCard className="size-5 text-[#3b82f6]" />
                  <DialogTitle className="text-lg font-bold text-white">
                    Add Payment Method
                  </DialogTitle>
                </div>
                <DialogDescription className="text-xs text-zinc-400">
                  Payment method setup
                </DialogDescription>
              </DialogHeader>

              <div className="py-4 space-y-3">
                <div className="p-3.5 rounded-xl border border-amber-500/20 bg-amber-500/10 text-xs text-amber-300 flex items-start gap-2.5">
                  <AlertCircle className="size-4 shrink-0 mt-0.5 text-amber-400" />
                  <div>
                    <p className="font-semibold text-amber-200">
                      Gateway Unavailable
                    </p>
                    <p className="mt-0.5 text-amber-300/80 leading-relaxed">
                      Payment methods cannot be attached because no payment provider is connected to process transactions.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Please connect a supported billing provider to securely link credit cards, debit cards, or regional payment methods.
                </p>
              </div>

              <DialogFooter className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="px-4 py-2 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
                >
                  Close
                </button>
              </DialogFooter>
            </>
          )}

          {activeModal === "invoices_all" && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="size-5 text-[#3b82f6]" />
                  <DialogTitle className="text-lg font-bold text-white">
                    Invoice History
                  </DialogTitle>
                </div>
                <DialogDescription className="text-xs text-zinc-400">
                  Workspace invoice and billing records
                </DialogDescription>
              </DialogHeader>

              <div className="py-6 text-center">
                <FileText className="size-9 text-zinc-500/70 mx-auto mb-2.5 stroke-[1.5]" />
                <p className="text-sm font-semibold text-zinc-200">
                  No Invoices Found
                </p>
                <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto leading-relaxed">
                  No invoice records or receipts exist for this account. Paid charges and tax invoices will appear here once payments are processed.
                </p>
              </div>

              <DialogFooter className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="px-4 py-2 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
                >
                  Close
                </button>
              </DialogFooter>
            </>
          )}

          {activeModal === "activity_all" && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="size-5 text-[#3b82f6]" />
                  <DialogTitle className="text-lg font-bold text-white">
                    Account Activity History
                  </DialogTitle>
                </div>
                <DialogDescription className="text-xs text-zinc-400">
                  Subscription changes, upgrades, and billing events
                </DialogDescription>
              </DialogHeader>

              {realEvents.length === 0 ? (
                <div className="py-6 text-center">
                  <Activity className="size-9 text-zinc-500/70 mx-auto mb-2.5 stroke-[1.5]" />
                  <p className="text-sm font-semibold text-zinc-200">
                    No Recorded Activity
                  </p>
                  <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto leading-relaxed">
                    No subscription or billing changes have been recorded for this workspace yet.
                  </p>
                </div>
              ) : (
                <div className="py-4 space-y-3">
                  {realEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-3 rounded-lg border border-[#1c2638] bg-[#0e1626] flex items-center justify-between text-xs"
                    >
                      <div>
                        <p className="font-semibold text-zinc-200">{ev.event}</p>
                        <p className="text-zinc-400 text-[11px]">{ev.date}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium text-zinc-200">{ev.amount}</p>
                        <span className="text-[10px] text-emerald-400 font-medium">
                          {ev.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <DialogFooter className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="px-4 py-2 rounded-lg border border-[#1c2638] bg-[#121927] hover:bg-[#182236] text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
                >
                  Close
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
