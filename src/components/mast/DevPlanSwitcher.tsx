import React, { useState } from "react";
import { Zap } from "lucide-react";

/**
 * DevPlanSwitcher
 * 
 * Floating control widget rendered only in local development environment.
 * Sets a localStorage override of the active subscription plan so developers
 * can test locked UI and backend validations instantly without database edits.
 */
export function DevPlanSwitcher() {
  // Only render in local development
  if (!import.meta.env.DEV) return null;

  const currentOverride = localStorage.getItem("mast_dev_plan_override") || "none";
  const [selectedPlan, setSelectedPlan] = useState(currentOverride);

  const handlePlanChange = (plan: string) => {
    setSelectedPlan(plan);
    if (plan === "none") {
      localStorage.removeItem("mast_dev_plan_override");
    } else {
      localStorage.setItem("mast_dev_plan_override", plan);
    }
    // Reload to instantly refresh permissions state everywhere in app
    window.location.reload();
  };

  return (
    <div className="fixed bottom-4 right-4 z-[9999] bg-card border border-brand/20 rounded-2xl p-3 shadow-2xl backdrop-blur-md flex items-center gap-2.5">
      <div className="size-7 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
        <Zap className="size-4 text-brand animate-pulse" />
      </div>
      <div className="flex flex-col">
        <span className="text-[8px] font-bold text-muted-foreground uppercase tracking-wider leading-none mb-1">
          Dev Override
        </span>
        <select
          value={selectedPlan}
          onChange={(e) => handlePlanChange(e.target.value)}
          className="bg-transparent text-xs text-foreground font-bold border-none focus:ring-0 p-0 pr-6 cursor-pointer outline-none"
        >
          <option value="none" className="bg-card text-foreground">Database Default</option>
          <option value="free" className="bg-card text-foreground">Free</option>
          <option value="starter" className="bg-card text-foreground">Starter</option>
          <option value="pro" className="bg-card text-foreground">Pro</option>
          <option value="premium" className="bg-card text-foreground">Premium</option>
        </select>
      </div>
    </div>
  );
}
