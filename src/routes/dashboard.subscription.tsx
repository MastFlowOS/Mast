import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { useState } from "react";
import { addNotification } from "@/lib/notifications";
import {
  Calendar,
  Compass,
  Zap,
  Rocket,
  Crown,
  Check,
  X,
  BarChart3,
  Target,
  Sparkles,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import { PLANS, getPlan, type PlanId, type PlanConfig } from "@/lib/plans";
import { useAccount, useChangePlan } from "@/hooks/use-mast-api";
import { getDevPlanOverride } from "@/lib/permissions";
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
        "Global Search (expanded from Local + USA)",
        "More daily opportunities (100 Opportunities / Day cap)",
        "AI Discovery Recommendations",
        "Instagram Profiles",
      ];
    } else if (targetPlan === "pro") {
      features = [
        "Full Pipeline workspace",
        "AI Pipeline Coaching & Insights",
        "Business Websites",
        "Higher discovery limits (400 Opportunities / Day cap)",
        "3 Team Seats",
      ];
    } else if (targetPlan === "premium") {
      features = [
        "Highest AI Suite: Executive Briefings & Weekly Intelligence",
        "AI Opportunity Insights",
        "Unlimited Team Seats",
        "Highest discovery limits (1,000 Opportunities / Day cap)",
        "Everything included",
      ];
    }
    return { type: "upgrade", features };
  } else if (isDowngrade) {
    let features: string[] = [];
    if (targetPlan === "free") {
      features = [
        "Mission Follow-ups",
        "Global Search (reverts to Local + USA)",
        "Instagram Profiles",
        "AI Discovery Recommendations",
        "Daily opportunity discovery above 20 Opportunities / Day",
      ];
    } else if (targetPlan === "starter") {
      features = [
        "Full Pipeline workspace",
        "Business Websites",
        "AI Pipeline Coaching & Insights",
        "High daily caps (above 100 Opportunities / Day)",
        "Additional team seats (reduces to 1 Team Seat)",
      ];
    } else if (targetPlan === "pro") {
      features = [
        "Highest AI Suite (Executive Briefings & Weekly Intelligence)",
        "AI Opportunity Insights",
        "Unlimited Team Seats (reduces to 3 Team Seats)",
      ];
    }
    return { type: "downgrade", features };
  }

  return { type: "change", features: [] };
}

// ─── Plan Cards Metadata ──────────────────────────────────────────────────────

type PlanCardMeta = {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  tagline: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  iconBorder: string;
  iconColor: string;
  features: string[];
  isPopular?: boolean;
};

const PLAN_CARDS: PlanCardMeta[] = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    tagline: "Perfect for getting started.",
    icon: Compass,
    iconBg: "bg-[#141c2c]",
    iconBorder: "border-[#212d45]",
    iconColor: "text-zinc-400",
    features: [
      "20 opportunities/day",
      "300 opportunities/month",
      "Basic features",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    monthlyPrice: 29,
    tagline: "For growing freelancers and small teams.",
    icon: Zap,
    iconBg: "bg-blue-600/15",
    iconBorder: "border-blue-500/25",
    iconColor: "text-blue-400",
    features: [
      "100 opportunities/day",
      "1,500 opportunities/month",
      "Advanced features",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    monthlyPrice: 79,
    tagline: "For serious users who need more.",
    icon: Rocket,
    iconBg: "bg-blue-600/15",
    iconBorder: "border-blue-500/25",
    iconColor: "text-blue-400",
    features: [
      "400 opportunities/day",
      "6,000 opportunities/month",
      "All features",
    ],
  },
  {
    id: "premium",
    name: "Premium",
    monthlyPrice: 199,
    tagline: "For power users and agencies.",
    icon: Crown,
    iconBg: "bg-purple-600/15",
    iconBorder: "border-purple-500/25",
    iconColor: "text-purple-400",
    features: [
      "1,000 opportunities/day",
      "25,000 opportunities/month",
      "Everything included",
    ],
    isPopular: true,
  },
];

// ─── Comparison Table Definition ──────────────────────────────────────────────

type ComparisonRow = {
  feature: string;
  free: string | boolean;
  starter: string | boolean;
  pro: string | boolean;
  premium: string | boolean;
};

const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: "Opportunities per day",
    free: "20",
    starter: "100",
    pro: "400",
    premium: "1,000",
  },
  {
    feature: "Opportunities per month",
    free: "300",
    starter: "1,500",
    pro: "6,000",
    premium: "25,000",
  },
  {
    feature: "Search coverage",
    free: "Local + USA",
    starter: "Global",
    pro: "Global",
    premium: "Global",
  },
  {
    feature: "Contact channels",
    free: "Email",
    starter: "Email + Phone",
    pro: "Email + Phone + Instagram",
    premium: "All channels",
  },
  {
    feature: "AI features",
    free: "Basic",
    starter: "Advanced",
    pro: "Coaching & Insights",
    premium: "Executive AI (Highest)",
  },
  {
    feature: "Relationships (CRM)",
    free: true,
    starter: true,
    pro: true,
    premium: true,
  },
  {
    feature: "Mission (Follow-ups)",
    free: false,
    starter: true,
    pro: true,
    premium: true,
  },
  {
    feature: "Pipeline",
    free: false,
    starter: false,
    pro: true,
    premium: true,
  },
  {
    feature: "Import / export",
    free: true,
    starter: true,
    pro: true,
    premium: true,
  },
  {
    feature: "Analytics",
    free: false,
    starter: true,
    pro: true,
    premium: true,
  },
  {
    feature: "Priority support",
    free: false,
    starter: false,
    pro: true,
    premium: true,
  },
];

// ─── Why Users Upgrade Definition ─────────────────────────────────────────────

const WHY_UPGRADE_ITEMS = [
  {
    title: "More Opportunities",
    description:
      "Access up to 25,000 opportunities per month and find more potential clients.",
    icon: BarChart3,
    iconBg: "bg-blue-600/15",
    iconBorder: "border-blue-500/25",
    iconColor: "text-blue-400",
  },
  {
    title: "More Contact Channels",
    description:
      "Get email, phone, Instagram and website data to reach your leads across multiple channels.",
    icon: Target,
    iconBg: "bg-emerald-500/15",
    iconBorder: "border-emerald-500/25",
    iconColor: "text-emerald-400",
  },
  {
    title: "Advanced AI Features",
    description:
      "Better research, smarter insights, and higher quality leads.",
    icon: Sparkles,
    iconBg: "bg-pink-500/15",
    iconBorder: "border-pink-500/25",
    iconColor: "text-pink-400",
  },
  {
    title: "Grow Faster",
    description:
      "Manage more leads, close more deals, and scale your business.",
    icon: Zap,
    iconBg: "bg-purple-600/15",
    iconBorder: "border-purple-500/25",
    iconColor: "text-purple-400",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

function Subscription() {
  const { data: account } = useAccount();
  const changePlan = useChangePlan();

  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [previewPlanId, setPreviewPlanId] = useState<PlanId | null>(null);

  const devOverride = getDevPlanOverride();
  const currentPlan = (devOverride || account?.subscription.plan || "free") as PlanId;
  const currentPlanConfig = getPlan(currentPlan);

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

  // Real date for header
  const headerDateString = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const getPriceDisplay = (monthlyPrice: number) => {
    if (monthlyPrice === 0) return { amount: "$0", period: "/ month" };
    if (billingCycle === "yearly") {
      const discounted = Math.round(monthlyPrice * 0.8);
      return { amount: `$${discounted}`, period: "/ month" };
    }
    return { amount: `$${monthlyPrice}`, period: "/ month" };
  };

  return (
    <div className="p-6 sm:p-8 max-w-7xl mx-auto space-y-6">
      {/* ── Page Header ────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Subscription
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Choose the right plan for your goals and unlock more opportunities.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl border border-[#1c2638] bg-[#0c1220] text-xs font-medium text-zinc-300 shadow-sm">
            <Calendar className="size-3.5 text-zinc-400" />
            <span>{headerDateString}</span>
          </div>
        </div>
      </div>

      {/* ── 1. Choose Your Plan ────────────────────────────────────── */}
      <section className="bg-[#090d18]/90 border border-[#182236] rounded-2xl p-6 sm:p-7 space-y-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">
              Choose Your Plan
            </h2>
            <p className="text-xs text-zinc-400 mt-1">
              Upgrade or downgrade your plan at any time.
            </p>
          </div>

          {/* Monthly / Yearly Toggle */}
          <div className="flex items-center bg-[#070b14] border border-[#1c2638] p-1 rounded-xl shrink-0">
            <button
              type="button"
              onClick={() => setBillingCycle("monthly")}
              className={cn(
                "px-4 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer",
                billingCycle === "monthly"
                  ? "bg-[#4e46dc] text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-white"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle("yearly")}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 cursor-pointer",
                billingCycle === "yearly"
                  ? "bg-[#4e46dc] text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-white"
              )}
            >
              <span>Yearly</span>
              <span
                className={cn(
                  "text-[11px] font-bold px-2 py-0.5 rounded-md transition-colors",
                  billingCycle === "yearly"
                    ? "text-[#00e5ff] bg-[#00e5ff]/20"
                    : "text-[#00e5ff] bg-[#00e5ff]/10"
                )}
              >
                Save 20%
              </span>
            </button>
          </div>
        </div>

        {/* 4 Plan Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLAN_CARDS.map((p) => {
            const isCurrent = p.id === currentPlan;
            const isUpgrade = p.monthlyPrice > currentPlanConfig.priceMonthly;
            const isDowngrade = p.monthlyPrice < currentPlanConfig.priceMonthly;
            const price = getPriceDisplay(p.monthlyPrice);

            let buttonText = "Upgrade";
            if (isCurrent) {
              buttonText = "Current Plan";
            } else if (isDowngrade) {
              buttonText = "Downgrade";
            } else {
              buttonText = "Upgrade";
            }

            return (
              <div
                key={p.id}
                className={cn(
                  "relative rounded-2xl p-5 sm:p-6 flex flex-col justify-between transition-all",
                  p.isPopular
                    ? "border-2 border-[#6d28d9] bg-[#0d1024] shadow-[0_0_24px_rgba(109,40,217,0.18)]"
                    : "border border-[#1a2336] bg-[#0c1222]/60 hover:border-[#23304a]"
                )}
              >
                {p.isPopular && (
                  <span className="absolute top-4 right-4 bg-[#5838ff] text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full tracking-wide">
                    Most Popular
                  </span>
                )}

                <div>
                  <div className="flex items-start justify-between">
                    <div
                      className={cn(
                        "size-9 rounded-xl border flex items-center justify-center shrink-0",
                        p.iconBg,
                        p.iconBorder,
                        p.iconColor
                      )}
                    >
                      <p.icon className="size-4.5" />
                    </div>
                  </div>

                  <div className="mt-4">
                    <h3 className="text-base font-semibold text-white">{p.name}</h3>
                    <div className="flex items-baseline gap-1.5 mt-1.5">
                      <span className="text-3xl font-extrabold text-white tracking-tight">
                        {price.amount}
                      </span>
                      <span className="text-xs font-normal text-zinc-400">
                        {price.period}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-2 min-h-[32px] leading-relaxed">
                      {p.tagline}
                    </p>
                  </div>

                  <ul className="mt-5 space-y-2.5 mb-6">
                    {p.features.map((feat) => (
                      <li key={feat} className="flex items-center gap-2 text-xs text-zinc-200">
                        <Check className="size-3.5 text-zinc-300 shrink-0" />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  type="button"
                  disabled={isCurrent || changePlan.isPending}
                  onClick={() => selectPlan(p.id)}
                  className={cn(
                    "w-full py-2.5 rounded-xl text-xs font-semibold transition-all",
                    isCurrent
                      ? "border border-[#1e2738] bg-[#111726]/80 text-zinc-500 cursor-default"
                      : isUpgrade
                        ? "border border-blue-600/40 bg-[#0e1b36] hover:bg-[#15274d] text-blue-200 hover:text-white cursor-pointer shadow-sm"
                        : "border border-zinc-700/50 bg-[#161c28] hover:bg-[#1e2638] text-zinc-300 hover:text-white cursor-pointer shadow-sm"
                  )}
                >
                  {buttonText}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 2. Compare Plans ──────────────────────────────────────── */}
      <section className="bg-[#090d18]/90 border border-[#182236] rounded-2xl p-6 sm:p-7 space-y-6 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Compare Plans
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            See what's included in each plan.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="border-b border-[#182236]">
                <th className="py-4 px-4 text-xs font-semibold text-zinc-300 w-[24%]">
                  Feature
                </th>
                {PLAN_CARDS.map((p) => {
                  const price = getPriceDisplay(p.monthlyPrice);
                  return (
                    <th key={p.id} className="py-4 px-4 w-[19%] text-center">
                      <div className="flex items-center justify-center gap-3">
                        <div
                          className={cn(
                            "size-8 rounded-lg border flex items-center justify-center shrink-0",
                            p.iconBg,
                            p.iconBorder,
                            p.iconColor
                          )}
                        >
                          <p.icon className="size-4" />
                        </div>
                        <div className="text-left">
                          <div className="text-xs font-bold text-white">{p.name}</div>
                          <div className="text-[11px] font-normal text-zinc-400">
                            {price.amount} / month
                          </div>
                        </div>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#141d2e]">
              {COMPARISON_ROWS.map((row) => (
                <tr
                  key={row.feature}
                  className="hover:bg-white/[0.015] transition-colors"
                >
                  <td className="py-3.5 px-4 text-xs font-medium text-zinc-300">
                    {row.feature}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-center">
                    {typeof row.free === "boolean" ? (
                      row.free ? (
                        <Check className="size-4 text-zinc-200 mx-auto" />
                      ) : (
                        <span className="text-zinc-600 font-semibold text-sm">—</span>
                      )
                    ) : (
                      <span className="text-zinc-300 font-medium">{row.free}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-center">
                    {typeof row.starter === "boolean" ? (
                      row.starter ? (
                        <Check className="size-4 text-zinc-200 mx-auto" />
                      ) : (
                        <span className="text-zinc-600 font-semibold text-sm">—</span>
                      )
                    ) : (
                      <span className="text-zinc-300 font-medium">{row.starter}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-center">
                    {typeof row.pro === "boolean" ? (
                      row.pro ? (
                        <Check className="size-4 text-zinc-200 mx-auto" />
                      ) : (
                        <span className="text-zinc-600 font-semibold text-sm">—</span>
                      )
                    ) : (
                      <span className="text-zinc-300 font-medium">{row.pro}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-xs text-center">
                    {typeof row.premium === "boolean" ? (
                      row.premium ? (
                        <Check className="size-4 text-zinc-200 mx-auto" />
                      ) : (
                        <span className="text-zinc-600 font-semibold text-sm">—</span>
                      )
                    ) : (
                      <span className="text-zinc-300 font-medium">{row.premium}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 3. Why Users Upgrade ──────────────────────────────────── */}
      <section className="bg-[#090d18]/90 border border-[#182236] rounded-2xl p-6 sm:p-7 space-y-6 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Why Users Upgrade
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Get more opportunities, unlock more channels, and grow faster.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {WHY_UPGRADE_ITEMS.map((item) => (
            <div
              key={item.title}
              className="bg-[#0c1222]/60 border border-[#1a243a] rounded-2xl p-5 flex flex-col justify-start hover:border-[#23304a] transition-all"
            >
              <div
                className={cn(
                  "size-10 rounded-xl border flex items-center justify-center shrink-0",
                  item.iconBg,
                  item.iconBorder,
                  item.iconColor
                )}
              >
                <item.icon className="size-5" />
              </div>
              <h3 className="text-sm font-bold text-white mt-4">{item.title}</h3>
              <p className="text-xs text-zinc-400 mt-2 leading-relaxed">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Impact Confirmation Dialog ───────────────────────────── */}
      <Dialog
        open={previewPlanId !== null}
        onOpenChange={(open) => !open && setPreviewPlanId(null)}
      >
        <DialogContent className="max-w-md border border-[#1c2638] bg-[#0c1220] text-foreground rounded-2xl shadow-elevated">
          {previewPlanId && (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl font-bold tracking-tight text-white">
                  {impact?.type === "upgrade"
                    ? `Upgrade to ${previewPlan?.name}?`
                    : impact?.type === "downgrade"
                      ? `Downgrade to ${previewPlan?.name}?`
                      : `Switch to ${previewPlan?.name}?`}
                </DialogTitle>
                <DialogDescription className="text-sm text-zinc-400 mt-1.5">
                  {impact?.type === "upgrade"
                    ? "You will unlock the following capabilities:"
                    : impact?.type === "downgrade"
                      ? "You will lose access to the following capabilities:"
                      : `Do you want to switch to the ${previewPlan?.name} plan?`}
                </DialogDescription>
              </DialogHeader>

              {impact && impact.features.length > 0 && (
                <div className="my-4 py-3 border-y border-[#1c2638]">
                  <ul className="space-y-3">
                    {impact.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-3 text-sm">
                        {impact.type === "upgrade" ? (
                          <Check className="size-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                          <X className="size-4 text-rose-500 shrink-0 mt-0.5" />
                        )}
                        <span className="text-zinc-200 font-medium">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <DialogFooter className="mt-6 flex flex-row justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPreviewPlanId(null)}
                  className="px-4 py-2 rounded-xl border border-[#1c2638] text-sm font-semibold text-zinc-300 hover:bg-zinc-800/50 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmPlanChange}
                  className="px-4 py-2 rounded-xl bg-brand text-brand-foreground hover:bg-brand-dark text-sm font-semibold transition-colors btn-press cursor-pointer"
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
