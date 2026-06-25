import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRecordLeadActivity } from "@/hooks/use-mast-api";
import type { Lead } from "@/lib/api";
import { appendVisibleNote, stripActivityMarkers } from "@/lib/lead-workspace";

// Patterns injected by the backend/scraper that should never be shown to users
const SYSTEM_NOISE_PATTERNS = [
  /Generated locally because SCRAPER_API_URL is not configured[^\n]*/gi,
  /Generated locally[^\n]*/gi,
  /SCRAPER_API_URL is not configured[^\n]*/gi,
];

function cleanNotesForDisplay(notes: string): string {
  let result = notes;
  for (const pattern of SYSTEM_NOISE_PATTERNS) {
    result = result.replace(pattern, "");
  }
  // Collapse multiple blank lines left after removal
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function NoteForm({ lead }: { lead: Lead }) {
  const [content, setContent] = useState("");
  const recordActivity = useRecordLeadActivity();
  const rawNotes = stripActivityMarkers(lead.notes);
  const visibleNotes = cleanNotesForDisplay(rawNotes);

  const handleSubmit = async () => {
    const trimmed = content.trim();
    const notes = appendVisibleNote(lead.notes, trimmed);
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "note_added",
          content: `Note added: ${trimmed.slice(0, 100)}${trimmed.length > 100 ? "..." : ""}`,
        },
        patch: { notes },
      });
      setContent("");
      toast.success("Note saved");
    } catch {
      toast.error("Failed to save note");
    }
  };

  return (
    <div className="space-y-3">
      {visibleNotes && (
        <div className="rounded-lg bg-muted/40 border border-border p-3 max-h-48 overflow-y-auto">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Saved Notes</p>
          <pre className="text-xs text-foreground whitespace-pre-wrap font-sans leading-relaxed">
            {visibleNotes}
          </pre>
        </div>
      )}

      <Textarea
        placeholder="Add a note…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="min-h-[100px] resize-none"
        disabled={recordActivity.isPending}
      />

      <Button
        onClick={handleSubmit}
        disabled={recordActivity.isPending || !content.trim()}
        className="w-full gap-2 bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        {recordActivity.isPending ? (
          <><Loader2 className="size-4 animate-spin" /> Saving…</>
        ) : (
          <><Plus className="size-4" /> Add Note</>
        )}
      </Button>
    </div>
  );
}
