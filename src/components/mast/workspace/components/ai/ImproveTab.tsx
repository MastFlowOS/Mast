import { useState } from "react";
import {
  Wand2,
  Edit2,
  Sliders,
  AlignLeft,
  Target,
  Sparkles,
  Loader2,
  Check,
  Copy,
  Trash2,
  FileEdit,
  ArrowRight,
  AlertCircle,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { Lead, OutreachTone, OutreachGenerationAction } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { useGenerateOutreachDraft, useMe, useSettings } from "@/hooks/use-mast-api";
import { normalizeDraftResponse } from "@/lib/lead-workspace";
import { countWords, htmlToPlainText } from "@/lib/richText";
import type { PersonalizationState, ToneOption, GeneratedDraft } from "./types";

interface ImproveTabProps {
  lead: Lead;
  channel: Channel;
  composerSubject: string;
  composerBody: string;
  onInsert: (body: string, subject?: string) => void;
  tone: string;
  setTone: (t: string) => void;
  personalization: PersonalizationState;
  customContextNotes: string;
  onNavigateToWrite: () => void;
  improvedDraft: GeneratedDraft | null;
  setImprovedDraft: React.Dispatch<React.SetStateAction<GeneratedDraft | null>>;
  customInstruction: string;
  setCustomInstruction: React.Dispatch<React.SetStateAction<string>>;
}

type ImprovementMode =
  | "personalized"
  | "concise"
  | "opening"
  | "cta"
  | "tone"
  | "grammar";

const IMPROVE_OPTIONS: { id: ImprovementMode; label: string; desc: string; icon: any }[] = [
  {
    id: "personalized",
    label: "More Personalized",
    desc: "Weave in prospect niche, local context, and business details",
    icon: Sparkles,
  },
  {
    id: "concise",
    label: "More Concise",
    desc: "Shorten and cut fluff to under 75 words",
    icon: Sliders,
  },
  {
    id: "opening",
    label: "Improve Opening Hook",
    desc: "Punchy, curiosity-inducing first sentence",
    icon: Edit2,
  },
  {
    id: "cta",
    label: "Stronger Call to Action",
    desc: "Low-friction next step (quick chat, review offer)",
    icon: Target,
  },
  {
    id: "tone",
    label: "Change Tone",
    desc: "Adjust to friendly, professional, direct, or casual",
    icon: AlignLeft,
  },
  {
    id: "grammar",
    label: "Fix Grammar & Clarity",
    desc: "Polish syntax, tighten readability, and smooth flow",
    icon: Wand2,
  },
];

const TONES: { id: ToneOption; label: string }[] = [
  { id: "friendly", label: "Friendly" },
  { id: "professional", label: "Professional" },
  { id: "direct", label: "Direct" },
  { id: "persuasive", label: "Persuasive" },
  { id: "casual", label: "Casual" },
  { id: "urgent", label: "Urgent" },
];

export function ImproveTab({
  lead,
  channel,
  composerSubject,
  composerBody,
  onInsert,
  tone,
  setTone,
  personalization,
  customContextNotes,
  onNavigateToWrite,
  improvedDraft,
  setImprovedDraft,
  customInstruction,
  setCustomInstruction,
}: ImproveTabProps) {
  const { data: settings } = useSettings();
  const { data: auth } = useMe();
  const generateDraft = useGenerateOutreachDraft();

  const [selectedMode, setSelectedMode] = useState<ImprovementMode>("personalized");
  const [selectedTone, setSelectedTone] = useState<ToneOption>((tone as ToneOption) || "friendly");
  const [copiedImproved, setCopiedImproved] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const cleanBody = htmlToPlainText(composerBody).trim();
  const hasDraft = cleanBody.length > 0;
  const wordCount = countWords(composerBody);
  const charCount = cleanBody.length;
  const senderName = settings?.senderName ?? auth?.user?.fullName ?? "";

  const handleRunImprovement = async () => {
    if (!hasDraft) {
      toast.error("Add a message in the composer first");
      return;
    }

    setLastError(null);

    let action: OutreachGenerationAction = "rewrite";
    let instructions = "";

    switch (selectedMode) {
      case "personalized":
        instructions =
          "Make this message much more personalized. Highlight specific details about the prospect's business, niche, and local market to make it feel completely tailored and authentic.";
        break;
      case "concise":
        action = "shorten";
        instructions = "Make this draft concise, punchy, and under 75 words without losing the key offer and CTA.";
        break;
      case "opening":
        instructions =
          "Rewrite the opening line and hook of this message. Make it curiosity-inducing, engaging, and relevant to the prospect so they immediately want to read on.";
        break;
      case "cta":
        instructions =
          "Strengthen the call to action at the end of the message. Propose a specific, low-friction next step (such as a 10-minute discovery call or sending a short audit).";
        break;
      case "tone":
        instructions = `Rewrite the entire message adopting a ${selectedTone} tone throughout while preserving the core offer and facts.`;
        break;
      case "grammar":
        instructions =
          "Proofread and polish this message for impeccable grammar, crisp readability, and natural flow without altering the core value proposition.";
        break;
    }

    if (customInstruction.trim()) {
      instructions = `${instructions} Additional guidance: ${customInstruction.trim()}`;
    }

    try {
      const backendTone = (selectedTone === "persuasive" ? "professional" : selectedTone) as OutreachTone;
      const response = await generateDraft.mutateAsync({
        leadId: lead.id,
        body: {
          channel,
          action,
          tone: backendTone || "friendly",
          customInstructions: instructions,
          subject: composerSubject || undefined,
          body: composerBody,
          senderName,
          personalization,
          contextNotes: customContextNotes.trim() || undefined,
        },
      });

      const next = normalizeDraftResponse(response);
      if (next.body) {
        setImprovedDraft({
          body: next.body,
          subject: next.subject || composerSubject,
        });
        toast.success("Improvement ready! Review before applying.");
      } else {
        setLastError("AI response returned an empty body.");
      }
    } catch (error: any) {
      let errorMsg = error instanceof Error ? error.message : "Could not improve draft";
      if (error?.status === 503 || errorMsg.includes("not configured")) {
        errorMsg = "AI rewriting is not configured on this deployment. DeepSeek API key is required on the backend.";
      } else if (error?.status === 403 || errorMsg.includes("paid plan")) {
        errorMsg = "AI draft rewriting requires a paid plan (Starter, Pro, or Premium).";
      }
      setLastError(errorMsg);
      toast.error(errorMsg);
    }
  };

  const handleApplyToComposer = () => {
    if (!improvedDraft) return;
    onInsert(improvedDraft.body, improvedDraft.subject);
    toast.success("Applied improved message to composer");
  };

  const handleDiscard = () => {
    setImprovedDraft(null);
    toast.info("Discarded improved version. Composer draft kept intact.");
  };

  const handleCopyImproved = async () => {
    if (!improvedDraft) return;
    await navigator.clipboard.writeText(improvedDraft.body);
    setCopiedImproved(true);
    toast.success("Improved draft copied to clipboard");
    setTimeout(() => setCopiedImproved(false), 2000);
  };

  // Empty state if composer has no draft
  if (!hasDraft) {
    return (
      <div className="py-8 px-4 text-center space-y-3">
        <div className="size-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 grid place-items-center mx-auto">
          <FileEdit className="size-6" />
        </div>
        <div>
          <h4 className="text-xs font-semibold text-foreground">No draft in composer</h4>
          <p className="text-[11px] text-muted-foreground mt-1 max-w-[240px] mx-auto leading-relaxed">
            Write or paste a message into the middle composer, or generate a fresh draft in the Write tab.
          </p>
        </div>
        <Button
          type="button"
          onClick={onNavigateToWrite}
          className="h-8 px-3 text-xs bg-[#4f46e5] hover:bg-[#4338ca] text-white rounded-lg gap-1.5"
        >
          <span>Go to Write Tab</span>
          <ArrowRight className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-lg bg-indigo-500/15 text-indigo-400 grid place-items-center">
            <Wand2 className="size-3.5" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">Improve Existing Draft</h4>
            <p className="text-[11px] text-muted-foreground">
              Enhance tone, hook, conciseness, or personalization.
            </p>
          </div>
        </div>

        {/* Live Preview of Current Composer Draft */}
        <div className="mt-2.5 p-2.5 rounded-lg bg-card/60 border border-border/60 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
            <span className="flex items-center gap-1 font-sans font-semibold text-foreground text-[11px]">
              <FileText className="size-3 text-indigo-400" />
              Current Message
            </span>
            <span>
              {wordCount} {wordCount === 1 ? "word" : "words"} · {charCount} chars
            </span>
          </div>
          <div className="text-xs text-foreground/80 max-h-24 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text font-normal pr-1 border-t border-border/40 pt-1.5">
            {cleanBody}
          </div>
        </div>
      </div>

      {/* Improvement Options */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-foreground">Select Improvement</label>
        <div className="grid grid-cols-2 gap-1.5">
          {IMPROVE_OPTIONS.map((opt) => {
            const isSelected = selectedMode === opt.id;
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSelectedMode(opt.id)}
                className={`p-2 rounded-lg text-left border transition-all flex flex-col gap-1 ${
                  isSelected
                    ? "border-brand bg-brand/15 text-white shadow-sm"
                    : "border-border/60 bg-card/40 text-muted-foreground hover:text-foreground hover:bg-card/70"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Icon className={`size-3 ${isSelected ? "text-indigo-300" : "text-muted-foreground"}`} />
                  <span className="text-xs font-medium leading-tight">{opt.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tone sub-selector if Tone mode selected */}
      {selectedMode === "tone" && (
        <div className="space-y-1.5 p-2 rounded-lg bg-card/50 border border-border/60">
          <label className="text-[10px] uppercase font-semibold text-muted-foreground">Target Tone</label>
          <div className="grid grid-cols-3 gap-1">
            {TONES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSelectedTone(t.id);
                  setTone(t.id);
                }}
                className={`py-1 px-1.5 rounded text-[11px] border font-medium text-center ${
                  selectedTone === t.id
                    ? "border-brand bg-brand/20 text-white"
                    : "border-border/50 text-muted-foreground hover:text-foreground bg-card/30"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Additional Custom Instruction */}
      <div className="space-y-1">
        <label
          htmlFor="improve-custom-instruction"
          className="text-[11px] font-semibold text-foreground flex items-center justify-between"
        >
          <span>Specific tweak instructions</span>
          <span className="text-[10px] text-muted-foreground font-normal">Optional</span>
        </label>
        <Textarea
          id="improve-custom-instruction"
          value={customInstruction}
          onChange={(e) => setCustomInstruction(e.target.value)}
          placeholder="e.g. Focus on ROI, keep their recent Instagram photos in mind..."
          className="min-h-14 text-xs bg-background/50 border-border/70 rounded-lg resize-none placeholder:text-muted-foreground/60 focus-visible:ring-brand/40"
        />
      </div>

      {/* Action: Improve Message */}
      <Button
        type="button"
        onClick={() => void handleRunImprovement()}
        disabled={generateDraft.isPending}
        className="w-full h-9 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-semibold rounded-xl shadow-md shadow-indigo-500/20"
      >
        {generateDraft.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Wand2 className="size-3.5" />
        )}
        <span>{generateDraft.isPending ? "Improving message..." : "Improve Draft"}</span>
      </Button>

      {/* Error state */}
      {lastError && (
        <div className="p-2.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-[11px] flex items-start gap-2">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium leading-tight">Improvement Failed</p>
            <p className="text-[10px] text-muted-foreground leading-tight">{lastError}</p>
          </div>
        </div>
      )}

      {/* Review Improved Version Area */}
      {improvedDraft && (
        <div className="mt-4 pt-3 border-t border-border/70 space-y-2.5 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Check className="size-3 text-emerald-400" />
              Improved Version
            </span>
            <span className="text-[10px] text-emerald-400 font-medium">Ready to review</span>
          </div>

          <div className="rounded-xl border border-indigo-500/40 bg-card/70 p-3 space-y-2">
            {improvedDraft.subject && channel !== "instagram" && channel !== "phone" && (
              <div className="pb-2 border-b border-border/40">
                <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block">
                  Subject Line
                </span>
                <p className="text-xs font-medium text-foreground mt-0.5 select-text">
                  {improvedDraft.subject}
                </p>
              </div>
            )}

            <div>
              <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider block mb-1">
                Revised Body
              </span>
              <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed select-text font-normal max-h-56 overflow-y-auto pr-1">
                {improvedDraft.body}
              </p>
            </div>
          </div>

          {/* Action buttons — Apply, Discard, Copy */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={handleApplyToComposer}
                className="flex-1 h-8 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg shadow-sm flex items-center justify-center gap-1.5"
              >
                <Check className="size-3" />
                <span>Apply to Composer</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={handleDiscard}
                className="h-8 px-2.5 text-xs border-border/70 bg-card/40 hover:bg-destructive/15 text-muted-foreground hover:text-destructive rounded-lg flex items-center gap-1"
                title="Discard improved draft without changing composer"
              >
                <Trash2 className="size-3" />
                <span>Discard</span>
              </Button>
            </div>

            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleCopyImproved()}
              className="w-full h-7 text-xs text-muted-foreground hover:text-foreground flex items-center justify-center gap-1.5"
            >
              {copiedImproved ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
              <span>{copiedImproved ? "Copied to clipboard" : "Copy improved draft only"}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
