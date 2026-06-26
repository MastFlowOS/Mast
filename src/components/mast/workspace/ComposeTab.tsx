import { ChannelSelector } from "./components/ChannelSelector";
import { EmailForm } from "./components/EmailForm";
import { InstagramForm } from "./components/InstagramForm";
import { PhoneForm } from "./components/PhoneForm";
import { ContactForm } from "./components/ContactForm";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

interface ComposeTabProps {
  lead: Lead;
  channel: Channel;
  setChannel: (c: Channel) => void;
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
}

const CHANNEL_LABELS: Record<Channel, { heading: string; hint: string }> = {
  email:        { heading: "Email Outreach",       hint: "Craft a personal, high-converting email to the decision-maker" },
  instagram:    { heading: "Instagram DM",          hint: "Send a warm, conversational DM that doesn't feel like a pitch" },
  phone:        { heading: "Call Script",           hint: "Use this script as your guide — keep it natural and confident" },
  contact_form: { heading: "Contact Form Message",  hint: "A concise message optimized for web contact forms" },
};

export function ComposeTab({
  lead,
  channel,
  setChannel,
  subject,
  setSubject,
  body,
  setBody,
}: ComposeTabProps) {
  const label = CHANNEL_LABELS[channel];

  return (
    <div className="p-8 space-y-6">
      {/* Channel selector */}
      <div className="flex items-center justify-between">
        <div className="animate-fade-up">
          <h2 className="text-base font-semibold">{label.heading}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{label.hint}</p>
        </div>
        <ChannelSelector value={channel} onChange={setChannel} />
      </div>

      <div className="border-t border-border" />

      {channel === "email" && (
        <EmailForm
          lead={lead}
          subject={subject}
          setSubject={setSubject}
          body={body}
          setBody={setBody}
        />
      )}
      {channel === "instagram" && (
        <InstagramForm lead={lead} body={body} setBody={setBody} />
      )}
      {channel === "phone" && (
        <PhoneForm lead={lead} body={body} setBody={setBody} />
      )}
      {channel === "contact_form" && (
        <ContactForm lead={lead} body={body} setBody={setBody} />
      )}
    </div>
  );
}
