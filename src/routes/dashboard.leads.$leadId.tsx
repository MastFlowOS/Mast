import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useLead } from "@/hooks/use-mast-api";
import { LeadWorkspaceHeader } from "@/components/mast/workspace/LeadWorkspaceHeader";
import { LeftSidebar } from "@/components/mast/workspace/LeftSidebar";
import { CenterWorkspace } from "@/components/mast/workspace/CenterWorkspace";
import { RightSidebar } from "@/components/mast/workspace/RightSidebar";
import { ArrowLeft } from "lucide-react";

export type Channel = "email" | "instagram" | "phone" | "contact_form";

type ComposeDraft = {
  subject: string;
  body: string;
};

const emptyDrafts: Record<Channel, ComposeDraft> = {
  email: { subject: "", body: "" },
  instagram: { subject: "", body: "" },
  phone: { subject: "", body: "" },
  contact_form: { subject: "", body: "" },
};

export const Route = createFileRoute("/dashboard/leads/$leadId")({
  head: () => ({ meta: [{ title: "Outreach Workspace — Mast" }] }),
  component: LeadWorkspace,
});

import { useEffect } from "react";
import { useFreeOutreach } from "@/hooks/use-free-outreach";
import { useMe, useSettings } from "@/hooks/use-mast-api";
import type { OutreachChannel } from "@/lib/api";

const DEFAULT_DRAFT_CHANNELS: OutreachChannel[] = ["email", "instagram", "phone", "contact_form"];

function LeadWorkspace() {
  const { leadId } = Route.useParams();
  const navigate = useNavigate();
  const { data: lead, isLoading, isError } = useLead(leadId);

  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const freeOutreach = useFreeOutreach(lead);

  const [channel, setChannel] = useState<Channel>("email");
  const [drafts, setDrafts] = useState<Record<Channel, ComposeDraft>>(emptyDrafts);
  const [loadedLeadId, setLoadedLeadId] = useState<number | null>(null);
  const activeDraft = drafts[channel];

  const senderName = settings?.senderName ?? auth?.user?.fullName ?? "";

  // Default drafts come from the SAME deterministic pipeline the Generate
  // button uses — there is no second message-generation system, and no
  // fabricated placeholder copy. If the lead has no profession resolved,
  // the drafts stay empty rather than falling back to profession-neutral
  // filler.
  useEffect(() => {
    if (!lead || lead.id === loadedLeadId) return;
    let cancelled = false;
    setLoadedLeadId(lead.id);

    void (async () => {
      const next: Record<Channel, ComposeDraft> = { ...emptyDrafts };
      for (const target of DEFAULT_DRAFT_CHANNELS) {
        const result = await freeOutreach.generate("initial", target, senderName);
        if (result.ok) {
          next[target] = { subject: result.subject ?? "", body: result.body };
        }
      }
      if (!cancelled) setDrafts(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [lead, loadedLeadId, freeOutreach, senderName]);

  const setSubject = (subject: string) => {
    setDrafts((current) => ({
      ...current,
      [channel]: { ...current[channel], subject },
    }));
  };

  const setBody = (body: string) => {
    setDrafts((current) => ({
      ...current,
      [channel]: { ...current[channel], body },
    }));
  };

  const handleInsert = (newBody: string, newSubject?: string) => {
    setDrafts((current) => ({
      ...current,
      [channel]: {
        subject: newSubject ?? current[channel].subject,
        body: newBody,
      },
    }));
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex h-16 items-center gap-3 px-6 border-b border-border">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="size-9 rounded-xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="w-60 border-r border-border p-5 space-y-3">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
          </div>
          <div className="flex-1 p-8 space-y-5">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-60 w-full rounded-xl" />
            <Skeleton className="h-10 w-48 rounded-lg" />
          </div>
          <div className="w-[268px] border-l border-border p-5 space-y-4">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !lead) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center space-y-4 animate-scale-in">
          <div className="size-12 rounded-2xl bg-destructive/10 border border-destructive/20 grid place-items-center mx-auto">
            <span className="text-xl">⚠</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold">Opportunity not found</h2>
            <p className="text-sm text-muted-foreground mt-1">
              This opportunity may have been removed or is no longer accessible.
            </p>
          </div>
          <button
            onClick={() => navigate({ to: "/dashboard/pipeline" })}
            className="inline-flex items-center gap-2 text-sm text-brand font-medium hover:underline"
          >
            <ArrowLeft className="size-4" /> Back to Pipeline
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full animate-page-enter">
      <LeadWorkspaceHeader lead={lead} />
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <LeftSidebar lead={lead} channel={channel} setChannel={setChannel} />
        <CenterWorkspace
          lead={lead}
          channel={channel}
          setChannel={setChannel}
          subject={activeDraft.subject}
          setSubject={setSubject}
          body={activeDraft.body}
          setBody={setBody}
        />
        <RightSidebar
          lead={lead}
          channel={channel}
          subject={activeDraft.subject}
          body={activeDraft.body}
          onInsert={handleInsert}
        />
      </div>
    </div>
  );
}
