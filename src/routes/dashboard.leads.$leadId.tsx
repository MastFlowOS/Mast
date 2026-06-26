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

function buildDefaultDraftsForLead(lead: Lead): Record<Channel, ComposeDraft> {
  const name = lead.businessName;
  const niche = lead.niche || "your industry";
  const location = lead.location || "your area";
  const ig = lead.instagramHandle ? `@${lead.instagramHandle.replace(/^@/, "")}` : name;

  return {
    email: {
      subject: `Partnership proposal for ${name}`,
      body: `Hi,

I came across ${name} while researching top-performing businesses in the ${niche} vertical in ${location}. 

I noticed a couple of quick improvements that could help you capture more inbound customers from your online presence. Specifically, we've helped similar brands increase conversion rates by optimizing mobile checkouts and customer booking forms.

Would you be open to a quick 5-minute chat next week to see some examples?

Best,
[Your Name]
MAST OS`,
    },
    instagram: {
      subject: "",
      body: `Hey ${ig} 👋 I came across ${name} and really liked your posts. I help ${niche} brands optimize their mobile branding and conversion pathways. Would love to send over a quick mockup if you're open to it? No pressure at all!`,
    },
    phone: {
      subject: "",
      body: `[Phone Script]
      
"Hi, is this the owner or manager at ${name}? 
Great. My name is [Your Name], and I'm calling because I specialize in helping ${niche} companies in ${location} capture more customers from their website. 

I was looking at your mobile booking page and noticed a quick fix that could prevent potential customers from bouncing. 

Do you have 2 minutes to talk, or should I send over a quick email with the details?"`,
    },
    contact_form: {
      subject: "Quick question regarding website optimization",
      body: `Hi team,

I came across your contact form while auditing websites in the ${niche} sector. 

I noticed a quick adjustment you could make to the booking flow of ${name} that could help prevent customer drop-off. 

If you are open to it, I'd love to share the recommendation. Where is the best place to send it?

Best,
[Your Name]`,
    },
  };
}

function LeadWorkspace() {
  const { leadId } = Route.useParams();
  const navigate = useNavigate();
  const { data: lead, isLoading, isError } = useLead(leadId);

  const [channel, setChannel] = useState<Channel>("email");
  const [drafts, setDrafts] = useState<Record<Channel, ComposeDraft>>(emptyDrafts);
  const [loadedLeadId, setLoadedLeadId] = useState<number | null>(null);
  const activeDraft = drafts[channel];

  useEffect(() => {
    if (lead && lead.id !== loadedLeadId) {
      setDrafts(buildDefaultDraftsForLead(lead));
      setLoadedLeadId(lead.id);
    }
  }, [lead, loadedLeadId]);

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
            onClick={() => navigate({ to: "/dashboard/crm" })}
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
