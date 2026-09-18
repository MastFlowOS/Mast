import { useState } from "react";
import { ArrowDownToLine, Loader2, MessageSquareText, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useGenerateOutreachDraft, useMe, useRecordLeadActivity, useSettings } from "@/hooks/use-mast-api";
import { type Lead, type OutreachGenerationAction, type OutreachTone } from "@/lib/api";
import { normalizeDraftResponse, TEMPLATES, type DraftContent } from "@/lib/lead-workspace";
import { useFreeOutreach } from "@/hooks/use-free-outreach";
import { isFreeTemplateKey } from "@/lib/outreach/templates";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { LockedFeatureCard } from "@/components/mast/LockedFeatureCard";

interface AIAssistantProps {
  lead: Lead;
  channel: Channel;
  subject: string;
  body: string;
  onInsert: (body: string, subject?: string) => void;
}

const REWRITE_TONES: { tone: OutreachTone; label: string }[] = [
  { tone: "friendly", label: "Rewrite Friendly" },
  { tone: "professional", label: "Rewrite Professional" },
  { tone: "direct", label: "Rewrite Direct" },
];

export function AIAssistant({ lead, channel, subject, body, onInsert }: AIAssistantProps) {
  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const generateDraft = useGenerateOutreachDraft();
  const recordActivity = useRecordLeadActivity();
  const freeOutreach = useFreeOutreach(lead);
  const [isGeneratingFree, setIsGeneratingFree] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<Channel, DraftContent>>>({});
  const [insertedDraftKey, setInsertedDraftKey] = useState<string | null>(null);
  const [template, setTemplate] = useState("initial");
  const [customInstructions, setCustomInstructions] = useState("");

  const draft = drafts[channel] ?? null;
  const sourceSubject = draft?.subject ?? subject;
  const sourceBody = draft?.body ?? body;
  const isGenerating = generateDraft.isPending || isGeneratingFree;
  const senderName = settings?.senderName ?? auth?.user?.fullName ?? "";
  const channelLabel =
    channel === "email"
      ? "Email"
      : channel === "instagram"
        ? "DM"
        : channel === "contact_form"
          ? "Contact Form"
          : "Call Script";

  const runAI = async (action: OutreachGenerationAction, tone?: OutreachTone) => {
    if (action === "rewrite" && !sourceBody.trim()) {
      toast.error("Add or generate a draft before rewriting.");
      return;
    }

    setInsertedDraftKey(null);

    try {
      const response = await generateDraft.mutateAsync({
        leadId: lead.id,
        body: {
          channel,
          action,
          tone,
          template,
          customInstructions: customInstructions.trim() || undefined,
          subject: sourceSubject,
          body: sourceBody,
          senderName,
          senderEmail: settings?.senderEmail ?? auth?.user?.email ?? "",
          signature: settings?.signature ?? "",
        },
      });
      const nextDraft = normalizeDraftResponse(response);

      if (!nextDraft.body) {
        throw new Error("The AI endpoint returned an empty draft.");
      }

      setDrafts((current) => ({ ...current, [channel]: nextDraft }));

      void recordActivity.mutateAsync({
        lead,
        activity: {
          type: "message_generated",
          channel,
          subject: nextDraft.subject,
          body: nextDraft.body,
          content:
            action === "rewrite"
              ? `${channelLabel} rewritten in ${tone ?? "selected"} tone`
              : action === "objections"
                ? "Objection handling generated"
                : `${channelLabel} draft generated (${TEMPLATES.find((t) => t.value === template)?.label ?? template})`,
          metadata: { action, tone, template },
        },
      });

      toast.success(action === "rewrite" ? "Draft rewritten" : "Draft generated");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate outreach draft.";
      toast.error(message);
    }
  };

  /**
   * The deterministic Free path. Entirely local apart from the existing
   * deterministic Opportunity Explanation read — it never touches
   * generateOutreachDraft() or any AI endpoint.
   */
  const runFreeGeneration = async () => {
    if (!isFreeTemplateKey(template)) {
      toast.error("That template is part of the AI plan.");
      return;
    }
    setInsertedDraftKey(null);
    setIsGeneratingFree(true);
    try {
      const result = await freeOutreach.generate(template, channel, senderName);
      if (!result.ok) {
        toast.error(result.detail);
        return;
      }
      const nextDraft: DraftContent = { subject: result.subject ?? undefined, body: result.body };
      setDrafts((current) => ({ ...current, [channel]: nextDraft }));

      // A generated draft is NOT a send: message_generated only, never a
      // lastContactedAt patch and never a genuine-send activity type.
      void recordActivity.mutateAsync({
        lead,
        activity: {
          type: "message_generated",
          channel,
          subject: nextDraft.subject,
          body: nextDraft.body,
          content: `${channelLabel} draft generated (${TEMPLATES.find((t) => t.value === template)?.label ?? template})`,
          metadata: { template, angleComponent: result.angleComponent, angleSource: result.angleSource },
        },
      });

      toast.success("Draft ready");
    } finally {
      setIsGeneratingFree(false);
    }
  };

  const handleInsert = () => {
    if (!draft) return;
    onInsert(draft.body, draft.subject);
    setInsertedDraftKey(`${channel}:${draft.subject ?? ""}:${draft.body}`);
    toast.success("Draft inserted into editor");
  };

  // Deterministic eligibility for the currently-selected template. Shown
  // inline next to the disabled Generate button rather than failing on click.
  const templateIsFree = isFreeTemplateKey(template);
  const eligibility = templateIsFree ? freeOutreach.checkEligibility(template) : null;
  const refusalReason =
    !templateIsFree
      ? "Objection Handling is part of the AI plan and isn't generated locally."
      : eligibility !== true && eligibility !== null
        ? eligibility.refusalReason
        : null;

  const draftKey = draft ? `${channel}:${draft.subject ?? ""}:${draft.body}` : null;
  const inserted = draftKey !== null && insertedDraftKey === draftKey;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <div className="size-7 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
          <Sparkles className="size-4 text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">AI Assistant</p>
          <p className="text-[11px] text-muted-foreground">Generating for: {channelLabel}</p>
        </div>
      </div>

      <Button
        onClick={() => void runFreeGeneration()}
        disabled={isGenerating || refusalReason !== null}
        className="w-full gap-2 bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        {isGenerating ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Writing...
          </>
        ) : (
          <>
            <Wand2 className="size-4" /> Generate {channelLabel}
          </>
        )}
      </Button>

      {refusalReason && (
        <p className="text-[11px] text-muted-foreground -mt-3">{refusalReason}</p>
      )}

      <div className="space-y-3 rounded-xl border border-border bg-background p-3">
        <div className="space-y-1.5">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Template</p>
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                  {item.tier === "ai" ? " (AI plan)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {template === "initial" && "First touch — introduce yourself and your value."}
            {template === "follow_up_2day" && "Gentle nudge 2 days after initial outreach."}
            {template === "follow_up_5day" && "Final follow-up at the 5-day mark."}
            {template === "buried_bump" && "Short bump to resurface a buried message."}
            {template === "objection_handling" && "Address common hesitations directly."}
            {template === "reengagement" && "Re-open conversation with a cold lead."}
            {template === "pricing_transition" && "Leverage urgency around a pricing change."}
          </p>
        </div>
        <div className="space-y-1.5">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Instructions</p>
          <Textarea
            value={customInstructions}
            onChange={(event) => setCustomInstructions(event.target.value)}
            placeholder="Mention a recent post, objection, offer angle, or next step..."
            className="min-h-20 resize-none text-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        {REWRITE_TONES.map((item) => (
          <Button
            key={item.tone}
            variant="outline"
            size="sm"
            onClick={() => runAI("rewrite", item.tone)}
            disabled={isGenerating || !sourceBody.trim()}
            className="justify-start gap-2 text-xs"
          >
            <RotateCcw className="size-4" />
            {item.label}
          </Button>
        ))}

        {channel === "phone" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAI("objections", "direct")}
            disabled={isGenerating}
            className="justify-start gap-2 text-xs"
          >
            <MessageSquareText className="size-4" />
            Generate Objection Handling
          </Button>
        )}
      </div>

      {(isGenerating || draft) && (
        <div className="space-y-3">
          <div className="h-px bg-border" />

          {isGenerating ? (
            <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-2">
              {[70, 90, 55, 80, 40].map((width, index) => (
                <div key={index} className="h-3 rounded bg-muted animate-pulse" style={{ width: `${width}%` }} />
              ))}
            </div>
          ) : draft ? (
            <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-2">
              {draft.subject && (
                <p className="text-[11px] font-bold text-brand uppercase tracking-wider">
                  Subject: {draft.subject}
                </p>
              )}
              <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">{draft.body}</p>
            </div>
          ) : null}

          {draft && !isGenerating && (
            <Button
              size="sm"
              onClick={handleInsert}
              className={`w-full gap-1.5 ${
                inserted
                  ? "bg-green-500/15 border border-green-500/30 text-green-600 hover:bg-green-500/15"
                  : "bg-brand hover:bg-brand/90 text-brand-foreground"
              }`}
            >
              <ArrowDownToLine className="size-4" />
              {inserted ? "Inserted" : "Insert into Editor"}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-2">
        <div className="h-px bg-border" />
        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground pt-1">
          Personalization Inputs
        </p>
        <div className="space-y-2">
          {lead.location && (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Location: {lead.location}
              </p>
            </div>
          )}
          {lead.niche && (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <p className="text-xs text-muted-foreground leading-relaxed">Niche: {lead.niche}</p>
            </div>
          )}
          {(settings?.senderName || auth?.user?.fullName) && (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Sender: {settings?.senderName ?? auth?.user?.fullName}
              </p>
            </div>
          )}
        </div>
      </div>

      {(auth?.user?.plan === "free" || auth?.user?.plan === "starter") && (
        <div className="pt-2">
          <LockedFeatureCard
            featureName="Standard AI Personalization"
            requiredPlan="pro"
            description="Unlock automated sequences, multi-channel triggers, and deeper context-aware drafts."
            valueProposition="Increase your response rates by 3x with multi-touch outreach flows."
          />
        </div>
      )}
    </div>
  );
}
