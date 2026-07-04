import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Phone, CheckCircle, MessagesSquare, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useRecordLeadActivity } from "@/hooks/use-mast-api";
import type { Lead } from "@/lib/api";
import { appendVisibleNote } from "@/lib/lead-workspace";

interface PhoneFormProps {
  lead: Lead;
  body: string;
  setBody: (v: string) => void;
}

export function PhoneForm({ lead, body, setBody }: PhoneFormProps) {
  const [isCalled, setIsCalled] = useState(false);
  const [callNotes, setCallNotes] = useState("");
  const recordActivity = useRecordLeadActivity();

  const saveCallNotes = async () => {
    const trimmed = callNotes.trim();
    if (!trimmed) return;
    const notes = appendVisibleNote(lead.notes, `Call notes:\n${trimmed}`);

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "note_added",
          channel: "phone",
          content: `Call notes saved: ${trimmed.slice(0, 100)}${trimmed.length > 100 ? "..." : ""}`,
        },
        patch: { notes },
      });
      setCallNotes("");
      toast.success("Call notes saved");
    } catch {
      toast.error("Could not save call notes");
    }
  };

  const markCalled = async () => {
    const completedAt = new Date().toISOString();
    const trimmedNotes = callNotes.trim();
    const patch = {
      status: "outreach",
      lastContactedAt: completedAt,
      ...(trimmedNotes ? { notes: appendVisibleNote(lead.notes, `Call notes:\n${trimmedNotes}`) } : {}),
    };

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "call_completed",
          channel: "phone",
          body,
          timestamp: completedAt,
          content: trimmedNotes ? `Call completed: ${trimmedNotes.slice(0, 100)}` : "Call completed",
        },
        patch,
      });
      setIsCalled(true);
      setCallNotes("");
      toast.success("Marked as called");
    } catch {
      toast.error("Could not mark call as completed");
    }
  };

  return (
    <div className="space-y-5">
      {lead.phone && (
        <a
          href={`tel:${lead.phone}`}
          className="flex items-center gap-3 px-4 py-3 rounded-xl bg-brand/5 border border-brand/20 hover:bg-brand/10 transition-colors group"
        >
          <div className="size-8 rounded-lg bg-brand/10 grid place-items-center shrink-0">
            <Phone className="size-4 text-brand" />
          </div>
          <span className="text-sm font-semibold">{lead.phone}</span>
          <span className="ml-auto text-xs font-bold text-brand opacity-0 group-hover:opacity-100 transition-opacity">
            Call now →
          </span>
        </a>
      )}

      <div className="space-y-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          Call Script
        </label>
        <Textarea
          placeholder="Write a call script, or use the AI Assistant to generate one..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[220px] resize-y text-sm font-mono leading-relaxed md:min-h-[260px]"
        />
      </div>

      <div className="space-y-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          Call Notes
        </label>
        <Textarea
          placeholder="Capture objections, buying signals, and next steps..."
          value={callNotes}
          onChange={(e) => setCallNotes(e.target.value)}
          className="min-h-[120px] resize-y text-sm leading-relaxed"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={saveCallNotes}
          disabled={!callNotes.trim() || recordActivity.isPending}
          className="w-full gap-1.5 sm:w-auto"
        >
          {recordActivity.isPending ? <Loader2 className="size-4 animate-spin" /> : <MessagesSquare className="size-4" />}
          Save Call Notes
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={markCalled}
          disabled={isCalled || recordActivity.isPending}
          className="w-full gap-1.5 text-muted-foreground hover:text-foreground sm:ml-auto sm:w-auto"
        >
          <CheckCircle className={`size-4 ${isCalled ? "text-green-500" : ""}`} />
          {isCalled ? "Called" : "Mark Called"}
        </Button>
      </div>
    </div>
  );
}
