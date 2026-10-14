import { useState, useEffect, useMemo } from "react";
import type { Lead, LeadActivity } from "@/lib/api";
import { useLeadActivities } from "@/hooks/use-mast-api";
import { ActivityTimelineItem } from "./ActivityTimelineItem";
import { Zap, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

const INITIAL_VISIBLE_COUNT = 3;
const INCREMENT_COUNT = 3;

export function ActivityTimeline({ lead }: { lead: Lead }) {
  const { data: rawActivities = [], isLoading, isError } = useLeadActivities(lead);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);

  // Reset expansion count when switching leads
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [lead?.id]);

  // Deduplicate activities by id and ensure sorted newest first
  const activities = useMemo(() => {
    if (!Array.isArray(rawActivities) || rawActivities.length === 0) return [];
    const seen = new Set<string>();
    const deduplicated: LeadActivity[] = [];

    for (const item of rawActivities) {
      const key = String(item.id || `${item.type}-${item.timestamp}`);
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(item);
      }
    }

    return deduplicated.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }, [rawActivities]);

  if (isLoading) {
    return (
      <div className="space-y-0" role="status" aria-label="Loading activity timeline">
        {[1, 2, 3].map((item) => (
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
      <div className="flex h-32 items-center justify-center px-4 text-center">
        <p className="text-xs text-muted-foreground">Activity history could not be loaded.</p>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="flex flex-col h-32 items-center justify-center gap-2 p-4 text-center">
        <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center">
          <Zap className="size-4 text-brand" />
        </div>
        <p className="text-xs text-muted-foreground">No outreach activity yet — begin your first contact above.</p>
      </div>
    );
  }

  const visibleActivities = activities.slice(0, visibleCount);
  const canShowMore = visibleCount < activities.length;
  const canShowLess = visibleCount > INITIAL_VISIBLE_COUNT;
  const remainingCount = activities.length - visibleCount;
  const nextIncrement = Math.min(INCREMENT_COUNT, remainingCount);

  return (
    <div className="space-y-1">
      <div className="divide-y divide-border/20 transition-all duration-200">
        {visibleActivities.map((activity, i) => (
          <ActivityTimelineItem key={activity.id} activity={activity} index={i} />
        ))}
      </div>

      {/* Pagination controls: only shown when total activities > 3 */}
      {activities.length > INITIAL_VISIBLE_COUNT && (
        <div className="flex items-center justify-between pt-2 px-2 border-t border-border/40 text-xs">
          {canShowMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setVisibleCount((prev) => Math.min(prev + INCREMENT_COUNT, activities.length))}
              className="h-7 px-2.5 text-xs text-brand hover:text-brand hover:bg-brand/10 gap-1 font-medium transition-colors"
            >
              <ChevronDown className="size-3.5" />
              <span>Show more ({nextIncrement})</span>
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground/70">All {activities.length} activities shown</span>
          )}

          {canShowLess && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setVisibleCount(INITIAL_VISIBLE_COUNT)}
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-card gap-1 transition-colors ml-auto"
            >
              <ChevronUp className="size-3.5" />
              <span>Show less</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
