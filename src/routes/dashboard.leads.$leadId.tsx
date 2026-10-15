import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useLead, useMe, useOutreachStatus, useSettings, useGenerateOutreachDraft, useRecordLeadActivity } from "@/hooks/use-mast-api";
import { LeadWorkspaceHeader } from "@/components/mast/workspace/LeadWorkspaceHeader";
import { LeftSidebar } from "@/components/mast/workspace/LeftSidebar";
import { CenterWorkspace } from "@/components/mast/workspace/CenterWorkspace";
import { RightSidebar } from "@/components/mast/workspace/RightSidebar";
import { ArrowLeft } from "lucide-react";
import { useFreeOutreach } from "@/hooks/use-free-outreach";
import type { OutreachChannel, OutreachTone } from "@/lib/api";
import { isFreeTemplateKey } from "@/lib/outreach/templates";
import { normalizeDraftResponse, TEMPLATES } from "@/lib/lead-workspace";
import { resolveOutreachGenerationMode } from "@/lib/outreach/generationMode";
import { toast } from "sonner";

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

const DEFAULT_DRAFT_CHANNELS: OutreachChannel[] = ["email", "instagram", "phone", "contact_form"];

function LeadWorkspace() {
  const { leadId } = Route.useParams();
  const navigate = useNavigate();
  const { data: lead, isLoading, isError } = useLead(leadId);

  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const { data: outreachStatus } = useOutreachStatus();
  const freeOutreach = useFreeOutreach(lead);
  const generateDraft = useGenerateOutreachDraft();
  const recordActivity = useRecordLeadActivity();

  const [channel, setChannel] = useState<Channel>("email");
  const [template, setTemplate] = useState("initial");
  const [tone, setTone] = useState("friendly");
  const [drafts, setDrafts] = useState<Record<Channel, ComposeDraft>>(emptyDrafts);
  const [loadedLeadId, setLoadedLeadId] = useState<number | null>(null);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  const activeDraft = drafts[channel];
  const senderName = settings?.senderName ?? auth?.user?.fullName ?? "";

  const activeLeadIdRef = useRef(lead?.id);
  activeLeadIdRef.current = lead?.id;

  // Authoritative generation mode policy:
  // - Free plan -> fallback template
  // - AI not configured -> fallback template
  // - Paid plan AND AI configured -> actual AI generation
  const generationMode = resolveOutreachGenerationMode({
    plan: auth?.user?.plan,
    aiConfigured: outreachStatus?.aiConfigured,
  });

  // When switching to a new lead, reset drafts cleanly without mount-time automatic generation
  useEffect(() => {
    if (!lead || lead.id === loadedLeadId) return;
    setLoadedLeadId(lead.id);
    setDrafts(emptyDrafts);
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
        subject: newSubject !== undefined ? newSubject : current[channel].subject,
        body: newBody,
      },
    }));
  };

  const handleGenerate = async () => {
    if (!lead || isGenerating) return;
    setIsGenerating(true);
    const currentLeadId = lead.id;

    try {
      if (generationMode === "ai") {
        const response = await generateDraft.mutateAsync({
          leadId: lead.id,
          body: {
            channel,
            action: template === "objection_handling" ? "objections" : "generate",
            tone: (tone as OutreachTone) || "friendly",
            template,
            subject: activeDraft.subject || undefined,
            body: activeDraft.body || undefined,
            senderName,
          },
        });

        if (activeLeadIdRef.current !== currentLeadId) return;

        const next = normalizeDraftResponse(response);
        if (next.body) {
          handleInsert(next.body, next.subject);
          toast.success("AI draft generated");
        } else {
          toast.error("AI response returned an empty message body");
        }
      } else {
        const templateKey = isFreeTemplateKey(template) ? template : "initial";
        const result = await freeOutreach.generate(templateKey, channel, senderName);

        if (activeLeadIdRef.current !== currentLeadId) return;

        if (!result.ok) {
          toast.error(result.detail);
          return;
        }
        handleInsert(result.body, result.subject ?? undefined);
        void recordActivity.mutateAsync({
          lead,
          activity: {
            type: "message_generated",
            channel,
            subject: result.subject ?? undefined,
            body: result.body,
            content: `${channel} draft generated (${TEMPLATES.find((t) => t.value === templateKey)?.label ?? templateKey})`,
            metadata: { template: templateKey, angleComponent: result.angleComponent, angleSource: result.angleSource },
          },
        });
        toast.success("Draft generated");
      }
    } catch (error: any) {
      if (activeLeadIdRef.current !== currentLeadId) return;
      let msg = error instanceof Error ? error.message : "Could not generate draft";
      if (error?.status === 429 || msg.includes("rate limit") || msg.includes("429")) {
        msg = "AI request rate-limited. Please wait a moment and try again.";
      } else if (error?.status === 504 || msg.includes("timeout")) {
        msg = "AI generation timed out. Please try again.";
      } else if (error?.status === 503 || msg.includes("not configured")) {
        msg = "AI service is currently unavailable. Please try again shortly.";
      }
      toast.error(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRewrite = async (type: "rewrite" | "expand" | "shorten" = "rewrite") => {
    if (!lead || isGenerating) return;
    if (!activeDraft.body.trim()) {
      toast.error("Add a message before rewriting");
      return;
    }
    setIsGenerating(true);
    const currentLeadId = lead.id;
    const instruction =
      type === "expand"
        ? "Expand with more detail, proof points, and depth"
        : type === "shorten"
          ? "Make it concise, punchy, and under 75 words"
          : `Rewrite in a ${tone} tone`;

    try {
      const response = await generateDraft.mutateAsync({
        leadId: lead.id,
        body: {
          channel,
          action: type,
          tone: (tone as OutreachTone) || "friendly",
          template,
          customInstructions: instruction,
          subject: activeDraft.subject,
          body: activeDraft.body,
          senderName,
        },
      });

      if (activeLeadIdRef.current !== currentLeadId) return;

      const next = normalizeDraftResponse(response);
      if (next.body) {
        handleInsert(next.body, next.subject);
        toast.success(type === "expand" ? "Draft expanded" : type === "shorten" ? "Draft shortened" : "Draft rewritten");
      }
    } catch (error: any) {
      if (lead.id !== currentLeadId) return;
      let msg = error instanceof Error ? error.message : "Could not rewrite draft";
      if (error?.status === 429 || msg.includes("rate limit") || msg.includes("429")) {
        msg = "AI request rate-limited. Please wait a moment and try again.";
      } else if (error?.status === 504 || msg.includes("timeout")) {
        msg = "AI generation timed out. Please try again.";
      }
      toast.error(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-[#0b0f17]">
        <div className="flex h-14 items-center gap-3 px-6 border-b border-border">
          <Skeleton className="h-8 w-28 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
          <div className="ml-auto flex gap-2">
            <Skeleton className="size-8 rounded-lg" />
            <Skeleton className="h-8 w-20 rounded-lg" />
            <Skeleton className="h-8 w-28 rounded-lg" />
          </div>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <div className="w-[320px] border-r border-border p-5 space-y-4">
            <Skeleton className="h-32 w-full rounded-2xl" />
            <Skeleton className="h-44 w-full rounded-2xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
          <div className="flex-1 p-7 space-y-4">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-10 w-64 rounded-xl" />
          </div>
          <div className="w-[320px] border-l border-border p-5 space-y-4">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !lead) {
    return (
      <div className="flex h-full items-center justify-center p-6 bg-[#0b0f17]">
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
            type="button"
            onClick={() => navigate({ to: "/dashboard/relationships" })}
            className="inline-flex items-center gap-2 text-sm text-brand font-medium hover:underline"
          >
            <ArrowLeft className="size-4" /> Back to Relationships
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0b0f17] animate-page-enter overflow-hidden">
      <LeadWorkspaceHeader lead={lead} channel={channel} />
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
          template={template}
          setTemplate={setTemplate}
          tone={tone}
          setTone={setTone}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          onRewrite={handleRewrite}
        />
        <RightSidebar
          lead={lead}
          channel={channel}
          subject={activeDraft.subject}
          body={activeDraft.body}
          onInsert={handleInsert}
          template={template}
          setTemplate={setTemplate}
          tone={tone}
          setTone={setTone}
          isOpen={aiAssistantOpen}
          onToggle={() => setAiAssistantOpen((prev) => !prev)}
        />
      </div>
    </div>
  );
}
