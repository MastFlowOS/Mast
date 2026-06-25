import { ActivityTimeline } from "./components/ActivityTimeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock } from "lucide-react";
import type { Lead } from "@/lib/api";

export function HistoryTab({ lead }: { lead: Lead }) {
  return (
    <div className="p-4 md:p-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="size-4 text-brand" />
            Activity Timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ActivityTimeline lead={lead} />
        </CardContent>
      </Card>
    </div>
  );
}
