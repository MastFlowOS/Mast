import { useEffect, useState } from "react";
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
  Loader2,
  Camera,
  Copy,
  Check,
  ArrowUpRight,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { InvestigateLeadResult, Lead } from "@/lib/api";
import {
  useOpportunityExplanation,
  useLeadTrust,
  useSettings,
  useInvestigateLead,
  useLeadWebsiteAudit,
  useRunLeadWebsiteAudit,
} from "@/hooks/use-mast-api";
import { leadNicheDisplay } from "@/lib/lead-workspace";
import { openExternalPopup } from "@/lib/externalPopup";

interface ResearchTabProps {
  lead: Lead;
  researchQuestion: string;
  setResearchQuestion: React.Dispatch<React.SetStateAction<string>>;
  onInsert?: (body: string, subject?: string) => void;
}

export function ResearchTab({ lead, researchQuestion, setResearchQuestion, onInsert }: ResearchTabProps) {
  const { data: explanation, isLoading: explanationLoading } = useOpportunityExplanation(lead.id);
  const { data: trust, isLoading: trustLoading } = useLeadTrust(lead.id);
  const { data: settings } = useSettings();
  const investigate = useInvestigateLead();
  const auditQuery = useLeadWebsiteAudit(lead.id);
  const runAudit = useRunLeadWebsiteAudit(lead.id);

  const [investigationResult, setInvestigationResult] = useState<InvestigateLeadResult | null>(null);
  const [copiedAudit, setCopiedAudit] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const websiteAudit = auditQuery?.data?.audit ?? null;

  useEffect(() => {
    setInvestigationResult(null);
    setCopiedAudit(false);
    setPreviewExpanded(false);
  }, [lead.id]);

  const handleRunWebsiteAudit = async () => {
    if (runAudit.isPending) return;
    try {
      await runAudit.mutateAsync({});
      toast.success("Website preview & mini audit ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run website audit");
    }
  };

  const formatAuditBulletsText = () => {
    if (!websiteAudit || websiteAudit.auditBullets.length === 0) return "";
    return [
      `Quick website notes for ${lead.businessName}:`,
      ...websiteAudit.auditBullets.map((b) => `• ${b}`),
    ].join("\n");
  };

  const handleCopyAuditBullets = async () => {
    const text = formatAuditBulletsText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAudit(true);
      toast.success("Mini audit bullets copied");
      setTimeout(() => setCopiedAudit(false), 2000);
    } catch {
      toast.error("Could not copy bullets");
    }
  };

  const handleInsertAuditBullets = () => {
    const text = formatAuditBulletsText();
    if (!text || !onInsert) return;
    onInsert(text);
    toast.success("Mini audit inserted into composer");
  };

  const nicheLabel = leadNicheDisplay(lead.niche);
  const score = lead.opportunityScore ?? explanation?.score ?? null;

  const runInvestigation = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed || investigate.isPending) return;
    try {
      const res = await investigate.mutateAsync({ leadId: lead.id, question: trimmed });
      setInvestigationResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run investigation");
    }
  };

  const handleInvestigate = (e: React.FormEvent) => {
    e.preventDefault();
    void runInvestigation(researchQuestion);
  };

  // Structured discovery questions to evaluate before reaching out
  const preOutreachQuestions = [
    `Does ${lead.businessName} currently offer online booking or digital self-scheduling for ${nicheLabel.toLowerCase()} services?`,
    `Who is the primary decision-maker for technology and marketing operations?`,
    `How does their online reputation and review volume compare to local competitors in ${lead.location || "their area"}?`,
    lead.website ? "Are their primary mobile calls-to-action clearly visible without scrolling?" : "Why does this business operate without an active official website?",
  ];

  return (
    <div className="space-y-3.5">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-lg bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 grid place-items-center shrink-0">
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
            className="h-8 text-xs bg-background/50 border-border/60 rounded-lg placeholder:text-muted-foreground/50 focus-visible:ring-indigo-500/40 flex-1"
          />
          <Button
            type="submit"
            disabled={!researchQuestion.trim() || investigate.isPending}
            variant="outline"
            className="h-8 px-2.5 text-xs border-border/60 bg-card/50 hover:bg-card text-foreground rounded-lg shrink-0 gap-1.5"
          >
            {investigate.isPending ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Checking
              </>
            ) : (
              "Investigate"
            )}
          </Button>
        </div>

        {/* Honest data-source notice */}
        <div className="p-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 text-[10px] space-y-0.5 text-foreground/90">
          <div className="flex items-center gap-1.5 font-semibold text-indigo-300">
            <Info className="size-3 text-indigo-400 shrink-0" />
            <span>Verified Data &amp; Live Homepage Check</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            Answers combine MAST&apos;s verified business database, scoring telemetry, and a live homepage signal check when a website is listed.
          </p>
        </div>
      </form>

      {/* Investigation Result */}
      {investigationResult && (
        <div
          data-testid="investigation-result"
          className="p-3 rounded-xl border border-indigo-500/35 bg-indigo-500/5 space-y-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-300 flex items-center gap-1">
              <Sparkles className="size-3 text-indigo-400" />
              {investigationResult.mode === "ai" ? "AI Research Answer" : "Verified Data Answer"}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border/60 bg-background/50 text-muted-foreground capitalize">
              {investigationResult.confidence} confidence
            </span>
          </div>

          <p className="text-xs text-foreground leading-relaxed">{investigationResult.answer}</p>

          {(investigationResult.websiteSnapshot.cmsOrTech.length > 0 ||
            investigationResult.websiteSnapshot.bookingTools.length > 0 ||
            investigationResult.websiteSnapshot.analyticsTools.length > 0) && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {[
                ...investigationResult.websiteSnapshot.cmsOrTech,
                ...investigationResult.websiteSnapshot.bookingTools,
                ...investigationResult.websiteSnapshot.analyticsTools,
              ].map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/25 text-indigo-300 font-medium"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {investigationResult.evidence.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-border/40">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 block">
                Evidence Found
              </span>
              <ul className="space-y-1 text-[11px] text-foreground/85">
                {investigationResult.evidence.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <CheckCircle2 className="size-3 text-emerald-400 shrink-0 mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {investigationResult.gaps.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-border/40">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 block">
                Not Verified Yet
              </span>
              <ul className="space-y-0.5 text-[10px] text-muted-foreground">
                {investigationResult.gaps.map((gap, idx) => (
                  <li key={idx}>• {gap}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 0. Website Screenshot Preview & 1-Click Bullet Mini Audit */}
      <div
        data-testid="website-mini-audit-card"
        className="p-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.04] space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Camera className="size-3.5 text-violet-400 shrink-0" />
            <span className="text-xs font-semibold text-foreground truncate">
              Website Preview &amp; Mini Audit
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRunWebsiteAudit}
            disabled={runAudit.isPending}
            className="h-7 px-2 text-[11px] border-violet-500/35 bg-violet-500/10 hover:bg-violet-500/20 text-violet-200 gap-1 shrink-0"
          >
            {runAudit.isPending ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Auditing...
              </>
            ) : websiteAudit ? (
              <>
                <RefreshCw className="size-3" />
                Refresh
              </>
            ) : (
              <>
                <Sparkles className="size-3" />
                Run Mini Audit
              </>
            )}
          </Button>
        </div>

        {!websiteAudit && !runAudit.isPending && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Capture a live homepage screenshot and generate 3–5 bullet points you can paste into outreach. The AI Writer also uses this visual critique automatically.
          </p>
        )}

        {websiteAudit && (
          <div className="space-y-2.5">
            {websiteAudit.screenshotDataUrl && (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setPreviewExpanded((prev) => !prev)}
                  className="block w-full overflow-hidden rounded-lg border border-border/70 bg-black/40 hover:border-violet-400/60 transition-colors cursor-pointer text-left"
                  title={previewExpanded ? "Collapse preview" : "Expand preview"}
                >
                  <img
                    src={websiteAudit.screenshotDataUrl}
                    alt={`${lead.businessName} homepage screenshot`}
                    className={`w-full object-cover object-top transition-all ${
                      previewExpanded ? "max-h-96" : "max-h-36"
                    }`}
                  />
                </button>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Click image to {previewExpanded ? "collapse" : "expand"}</span>
                  <span className="text-violet-300 font-medium">Synced to AI Writer</span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/25 text-violet-300 font-medium">
                {websiteAudit.mode === "ai_vision"
                  ? "AI Visual Critique"
                  : websiteAudit.mode === "ai_text"
                    ? "AI Mini Audit"
                    : "Verified Signals"}
              </span>
              {!websiteAudit.screenshotAvailable && (
                <span className="text-muted-foreground">Synced to AI Writer</span>
              )}
            </div>

            {websiteAudit.visualSummary && (
              <p className="text-[11px] text-foreground/90 leading-relaxed">
                {websiteAudit.visualSummary}
              </p>
            )}

            {websiteAudit.auditBullets.length > 0 && (
              <ul className="space-y-1.5 text-[11px] text-foreground/90">
                {websiteAudit.auditBullets.map((bullet, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="text-violet-400 font-bold leading-snug">•</span>
                    <span className="leading-snug">{bullet}</span>
                  </li>
                ))}
              </ul>
            )}

            {websiteAudit.auditBullets.length > 0 && (
              <div className="flex items-center gap-1.5 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCopyAuditBullets}
                  className="h-7 px-2.5 text-[11px] border-border/70 bg-card/60 hover:bg-card gap-1 flex-1"
                >
                  {copiedAudit ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                  {copiedAudit ? "Copied" : "Copy Bullets"}
                </Button>
                {onInsert && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleInsertAuditBullets}
                    className="h-7 px-2.5 text-[11px] bg-violet-600 hover:bg-violet-500 text-white gap-1 flex-1"
                  >
                    <ArrowUpRight className="size-3" />
                    Insert in Composer
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 1. Business Overview Card */}
      <div className="p-3 rounded-xl border border-border/60 bg-card/40 space-y-2.5">
        <div className="flex items-start justify-between">
          <div className="min-w-0 pr-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
              Business Summary
            </span>
            <h5 className="text-sm font-semibold text-foreground mt-0.5 truncate">{lead.businessName}</h5>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground flex-wrap">
              <span className="px-1.5 py-0.2 rounded bg-border/50 text-foreground/90 font-medium text-[10px]">
                {nicheLabel}
              </span>
              {lead.location && <span className="text-[11px]">· {lead.location}</span>}
            </div>
          </div>

          {score !== null && (
            <div className="text-right shrink-0">
              <span className="text-[10px] text-muted-foreground uppercase font-mono block">Opportunity</span>
              <div className="flex items-center gap-0.5 justify-end mt-0.5">
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
                onClick={(e) => {
                  e.preventDefault();
                  openExternalPopup(lead.website!);
                }}
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
      <div className="space-y-1.5">
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
            {explanation.reasons.map((r, i) => {
              const reasonText = (r as any).reason || (r as any).label || (r as any).detail || "";
              return (
                <div
                  key={i}
                  className="p-2.5 rounded-lg border border-border/50 bg-card/30 flex items-start gap-2"
                >
                  <div className="size-2 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-xs font-medium text-foreground leading-snug">{reasonText}</p>
                    <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                      Component: {r.component} · Weight {r.weight}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-3 rounded-lg border border-border/50 bg-card/25 text-xs text-muted-foreground text-center">
            {explanation?.summary || "No specific negative findings detected for this lead."}
          </div>
        )}
      </div>

      {/* 3. Evidence vs. Inference */}
      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-emerald-400" />
          Evidence vs. Inference
        </span>

        <div className="grid grid-cols-1 gap-2 text-xs">
          {/* Evidence */}
          <div className="p-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 space-y-1">
            <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider block">
              Verified Evidence
            </span>
            <ul className="space-y-1 text-[11px] text-foreground/90">
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                <span className="truncate">
                  {lead.email ? `Verified email: ${lead.email}` : "No verified email on record"}
                </span>
              </li>
              <li className="flex items-center gap-1.5">
                <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                <span className="truncate">
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
          <div className="p-2.5 rounded-lg border border-indigo-500/25 bg-indigo-500/5 space-y-1">
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
      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <HelpCircle className="size-3.5 text-indigo-400" />
          Questions to Investigate Before Contacting
        </span>

        <div className="space-y-1.5">
          {preOutreachQuestions.map((q, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setResearchQuestion(q);
                void runInvestigation(q);
              }}
              disabled={investigate.isPending}
              className="w-full text-left p-2 rounded-lg border border-border/40 bg-card/25 hover:bg-card/50 hover:border-indigo-500/35 transition-colors text-[11px] text-foreground/80 leading-relaxed flex items-start gap-2"
            >
              <span className="text-[10px] font-mono text-muted-foreground mt-0.5 shrink-0">{idx + 1}.</span>
              <span>{q}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
