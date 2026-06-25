import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Check, Loader2, CalendarCheck } from "lucide-react";
import { toast } from "sonner";
import { useCreateFollowup, useRecordLeadActivity, useLeadFollowups } from "@/hooks/use-mast-api";
import type { Lead, OutreachChannel } from "@/lib/api";
import { CHANNELS, formatDate } from "@/lib/lead-workspace";

export function FollowUpsTab({ lead }: { lead: Lead }) {
  const [date, setDate] = useState(
    lead.followUpAt ? new Date(lead.followUpAt).toISOString().split("T")[0] : "",
  );
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [notes, setNotes] = useState("");
  const createFollowup = useCreateFollowup();
  const recordActivity = useRecordLeadActivity();
  const { data: followups = [] } = useLeadFollowups(lead.id);

  const isPending = createFollowup.isPending || recordActivity.isPending;

  const handleSchedule = async () => {
    if (!date) return;
    const followUpAt = new Date(date).toISOString();
    const channelLabelStr = channelLabel(channel);

    try {
      // Create the follow-up record (persists to Follow-Ups page)
      await createFollowup.mutateAsync({
        leadId: lead.id,
        channel,
        dueAt: followUpAt,
        notes: notes.trim() || undefined,
      });

      // Record activity to History tab
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

      setNotes("");
      toast.success("Follow-up scheduled");
    } catch {
      toast.error("Failed to schedule follow-up");
    }
  };

  const handleComplete = async (followupId?: number | string) => {
    const completedAt = new Date().toISOString();
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "followup_completed",
          timestamp: completedAt,
          content: "Follow-up completed",
          metadata: followupId ? { followupId } : undefined,
        },
        patch: { followUpAt: null, status: "contacted" },
      });
      setDate("");
      toast.success("Follow-up completed");
    } catch {
      toast.error("Could not complete follow-up");
    }
  };

  // Active follow-ups from the API
  const activeFollowups = Array.isArray(followups)
    ? followups.filter((f) => f.status !== "completed")
    : [];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar className="size-4 text-brand" />
            Follow-ups
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Active follow-ups list */}
          {activeFollowups.length > 0 && (
            <div className="space-y-2">
              {activeFollowups.map((followup) => (
                <div
                  key={followup.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/20 bg-brand/5 p-3"
                >
                  <CalendarCheck className="size-4 shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-foreground">
                      {channelLabel(followup.channel as OutreachChannel)} follow-up
                    </p>
                    <p className="text-xs text-muted-foreground">{formatDate(followup.dueAt)}</p>
                    {followup.notes && (
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">{followup.notes}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleComplete(followup.id)}
                    disabled={isPending}
                    className="gap-1.5"
                  >
                    <Check className="size-3.5" /> Done
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Legacy followUpAt field */}
          {lead.followUpAt && activeFollowups.length === 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/20 bg-brand/5 p-3">
              <CalendarCheck className="size-4 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">Scheduled follow-up</p>
                <p className="text-xs text-muted-foreground">{formatDate(lead.followUpAt)}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleComplete()}
                disabled={isPending}
                className="gap-1.5"
              >
                <Check className="size-3.5" /> Done
              </Button>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Channel
              </label>
              <Select value={channel} onValueChange={(value) => setChannel(value as OutreachChannel)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNELS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Due Date
              </label>
              <Input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                min={new Date().toISOString().split("T")[0]}
                disabled={isPending}
              />
            </div>
          </div>

          <Input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Notes for the next touch (optional)"
            disabled={isPending}
          />

          <Button
            onClick={handleSchedule}
            disabled={!date || isPending}
            className="w-full gap-2 bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Saving...
              </>
            ) : (
              <>
                <Calendar className="size-4" /> Schedule Follow-up
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function channelLabel(channel: string) {
  return CHANNELS.find((item) => item.value === channel)?.label ?? channel.replace(/_/g, " ");
}
