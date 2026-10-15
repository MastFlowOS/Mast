import { useState, useMemo } from "react";
import {
  Lightbulb,
  Copy,
  Check,
  Send,
  Sparkles,
  Compass,
  MessageSquare,
  ArrowRight,
  Info,
  Clock,
  ShieldCheck,
  Target,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Lead } from "@/lib/api";
import { useOpportunityInsight, useOpportunityExplanation, useSettings } from "@/hooks/use-mast-api";
import { leadNicheDisplay } from "@/lib/lead-workspace";

interface IdeasTabProps {
  lead: Lead;
  onInsert: (body: string, subject?: string) => void;
  composerBody: string;
  topic: string;
  setTopic: React.Dispatch<React.SetStateAction<string>>;
}

type IdeaCategory = "angles" | "openers" | "starters" | "followups";

interface IdeaItem {
  id: string;
  category: IdeaCategory;
  tag: string;
  badgeColor: string;
  text: string;
  source: "opportunity_insight" | "explanation_signal" | "lead_fact";
}

const CATEGORIES: { id: IdeaCategory; label: string; icon: any }[] = [
  { id: "angles", label: "Outreach Angles", icon: Compass },
  { id: "openers", label: "Opening Lines", icon: Sparkles },
  { id: "starters", label: "Conversation Starters", icon: MessageSquare },
  { id: "followups", label: "Follow-up Angles", icon: Clock },
];

export function IdeasTab({ lead, onInsert, composerBody, topic, setTopic }: IdeasTabProps) {
  const { data: settings } = useSettings();
  const [selectedCategory, setSelectedCategory] = useState<IdeaCategory>("angles");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Read genuine grounded AI intelligence and deterministic explanations
  const { data: insight, isLoading: insightLoading } = useOpportunityInsight(lead.businessId);
  const { data: explanation, isLoading: explanationLoading } = useOpportunityExplanation(lead.id);

  const businessName = lead.businessName || "the business";
  const nicheLabel = leadNicheDisplay(lead.niche);
  const userProfession = settings?.focusArea || "Service Specialist";

  // Derive genuine ideas from lead facts, opportunity reasons, and AI insights
  const allIdeas: IdeaItem[] = useMemo(() => {
    const list: IdeaItem[] = [];

    // 1. AI Opportunity Insight Talking Points
    if (insight?.talking_points && Array.isArray(insight.talking_points)) {
      insight.talking_points.forEach((tp, idx) => {
        list.push({
          id: `ai-talking-${idx}`,
          category: "angles",
          tag: "AI Talking Point",
          badgeColor: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
          text: tp,
          source: "opportunity_insight",
        });
      });
    }

    // 2. AI Opportunity Insight Opening Line
    if (insight?.opening_line) {
      list.push({
        id: "ai-opener",
        category: "openers",
        tag: "Grounded AI Opener",
        badgeColor: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        text: insight.opening_line,
        source: "opportunity_insight",
      });
    }

    // 3. AI Opportunity Headline
    if (insight?.headline) {
      list.push({
        id: "ai-headline",
        category: "angles",
        tag: "Opportunity Hook",
        badgeColor: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
        text: insight.headline,
        source: "opportunity_insight",
      });
    }

    // 4. Deterministic Opportunity Reasons (Scoring Engine)
    if (explanation?.reasons && Array.isArray(explanation.reasons)) {
      explanation.reasons.forEach((r, idx) => {
        const reasonText = (r as any).reason || (r as any).label || (r as any).detail;
        if (!reasonText) return;
        const comp = r.component || "opportunity";
        const cat: IdeaCategory =
          comp === "social" || comp === "growth" ? "starters" : "angles";

        list.push({
          id: `exp-reason-${idx}`,
          category: cat,
          tag: `Signal: ${comp.toUpperCase()}`,
          badgeColor: "bg-blue-500/15 text-blue-400 border-blue-500/30",
          text: `Focus on their ${String(reasonText).toLowerCase()}: demonstrate how ${userProfession.toLowerCase()} improvements will attract more local customers.`,
          source: "explanation_signal",
        });
      });
    }

    // 5. Lead fact-grounded conversation starters & follow-ups
    if (lead.location) {
      list.push({
        id: "local-starter",
        category: "starters",
        tag: "Local Market Angle",
        badgeColor: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
        text: `I noticed ${businessName}'s strong reputation in ${lead.location} — how are you currently navigating new client acquisition this quarter?`,
        source: "lead_fact",
      });
    }

    if (lead.website) {
      list.push({
        id: "website-starter",
        category: "openers",
        tag: "Digital Experience",
        badgeColor: "bg-purple-500/15 text-purple-400 border-purple-500/30",
        text: `I was taking a look at ${businessName}'s website and noticed a couple of quick high-impact adjustments that could boost your conversion rate.`,
        source: "lead_fact",
      });
    }

    // Follow-up approaches
    list.push({
      id: "followup-audit",
      category: "followups",
      tag: "Free Value Bump",
      badgeColor: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      text: `Wanted to quickly share a 2-minute video walkthrough comparing ${businessName}'s setup to top ${nicheLabel} competitors in your area.`,
      source: "lead_fact",
    });

    list.push({
      id: "followup-bump",
      category: "followups",
      tag: "Gentle Check-in",
      badgeColor: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      text: `Just wanted to float this back to the top of your inbox in case it got buried under daily customer operations.`,
      source: "lead_fact",
    });

    list.push({
      id: "followup-case-study",
      category: "followups",
      tag: "Proof Point",
      badgeColor: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      text: `We recently helped another ${nicheLabel} business increase their booking inquiries by 35% using a streamlined onboarding flow.`,
      source: "lead_fact",
    });

    return list;
  }, [insight, explanation, lead, userProfession, nicheLabel, businessName]);

  // Filter ideas by current category
  const filteredIdeas = useMemo(() => {
    return allIdeas.filter((item) => item.category === selectedCategory);
  }, [allIdeas, selectedCategory]);

  const handleCopyIdea = async (idea: IdeaItem) => {
    await navigator.clipboard.writeText(idea.text);
    setCopiedId(idea.id);
    toast.success("Idea copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleUseIdeaInComposer = (idea: IdeaItem) => {
    if (selectedCategory === "openers") {
      // If composer is empty, insert opener; if not empty, prepend or replace first sentence
      if (!composerBody.trim()) {
        onInsert(idea.text);
      } else {
        onInsert(`${idea.text}\n\n${composerBody.trim()}`);
      }
      toast.success("Opener added to composer");
    } else {
      // Append idea as talking point or message addition
      if (!composerBody.trim()) {
        onInsert(idea.text);
      } else {
        onInsert(`${composerBody.trimEnd()}\n\n${idea.text}`);
      }
      toast.success("Idea inserted into composer");
    }
  };

  return (
    <div className="space-y-3.5">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-lg bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 grid place-items-center shrink-0">
            <Lightbulb className="size-3.5" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">Outreach Ideas &amp; Angles</h4>
            <p className="text-[11px] text-muted-foreground">
              Grounded talking points, openers, and angles for {lead.businessName}.
            </p>
          </div>
        </div>
      </div>

      {/* Goal / Topic Field */}
      <div className="space-y-1">
        <label htmlFor="ideas-goal-topic" className="text-[11px] font-semibold text-foreground flex items-center justify-between">
          <span>Goal or Topic to Explore</span>
          <span className="text-[10px] text-muted-foreground font-normal">Optional</span>
        </label>
        <Input
          id="ideas-goal-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. Website revamp, booking flow, follow-up bump..."
          className="h-8 text-xs bg-background/50 border-border/60 rounded-lg placeholder:text-muted-foreground/50 focus-visible:ring-indigo-500/40"
        />
      </div>

      {/* Grounded Intelligence Notice (compact & subordinate) */}
      <div className="p-2 rounded-lg border border-indigo-500/25 bg-indigo-500/5 text-[11px] space-y-0.5">
        <div className="flex items-center gap-1.5 font-semibold text-indigo-300">
          <Info className="size-3 text-indigo-400 shrink-0" />
          <span>Grounded Intelligence Live</span>
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Ideas below are generated from MAST's verified lead data and opportunity intelligence. Freeform AI brainstorming for custom topics requires a dedicated AI ideas route (not currently deployed).
        </p>
      </div>

      {/* Category selector */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-semibold text-foreground">Idea Category</label>
        <div className="grid grid-cols-2 gap-1.5">
          {CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat.id;
            const Icon = cat.icon;
            const count = allIdeas.filter((i) => i.category === cat.id).length;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id)}
                className={`py-1.5 px-2 rounded-lg text-xs font-medium border text-left transition-all flex items-center justify-between min-w-0 ${
                  isSelected
                    ? "border-indigo-500/80 bg-indigo-500/20 text-white shadow-xs font-semibold"
                    : "border-border/50 bg-card/30 text-muted-foreground hover:text-foreground hover:bg-card/60"
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className={`size-3 shrink-0 ${isSelected ? "text-indigo-300" : "text-muted-foreground"}`} />
                  <span className="truncate text-[11px]">{cat.label}</span>
                </div>
                <span className="text-[10px] text-muted-foreground font-mono ml-1 shrink-0 px-1 py-0.2 rounded bg-border/40">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Ideas Result List */}
      <div className="space-y-2 pt-0.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{filteredIdeas.length} {filteredIdeas.length === 1 ? "idea" : "ideas"} available</span>
          <span>Click to copy or insert</span>
        </div>

        {insightLoading || explanationLoading ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            Loading lead intelligence signals...
          </div>
        ) : filteredIdeas.length === 0 ? (
          <div className="py-5 px-3 text-center space-y-2 bg-card/25 rounded-xl border border-border/50">
            <p className="text-xs text-muted-foreground">
              No specific {selectedCategory} found for this lead. Try selecting another category above.
            </p>
            <div className="flex flex-wrap gap-1.5 justify-center pt-1">
              <button
                type="button"
                onClick={() => setSelectedCategory("angles")}
                className="text-[10px] font-medium px-2 py-0.5 rounded border border-border/60 bg-card/40 text-foreground hover:border-indigo-500"
              >
                Outreach Angles
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory("openers")}
                className="text-[10px] font-medium px-2 py-0.5 rounded border border-border/60 bg-card/40 text-foreground hover:border-indigo-500"
              >
                Opening Lines
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-0.5">
            {filteredIdeas.map((idea) => {
              const isCopied = copiedId === idea.id;
              return (
                <div
                  key={idea.id}
                  className="p-2.5 rounded-xl border border-border/60 bg-card/40 hover:border-border/80 hover:bg-card/60 transition-all space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wider ${idea.badgeColor}`}
                    >
                      {idea.tag}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleCopyIdea(idea)}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-card/70 transition-colors"
                        title="Copy idea"
                      >
                        {isCopied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUseIdeaInComposer(idea)}
                        className="p-1 rounded text-muted-foreground hover:text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                        title="Insert into composer"
                      >
                        <Send className="size-3" />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-foreground/90 leading-relaxed font-normal select-text">
                    {idea.text}
                  </p>

                  <div className="flex items-center justify-between pt-1 border-t border-border/40 text-[10px]">
                    <span className="text-muted-foreground truncate max-w-[170px]">
                      {idea.source === "opportunity_insight"
                        ? "Source: AI Opportunity Insight"
                        : idea.source === "explanation_signal"
                          ? "Source: Scoring Engine Signal"
                          : "Source: Verified Lead Profile"}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleUseIdeaInComposer(idea)}
                      className="text-indigo-400 hover:text-indigo-300 font-medium inline-flex items-center gap-1 shrink-0"
                    >
                      <span>Use in composer</span>
                      <ArrowRight className="size-2.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
