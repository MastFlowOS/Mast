import { Link } from "@tanstack/react-router";
import { Lock, ArrowRight, Sparkles } from "lucide-react";
import type { PlanId } from "@/lib/plans";
import { getPlan } from "@/lib/plans";

interface LockedFeatureCardProps {
  featureName: string;
  requiredPlan: PlanId;
  description: string;
  valueProposition: string;
  className?: string;
}

export function LockedFeatureCard({
  featureName,
  requiredPlan,
  description,
  valueProposition,
  className = "",
}: LockedFeatureCardProps) {
  const plan = getPlan(requiredPlan);

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-brand/20 bg-card/60 p-6 shadow-lg backdrop-blur-md transition-all hover:border-brand/40 ${className}`}
    >
      {/* Background radial glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          background:
            "radial-gradient(ellipse at top right, color-mix(in oklab, var(--brand) 30%, transparent), transparent 60%)",
        }}
      />

      <div className="relative space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 flex items-center justify-center">
              <Lock className="size-4 text-brand" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-foreground tracking-tight">
                {featureName}
              </h4>
              <p className="text-[10px] font-bold text-brand uppercase tracking-wider">
                Requires {plan.name} Plan
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-brand/15 text-brand border border-brand/25">
            <Sparkles className="size-2.5" /> Premium
          </span>
        </div>

        {/* Description & Value Proposition */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            {description}
          </p>
          <div className="rounded-lg bg-brand/5 border border-brand/10 p-3 text-xs text-brand font-medium leading-relaxed">
            <span className="font-bold">Impact: </span>
            {valueProposition}
          </div>
        </div>

        {/* CTA Button */}
        <Link
          to="/dashboard/subscription"
          className="group flex w-full items-center justify-center gap-2 rounded-xl bg-foreground text-background py-2.5 text-xs font-bold transition-all hover:bg-foreground/90 active:scale-[0.99]"
        >
          <span>Upgrade to {plan.name}</span>
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  );
}
