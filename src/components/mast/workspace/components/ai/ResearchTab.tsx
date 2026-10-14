import { useState } from "react";
import {
  Search,
  Building2,
  Globe,
  Mail,
  Phone,
  Instagram,
  Star,
  ShieldCheck,
  AlertTriangle,
  HelpCircle,
  ExternalLink,
  Info,
  CheckCircle2,
  TrendingUp,
  Activity,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Lead } from "@/lib/api";
import { useOpportunityExplanation, useLeadTrust, useSettings } from "@/hooks/use-mast-api";
import { leadNicheDisplay } from "@/lib/lead-workspace";

interface ResearchTabProps {
  lead: Lead;
  researchQuestion: string;
  setResearchQuestion: React.Dispatch<React.SetStateAction<string>>;
}

export function ResearchTab({ lead, researchQuestion, setResearchQuestion }: ResearchTabProps) {
  const { data: explanation, isLoading: explanationLoading } = useOpportunityExplanation(lead.id);
  const { data: trust, isLoading: trustLoading } = useLeadTrust(lead.id);
  const { data: settings } = useSettings();

  const [hasQueried, setHasQueried] = useState(false);

  const nicheLabel = leadNicheDisplay(lead.niche);
  const score = lead.opportunityScore ?? explanation?.score ?? null;

  const handleInvestigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!researchQuestion.trim()) return;
    setHasQueried(true);
    toast.info("Live web crawling is unavailable on this deployment. Stored intelligence is displayed below.");
  };

  // Structured discovery questions to evaluate before reaching out
  const preOutreachQuestions = [
    `Does ${lead.businessName} currently offer online booking or digital self-scheduling for ${nicheLabel.toLowerCase()} services?`,
    `Who is the primary decision-maker for technology and marketing operations?`,
    `How does their online reputation and review volume compare to local competitors in ${lead.location || "their area"}?`,
    lead.website ? "Are their primary mobile calls-to-action clearly visible without scrolling?" : "Why does this business operate without an active official website?",
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-lg bg-indigo-500/15 text-indigo-400 grid place-items-center">
            <Search className="size-3.5" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-foreground">Business Research</h4>
            <p className="text-[11px] text-muted-foreground">
              Verified intelligence, data health, and pre-outreach audit.
            </p>
          </div>
        </div>
      </div>

      {/* Specific Research Question Field */}
      <form onSubmit={handleInvestigate} className="space-y-1.5">
        <label htmlFor="research-question-input" className="text-[11px] font-semibold text-foreground flex items-center justify-between">
          <span>Specific Research Question</span>
          <span className="text-[10px] text-muted-foreground font-normal">Ask anything</span>
        </label>
        <div className="flex gap-1.5">
          <Input
            id="research-question-input"
            value={researchQuestion}
            onChange={(e) => setResearchQuestion(e.target.value)}
            placeholder="e.g. Do they use WordPress? Who is the owner?"
            className="h-8 text-xs bg-background/50 border-border/70 rounded-lg placeholder:text-muted-foreground/60 flex-1"
          />
          <Button
            type="submit"
            disabled={!researchQuestion.trim()}
            variant="outline"
            className="h-8 px-2.5 text-xs border-border/70 bg-card/60 hover:bg-card text-foreground rounded-lg"
          >
            Investigate
          </Button>
        </div>

        {/* Honest AI connection notice */}
        <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[10px] space-y-1 text-foreground/90">
          <div className="flex items-center gap-1.5 font-semibold text-amber-300">
            <Info className="size-3 text-amber-400 shrink-0" />
            <span>Telemetry &amp; Verified Data Only</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            Live web crawling and autonomous web research are not configured on this server. All facts below come directly from MAST's verified database and scoring engine.
          </p>
        </div>
      </form>

      {/* 1. Business Overview Card */}
      <div className="p-3 rounded-xl border border-border/70 bg-card/50 space-y-2.5">
        <div className="flex items-start justify-between">
          <div>
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
              Business Summary
            </span>
            <h5 className="text-sm font-semibold text-foreground mt-0.5">{lead.businessName}</h5>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
              <span className="px-1.5 py-0.5 rounded bg-border/50 text-foreground/90 font-medium">
                {nicheLabel}
              </span>
              {lead.location && <span>· {lead.location}</span>}
            </div>
          </div>

          {score !== null && (
            <div className="text-right">
              <span className="text-[10px] text-muted-foreground uppercase font-mono">Opportunity</span>
              <div className="flex items-center gap-1 justify-end mt-0.5">
                <span className="text-sm font-bold text-indigo-400">{score}</span>
                <span className="text-[10px] text-muted-foreground font-mono">/100</span>
              </div>
            </div>
          )}
        </div>

        {/* Known Contact Methods & Profiles */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/40 text-[11px]">
          <div className="flex items-center gap-1.5 truncate text-muted-foreground">
            <Globe className="size-3 text-indigo-400 shrink-0" />
            {lead.website ? (
              <a
                href={lead.website.startsWith("http") ? lead.website : `https://${lead.website}`}
                target="_blank"
                rel="noreferrer"
                className="text-foreground hover:underline truncate"
              >
                {lead.website.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            ) : (
              <span className="italic text-muted-foreground/60">No website</span>
            )}
          </div>

          <div className="flex items-center gap-1.5 truncate text-muted-foreground">
            <Mail className="size-3 text-indigo-400 shrink-0" />
            {lead.email ? (
              <span className="text-foreground truncate">{lead.email}</span>
            ) : (
              <span className="italic text-muted-foreground/60">No email found</span>
            )}
          </div>

          <div className="flex items-center gap-1.5 truncate text-muted-foreground">
            <Phone className="size-3 text-indigo-400 shrink-0" />
            {lead.phone ? (
              <span className="text-foreground truncate">{lead.phone}</span>
            ) : (
              <span className="italic text-muted-foreground/60">No phone</span>
            )}
          </div>

          <div className="flex items-center gap-1.5 truncate text-muted-foreground">
            <Instagram className="size-3 text-purple-400 shrink-0" />
            {lead.instagramHandle ? (
              <span className="text-foreground truncate">@{lead.instagramHandle}</span>
            ) : (
              <span className="italic text-muted-foreground/60">No Instagram</span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Useful Findings from Intelligence Data */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <TrendingUp className="size-3.5 text-indigo-400" />
          Opportunity Findings
        </span>

        {explanationLoading ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            Loading scoring engine signals...
          </div>
        ) : explanation?.reasons && explanation.reasons.length > 0 ? (
          <div className="space-y-1.5">
            {explanation.reasons.map((r, i) => (
              <div
                key={i}
                className="p-2.5 rounded-lg border border-border/60 bg-card/40 flex items-start gap-2"
              >
                <div className="size-2 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-foreground leading-snug">{r.reason}</p>
                  <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                    Component: {r.component} · Weight {r.weight}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-3 rounded-lg border border-border/60 bg-card/30 text-xs text-muted-foreground text-center">
            {explanation?.summary || "No specific negative findings detected for this lead."}
          </div>
        )}
      </div>

      {/* 3. Evidence vs. Inference */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-emerald-400" />
          Evidence vs. Inference
        </span>

        <div className="grid grid-cols-1 gap-2 text-xs">
          {/* Evidence */}
          <div className="p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 space-y-1">
            <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider block">
              Verified Evidence
            </span>
            <ul className="space-y-1 text-[11px] text-foreground/90">
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                <span>
                  {lead.email ? `Verified email: ${lead.email}` : "No verified email on record"}
                </span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                <span>
                  {lead.website ? `Active domain: ${lead.website}` : "No official web domain registered"}
                </span>
              </li>
              {trust?.businessHealth && (
                <li className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                  <span>Business Health score: {trust.businessHealth.score}/100</span>
                </li>
              )}
            </ul>
          </div>

          {/* Inference */}
          <div className="p-2.5 rounded-lg border border-indigo-500/30 bg-indigo-500/5 space-y-1">
            <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider block">
              Inferred Opportunity
            </span>
            <p className="text-[11px] text-foreground/90 leading-relaxed">
              {score && score >= 70
                ? "High probability of receptiveness to digital upgrades based on detected website and channel gaps."
                : "Moderate outreach opportunity. Verify specific pain points during initial discovery conversation."}
            </p>
          </div>
        </div>
      </div>

      {/* 4. Pre-Outreach Investigation Questions */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <HelpCircle className="size-3.5 text-indigo-400" />
          Questions to Investigate Before Contacting
        </span>

        <div className="space-y-1.5">
          {preOutreachQuestions.map((q, idx) => (
            <div
              key={idx}
              className="p-2 rounded-lg border border-border/50 bg-card/30 text-[11px] text-foreground/80 leading-relaxed flex items-start gap-2"
            >
              <span className="text-[10px] font-mono text-muted-foreground mt-0.5">{idx + 1}.</span>
              <span>{q}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
