import { ActivityTimeline } from "./components/ActivityTimeline";
import type { Lead } from "@/lib/api";

export function HistoryTab({ lead }: { lead: Lead }) {
  return (
    <div className="flex flex-col animate-fade-up">
      {/* Section header */}
      <div className="px-8 py-5 border-b border-border/60 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Outreach History</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Every action, contact, and pipeline move for this opportunity</p>
        </div>
        {/* Live activity indicator */}
        <div className="flex items-center gap-1.5">
          <div className="size-2 rounded-full bg-success ping-dot" />
          <span className="text-[11px] font-medium text-muted-foreground">Live</span>
        </div>
      </div>
      <ActivityTimeline lead={lead} />
    </div>
  );
}
