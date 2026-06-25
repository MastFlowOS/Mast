import { Clock, Mail, Instagram, FileText, Phone, Calendar, Sparkles, CheckCircle2, UserPlus, Globe } from "lucide-react";
import type { LeadActivity } from "@/lib/api";

export function ActivityTimelineItem({ activity }: { activity: LeadActivity }) {
  const icons: Record<string, React.ComponentType<{ className?: string }>> = {
    lead_created: UserPlus,
    message_generated: Sparkles,
    email_opened: Mail,
    email_sent: Mail,
    instagram_opened: Instagram,
    instagram_sent: Instagram,
    contact_form_opened: Globe,
    contact_form_sent: Globe,
    note_added: FileText,
    call_completed: Phone,
    followup_scheduled: Calendar,
    followup_completed: CheckCircle2,
    status_changed: CheckCircle2,
  };

  const Icon = icons[activity.type] ?? Clock;
  const timestamp = new Date(activity.timestamp);

  return (
    <div className="flex items-start gap-4 py-3">
      <div className="shrink-0 size-8 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center">
        <Icon className="size-4 text-brand" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="text-sm font-medium break-words">{activity.content}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            {Number.isNaN(timestamp.getTime()) ? "Unknown time" : timestamp.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
