import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FocusMilestoneJourney } from "@/components/mast/focus/FocusMilestoneJourney";
import { FocusGreeting } from "@/components/mast/focus/FocusSections";
import { getTimeOfDayPeriod, type GreetingPeriod, MILESTONE_TIERS } from "@/lib/focus";

export const Route = createFileRoute("/milestone-preview")({
  component: MilestonePreviewPage,
});

export function MilestonePreviewPage() {
  const [overridePeriod, setOverridePeriod] = useState<GreetingPeriod | undefined>(undefined);
  const [xp, setXp] = useState<number>(100);

  const effectivePeriod = overridePeriod ?? getTimeOfDayPeriod();

  // Find current and next milestone based on xp
  const currentTier = [...MILESTONE_TIERS].reverse().find((t) => xp >= t.xpRequired) ?? MILESTONE_TIERS[0];
  const nextTier = MILESTONE_TIERS.find((t) => t.xpRequired > xp) ?? null;

  return (
    <div className="min-h-screen bg-[#0c0f17] text-white p-6 font-sans">
      {/* Dev preview controls */}
      <div className="max-w-[1200px] mx-auto mb-8 p-4 rounded-xl bg-[#12151e] border border-white/10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-white/50">Time of Day:</span>
          {(["morning", "afternoon", "evening", "night"] as GreetingPeriod[]).map((p) => (
            <button
              key={p}
              onClick={() => setOverridePeriod(p)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                effectivePeriod === p
                  ? "bg-purple-600 text-white shadow-sm"
                  : "bg-white/5 text-white/70 hover:bg-white/10"
              }`}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
          <button
            onClick={() => setOverridePeriod(undefined)}
            className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
              overridePeriod === undefined
                ? "bg-emerald-600 text-white"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            Auto (Local Time: {getTimeOfDayPeriod()})
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-wider text-white/50">XP Preset:</span>
          {[
            { label: "0 XP (Explorer)", val: 0 },
            { label: "100 XP (Prospector)", val: 100 },
            { label: "150 XP (33% Closer)", val: 150 },
            { label: "200 XP (67% Closer)", val: 200 },
            { label: "250 XP (Closer summit)", val: 250 },
            { label: "375 XP (50% Rainmaker)", val: 375 },
            { label: "500 XP (Rainmaker summit)", val: 500 },
          ].map((preset) => (
            <button
              key={preset.val}
              onClick={() => setXp(preset.val)}
              className={`px-2.5 py-1 text-xs rounded transition-all ${
                xp === preset.val
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold"
                  : "bg-white/5 text-white/60 hover:bg-white/10"
              }`}
            >
              {preset.val} XP
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto">
        {/* Synchronized Greeting */}
        <FocusGreeting
          period={effectivePeriod}
          name="Ibrahim"
          subtitle="Complete goals, earn XP and climb to the next tier."
        />

        {/* Milestone Journey Component */}
        <FocusMilestoneJourney
          xp={xp}
          currentName={currentTier.name}
          nextName={nextTier?.name ?? null}
          period={effectivePeriod}
          overridePeriod={overridePeriod}
        />
      </div>
    </div>
  );
}
