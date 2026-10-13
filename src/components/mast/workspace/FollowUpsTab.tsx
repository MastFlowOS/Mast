import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Check, Loader2, CalendarCheck, Clock, X, RotateCcw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  useCreateFollowup,
  useUpdateFollowup,
  useRecordLeadActivity,
  useLeadFollowups,
} from "@/hooks/use-mast-api";
import type { Followup, Lead, OutreachChannel } from "@/lib/api";
import { CHANNELS, formatDate } from "@/lib/lead-workspace";

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
    <div className="space-y-3">
      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center p-6 text-muted-foreground gap-2 text-xs">
          <Loader2 className="size-4 animate-spin text-brand" />
          <span>Loading follow-ups…</span>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive space-y-2">
          <div className="flex items-center gap-1.5 font-semibold">
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
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Upcoming ({activeFollowups.length})
          </p>
          {activeFollowups.map((followup) => {
            const isEditing = reschedulingId === followup.id;

            return (
              <div
                key={followup.id}
                className="rounded-xl border border-border/80 bg-card/60 p-3 space-y-2.5 transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/15 text-indigo-400 border border-indigo-500/25">
                        {channelLabel(followup.channel as OutreachChannel)}
                      </span>
                      <span className="text-xs font-semibold text-foreground flex items-center gap-1">
                        <Clock className="size-3 text-muted-foreground" />
                        {formatDate(followup.dueAt)}
                      </span>
                    </div>
                    {followup.notes && (
                      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                        {followup.notes}
                      </p>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="pt-2 border-t border-border/60 space-y-2 animate-fade-in">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold uppercase text-muted-foreground">
                        New Due Date
                      </label>
                      <Input
                        type="date"
                        value={rescheduleDate}
                        onChange={(e) => setRescheduleDate(e.target.value)}
                        min={new Date().toISOString().split("T")[0]}
                        disabled={isPending}
                        className="h-8 text-xs bg-card/80"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold uppercase text-muted-foreground">
                        Notes
                      </label>
                      <Input
                        value={rescheduleNotes}
                        onChange={(e) => setRescheduleNotes(e.target.value)}
                        placeholder="Add or update notes…"
                        disabled={isPending}
                        className="h-8 text-xs bg-card/80"
                      />
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() => void handleSaveReschedule(followup.id)}
                        disabled={isPending || !rescheduleDate}
                        className="h-7 text-xs bg-brand hover:bg-brand/90 gap-1"
                      >
                        {isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReschedulingId(null)}
                        disabled={isPending}
                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleComplete(followup)}
                      disabled={isPending}
                      className="h-7 px-2.5 text-xs gap-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                      title="Mark follow-up as complete"
                    >
                      <Check className="size-3" /> Done
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleStartReschedule(followup)}
                      disabled={isPending}
                      className="h-7 px-2.5 text-xs gap-1 border-border/70 hover:bg-card text-muted-foreground hover:text-foreground"
                      title="Reschedule follow-up"
                    >
                      <RotateCcw className="size-3" /> Reschedule
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleCancelFollowup(followup)}
                      disabled={isPending}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Cancel this follow-up"
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Legacy followUpAt field when no follow-up rows exist in database */}
      {!isLoading && !isError && lead.followUpAt && activeFollowups.length === 0 && (
        <div className="rounded-xl border border-brand/20 bg-brand/5 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <CalendarCheck className="size-4 shrink-0 text-brand" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">Scheduled follow-up</p>
              <p className="text-xs text-muted-foreground">{formatDate(lead.followUpAt)}</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
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
            className="h-7 text-xs gap-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
          >
            <Check className="size-3" /> Done
          </Button>
        </div>
      )}

      {/* Empty state when no follow-ups scheduled */}
      {!isLoading && !isError && activeFollowups.length === 0 && !lead.followUpAt && (
        <div className="rounded-xl border border-border/60 bg-card/20 p-3 text-center space-y-1">
          <Calendar className="size-5 mx-auto text-muted-foreground/50" />
          <p className="text-xs font-medium text-muted-foreground">No active follow-ups</p>
          <p className="text-[11px] text-muted-foreground/70">
            Schedule a touchpoint below to stay on top of this lead.
          </p>
        </div>
      )}

      {/* Create / Schedule follow-up form */}
      <div className="rounded-xl border border-border/80 bg-card/40 p-3 space-y-2.5">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Calendar className="size-3 text-brand" />
          Schedule Follow-up
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase">
              Channel
            </label>
            <Select value={channel} onValueChange={(value) => setChannel(value as OutreachChannel)}>
              <SelectTrigger className="h-8 text-xs bg-card/60 border-border/70">
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

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase">
              Due Date
            </label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().split("T")[0]}
              disabled={isPending}
              className="h-8 text-xs bg-card/60 border-border/70"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-muted-foreground uppercase">
            Notes (optional)
          </label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Follow up on custom design quote"
            disabled={isPending}
            className="h-8 text-xs bg-card/60 border-border/70 placeholder:text-muted-foreground/60"
          />
        </div>

        <Button
          onClick={handleSchedule}
          disabled={!date || isPending}
          className="w-full h-8 gap-1.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-medium rounded-lg shadow-sm"
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
        <details className="text-xs pt-1 text-muted-foreground">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-muted-foreground hover:text-foreground">
            Completed history ({completedFollowups.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {completedFollowups.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between p-2 rounded-lg bg-card/20 border border-border/40 text-[11px]"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <Check className="size-3 text-emerald-400 shrink-0" />
                  <span className="capitalize">{channelLabel(f.channel as OutreachChannel)}</span>
                  {f.notes && <span className="text-muted-foreground/80 truncate">· {f.notes}</span>}
                </div>
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {f.status === "completed" ? "Completed" : "Cancelled"}
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
