import { useState } from "react";
import { ArrowDownToLine, Loader2, MessageSquareText, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useGenerateOutreachDraft, useMe, useRecordLeadActivity, useSettings } from "@/hooks/use-mast-api";
import { isMissingBackendEndpoint, type Lead, type OutreachGenerationAction, type OutreachTone } from "@/lib/api";
import { normalizeDraftResponse, TEMPLATES, type DraftContent } from "@/lib/lead-workspace";
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

// Template-specific fallback content when AI endpoint is unavailable
function buildFallbackDraft(
  template: string,
  channel: Channel,
  lead: Lead,
  senderName: string,
): DraftContent {
  const name = lead.businessName;
  const ig = lead.instagramHandle ? `@${lead.instagramHandle.replace(/^@/, "")}` : name;
  const niche = lead.niche ?? "your business";
  const sender = senderName || "a web designer";

  if (channel === "instagram") {
    switch (template) {
      case "follow_up_2day":
        return {
          body: `Hey ${ig} 👋 Just wanted to follow up on my message from a couple days ago. I work with ${niche} businesses on branding and web presence — would love to chat if you're open to it!\n\n– ${senderName || ""}`.trim(),
        };
      case "follow_up_5day":
        return {
          body: `Hi ${ig}! Checking in one more time — I help ${niche} brands stand out online with clean, conversion-focused design. Happy to share some ideas specific to your brand. No pressure!\n\n– ${senderName || ""}`.trim(),
        };
      case "objection_handling":
        return {
          body: `Hey ${ig} — totally understand if now isn't the right time, or budget's tight. I work with businesses at all stages and offer flexible options. Even a quick chat could be valuable. Open to a 15-min call?\n\n– ${senderName || ""}`.trim(),
        };
      case "reengagement":
        return {
          body: `Hey ${ig}! It's been a while — hope ${name} is doing well. I've been helping ${niche} businesses refresh their online presence lately and had some ideas for you. Worth a quick chat?\n\n– ${senderName || ""}`.trim(),
        };
      default:
        return {
          body: `Hey ${ig}! 👋 I came across ${name} and love what you're building. I'm ${sender} who specializes in working with ${niche} brands — I think I could add real value to your online presence. Would love to connect!\n\n– ${senderName || ""}`.trim(),
        };
    }
  }

  // Email templates
  switch (template) {
    case "follow_up_2day":
      return {
        subject: `Following up — ${name}`,
        body: `Hi,\n\nI wanted to follow up on my previous message regarding ${name}'s online presence.\n\nI specialize in working with ${niche} businesses and I genuinely believe there's an opportunity to strengthen your brand and attract more customers through your website and design.\n\nWould you be open to a quick 15-minute call this week?\n\nBest,\n${senderName}`.trim(),
      };
    case "follow_up_5day":
      return {
        subject: `Last note — ${name}`,
        body: `Hi,\n\nI know your inbox is busy, so I'll keep this brief — this is my last follow-up.\n\nI help ${niche} businesses like ${name} create a polished digital presence that converts visitors into customers. If timing isn't right now, no worries at all.\n\nWhenever you're ready to invest in your brand's online experience, I'd love to be the one to help.\n\nAll the best,\n${senderName}`.trim(),
      };
    case "objection_handling":
      return {
        subject: `A few thoughts on your concerns — ${name}`,
        body: `Hi,\n\nI appreciate you getting back to me. I want to address a few common concerns:\n\n**"It's not the right time"** — Design work can be phased to fit your schedule and cash flow.\n\n**"It's too expensive"** — I offer flexible pricing tailored to ${niche} businesses at different growth stages.\n\n**"We handle it in-house"** — I work collaboratively and can supplement your team rather than replace it.\n\nWould a quick 15-minute call help clarify things?\n\nBest,\n${senderName}`.trim(),
      };
    case "reengagement":
      return {
        subject: `Reconnecting — ${name}`,
        body: `Hi,\n\nI hope ${name} has been thriving since we last spoke. I wanted to reach back out because I've been thinking about a few specific ideas that could be a great fit for your brand.\n\nA lot has changed in the ${niche} space — new design trends, conversion patterns, and customer expectations. I'd love to walk you through what I'm seeing and how it could apply to you.\n\nWould you be open to catching up this week?\n\nBest,\n${senderName}`.trim(),
      };
    case "pricing_transition":
      return {
        subject: `A note on pricing — ${name}`,
        body: `Hi,\n\nI wanted to reach out personally because I'm updating my service packages and pricing structure.\n\nCurrently, I'm offering a limited number of spots at my current rates before the change takes effect. Given your business in the ${niche} space, I thought this might be timely.\n\nIf you've been considering a refresh of your website or brand, now is a great time to lock in. Happy to talk through options.\n\nBest,\n${senderName}`.trim(),
      };
    default:
      return {
        subject: `Quick question for ${name}`,
        body: `Hi,\n\nI came across ${name} and was genuinely impressed — it's clear you care about the quality of your work.\n\nI'm a web designer and brand consultant who specializes in helping ${niche} businesses build a polished online presence that attracts more of the right customers.\n\nI'd love to share a few ideas specific to your brand — would you be open to a quick 15-minute call this week?\n\nBest,\n${senderName}`.trim(),
      };
  }
}

export function AIAssistant({ lead, channel, subject, body, onInsert }: AIAssistantProps) {
  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const generateDraft = useGenerateOutreachDraft();
  const recordActivity = useRecordLeadActivity();
  const [drafts, setDrafts] = useState<Partial<Record<Channel, DraftContent>>>({});
  const [insertedDraftKey, setInsertedDraftKey] = useState<string | null>(null);
  const [template, setTemplate] = useState("initial");
  const [customInstructions, setCustomInstructions] = useState("");

  const draft = drafts[channel] ?? null;
  const sourceSubject = draft?.subject ?? subject;
  const sourceBody = draft?.body ?? body;
  const isGenerating = generateDraft.isPending;
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
      if (isMissingBackendEndpoint(error)) {
        // Fallback: generate template-specific content locally
        const fallback = buildFallbackDraft(template, channel, lead, senderName);
        setDrafts((current) => ({ ...current, [channel]: fallback }));
        toast.success("Draft ready (template-based)");
        return;
      }
      const message = error instanceof Error ? error.message : "Could not generate outreach draft.";
      toast.error(message);
    }
  };

  const handleInsert = () => {
    if (!draft) return;
    onInsert(draft.body, draft.subject);
    setInsertedDraftKey(`${channel}:${draft.subject ?? ""}:${draft.body}`);
    toast.success("Draft inserted into editor");
  };

  const draftKey = draft ? `${channel}:${draft.subject ?? ""}:${draft.body}` : null;
  const inserted = draftKey !== null && insertedDraftKey === draftKey;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <div className="size-7 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
          <Sparkles className="size-3.5 text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">AI Assistant</p>
          <p className="text-[11px] text-muted-foreground">Generating for: {channelLabel}</p>
        </div>
      </div>

      <Button
        onClick={() => runAI("generate")}
        disabled={isGenerating}
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
            <RotateCcw className="size-3.5" />
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
            <MessageSquareText className="size-3.5" />
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
              <ArrowDownToLine className="size-3.5" />
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
