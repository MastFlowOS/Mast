import { useEffect, useState } from "react";
import { Check, CheckCircle, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRecordLeadActivity } from "@/hooks/use-mast-api";
import type { Lead } from "@/lib/api";

interface ContactFormProps {
  lead: Lead;
  body: string;
  setBody: (value: string) => void;
}

export function ContactForm({ lead, body, setBody }: ContactFormProps) {
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const recordActivity = useRecordLeadActivity();

  useEffect(() => {
    setCopied(false);
  }, [body, lead.id]);

  const websiteUrl = lead.website
    ? lead.website.startsWith("http")
      ? lead.website
      : `https://${lead.website}`
    : "";

  const copyMessage = async () => {
    if (!body.trim()) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      toast.success("Message copied");
    } catch {
      toast.error("Could not copy message");
    }
  };

  const openWebsite = async () => {
    if (!websiteUrl) {
      toast.error("No website recorded for this lead");
      return;
    }
    if (body.trim()) await copyMessage();
    window.open(websiteUrl, "_blank", "noopener,noreferrer");
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "contact_form_opened",
          channel: "contact_form",
          body,
          content: `Website opened for ${lead.businessName}`,
        },
      });
      toast.success(body.trim() ? "Message copied and website opened" : "Website opened");
    } catch {
      toast.error("Website opened, but history could not be saved");
    }
  };

  const markSent = async () => {
    const sentAt = new Date().toISOString();
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "contact_form_sent",
          channel: "contact_form",
          body,
          timestamp: sentAt,
          content: "Contact form message marked sent",
        },
        patch: {
          status: "contact_form_sent",
          lastContactedAt: sentAt,
        },
      });
      setSent(true);
      toast.success("Marked as sent");
    } catch {
      toast.error("Could not mark contact form as sent");
    }
  };

  return (
    <div className="space-y-5">
      {!lead.website && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          No website recorded for this lead.
        </div>
      )}

      <div className="space-y-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          Contact Form Message
        </label>
        <Textarea
          placeholder="Write a contact form message, or use the AI Assistant to generate one..."
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="min-h-[260px] resize-y text-sm leading-relaxed"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={copyMessage} disabled={!body.trim()} className="w-full gap-1.5 sm:w-auto">
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy Message
            </>
          )}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={openWebsite}
          disabled={!lead.website || recordActivity.isPending}
          className="w-full gap-1.5 sm:w-auto"
        >
          <ExternalLink className="size-3.5" />
          Open Website
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={markSent}
          disabled={sent || recordActivity.isPending}
          className="w-full gap-1.5 text-muted-foreground hover:text-foreground sm:ml-auto sm:w-auto"
        >
          <CheckCircle className={`size-3.5 ${sent ? "text-green-500" : ""}`} />
          {sent ? "Sent" : "Mark Sent"}
        </Button>
      </div>
    </div>
  );
}
