import { Globe, Instagram, Mail, Phone } from "lucide-react";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

const channelRows: Array<{
  id: Channel;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  getValue: (lead: Lead) => string | null | undefined;
}> = [
  { id: "email", label: "Email", icon: Mail, getValue: (lead) => lead.email },
  { id: "instagram", label: "Instagram DM", icon: Instagram, getValue: (lead) => lead.instagramHandle },
  { id: "phone", label: "Phone", icon: Phone, getValue: (lead) => lead.phone },
  { id: "contact_form", label: "Contact Form", icon: Globe, getValue: (lead) => lead.website },
];

export function ChannelAvailabilityCard({
  lead,
  channel,
  setChannel,
}: {
  lead: Lead;
  channel: Channel;
  setChannel: (channel: Channel) => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        Outreach Channels
      </h3>
      <div className="space-y-1.5">
        {channelRows.map((item) => {
          const value = item.getValue(lead);
          const available = Boolean(value);
          const active = channel === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={!available}
              onClick={() => setChannel(item.id)}
              className={
                active
                  ? "flex w-full items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-left text-xs text-foreground"
                  : available
                    ? "flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs text-foreground hover:border-muted-foreground/40"
                    : "flex w-full items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2 text-left text-xs text-muted-foreground/50 cursor-not-allowed"
              }
            >
              <item.icon className={active ? "size-4 shrink-0 text-brand" : "size-4 shrink-0"} />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {available ? (
                <span className="text-[10px] font-bold text-success">Available</span>
              ) : (
                <span className="text-[10px] font-medium text-muted-foreground/60">Unavailable</span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
