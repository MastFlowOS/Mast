import type { Lead } from "@/lib/api";
import { useLeadActivities } from "@/hooks/use-mast-api";
import { ActivityTimelineItem } from "./ActivityTimelineItem";
import { Zap } from "lucide-react";

export function ActivityTimeline({ lead }: { lead: Lead }) {
  const { data: activities = [], isLoading, isError } = useLeadActivities(lead);

  if (isLoading) {
    return (
      <div className="space-y-0">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="flex items-start gap-3 py-3 px-4">
            <div className="mast-skeleton size-7 rounded-lg shrink-0" />
            <div className="flex-1 space-y-2 pt-0.5">
              <div className="mast-skeleton h-3.5 w-3/4 rounded" />
              <div className="mast-skeleton h-2.5 w-1/3 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-40 items-center justify-center px-4 text-center">
        <p className="text-sm text-muted-foreground">Activity history could not be loaded.</p>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="flex flex-col h-40 items-center justify-center gap-2">
        <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center">
          <Zap className="size-4 text-brand" />
        </div>
        <p className="text-sm text-muted-foreground">No outreach activity yet — begin your first contact above.</p>
      </div>
    );
  }

  return (
    <div>
      {activities.map((activity, i) => (
        <ActivityTimelineItem key={activity.id} activity={activity} index={i} />
      ))}
    </div>
  );
}
