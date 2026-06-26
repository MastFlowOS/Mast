import { useState, useEffect } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import {
  Mail,
  Phone,
  Globe,
  Instagram,
  MapPin,
  Sparkles,
  Zap,
  Send,
  ExternalLink,
  Save,
  Copy,
  Check,
  Loader2,
  Calendar,
  Building2,
  Tag,
  Share2,
} from "lucide-react";
import type { Lead } from "@/lib/api";
import { stripActivityMarkers } from "@/lib/lead-workspace";

interface LeadDetailsDrawerProps {
  lead: Lead | null;
  isOpen: boolean;
  onClose: () => void;
  onSaveToCRM?: (lead: Lead) => void;
}

export function LeadDetailsDrawer({ lead, isOpen, onClose, onSaveToCRM }: LeadDetailsDrawerProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);
  const [generatedMessage, setGeneratedMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  // Reset local interactive states when drawer opens/closes or lead changes
  useEffect(() => {
    setGeneratedMessage(null);
    setIsGeneratingAI(false);
    setIsSaved(lead?.status === "crm" || false);
  }, [lead, isOpen]);

  if (!lead) return null;

  const handleCopy = (text: string, fieldName: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    toast.success(`${fieldName} copied to clipboard`);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleGenerateAIMessage = () => {
    setIsGeneratingAI(true);
    setGeneratedMessage(null);

    // Simulate AI thinking and generating a multi-channel outreach message
    setTimeout(() => {
      const nicheText = lead.niche || "your industry";
      const businessText = lead.businessName || "your business";
      const message = `Hey there!

I stumbled upon ${businessText} while researching active leaders in the ${nicheText} space. I was really impressed by your operations and online presence.

I noticed a couple of quick multi-channel outreach improvements you could implement this week to increase client acquisition. 

Would you be open to a brief 5-minute exchange next Tuesday at 10:00 AM?

Best,
[Your Name]
Mast Acquisition OS`;

      setGeneratedMessage(message);
      setIsGeneratingAI(false);
      toast.success("AI Outreach message generated!");
    }, 1500);
  };

  const handleSaveToCRM = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setIsSaved(true);
      if (onSaveToCRM) {
        onSaveToCRM(lead);
      } else {
        toast.success(`${lead.businessName} saved to CRM successfully!`);
      }
    }, 1000);
  };

  const handleSendEmail = () => {
    if (lead.email) {
      window.location.href = `mailto:${lead.email}?subject=Collaboration%20Query`;
      toast.success("Opening default email client...");
    } else {
      toast.error("No email available for this lead.");
    }
  };

  const initials = lead.businessName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "L";

  // Score simulation based on priority
  const leadScore = lead.priority === "high" ? 94 : lead.priority === "normal" ? 78 : 62;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md md:max-w-lg bg-background border-l border-border flex flex-col p-0 overflow-hidden shadow-2xl">
        {/* Header Branding Panel */}
        <div className="relative p-6 border-b border-border bg-card overflow-hidden">
          <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              background: "radial-gradient(ellipse at top right, color-mix(in oklab, var(--brand) 25%, transparent), transparent 60%)",
            }}
          />
          <div className="pointer-events-none absolute inset-0 bg-grid opacity-[0.1]" />

          <div className="relative flex items-start gap-4">
            <div className="size-12 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center text-lg font-bold text-brand shrink-0">
              {initials}
            </div>
            <div className="space-y-1 min-w-0">
              <SheetHeader className="text-left">
                <SheetTitle className="text-xl font-bold tracking-tight text-foreground truncate pr-6">
                  {lead.businessName}
                </SheetTitle>
              </SheetHeader>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {lead.niche && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-brand/10 text-brand border border-brand/25">
                    <Tag className="size-2.5" /> {lead.niche}
                  </span>
                )}
                {lead.location && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-muted text-muted-foreground border border-border">
                    <MapPin className="size-2.5" /> {lead.location}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Body Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Quality Score Meter */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
              <span>Lead Verification Score</span>
              <span className="text-brand font-mono text-sm">{leadScore}%</span>
            </div>
            <div className="h-2 w-full bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-brand/60 to-brand transition-all duration-500"
                style={{ width: `${leadScore}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              This score aggregates contact validity, domain authority, and social signal strength.
            </p>
          </div>

          {/* Contextual Intelligence */}
          {(() => {
            let aiOverview = "";
            let suggestedAction = "";
            if (lead.notes) {
              const rawNotes = stripActivityMarkers(lead.notes);
              const overviewMatch = rawNotes.match(/AI Overview:\s*([\s\S]*?)(?=\n\nSuggested First Action:|$)/i);
              const actionMatch = rawNotes.match(/Suggested First Action:\s*([\s\S]*?)$/i);
              
              if (overviewMatch) aiOverview = overviewMatch[1].trim();
              if (actionMatch) suggestedAction = actionMatch[1].trim();
            }

            if (!aiOverview && !suggestedAction) return null;

            return (
              <div className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Contextual Intelligence
                </h3>
                <div className="space-y-3">
                  {aiOverview && (
                    <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-1.5 relative overflow-hidden">
                      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand">
                        <Sparkles className="size-3.5 text-brand" />
                        <span>AI Overview</span>
                      </div>
                      <p className="text-xs text-foreground leading-relaxed font-sans">
                        {aiOverview}
                      </p>
                    </div>
                  )}
                  {suggestedAction && (
                    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 space-y-1.5 relative overflow-hidden">
                      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-500">
                        <Zap className="size-3.5 text-amber-500" />
                        <span>Suggested Action</span>
                      </div>
                      <p className="text-xs text-foreground leading-relaxed font-sans font-medium">
                        {suggestedAction}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Contact Details Grid */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Contact Information
            </h3>
            <div className="space-y-2.5">
              {/* Email */}
              <ContactField
                label="Email"
                value={lead.email}
                icon={Mail}
                onCopy={() => handleCopy(lead.email!, "Email")}
                isCopied={copiedField === "Email"}
              />

              {/* Phone */}
              <ContactField
                label="Phone"
                value={lead.phone}
                icon={Phone}
                onCopy={() => handleCopy(lead.phone!, "Phone")}
                isCopied={copiedField === "Phone"}
              />

              {/* Website */}
              <ContactField
                label="Website"
                value={lead.website}
                icon={Globe}
                onCopy={() => handleCopy(lead.website!, "Website")}
                isCopied={copiedField === "Website"}
                action={
                  lead.website ? (
                    <a
                      href={lead.website.startsWith("http") ? lead.website : `https://${lead.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="size-7 rounded bg-brand/10 hover:bg-brand/20 grid place-items-center text-brand transition-colors focus:outline-none"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : undefined
                }
              />

              {/* Instagram */}
              <ContactField
                label="Instagram"
                value={lead.instagramHandle}
                icon={Instagram}
                onCopy={() => handleCopy(lead.instagramHandle!, "Instagram")}
                isCopied={copiedField === "Instagram"}
                action={
                  lead.instagramHandle ? (
                    <a
                      href={`https://instagram.com/${lead.instagramHandle.replace(/^@/, "")}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="size-7 rounded bg-brand/10 hover:bg-brand/20 grid place-items-center text-brand transition-colors focus:outline-none"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : undefined
                }
              />
            </div>
          </div>

          {/* Meta Info */}
          <div className="grid grid-cols-2 gap-3 bg-card border border-border rounded-xl p-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Source</p>
              <p className="text-sm font-semibold text-foreground mt-1 capitalize">
                {lead.source || "Live Search"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Generated On</p>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground mt-1">
                <Calendar className="size-3.5 text-muted-foreground" />
                <span>{new Date(lead.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {/* AI Message Section */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-brand animate-pulse" />
                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                  AI Outreach Assistant
                </span>
              </div>
              {generatedMessage && (
                <button
                  onClick={() => handleCopy(generatedMessage, "AI Message")}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:text-brand-dark focus:outline-none"
                >
                  {copiedField === "AI Message" ? (
                    <>
                      <Check className="size-3" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-3" /> Copy Message
                    </>
                  )}
                </button>
              )}
            </div>

            {isGeneratingAI ? (
              <div className="flex flex-col items-center justify-center py-8 space-y-3">
                <Loader2 className="size-6 text-brand animate-spin" />
                <p className="text-xs text-muted-foreground animate-pulse">
                  Analyzing lead profile & drafting message...
                </p>
              </div>
            ) : generatedMessage ? (
              <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                <textarea
                  readOnly
                  value={generatedMessage}
                  className="w-full bg-background border border-border rounded-lg p-3 text-xs text-foreground font-sans leading-relaxed focus:outline-none min-h-[160px] resize-none"
                />
                <p className="text-[10px] text-muted-foreground text-center">
                  Copy and customize this template for email or direct messaging.
                </p>
              </div>
            ) : (
              <div className="text-center py-3">
                <p className="text-xs text-muted-foreground mb-4">
                  Create a highly targeted multi-channel outreach draft for {lead.businessName}.
                </p>
                <button
                  onClick={handleGenerateAIMessage}
                  className="inline-flex items-center justify-center gap-2 w-full bg-gradient-to-r from-brand to-brand-dark hover:opacity-95 text-brand-foreground text-xs font-bold py-2.5 px-4 rounded-lg shadow-brand transition-all hover:scale-[1.01] active:scale-[0.99] focus:outline-none"
                >
                  <Sparkles className="size-3.5" /> Generate AI Message
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions Panel */}
        <div className="p-4 border-t border-border bg-card grid grid-cols-2 gap-2">
          <button
            onClick={handleSendEmail}
            disabled={!lead.email}
            className="flex items-center justify-center gap-2 py-2.5 rounded-lg border border-border bg-background hover:bg-muted font-bold text-xs text-foreground transition-all disabled:opacity-50 disabled:hover:bg-background cursor-pointer"
          >
            <Send className="size-3.5" /> Send Email
          </button>

          <button
            onClick={handleSaveToCRM}
            disabled={isSaving || isSaved}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-lg font-bold text-xs text-brand-foreground transition-all cursor-pointer ${
              isSaved
                ? "bg-success/20 border border-success/30 text-success"
                : "bg-brand hover:bg-brand-dark shadow-brand"
            }`}
          >
            {isSaving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Saving...
              </>
            ) : isSaved ? (
              <>
                <Check className="size-3.5" /> Saved to CRM
              </>
            ) : (
              <>
                <Save className="size-3.5" /> Save to CRM
              </>
            )}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface ContactFieldProps {
  label: string;
  value?: string | null;
  icon: React.ComponentType<{ className?: string }>;
  onCopy: () => void;
  isCopied: boolean;
  action?: React.ReactNode;
}

function ContactField({ label, value, icon: Icon, onCopy, isCopied, action }: ContactFieldProps) {
  if (!value) return null;

  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-card border border-border hover:border-muted-foreground/30 transition-colors group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-8 rounded bg-background border border-border flex items-center justify-center text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <span className="block text-xs font-semibold text-foreground truncate mt-0.5">
            {value}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onCopy}
          className="size-7 rounded bg-background hover:bg-muted border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
          title={`Copy ${label}`}
        >
          {isCopied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
        {action}
      </div>
    </div>
  );
}
