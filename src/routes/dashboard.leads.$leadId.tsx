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
  head: () => ({ meta: [{ title: "Lead Workspace — Mast" }] }),
  component: LeadWorkspace,
});

function LeadWorkspace() {
  const { leadId } = Route.useParams();
  const navigate = useNavigate();
  const { data: lead, isLoading, isError } = useLead(leadId);

  const [channel, setChannel] = useState<Channel>("email");
  const [drafts, setDrafts] = useState<Record<Channel, ComposeDraft>>(emptyDrafts);
  const activeDraft = drafts[channel];

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
        <div className="text-center space-y-4">
          <div className="size-12 rounded-2xl bg-destructive/10 border border-destructive/20 grid place-items-center mx-auto">
            <span className="text-xl">⚠</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold">Lead not found</h2>
            <p className="text-sm text-muted-foreground mt-1">
              This lead may have been deleted or is no longer accessible.
            </p>
          </div>
          <button
            onClick={() => navigate({ to: "/dashboard/crm" })}
            className="inline-flex items-center gap-2 text-sm text-brand font-medium hover:underline"
          >
            <ArrowLeft className="size-4" /> Back to CRM
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
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
