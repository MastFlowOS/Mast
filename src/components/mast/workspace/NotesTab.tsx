import { NoteForm } from "./components/NoteForm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StickyNote } from "lucide-react";
import type { Lead } from "@/lib/api";

export function NotesTab({ lead }: { lead: Lead }) {
  return (
    <div className="p-4 md:p-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <StickyNote className="size-4 text-brand" />
            Notes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NoteForm lead={lead} />
        </CardContent>
      </Card>
    </div>
  );
}
