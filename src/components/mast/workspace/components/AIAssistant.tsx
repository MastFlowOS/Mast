import { useState } from "react";
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
  Wand2,
  Edit2,
  Sliders,
  AlignLeft,
  MessageCircle,
  Target,
  Loader2,
  Check,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import type { Lead, OutreachTone } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { useGenerateOutreachDraft, useMe, useRecordLeadActivity, useSettings } from "@/hooks/use-mast-api";
import { normalizeDraftResponse, TEMPLATES } from "@/lib/lead-workspace";
import { useFreeOutreach } from "@/hooks/use-free-outreach";
import { isFreeTemplateKey } from "@/lib/outreach/templates";

interface AIAssistantProps {
  lead: Lead;
  channel: Channel;
  subject: string;
  body: string;
  onInsert: (body: string, subject?: string) => void;
  template: string;
  setTemplate: (t: string) => void;
  tone: string;
  setTone: (t: string) => void;
  onHide?: () => void;
}

type TabType = "write" | "improve" | "ideas" | "research";

export function AIAssistant({
  lead,
  channel,
  subject,
  body,
  onInsert,
  template,
  setTemplate,
  tone,
  setTone,
  onHide,
}: AIAssistantProps) {
  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const generateDraft = useGenerateOutreachDraft();
  const recordActivity = useRecordLeadActivity();
  const freeOutreach = useFreeOutreach(lead);

  const [activeTab, setActiveTab] = useState<TabType>("write");
  const [isGeneratingFree, setIsGeneratingFree] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");

  // Accordion state - Generate Message open by default, all others collapsed by default
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    generate: true,
    rewrite: false,
    tone: false,
    length: false,
    more: false,
    cta: false,
  });

  // Personalization context checkboxes
  const [personalization, setPersonalization] = useState({
    businessNameAndNiche: true,
    recentInstagramActivity: true,
    locationAndLocalMarket: true,
    businessReviewsAndReputation: true,
    similarBusinessSuccessStories: true,
  });
  const [editingContext, setEditingContext] = useState(false);
  const [customContextNotes, setCustomContextNotes] = useState("");

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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

  const runGeneration = async () => {
    if (isFreeTemplateKey(template)) {
      setIsGeneratingFree(true);
      try {
        const result = await freeOutreach.generate(template, channel, senderName);
        if (!result.ok) {
          toast.error(result.detail);
          return;
        }
        onInsert(result.body, result.subject ?? undefined);
        void recordActivity.mutateAsync({
          lead,
          activity: {
            type: "message_generated",
            channel,
            subject: result.subject ?? undefined,
            body: result.body,
            content: `${channelLabel} draft generated (${TEMPLATES.find((t) => t.value === template)?.label ?? template})`,
            metadata: { template, angleComponent: result.angleComponent, angleSource: result.angleSource },
          },
        });
        toast.success("Message generated & inserted");
      } finally {
        setIsGeneratingFree(false);
      }
    } else {
      // Paid AI path
      try {
        const response = await generateDraft.mutateAsync({
          leadId: lead.id,
          body: {
            channel,
            action: "generate",
            tone: (tone as OutreachTone) || "friendly",
            template,
            customInstructions: customInstructions.trim() || undefined,
            subject,
            body,
            senderName,
          },
        });
        const next = normalizeDraftResponse(response);
        if (next.body) {
          onInsert(next.body, next.subject);
          toast.success("Draft generated & inserted");
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not generate draft");
      }
    }
  };

  const runRewriteWithInstructions = async (instructionText: string, toneOverride?: OutreachTone) => {
    if (!body.trim()) {
      toast.error("Add a draft before rewriting");
      return;
    }

    try {
      const response = await generateDraft.mutateAsync({
        leadId: lead.id,
        body: {
          channel,
          action: "rewrite",
          tone: toneOverride ?? ((tone as OutreachTone) || "friendly"),
          template,
          customInstructions: instructionText,
          subject,
          body,
          senderName,
        },
      });
      const next = normalizeDraftResponse(response);
      if (next.body) {
        onInsert(next.body, next.subject);
        toast.success("Draft updated");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rewrite draft");
    }
  };

  const addCTA = (ctaText: string) => {
    const cleanBody = body.trimEnd();
    const newBody = `${cleanBody}\n\n${ctaText}`;
    onInsert(newBody);
    toast.success("CTA added to message");
  };

  return (
    <div className="flex flex-col h-full bg-[#0d121d] text-foreground select-none">
      {/* ─── HEADER: Title + Hide button ─── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/70">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-indigo-400" />
          <h3 className="text-xs font-semibold text-foreground">AI Assistant</h3>
        </div>
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Hide
          </button>
        )}
      </div>

      {/* ─── TABS: Write, Improve, Ideas, Research ─── */}
      <div className="p-3 border-b border-border/50">
        <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-card/60 border border-border/60">
          {(["write", "improve", "ideas", "research"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
                activeTab === tab
                  ? "bg-[#4f46e5] text-white shadow-sm font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:bg-card/40"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* ─── ACCORDIONS (COMPACT COLLAPSIBLE SECTIONS) ─── */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* 1. Generate Message (expanded by default) */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("generate")}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <div className="size-6 rounded-lg bg-indigo-500/15 text-indigo-400 grid place-items-center">
                <Sparkles className="size-3.5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground leading-tight">Generate Message</p>
                <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                  Using business details and context
                </p>
              </div>
            </div>
            {openSections.generate ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.generate && (
            <div className="p-3 pt-1 border-t border-border/40 space-y-2.5">
              <Button
                type="button"
                onClick={() => void runGeneration()}
                disabled={isGenerating}
                className="w-full h-9 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold rounded-xl shadow-md shadow-indigo-500/20"
              >
                {isGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                <span>Generate</span>
              </Button>
            </div>
          )}
        </div>

        {/* 2. Rewrite & Adjust (collapsed by default) */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("rewrite")}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Edit2 className="size-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Rewrite &amp; Adjust</span>
            </div>
            {openSections.rewrite ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.rewrite && (
            <div className="p-3 pt-1 border-t border-border/40 space-y-2.5">
              <Textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="Mention a specific angle, local detail, or objection..."
                className="min-h-16 text-xs bg-background/50 border-border/70 rounded-lg resize-none"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void runRewriteWithInstructions(customInstructions)}
                disabled={isGenerating || !body.trim() || !customInstructions.trim()}
                className="w-full h-8 text-xs bg-brand hover:bg-brand/90 text-brand-foreground rounded-lg"
              >
                Apply Rewrite
              </Button>
            </div>
          )}
        </div>

        {/* 3. Tone (collapsed by default) */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("tone")}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <AlignLeft className="size-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Tone</span>
            </div>
            {openSections.tone ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.tone && (
            <div className="p-3 pt-1 border-t border-border/40 space-y-1.5">
              {(["friendly", "professional", "direct"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setTone(t);
                    void runRewriteWithInstructions(`Rewrite in a ${t} tone`, t);
                  }}
                  disabled={isGenerating || !body.trim()}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium border text-left transition-colors ${
                    tone === t
                      ? "border-[#4f46e5]/60 bg-[#4f46e5]/10 text-white"
                      : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground hover:bg-card"
                  }`}
                >
                  <span className="capitalize">{t}</span>
                  {tone === t && <Check className="size-3.5 text-indigo-400" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 4. Length (collapsed by default) */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("length")}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Sliders className="size-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Length</span>
            </div>
            {openSections.length ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.length && (
            <div className="p-3 pt-1 border-t border-border/40 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runRewriteWithInstructions("Make it concise, punchy, and under 75 words")}
                disabled={isGenerating || !body.trim()}
                className="h-8 text-xs border-border/60 bg-background/50 hover:bg-card text-foreground"
              >
                Shorten
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runRewriteWithInstructions("Expand with more detail, proof points, and depth")}
                disabled={isGenerating || !body.trim()}
                className="h-8 text-xs border-border/60 bg-background/50 hover:bg-card text-foreground"
              >
                Expand
              </Button>
            </div>
          )}
        </div>

        {/* 5. Make it more... (collapsed by default) */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("more")}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <MessageCircle className="size-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Make it more...</span>
            </div>
            {openSections.more ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.more && (
            <div className="p-3 pt-1 border-t border-border/40 grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => void runRewriteWithInstructions("Make it casual, approachable, and warm")}
                disabled={isGenerating || !body.trim()}
                className="p-2 rounded-lg border border-border/60 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground text-left"
              >
                Casual
              </button>
              <button
                type="button"
                onClick={() => void runRewriteWithInstructions("Make it persuasive, focused on tangible business ROI")}
                disabled={isGenerating || !body.trim()}
                className="p-2 rounded-lg border border-border/60 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground text-left"
              >
                Persuasive
              </button>
              <button
                type="button"
                onClick={() => void runRewriteWithInstructions("Add timely urgency and limited availability")}
                disabled={isGenerating || !body.trim()}
                className="p-2 rounded-lg border border-border/60 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground text-left"
              >
                Urgent
              </button>
              <button
                type="button"
                onClick={() => void runRewriteWithInstructions("Add genuine compliments and appreciation for their work")}
                disabled={isGenerating || !body.trim()}
                className="p-2 rounded-lg border border-border/60 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground text-left"
              >
                Complimentary
              </button>
            </div>
          )}
        </div>

        {/* 6. Add a stronger CTA (collapsed by default) */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("cta")}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Target className="size-4 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Add a stronger CTA</span>
            </div>
            {openSections.cta ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {openSections.cta && (
            <div className="p-3 pt-1 border-t border-border/40 space-y-1.5 text-xs">
              <button
                type="button"
                onClick={() => addCTA("Would you be open to a quick 10-minute chat to see if this could be a good fit for you?")}
                className="w-full text-left p-2 rounded-lg border border-border/50 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground leading-tight"
              >
                <p className="font-semibold text-foreground">10-Minute Chat</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Low-friction conversation question</p>
              </button>
              <button
                type="button"
                onClick={() => addCTA("Feel free to grab 15 minutes on my calendar directly whenever works best: [Calendar Link]")}
                className="w-full text-left p-2 rounded-lg border border-border/50 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground leading-tight"
              >
                <p className="font-semibold text-foreground">Calendar Link</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Direct link to book time</p>
              </button>
              <button
                type="button"
                onClick={() => addCTA("Can I send over a quick 2-minute video review with a couple ideas for your site?")}
                className="w-full text-left p-2 rounded-lg border border-border/50 bg-background/40 hover:bg-card text-muted-foreground hover:text-foreground leading-tight"
              >
                <p className="font-semibold text-foreground">Free Audit Offer</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">High-value video audit</p>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ─── BOTTOM: PERSONALIZATION CONTEXT ─── */}
      <div className="p-4 border-t border-border/60 bg-card/20 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">Personalization Context</span>
          <button
            type="button"
            onClick={() => setEditingContext(!editingContext)}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border/60 bg-card/40 transition-colors"
          >
            {editingContext ? "Done" : "Edit"}
          </button>
        </div>

        {editingContext && (
          <div className="space-y-1.5 pt-1">
            <Textarea
              value={customContextNotes}
              onChange={(e) => setCustomContextNotes(e.target.value)}
              placeholder="Add extra context (e.g., founded in 2018, opened second branch)..."
              className="min-h-16 text-xs bg-background/50 border-border/70 rounded-lg resize-none"
            />
          </div>
        )}

        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <Checkbox
              checked={personalization.businessNameAndNiche}
              onCheckedChange={(c) =>
                setPersonalization((prev) => ({ ...prev, businessNameAndNiche: Boolean(c) }))
              }
              className="size-4 border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
            />
            <span className="text-xs">Business name and niche</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <Checkbox
              checked={personalization.recentInstagramActivity}
              onCheckedChange={(c) =>
                setPersonalization((prev) => ({ ...prev, recentInstagramActivity: Boolean(c) }))
              }
              className="size-4 border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
            />
            <span className="text-xs">Recent Instagram activity</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <Checkbox
              checked={personalization.locationAndLocalMarket}
              onCheckedChange={(c) =>
                setPersonalization((prev) => ({ ...prev, locationAndLocalMarket: Boolean(c) }))
              }
              className="size-4 border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
            />
            <span className="text-xs">Location and local market</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <Checkbox
              checked={personalization.businessReviewsAndReputation}
              onCheckedChange={(c) =>
                setPersonalization((prev) => ({ ...prev, businessReviewsAndReputation: Boolean(c) }))
              }
              className="size-4 border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
            />
            <span className="text-xs">Business reviews and reputation</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground">
            <Checkbox
              checked={personalization.similarBusinessSuccessStories}
              onCheckedChange={(c) =>
                setPersonalization((prev) => ({ ...prev, similarBusinessSuccessStories: Boolean(c) }))
              }
              className="size-4 border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
            />
            <span className="text-xs">Similar business success stories</span>
          </label>
        </div>
      </div>
    </div>
  );
}
