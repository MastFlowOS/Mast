import { useState, useRef } from "react";
import {
  Sparkles,
  Loader2,
  Copy,
  Check,
  Send,
  Building2,
  Briefcase,
  AlertCircle,
  ArrowRight,
  Info,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { Lead, OutreachTone } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { useGenerateOutreachDraft, useMe, useOutreachStatus, useRecordLeadActivity, useSettings } from "@/hooks/use-mast-api";
import { normalizeDraftResponse, TEMPLATES, leadNicheDisplay } from "@/lib/lead-workspace";
import { useFreeOutreach } from "@/hooks/use-free-outreach";
import { isFreeTemplateKey } from "@/lib/outreach/templates";
import { resolveOutreachGenerationMode } from "@/lib/outreach/generationMode";
import type { PersonalizationState, LengthPreference, ToneOption, GeneratedDraft } from "./types";

interface WriteTabProps {
  lead: Lead;
  channel: Channel;
  composerSubject: string;
  composerBody: string;
  onInsert: (body: string, subject?: string) => void;
  template: string;
  setTemplate: (t: string) => void;
  tone: string;
  setTone: (t: string) => void;
  personalization: PersonalizationState;
  customContextNotes: string;
  generatedDraft: GeneratedDraft | null;
  setGeneratedDraft: React.Dispatch<React.SetStateAction<GeneratedDraft | null>>;
  customInstructions: string;
  setCustomInstructions: React.Dispatch<React.SetStateAction<string>>;
}

const TONES: { id: ToneOption; label: string; desc: string }[] = [
  { id: "friendly", label: "Friendly", desc: "Warm and conversational" },
  { id: "professional", label: "Professional", desc: "Polished and business-like" },
  { id: "direct", label: "Concise", desc: "Punchy, minimal fluff" },
  { id: "persuasive", label: "Persuasive", desc: "Outcome and ROI focused" },
  { id: "casual", label: "Casual", desc: "Relaxed peer-to-peer" },
  { id: "urgent", label: "Urgent", desc: "Timely call to action" },
];

const LENGTH_OPTIONS: { id: LengthPreference; label: string; sub: string }[] = [
  { id: "short", label: "Short", sub: "< 75 words" },
  { id: "standard", label: "Standard", sub: "75–150 words" },
  { id: "detailed", label: "Detailed", sub: "150+ words" },
];

export function WriteTab({
  lead,
  channel,
  composerSubject,
  composerBody,
  onInsert,
  template,
  setTemplate,
  tone,
  setTone,
  personalization,
  customContextNotes,
  generatedDraft,
  setGeneratedDraft,
  customInstructions,
  setCustomInstructions,
}: WriteTabProps) {
  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const { data: outreachStatus } = useOutreachStatus();
  const generateDraft = useGenerateOutreachDraft();
  const recordActivity = useRecordLeadActivity();
  const freeOutreach = useFreeOutreach(lead);

  const [lengthPreference, setLengthPreference] = useState<LengthPreference>("standard");
  const [isGeneratingFree, setIsGeneratingFree] = useState(false);
  const [isGeneratingManual, setIsGeneratingManual] = useState(false);
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(() => {
    return Boolean(customInstructions.trim() || (template && template !== "initial"));
  });

  const activeLeadIdRef = useRef(lead.id);
  activeLeadIdRef.current = lead.id;

  const isGenerating = generateDraft.isPending || isGeneratingFree || isGeneratingManual;
  const senderName = settings?.senderName ?? auth?.user?.fullName ?? "";

  // Authoritative generation mode:
  // - Free plan -> fallback template
  // - AI not configured -> fallback template
  // - Paid plan AND AI configured -> actual AI generation
  const generationMode = resolveOutreachGenerationMode({
    plan: auth?.user?.plan,
    aiConfigured: outreachStatus?.aiConfigured,
  });

  const channelLabel =
    channel === "email"
      ? "Cold Email"
      : channel === "instagram"
        ? "Instagram DM"
        : channel === "contact_form"
          ? "Contact Form"
          : "Phone Script";

  const handleGenerate = async () => {
    // Prevent duplicate submissions while in-flight
    if (isGenerating) return;
    setLastError(null);

    const currentLeadId = lead.id;

    // Build length instruction to append to customInstructions
    const lengthInstruction =
      lengthPreference === "short"
        ? "Keep the message punchy and under 75 words."
        : lengthPreference === "detailed"
          ? "Provide a thorough, comprehensive message with concrete proof points and depth (150+ words)."
          : "Keep the message balanced and easy to read (around 100 words).";

    const combinedInstructions = [customInstructions.trim(), lengthInstruction]
      .filter(Boolean)
      .join(" ");

    if (generationMode === "ai") {
      setIsGeneratingManual(true);
      try {
        const backendTone = (tone === "persuasive" ? "professional" : tone) as OutreachTone;
        const response = await generateDraft.mutateAsync({
          leadId: lead.id,
          body: {
            channel,
            action: template === "objection_handling" ? "objections" : "generate",
            tone: backendTone || "friendly",
            template,
            customInstructions: combinedInstructions || undefined,
            subject: composerSubject || undefined,
            body: composerBody || undefined,
            senderName,
            personalization,
            contextNotes: customContextNotes.trim() || undefined,
          },
        });

        // Stale closure / lead change guard
        if (activeLeadIdRef.current !== currentLeadId) return;

        const next = normalizeDraftResponse(response);
        if (next.body) {
          setGeneratedDraft({
            body: next.body,
            subject: next.subject,
          });
          setLastError(null);
          toast.success("AI draft generated! Review below.");
        } else {
          setLastError("AI response returned an empty message body. Please retry.");
        }
      } catch (error: any) {
        if (activeLeadIdRef.current !== currentLeadId) return;

        let errorMsg = error instanceof Error ? error.message : "Could not generate draft";
        if (error?.status === 429 || errorMsg.includes("rate limit") || errorMsg.includes("429")) {
          errorMsg = "AI request rate-limited. Please wait a moment and click Retry.";
        } else if (error?.status === 504 || errorMsg.includes("timeout")) {
          errorMsg = "AI generation timed out. Please click Retry.";
        } else if (error?.status === 503 || errorMsg.includes("not configured")) {
          errorMsg = "AI service is currently unavailable. Please click Retry or try again shortly.";
        }
        setLastError(errorMsg);
        toast.error(errorMsg);
      } finally {
        setIsGeneratingManual(false);
      }
    } else {
      // Fallback deterministic template generation (Free plan OR AI unconfigured)
      setIsGeneratingFree(true);
      try {
        const templateKey = isFreeTemplateKey(template) ? template : "initial";
        const result = await freeOutreach.generate(templateKey, channel, senderName);

        // Stale closure / lead change guard
        if (activeLeadIdRef.current !== currentLeadId) return;

        if (!result.ok) {
          setLastError(result.detail);
          toast.error(result.detail);
          return;
        }

        const draft: GeneratedDraft = {
          body: result.body,
          subject: result.subject ?? undefined,
        };
        setGeneratedDraft(draft);
        setLastError(null);

        void recordActivity.mutateAsync({
          lead,
          activity: {
            type: "message_generated",
            channel,
            subject: result.subject ?? undefined,
            body: result.body,
            content: `${channelLabel} draft generated (${TEMPLATES.find((t) => t.value === templateKey)?.label ?? templateKey})`,
            metadata: { template: templateKey, angleComponent: result.angleComponent, angleSource: result.angleSource },
          },
        });
        toast.success("Message drafted! Review below before applying.");
      } catch (err) {
        if (activeLeadIdRef.current !== currentLeadId) return;
        const msg = err instanceof Error ? err.message : "Generation failed";
        setLastError(msg);
        toast.error(msg);
      } finally {
        setIsGeneratingFree(false);
      }
    }
  };

  const handleCopyDraft = async () => {
    if (!generatedDraft) return;
    const textToCopy =
      generatedDraft.subject && channel !== "instagram" && channel !== "phone"
        ? `Subject: ${generatedDraft.subject}\n\n${generatedDraft.body}`
        : generatedDraft.body;
    await navigator.clipboard.writeText(textToCopy);
    setCopiedDraft(true);
    toast.success("Draft copied to clipboard");
    setTimeout(() => setCopiedDraft(false), 2000);
  };

  const handleApplyToComposer = () => {
    if (!generatedDraft) return;
    onInsert(generatedDraft.body, generatedDraft.subject);
    toast.success("Inserted draft into composer");
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-lg bg-indigo-500/15 text-indigo-400 grid place-items-center">
            <Sparkles className="size-3.5" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">Create Outreach Draft</h4>
            <p className="text-[11px] text-muted-foreground">
              Ground message in prospect data and your niche profile.
            </p>
          </div>
        </div>

        {/* Selected Lead Context Pill */}
        <div className="mt-2.5 p-2 rounded-lg bg-card/60 border border-border/60 flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Building2 className="size-3.5 text-indigo-400 shrink-0" />
            <span className="font-medium text-foreground truncate">{lead.businessName}</span>
            {lead.niche && (
              <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-border/40 shrink-0">
                {leadNicheDisplay(lead.niche)}
              </span>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground uppercase font-mono tracking-wider shrink-0 ml-2">
            {channelLabel}
          </span>
        </div>
      </div>

      {/* Tone Controls */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-semibold text-foreground">Tone</span>
          <span className="text-[10px] text-muted-foreground truncate max-w-[170px]">
            {TONES.find((t) => t.id === tone)?.desc ?? tone}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          {TONES.map((t) => {
            const isSelected = tone === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTone(t.id)}
                title={t.desc}
                className={`h-7 px-1.5 rounded-md text-[11px] font-medium border text-center transition-all truncate ${
                  isSelected
                    ? "border-indigo-500/80 bg-indigo-500/20 text-white font-semibold shadow-xs"
                    : "border-border/50 bg-card/30 text-muted-foreground hover:text-foreground hover:bg-card/60"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Length Preference */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-semibold text-foreground">Length Preference</span>
          <span className="text-[10px] text-muted-foreground">
            {LENGTH_OPTIONS.find((l) => l.id === lengthPreference)?.sub}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-card/40 border border-border/50">
          {LENGTH_OPTIONS.map((l) => {
            const isSelected = lengthPreference === l.id;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => setLengthPreference(l.id)}
                className={`py-1.5 px-2 rounded-md text-[11px] font-medium text-center transition-all ${
                  isSelected
                    ? "bg-indigo-600 text-white shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-card/40"
                }`}
              >
                <span>{l.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Progressive Disclosure: Collapsible Advanced Options */}
      <div className="pt-0.5">
        <button
          type="button"
          onClick={() => setShowAdvanced((prev) => !prev)}
          aria-expanded={showAdvanced}
          className="w-full flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-card/30 hover:bg-card/60 border border-border/50 text-[11px] text-muted-foreground hover:text-foreground transition-all group"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <SlidersHorizontal className="size-3 text-indigo-400 group-hover:text-indigo-300 shrink-0" />
            <span className="font-medium text-foreground">Advanced Settings</span>
            {(customInstructions.trim() || template !== "initial") && (
              <span className="size-1.5 rounded-full bg-indigo-400 shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-1 text-[10px] shrink-0 text-muted-foreground/80">
            <span className="truncate max-w-[120px]">
              {TEMPLATES.find((t) => t.value === template)?.label ?? "Sequence"}
            </span>
            {showAdvanced ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </div>
        </button>

        {showAdvanced && (
          <div className="mt-2 space-y-2.5 p-2.5 rounded-xl bg-card/25 border border-border/50 animate-fade-in">
            {/* Outreach Sequence / Type */}
            <div className="space-y-1">
              <label
                htmlFor="write-template-selector"
                className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block"
              >
                Outreach Sequence / Type
              </label>
              <select
                id="write-template-selector"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-full h-8 px-2 text-xs rounded-lg bg-background/60 border border-border/60 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {TEMPLATES.map((t) => (
                  <option key={t.value} value={t.value} className="bg-[#0d121d] text-foreground">
                    {t.label} {t.tier === "ai" ? "(AI DeepSeek)" : "(Grounded Template)"}
                  </option>
                ))}
              </select>
            </div>

            {/* What do you want to communicate? */}
            <div className="space-y-1">
              <label
                htmlFor="write-custom-instructions"
                className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between"
              >
                <span>What do you want to communicate?</span>
                <span className="text-[9px] text-muted-foreground/70 font-normal lowercase">Optional</span>
              </label>
              <Textarea
                id="write-custom-instructions"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="e.g. Mention their website speed issue, offer a quick 2-minute video audit, reference their high review count..."
                className="min-h-16 text-xs bg-background/60 border-border/60 rounded-lg resize-none placeholder:text-muted-foreground/50 focus-visible:ring-indigo-500/40"
              />
            </div>
          </div>
        )}
      </div>

      {/* Primary Action: Generate Draft */}
      <Button
        type="button"
        onClick={() => void handleGenerate()}
        disabled={isGenerating}
        className="w-full h-9 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold rounded-xl shadow-md shadow-indigo-500/20 transition-all active:scale-[0.99] cursor-pointer"
      >
        {isGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        <span>{isGenerating ? (generationMode === "ai" ? "Generating AI draft..." : "Generating draft...") : "Generate Draft"}</span>
      </Button>

      {/* Error State with Retry Action */}
      {lastError && (
        <div className="p-2.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-[11px] flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5 text-destructive" />
            <div className="space-y-1 min-w-0">
              <p className="font-medium leading-tight">Generation Error</p>
              <p className="text-[10px] text-muted-foreground leading-tight break-words">{lastError}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleGenerate()}
            disabled={isGenerating}
            className="h-6 px-2 text-[10px] font-medium border-destructive/40 bg-card/60 hover:bg-card text-foreground shrink-0 cursor-pointer"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Useful empty state */}
      {!generatedDraft && !isGenerating && !lastError && (
        <div className="py-4 px-3 text-center text-xs text-muted-foreground border border-dashed border-border/50 rounded-xl bg-card/20">
          <p className="text-[11px]">Select your preferred tone and options above, then click Generate Draft to create an outreach message.</p>
        </div>
      )}

      {/* Generated Result Review Area */}
      {generatedDraft && (
        <div className="mt-4 pt-3 border-t border-border/70 space-y-2.5 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Check className="size-3 text-emerald-400" />
              Generated Draft
            </span>
            <span className="text-[10px] text-muted-foreground">Ready to review</span>
          </div>

          <div className="rounded-xl border border-indigo-500/30 bg-card/60 p-3 space-y-2">
            {generatedDraft.subject && channel !== "instagram" && channel !== "phone" && (
              <div className="pb-2 border-b border-border/40">
                <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">
                  Subject Line
                </span>
                <p className="text-xs font-medium text-foreground mt-0.5 select-text">
                  {generatedDraft.subject}
                </p>
              </div>
            )}

            <div>
              <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block mb-1">
                Message Body
              </span>
              <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed select-text font-normal max-h-56 overflow-y-auto pr-1">
                {generatedDraft.body}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleApplyToComposer}
              className="flex-1 h-8 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg shadow-sm flex items-center justify-center gap-1.5"
            >
              <Send className="size-3" />
              <span>Insert into Composer</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={() => void handleCopyDraft()}
              className="h-8 px-3 text-xs border-border/70 bg-card/50 hover:bg-card text-foreground rounded-lg flex items-center gap-1.5"
            >
              {copiedDraft ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
              <span>{copiedDraft ? "Copied" : "Copy"}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
