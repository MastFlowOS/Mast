import { useState } from "react";
import {
  Mail,
  Phone,
  Globe,
  Instagram,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Star,
  MoreVertical,
  Lightbulb,
  Target,
  Clock,
  FileText,
  Sparkles,
  ShieldCheck,
  Zap,
  AlertTriangle,
  Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Lead, FieldTrustEntry } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { leadNicheLabel, stripActivityMarkers } from "@/lib/lead-workspace";
import { useOpportunityExplanation, useOpportunityInsight, useLeadTrust, useUpdateLead } from "@/hooks/use-mast-api";
import { normalizeInstagram } from "@/lib/instagram";
import { resolveTrustPanelState, getFieldTrustEntry, formatVerificationLine, resolveDisqualificationDisplay } from "@/lib/trustPanel";
import { nicheImage } from "@/components/mast/discover/nicheImages";
import { ActivityTimeline } from "./components/ActivityTimeline";
import { NoteForm } from "./components/NoteForm";

const TRUST_FIELDS: Array<{ key: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "email", label: "Email", icon: Mail },
  { key: "phone", label: "Phone", icon: Phone },
  { key: "website", label: "Website", icon: Globe },
  { key: "instagram", label: "Instagram", icon: Instagram },
];

export function LeftSidebar({
  lead,
  channel,
  setChannel,
}: {
  lead: Lead;
  channel: Channel;
  setChannel: (channel: Channel) => void;
}) {
  const updateLeadMutation = useUpdateLead();
  const [copied, setCopied] = useState<string | null>(null);
  const [contactMethodsOpen, setContactMethodsOpen] = useState(true);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    insights: false,
    why: false,
    activity: false,
    notes: false,
  });

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(label);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(null), 2000);
  };

  const hasRealScore = lead.opportunityScore != null;
  const score = hasRealScore
    ? Math.round(lead.opportunityScore!)
    : lead.priority === "high"
      ? 94
      : lead.priority === "normal"
        ? 78
        : 62;

  const opportunityLevel = score >= 80 ? "High Opportunity" : score >= 60 ? "Medium Opportunity" : "Opportunity";
  const nicheLabel = leadNicheLabel(lead.niche);
  const ig = normalizeInstagram(lead.instagramHandle);
  const businessImageUrl = nicheImage(lead.niche || "");

  // Real Opportunity Explanation read
  const { data: explanation } = useOpportunityExplanation(lead.id, Boolean(lead.businessId));

  // Trust / Business Health read
  const { data: trust, isLoading: trustLoading, isError: trustError } = useLeadTrust(lead.id, Boolean(lead.businessId));
  const disqualification = resolveDisqualificationDisplay(trust);

  // AI Opportunity Insight read
  const { data: insight } = useOpportunityInsight(lead.businessId);

  // Extract AI Overview and Suggested Action if present in notes
  let aiOverview = "";
  let suggestedAction = "";
  if (lead.notes) {
    const rawNotes = stripActivityMarkers(lead.notes);
    const overviewMatch = rawNotes.match(/AI Overview:\s*([\s\S]*?)(?=\n\nSuggested First Action:|$)/i);
    const actionMatch = rawNotes.match(/Suggested First Action:\s*([\s\S]*?)$/i);
    if (overviewMatch) aiOverview = overviewMatch[1].trim();
    if (actionMatch) suggestedAction = actionMatch[1].trim();
  }

  // Derive bio / description
  const cleanDomain = lead.website ? lead.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "";
  const displayDescription =
    lead.igBio ||
    lead.brandingNotes ||
    (explanation?.summary ? explanation.summary : null) ||
    (lead.websiteNotes || null) ||
    `Local ${nicheLabel || "business"} in ${lead.location || "your market"} with verified outreach opportunities.`;

  const contactFormUrl = cleanDomain ? `${cleanDomain}/contact` : lead.website || "Website contact";

  return (
    <aside className="w-full shrink-0 border-b border-border bg-[#0d121d]/80 lg:w-[320px] lg:border-b-0 lg:border-r overflow-y-auto flex flex-col p-4 space-y-4">
      {/* ─── 1. LEAD PROFILE CARD ─── */}
      <div className="rounded-2xl border border-border/80 bg-card/40 p-4 space-y-3.5">
        <div className="flex items-start gap-3">
          {/* Business Image thumbnail */}
          <div className="size-16 rounded-xl overflow-hidden bg-muted/40 border border-border/60 shrink-0">
            <img
              src={businessImageUrl}
              alt={lead.businessName}
              className="size-full object-cover"
              onError={(e) => {
                // Fallback to initial avatar
                e.currentTarget.style.display = "none";
              }}
            />
            <div className="size-full grid place-items-center text-sm font-bold text-brand bg-brand/10">
              {lead.businessName.slice(0, 2).toUpperCase()}
            </div>
          </div>

          {/* Business Name, Category, Location, Star, More */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <h2 className="font-semibold text-sm text-foreground truncate" title={lead.businessName}>
                {lead.businessName}
              </h2>
              <div className="flex items-center shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    const next = lead.priority === "high" ? "normal" : "high";
                    await updateLeadMutation.mutateAsync({ id: lead.id, body: { priority: next } });
                    toast.success(next === "high" ? "Marked as favorite" : "Removed from favorites");
                  }}
                  className="p-1 text-muted-foreground hover:text-amber-400 transition-colors"
                  title="Favorite"
                >
                  <Star className={`size-3.5 ${lead.priority === "high" ? "text-amber-400 fill-amber-400" : ""}`} />
                </button>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
              {nicheLabel || "Business"} • {lead.location || "Local"} 🇺🇸
            </p>
          </div>
        </div>

        {/* Bio / Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 font-normal">
          {displayDescription}
        </p>

        {/* Opportunity Score Badges */}
        <div className="flex items-center gap-2 pt-0.5">
          <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
            {opportunityLevel}
          </span>
          <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold bg-card/80 border border-border/80 text-foreground">
            Score <span className="ml-1 text-foreground font-mono font-bold">{score}</span>
          </span>
        </div>
      </div>

      {/* ─── 2. CONTACT METHODS SECTION ─── */}
      <div className="rounded-2xl border border-border/80 bg-card/40 p-4 space-y-3">
        <button
          type="button"
          onClick={() => setContactMethodsOpen(!contactMethodsOpen)}
          className="flex w-full items-center justify-between text-left text-xs font-semibold text-foreground hover:text-white transition-colors"
        >
          <span>Contact Methods</span>
          {contactMethodsOpen ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {contactMethodsOpen && (
          <div className="space-y-2 pt-1">
            {/* Email */}
            <div
              onClick={() => setChannel("email")}
              className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all ${
                channel === "email"
                  ? "border-[#4f46e5]/50 bg-[#4f46e5]/10 shadow-sm"
                  : "border-border/60 bg-[#0d121d]/40 hover:border-border hover:bg-card/60"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-lg bg-blue-500/15 border border-blue-500/25 text-blue-400 grid place-items-center shrink-0">
                  <Mail className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground leading-tight">Email</p>
                  <p className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5 max-w-[140px]">
                    {lead.email || "No email available"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                    lead.email
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      : "bg-muted/40 text-muted-foreground border border-border/40"
                  }`}
                >
                  {lead.email ? "Verified" : "Missing"}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </div>
            </div>

            {/* Instagram */}
            <div
              onClick={() => setChannel("instagram")}
              className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all ${
                channel === "instagram"
                  ? "border-[#4f46e5]/50 bg-[#4f46e5]/10 shadow-sm"
                  : "border-border/60 bg-[#0d121d]/40 hover:border-border hover:bg-card/60"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-lg bg-pink-500/15 border border-pink-500/25 text-pink-400 grid place-items-center shrink-0">
                  <Instagram className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground leading-tight">Instagram</p>
                  <p className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5 max-w-[140px]">
                    {ig?.handle ? `@${ig.handle}` : lead.instagramHandle ? `@${lead.instagramHandle}` : "Not connected"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                    lead.instagramHandle
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      : "bg-muted/40 text-muted-foreground border border-border/40"
                  }`}
                >
                  {lead.instagramHandle ? "Available" : "Missing"}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </div>
            </div>

            {/* Phone */}
            <div
              onClick={() => setChannel("phone")}
              className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all ${
                channel === "phone"
                  ? "border-[#4f46e5]/50 bg-[#4f46e5]/10 shadow-sm"
                  : "border-border/60 bg-[#0d121d]/40 hover:border-border hover:bg-card/60"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 grid place-items-center shrink-0">
                  <Phone className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground leading-tight">Phone</p>
                  <p className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5 max-w-[140px]">
                    {lead.phone || "Not connected"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                    lead.phone
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      : "bg-muted/40 text-muted-foreground border border-border/40"
                  }`}
                >
                  {lead.phone ? "Verified" : "Missing"}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </div>
            </div>

            {/* Contact Form */}
            <div
              onClick={() => setChannel("contact_form")}
              className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all ${
                channel === "contact_form"
                  ? "border-[#4f46e5]/50 bg-[#4f46e5]/10 shadow-sm"
                  : "border-border/60 bg-[#0d121d]/40 hover:border-border hover:bg-card/60"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-lg bg-sky-500/15 border border-sky-500/25 text-sky-400 grid place-items-center shrink-0">
                  <LinkIcon className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground leading-tight">Contact Form</p>
                  <p className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5 max-w-[140px]">
                    {contactFormUrl}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                    lead.website
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      : "bg-muted/40 text-muted-foreground border border-border/40"
                  }`}
                >
                  {lead.website ? "Available" : "Missing"}
                </span>
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── 3. SECONDARY ACCORDIONS ─── */}
      <div className="space-y-2">
        {/* Accordion 1: Business Insights */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("insights")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-amber-400" />
              <span>Business Insights</span>
            </div>
            {openSections.insights ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.insights && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-3 text-xs">
              {/* Contextual Intelligence */}
              {aiOverview && (
                <div className="rounded-lg border border-brand/20 bg-brand/5 p-2.5 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-brand">
                    <Sparkles className="size-3.5" />
                    <span>AI Overview</span>
                  </div>
                  <p className="text-[11px] text-foreground leading-relaxed">{aiOverview}</p>
                </div>
              )}

              {suggestedAction && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-500">
                    <Zap className="size-3.5" />
                    <span>Suggested First Action</span>
                  </div>
                  <p className="text-[11px] text-foreground leading-relaxed font-medium">{suggestedAction}</p>
                </div>
              )}

              {/* Health Score */}
              {trust?.businessHealth && (
                <div className="rounded-lg border border-border bg-background/50 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                      <ShieldCheck className="size-3.5 text-brand" /> Business Health
                    </span>
                    <span className="font-mono font-bold text-foreground">{Math.round(trust.businessHealth.score)}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand rounded-full"
                      style={{ width: `${Math.round(trust.businessHealth.score)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* AI Opportunity Insight */}
              {insight && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Talking Points</p>
                  <ul className="space-y-1 text-[11px] text-muted-foreground list-disc list-inside">
                    {insight.talking_points.slice(0, 3).map((pt, i) => (
                      <li key={i} className="text-foreground leading-tight">{pt}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Details */}
              <div className="space-y-1 pt-1 text-[11px] text-muted-foreground">
                {lead.igFollowers && (
                  <div className="flex justify-between">
                    <span>IG Followers</span>
                    <span className="font-medium text-foreground">{lead.igFollowers}</span>
                  </div>
                )}
                {lead.website && (
                  <div className="flex justify-between">
                    <span>Website</span>
                    <span className="font-medium text-foreground truncate max-w-[130px]">{lead.website}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span>Created</span>
                  <span className="font-medium text-foreground">{new Date(lead.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Accordion 2: Why This Opportunity */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("why")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Target className="size-4 text-rose-400" />
              <span>Why This Opportunity</span>
            </div>
            {openSections.why ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.why && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-2.5 text-xs">
              {explanation ? (
                <div className="space-y-2">
                  <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-semibold bg-brand/10 text-brand border border-brand/20">
                    <Sparkles className="size-3" />
                    <span>{explanation.professionMatch === "strong" ? "Strong match for your profession" : "Profession match"}</span>
                  </div>
                  <p className="text-[11px] text-foreground leading-relaxed">{explanation.summary}</p>
                  <ul className="space-y-1">
                    {explanation.reasons.map((r) => (
                      <li key={r.component} className="text-[11px]">
                        <span className="font-semibold text-foreground">{r.label}:</span>{" "}
                        <span className="text-muted-foreground">{r.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Opportunity scored based on local market factors, contact availability, and conversion likelihood.
                </p>
              )}

              {disqualification && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-2.5">
                  <AlertTriangle className="size-3.5 text-destructive shrink-0 mt-0.5" />
                  <div className="text-[11px] text-destructive">
                    <p className="font-bold">{disqualification.label}</p>
                    <p className="text-foreground">{disqualification.reason}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Accordion 3: Recent Activity */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("activity")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-indigo-400" />
              <span>Recent Activity</span>
            </div>
            {openSections.activity ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.activity && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-2 text-xs">
              <ActivityTimeline lead={lead} />
            </div>
          )}
        </div>

        {/* Accordion 4: Notes */}
        <div className="rounded-xl border border-border/80 bg-card/40 overflow-hidden">
          <button
            type="button"
            onClick={() => toggleSection("notes")}
            className="flex w-full items-center justify-between p-3.5 text-left text-xs font-semibold text-foreground hover:bg-card/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-sky-400" />
              <span>Notes</span>
            </div>
            {openSections.notes ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {openSections.notes && (
            <div className="p-3.5 pt-0 border-t border-border/40 space-y-2 text-xs">
              <NoteForm lead={lead} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
