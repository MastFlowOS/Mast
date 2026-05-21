import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { PLANS, type PlanId } from "@/lib/plans";
import { useAccount, useChangePlan } from "@/hooks/use-mast-api";

export const Route = createFileRoute("/dashboard/subscription")({
  head: () => ({ meta: [{ title: "Subscription — Mast" }] }),
  component: Subscription,
});

function Subscription() {
  const { data: account } = useAccount();
  const changePlan = useChangePlan();
  const currentPlan = account?.subscription.plan ?? "free";
  const currentPlanName = account?.subscription.name ?? "Free";
  const price = account?.subscription.priceMonthly ?? 0;

  const selectPlan = async (plan: PlanId) => {
    try {
      await changePlan.mutateAsync(plan);
      toast.success("Plan updated");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not update plan");
    }
  };

  return (
    <div className="p-8 max-w-6xl">
      <h1 className="text-2xl font-bold tracking-tight">Subscription</h1>
      <p className="text-sm text-muted-foreground mt-1">Manage your plan and usage.</p>

      <div className="mt-6 bg-card border border-border rounded-2xl p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-xs font-bold text-brand uppercase tracking-widest">Current Plan</span>
            <p className="mt-1 text-3xl font-bold">{currentPlanName}</p>
            <p className="text-sm text-muted-foreground">${price}/month · {account?.credits.remaining.toLocaleString() ?? 0} credits remaining</p>
          </div>
          <button className="px-5 py-2.5 rounded-lg border border-border text-sm font-semibold hover:bg-background">
            Cancel plan
          </button>
        </div>
      </div>

      <h2 className="mt-10 text-lg font-bold">Change plan</h2>
      <div className="mt-5 grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PLANS.map((p) => {
          const current = p.id === currentPlan;
          return (
          <div
            key={p.name}
            className={
              current
                ? "bg-card border-2 border-brand rounded-2xl p-6 shadow-brand"
                : "bg-card border border-border rounded-2xl p-6"
            }
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">{p.name}</span>
              {current && (
                <span className="text-[10px] font-bold bg-brand/15 text-brand px-2 py-0.5 rounded border border-brand/20 uppercase tracking-wider">
                  Current
                </span>
              )}
            </div>
            <p className="mt-3 text-3xl font-bold">
              {p.price}<span className="text-sm text-muted-foreground font-normal">/mo</span>
            </p>
            <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-brand shrink-0 mt-0.5" /> {f}
                </li>
              ))}
            </ul>
            <button
              onClick={() => selectPlan(p.id)}
              className={
                current
                  ? "mt-6 w-full py-2.5 rounded-lg border border-border font-semibold text-sm"
                  : "mt-6 w-full py-2.5 rounded-lg bg-brand text-brand-foreground font-semibold text-sm hover:bg-brand-dark"
              }
              disabled={current || changePlan.isPending}
            >
              {current ? "Active" : `Switch to ${p.name}`}
            </button>
          </div>
          );
        })}
      </div>
    </div>
  );
}
