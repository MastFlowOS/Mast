import type { Lead } from "@/lib/api";
import { useLeadActivities } from "@/hooks/use-mast-api";
import { ActivityTimelineItem } from "./ActivityTimelineItem";

export function ActivityTimeline({ lead }: { lead: Lead }) {
  const { data: activities = [], isLoading, isError } = useLeadActivities(lead);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2, 3].map((item) => (
          <div key={item} className="h-10 rounded-lg bg-muted animate-pulse" />
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
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {activities.map((activity) => (
        <ActivityTimelineItem key={activity.id} activity={activity} />
      ))}
    </div>
  );
}
