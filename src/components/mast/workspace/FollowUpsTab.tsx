import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Calendar,
  Check,
  Loader2,
  CalendarCheck,
  Clock,
  X,
  RotateCcw,
  AlertTriangle,
  Mail,
  Instagram,
  Phone,
  Link as LinkIcon,
  PlusCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  useCreateFollowup,
  useUpdateFollowup,
  useRecordLeadActivity,
  useLeadFollowups,
} from "@/hooks/use-mast-api";
import type { Followup, Lead, OutreachChannel } from "@/lib/api";
import { CHANNELS, formatDate } from "@/lib/lead-workspace";

function getChannelIcon(channel: string) {
  switch (channel) {
    case "email":
      return Mail;
    case "instagram":
      return Instagram;
    case "phone":
      return Phone;
    case "contact_form":
      return LinkIcon;
    default:
      return Clock;
  }
}

function getDueStatus(dueAt: string) {
  const due = new Date(dueAt);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());

  if (startOfDue < startOfToday) {
    return { label: "Overdue", style: "bg-rose-500/15 border-rose-500/30 text-rose-400" };
  }
  if (startOfDue.getTime() === startOfToday.getTime()) {
    return { label: "Due Today", style: "bg-amber-500/15 border-amber-500/30 text-amber-400" };
  }
  return { label: "Upcoming", style: "bg-indigo-500/15 border-indigo-500/30 text-indigo-300" };
}

export function FollowUpsTab({ lead }: { lead: Lead }) {
  const [date, setDate] = useState(
    lead.followUpAt ? new Date(lead.followUpAt).toISOString().split("T")[0] : "",
  );
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [notes, setNotes] = useState("");
  const [reschedulingId, setReschedulingId] = useState<number | string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleNotes, setRescheduleNotes] = useState("");

  const createFollowup = useCreateFollowup();
  const updateFollowup = useUpdateFollowup();
  const recordActivity = useRecordLeadActivity();
  const { data: followups = [], isLoading, isError, refetch } = useLeadFollowups(lead.id);

  const isPending = createFollowup.isPending || updateFollowup.isPending || recordActivity.isPending;

  // Active follow-ups from the database
  const activeFollowups = Array.isArray(followups)
    ? followups.filter((f) => f.status !== "completed" && f.status !== "cancelled")
    : [];

  const completedFollowups = Array.isArray(followups)
    ? followups.filter((f) => f.status === "completed" || f.status === "cancelled")
    : [];

  const getNextRemainingDueAt = (excludeId: number | string) => {
    const remaining = activeFollowups.filter((f) => f.id !== excludeId);
    if (remaining.length === 0) return null;
    const sorted = [...remaining].sort(
      (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
    );
    return sorted[0].dueAt;
  };

  const handleSchedule = async () => {
    if (!date) return;
    const followUpAt = new Date(date).toISOString();
    const channelLabelStr = channelLabel(channel);

    try {
      await createFollowup.mutateAsync({
        leadId: lead.id,
        channel,
        dueAt: followUpAt,
        notes: notes.trim() || undefined,
      });

      try {
        await recordActivity.mutateAsync({
          lead,
          activity: {
            type: "followup_scheduled",
            channel,
            timestamp: new Date().toISOString(),
            content: `${channelLabelStr} follow-up scheduled for ${new Date(followUpAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
            metadata: { dueAt: followUpAt, notes: notes.trim() || undefined },
          },
          patch: { followUpAt, status: "follow_up_due" },
        });
      } catch {
        // Activity history persistence is best-effort
      }

      setDate("");
      setNotes("");
      toast.success("Follow-up scheduled");
    } catch {
      toast.error("Failed to schedule follow-up");
    }
  };

  const handleComplete = async (followup: Followup) => {
    const completedAt = new Date().toISOString();
    const nextDue = getNextRemainingDueAt(followup.id);

    try {
      await updateFollowup.mutateAsync({
        id: followup.id,
        body: { status: "completed", completedAt },
      });

      try {
        await recordActivity.mutateAsync({
          lead,
          activity: {
            type: "followup_completed",
            channel: followup.channel as OutreachChannel,
            timestamp: completedAt,
            content: `Follow-up completed (${channelLabel(followup.channel)})`,
            metadata: { followupId: followup.id },
          },
          patch: {
            followUpAt: nextDue,
            status: nextDue ? "follow_up_due" : "contacted",
          },
        });
      } catch {
        // Activity history persistence is best-effort
      }

      toast.success("Follow-up completed");
    } catch {
      toast.error("Could not complete follow-up");
    }
  };

  const handleStartReschedule = (followup: Followup) => {
    setReschedulingId(followup.id);
    setRescheduleDate(new Date(followup.dueAt).toISOString().split("T")[0]);
    setRescheduleNotes(followup.notes ?? "");
  };

  const handleSaveReschedule = async (followupId: number | string) => {
    if (!rescheduleDate) {
      toast.error("Please pick a due date");
      return;
    }
    const newDueAt = new Date(rescheduleDate).toISOString();

    try {
      await updateFollowup.mutateAsync({
        id: followupId,
        body: { dueAt: newDueAt, notes: rescheduleNotes.trim() || undefined },
      });

      try {
        await recordActivity.mutateAsync({
          lead,
          activity: {
            type: "followup_scheduled",
            timestamp: new Date().toISOString(),
            content: `Follow-up rescheduled to ${new Date(newDueAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
            metadata: { followupId, dueAt: newDueAt, notes: rescheduleNotes.trim() || undefined },
          },
          patch: { followUpAt: newDueAt, status: "follow_up_due" },
        });
      } catch {
        // Activity history persistence is best-effort
      }

      setReschedulingId(null);
      setRescheduleDate("");
      setRescheduleNotes("");
      toast.success("Follow-up rescheduled");
    } catch {
      toast.error("Failed to reschedule follow-up");
    }
  };

  const handleCancelFollowup = async (followup: Followup) => {
    const nextDue = getNextRemainingDueAt(followup.id);
    try {
      await updateFollowup.mutateAsync({
        id: followup.id,
        body: { status: "cancelled" },
      });

      try {
        await recordActivity.mutateAsync({
          lead,
          activity: {
            type: "status_changed",
            channel: followup.channel as OutreachChannel,
            timestamp: new Date().toISOString(),
            content: `Follow-up cancelled (${channelLabel(followup.channel)})`,
            metadata: { followupId: followup.id },
          },
          patch: { followUpAt: nextDue },
        });
      } catch {
        // Activity history persistence is best-effort
      }

      toast.success("Follow-up cancelled");
    } catch {
      toast.error("Could not cancel follow-up");
    }
  };

  return (
    <div className="space-y-4">
      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center p-6 text-muted-foreground gap-2 text-xs">
          <Loader2 className="size-4 animate-spin text-brand" />
          <span>Loading follow-ups…</span>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-3.5 text-xs text-destructive space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="size-4 shrink-0" />
            <span>Could not load follow-ups</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refetch()}
            className="h-7 text-xs border-destructive/30 hover:bg-destructive/10"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Active follow-ups list */}
      {!isLoading && !isError && activeFollowups.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Upcoming Follow-ups
            </h4>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/25">
              {activeFollowups.length} scheduled
            </span>
          </div>

          <div className="space-y-2.5">
            {activeFollowups.map((followup) => {
              const isEditing = reschedulingId === followup.id;
              const ChannelIcon = getChannelIcon(followup.channel);
              const dueStatus = getDueStatus(followup.dueAt);

              return (
                <div
                  key={followup.id}
                  className="rounded-xl border border-border/80 bg-[#0d121d]/70 p-3 space-y-2.5 transition-all shadow-xs hover:border-border"
                >
                  {/* Top row: channel icon + due date status */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="size-7 rounded-lg bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 grid place-items-center shrink-0">
                        <ChannelIcon className="size-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground capitalize truncate">
                          {channelLabel(followup.channel as OutreachChannel)}
                        </p>
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Clock className="size-3 shrink-0" />
                          <span>{formatDate(followup.dueAt)}</span>
                        </p>
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-md border shrink-0 ${dueStatus.style}`}
                    >
                      {dueStatus.label}
                    </span>
                  </div>

                  {/* Message/Notes preview */}
                  {followup.notes && (
                    <div className="rounded-lg bg-card/40 border border-border/50 p-2 text-xs text-foreground/90 leading-relaxed break-words whitespace-pre-wrap">
                      {followup.notes}
                    </div>
                  )}

                  {/* Edit mode or standard actions */}
                  {isEditing ? (
                    <div className="pt-2 border-t border-border/60 space-y-2.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Reschedule Follow-up
                      </p>
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-muted-foreground">
                          New Due Date
                        </label>
                        <Input
                          type="date"
                          value={rescheduleDate}
                          onChange={(e) => setRescheduleDate(e.target.value)}
                          min={new Date().toISOString().split("T")[0]}
                          disabled={isPending}
                          className="h-8 text-xs bg-background border-border/80"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-muted-foreground">
                          Notes / Context
                        </label>
                        <Input
                          value={rescheduleNotes}
                          onChange={(e) => setRescheduleNotes(e.target.value)}
                          placeholder="Update follow-up context…"
                          disabled={isPending}
                          className="h-8 text-xs bg-background border-border/80"
                        />
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          onClick={() => void handleSaveReschedule(followup.id)}
                          disabled={isPending || !rescheduleDate}
                          className="h-7 px-3 text-xs bg-brand hover:bg-brand/90 gap-1.5 font-medium"
                        >
                          {isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                          Save Changes
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setReschedulingId(null)}
                          disabled={isPending}
                          className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between pt-2 border-t border-border/50 gap-2">
                      {/* Primary action: Done */}
                      <Button
                        size="sm"
                        onClick={() => void handleComplete(followup)}
                        disabled={isPending}
                        className="h-7 px-3 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-xs"
                        title="Mark follow-up as complete"
                      >
                        <Check className="size-3.5" />
                        <span>Done</span>
                      </Button>

                      {/* Secondary actions */}
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleStartReschedule(followup)}
                          disabled={isPending}
                          className="h-7 px-2.5 text-xs gap-1 border-border/70 bg-card/40 hover:bg-card text-muted-foreground hover:text-foreground"
                          title="Reschedule follow-up"
                        >
                          <RotateCcw className="size-3" />
                          <span>Reschedule</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleCancelFollowup(followup)}
                          disabled={isPending}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title="Cancel this follow-up"
                          aria-label="Cancel this follow-up"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legacy followUpAt field when no follow-up rows exist in database */}
      {!isLoading && !isError && lead.followUpAt && activeFollowups.length === 0 && (
        <div className="rounded-xl border border-brand/20 bg-brand/5 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <CalendarCheck className="size-4 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">Scheduled follow-up</p>
              <p className="text-[11px] text-muted-foreground">{formatDate(lead.followUpAt)}</p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={async () => {
              try {
                await recordActivity.mutateAsync({
                  lead,
                  activity: {
                    type: "followup_completed",
                    timestamp: new Date().toISOString(),
                    content: "Follow-up completed",
                  },
                  patch: { followUpAt: null, status: "contacted" },
                });
                toast.success("Follow-up completed");
              } catch {
                toast.error("Could not complete follow-up");
              }
            }}
            disabled={isPending}
            className="h-7 px-3 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
          >
            <Check className="size-3.5" /> Done
          </Button>
        </div>
      )}

      {/* Empty state when no follow-ups scheduled */}
      {!isLoading && !isError && activeFollowups.length === 0 && !lead.followUpAt && (
        <div className="rounded-xl border border-border/60 bg-card/20 p-4 text-center space-y-1.5">
          <Calendar className="size-5 mx-auto text-muted-foreground/50" />
          <p className="text-xs font-semibold text-foreground">No active follow-ups</p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Schedule a touchpoint below to stay organized and ensure timely outreach.
          </p>
        </div>
      )}

      {/* Create / Schedule follow-up form */}
      <div className="rounded-xl border border-border/80 bg-[#0d121d]/70 p-3.5 space-y-3">
        <div className="flex items-center gap-1.5">
          <PlusCircle className="size-3.5 text-brand" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
            Schedule Follow-up
          </span>
        </div>

        <div className="space-y-2.5">
          {/* Channel selector */}
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Channel
            </label>
            <Select value={channel} onValueChange={(value) => setChannel(value as OutreachChannel)}>
              <SelectTrigger className="h-8.5 text-xs bg-background border-border/80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#101726] border-border text-xs">
                {CHANNELS.map((item) => (
                  <SelectItem key={item.value} value={item.value} className="text-xs">
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Due date */}
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Due Date
            </label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().split("T")[0]}
              disabled={isPending}
              className="h-8.5 text-xs bg-background border-border/80"
            />
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Notes (optional)
            </label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Follow up on custom proposal"
              disabled={isPending}
              className="h-8.5 text-xs bg-background border-border/80 placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        <Button
          onClick={handleSchedule}
          disabled={!date || isPending}
          className="w-full h-8.5 gap-1.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
        >
          {isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Scheduling…
            </>
          ) : (
            <>
              <Calendar className="size-3.5" /> Schedule Follow-up
            </>
          )}
        </Button>
      </div>

      {/* Completed follow-ups log (collapsible if any) */}
      {!isLoading && !isError && completedFollowups.length > 0 && (
        <details className="text-xs pt-1 text-muted-foreground group">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1.5 py-1">
            <span>Completed history ({completedFollowups.length})</span>
          </summary>
          <div className="mt-2 space-y-1.5 pt-1 border-t border-border/30">
            {completedFollowups.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between p-2 rounded-lg bg-card/20 border border-border/40 text-[11px] gap-2"
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
                  <Check className="size-3 text-emerald-400 shrink-0" />
                  <span className="capitalize font-medium text-foreground">{channelLabel(f.channel as OutreachChannel)}</span>
                  {f.notes && <span className="text-muted-foreground truncate">· {f.notes}</span>}
                </div>
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {f.status === "completed" ? "Done" : "Cancelled"}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function channelLabel(channel: string) {
  return CHANNELS.find((item) => item.value === channel)?.label ?? channel.replace(/_/g, " ");
}
