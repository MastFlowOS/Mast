import { Mail, Phone, Globe, Instagram, MapPin, Tag, ExternalLink, Copy, Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { ChannelAvailabilityCard } from "./components/ChannelAvailabilityCard";
import { NICHES } from "@/lib/lead-workspace";

function formatSourceLabel(source: string | null | undefined): string {
  if (!source) return "Mast Lead Engine";
  if (source === "internal_generator") return "Mast Lead Engine";
  if (source === "manual") return "Manual Entry";
  if (source === "import") return "CSV Import";
  if (source === "live_search") return "Live Search";
  return source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function LeftSidebar({
  lead,
  channel,
  setChannel,
}: {
  lead: Lead;
  channel: Channel;
  setChannel: (channel: Channel) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(label);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(null), 2000);
  };

  const score = lead.priority === "high" ? 94 : lead.priority === "normal" ? 78 : 62;
  const nicheLabel = NICHES.find((n) => n.value === lead.niche)?.label ?? lead.niche;

  const hasContactData = lead.email || lead.phone || lead.website || lead.instagramHandle || lead.location;

  return (
    <aside className="w-[232px] shrink-0 border-r border-border flex flex-col overflow-y-auto bg-card/40">
      <div className="p-5 space-y-7">

        {/* Score */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Lead Score</span>
            <span className="text-sm font-bold text-brand font-mono">{score}%</span>
          </div>
          <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-brand/70 to-brand rounded-full transition-all duration-700"
              style={{ width: `${score}%` }}
            />
          </div>
        </div>

        {/* Contact */}
        <section className="space-y-3">
          <SectionHeading>Contact</SectionHeading>
          {hasContactData ? (
            <div className="space-y-1.5">
              {lead.email && (
                <ContactRow
                  icon={Mail}
                  label="Email"
                  value={lead.email}
                  onCopy={() => handleCopy(lead.email!, "Email")}
                  copied={copied === "Email"}
                />
              )}
              {lead.phone && (
                <ContactRow
                  icon={Phone}
                  label="Phone"
                  value={lead.phone}
                  href={`tel:${lead.phone}`}
                  onCopy={() => handleCopy(lead.phone!, "Phone")}
                  copied={copied === "Phone"}
                />
              )}
              {lead.website && (
                <ContactRow
                  icon={Globe}
                  label="Website"
                  value={lead.website}
                  href={lead.website.startsWith("http") ? lead.website : `https://${lead.website}`}
                  onCopy={() => handleCopy(lead.website!, "Website")}
                  copied={copied === "Website"}
                />
              )}
              {lead.instagramHandle && (
                <ContactRow
                  icon={Instagram}
                  label="Instagram"
                  value={`@${lead.instagramHandle.replace(/^@/, "")}`}
                  href={`https://instagram.com/${lead.instagramHandle.replace(/^@/, "")}`}
                  onCopy={() => handleCopy(lead.instagramHandle!, "Instagram")}
                  copied={copied === "Instagram"}
                />
              )}
              {lead.location && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-background border border-border">
                  <MapPin className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs text-foreground truncate">{lead.location}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No contact data available.</p>
          )}
        </section>

        <ChannelAvailabilityCard lead={lead} channel={channel} setChannel={setChannel} />

        {/* Status */}
        <section className="space-y-3">
          <SectionHeading>Status</SectionHeading>
          <div className="space-y-1.5">
            <InfoRow label="Status" value={lead.status} />
            {lead.priority && <InfoRow label="Priority" value={lead.priority} />}
            {nicheLabel && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border">
                <Tag className="size-3 text-brand shrink-0" />
                <span className="text-xs text-foreground truncate">{nicheLabel}</span>
              </div>
            )}
            {lead.tags && <InfoRow label="Tags" value={lead.tags} />}
          </div>
        </section>

        {(lead.igFollowers || lead.igBio || lead.igLastPost || lead.igPostDescription || lead.brandingNotes || lead.websiteNotes) && (
          <section className="space-y-3">
            <SectionHeading>Research</SectionHeading>
            <div className="space-y-2 text-xs">
              {lead.igFollowers && <MetaRow label="IG followers" value={lead.igFollowers} />}
              {lead.igBio && <ResearchBlock label="IG bio" value={lead.igBio} />}
              {lead.igLastPost && <ResearchBlock label="Last post" value={lead.igLastPost} />}
              {lead.igPostDescription && <ResearchBlock label="Post notes" value={lead.igPostDescription} />}
              {lead.brandingNotes && <ResearchBlock label="Branding" value={lead.brandingNotes} />}
              {lead.websiteNotes && <ResearchBlock label="Website" value={lead.websiteNotes} />}
            </div>
          </section>
        )}

        {/* Meta */}
        <section className="space-y-3">
          <SectionHeading>Details</SectionHeading>
          <div className="space-y-1.5 text-xs">
            <MetaRow label="Source" value={formatSourceLabel(lead.source)} />
            <MetaRow label="Created" value={new Date(lead.createdAt).toLocaleDateString()} />
            {lead.lastContactedAt && (
              <MetaRow label="Last contact" value={new Date(lead.lastContactedAt).toLocaleDateString()} />
            )}
            {lead.followUpAt && (
              <MetaRow label="Follow-up" value={new Date(lead.followUpAt).toLocaleDateString()} />
            )}
          </div>
        </section>

      </div>
    </aside>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

function ContactRow({
  icon: Icon, label, value, href, onCopy, copied,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
  href?: string;
  onCopy: () => void;
  copied: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-background border border-border group hover:border-muted-foreground/30 transition-colors">
      <Icon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-foreground truncate flex-1">{value}</span>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button onClick={onCopy} className="size-5 rounded hover:bg-muted grid place-items-center" title={`Copy ${label}`}>
          {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3 text-muted-foreground" />}
        </button>
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="size-5 rounded hover:bg-muted grid place-items-center">
            <ExternalLink className="size-3 text-muted-foreground hover:text-brand" />
          </a>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-background border border-border">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold capitalize">{value}</span>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function ResearchBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground">{value}</p>
    </div>
  );
}
