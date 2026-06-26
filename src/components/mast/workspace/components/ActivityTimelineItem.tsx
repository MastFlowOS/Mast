import { Clock, Mail, Instagram, FileText, Phone, Calendar, Sparkles, CheckCircle2, UserPlus, Globe, Zap } from "lucide-react";
import type { LeadActivity } from "@/lib/api";

type IconConfig = {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
  border: string;
};

const ACTIVITY_CONFIG: Record<string, IconConfig> = {
  lead_created:        { icon: UserPlus,     color: "text-brand",       bg: "bg-brand/10",       border: "border-brand/20" },
  opportunity_discovered: { icon: Sparkles,  color: "text-brand",       bg: "bg-brand/10",       border: "border-brand/20" },
  message_generated:   { icon: Sparkles,     color: "text-brand",       bg: "bg-brand/10",       border: "border-brand/20" },
  email_opened:        { icon: Mail,         color: "text-blue-400",    bg: "bg-blue-400/10",   border: "border-blue-400/20" },
  email_sent:          { icon: Mail,         color: "text-blue-400",    bg: "bg-blue-400/10",   border: "border-blue-400/20" },
  instagram_opened:    { icon: Instagram,    color: "text-pink-400",    bg: "bg-pink-400/10",   border: "border-pink-400/20" },
  instagram_sent:      { icon: Instagram,    color: "text-pink-400",    bg: "bg-pink-400/10",   border: "border-pink-400/20" },
  contact_form_opened: { icon: Globe,        color: "text-cyan-400",    bg: "bg-cyan-400/10",   border: "border-cyan-400/20" },
  contact_form_sent:   { icon: Globe,        color: "text-cyan-400",    bg: "bg-cyan-400/10",   border: "border-cyan-400/20" },
  note_added:          { icon: FileText,     color: "text-amber-400",   bg: "bg-amber-400/10",  border: "border-amber-400/20" },
  call_completed:      { icon: Phone,        color: "text-green-400",   bg: "bg-green-400/10",  border: "border-green-400/20" },
  followup_scheduled:  { icon: Calendar,     color: "text-violet-400",  bg: "bg-violet-400/10", border: "border-violet-400/20" },
  followup_completed:  { icon: CheckCircle2, color: "text-green-400",   bg: "bg-green-400/10",  border: "border-green-400/20" },
  status_changed:      { icon: Zap,          color: "text-brand",       bg: "bg-brand/10",       border: "border-brand/20" },
  pipeline_advanced:   { icon: Zap,          color: "text-brand",       bg: "bg-brand/10",       border: "border-brand/20" },
  outreach_started:    { icon: Sparkles,     color: "text-brand",       bg: "bg-brand/10",       border: "border-brand/20" },
};

const DEFAULT_CONFIG: IconConfig = { icon: Clock, color: "text-muted-foreground", bg: "bg-muted", border: "border-border" };

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function ActivityTimelineItem({
  activity,
  index = 0,
}: {
  activity: LeadActivity;
  index?: number;
}) {
  const config = ACTIVITY_CONFIG[activity.type] ?? DEFAULT_CONFIG;
  const Icon = config.icon;
  const timestamp = new Date(activity.timestamp);
  const delayClass = ["delay-50","delay-100","delay-150","delay-200","delay-250","delay-300","delay-350","delay-400","delay-500"][Math.min(index, 8)];

  return (
    <div className={`flex items-start gap-3 py-3 px-4 animate-fade-up ${delayClass} group relative`}>
      {/* Vertical track line (connects items) */}
      <div className="absolute left-[30px] top-10 bottom-0 w-px bg-border/60 group-last:hidden" />

      {/* Icon */}
      <div className={`relative z-10 shrink-0 size-7 rounded-lg ${config.bg} border ${config.border} grid place-items-center`}>
        <Icon className={`size-3.5 ${config.color}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-1">
        <p className="text-sm font-medium leading-snug break-words text-foreground">{activity.content}</p>
        <span className="text-[11px] text-muted-foreground mt-0.5 block">
          {Number.isNaN(timestamp.getTime()) ? "Unknown time" : relativeTime(timestamp)}
        </span>
      </div>
    </div>
  );
}
