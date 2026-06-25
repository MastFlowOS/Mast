import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Mail, Send, CheckCircle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRecordLeadActivity, useSendLeadEmail } from "@/hooks/use-mast-api";
import { isMissingBackendEndpoint, type Lead } from "@/lib/api";
import { normalizeLeadStatus } from "@/lib/lead-workspace";

interface EmailFormProps {
  lead: Lead;
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
}

export function EmailForm({ lead, subject, setSubject, body, setBody }: EmailFormProps) {
  const [isSent, setIsSent] = useState(
    ["contacted", "email_sent"].includes(normalizeLeadStatus(lead.status)) && Boolean(lead.lastContactedAt),
  );
  const sendEmail = useSendLeadEmail();
  const recordActivity = useRecordLeadActivity();

  useEffect(() => {
    setIsSent(["contacted", "email_sent"].includes(normalizeLeadStatus(lead.status)) && Boolean(lead.lastContactedAt));
  }, [lead.lastContactedAt, lead.status]);

  const buildMailtoUrl = () => {
    if (!lead.email) return "";
    const params = new URLSearchParams();
    if (subject) params.set("subject", subject);
    if (body) params.set("body", body);
    const query = params.toString();
    return `mailto:${lead.email}${query ? `?${query}` : ""}`;
  };

  const handleOpenMail = async () => {
    if (!lead.email) {
      toast.error("No email address for this lead");
      return;
    }
    // Use location.href so mailto opens the default mail client correctly
    // without triggering popup blockers or broken blank tabs
    const url = buildMailtoUrl();
    window.location.href = url;

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "email_opened",
          channel: "email",
          subject,
          body,
          content: `Email client opened for ${lead.email}`,
        },
      });
    } catch {
      // Non-critical
    }
    toast.success("Opening email client…");
  };

  const handleSend = async () => {
    if (!lead.email) {
      toast.error("No email address for this lead");
      return;
    }
    if (!subject.trim() || !body.trim()) return;

    const sentAt = new Date().toISOString();
    try {
      await sendEmail.mutateAsync({ leadId: lead.id, body: { subject, body } });
      await recordSent(sentAt, "Email sent via connected account");
      toast.success("Email sent");
    } catch (error) {
      if (isMissingBackendEndpoint(error)) {
        // Fallback: open mail client and record activity
        window.location.href = buildMailtoUrl();
        try {
          await recordActivity.mutateAsync({
            lead,
            activity: {
              type: "email_opened",
              channel: "email",
              subject,
              body,
              content: "Connected email send unavailable; mail client opened",
            },
          });
        } catch {
          // Non-critical
        }
        toast.info("Connected email not available. Opening your mail client.");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Failed to send email");
    }
  };

  const recordSent = async (sentAt = new Date().toISOString(), content = "Email marked sent") => {
    await recordActivity.mutateAsync({
      lead,
      activity: {
        type: "email_sent",
        channel: "email",
        subject,
        body,
        timestamp: sentAt,
        content,
      },
      patch: {
        status: "email_sent",
        lastContactedAt: sentAt,
      },
    });
    setIsSent(true);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          Subject Line
        </label>
        <Input
          placeholder="e.g. Quick question for you…"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          Message Body
        </label>
        <Textarea
          placeholder="Write your message, or use the AI Assistant → to generate one…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[260px] resize-y text-sm leading-relaxed"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {lead.email && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenMail}
            disabled={recordActivity.isPending}
            className="w-full gap-1.5 sm:w-auto"
          >
            <Mail className="size-3.5" />
            Open Email
          </Button>
        )}

        <Button
          onClick={handleSend}
          disabled={!subject.trim() || !body.trim() || sendEmail.isPending || recordActivity.isPending}
          size="sm"
          className="w-full gap-1.5 bg-brand hover:bg-brand/90 text-brand-foreground sm:ml-auto sm:w-auto"
        >
          {sendEmail.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send via Connected Email
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              await recordSent();
              toast.success("Marked as sent");
            } catch {
              toast.error("Could not mark email as sent");
            }
          }}
          disabled={isSent || recordActivity.isPending}
          className="w-full gap-1.5 text-muted-foreground hover:text-foreground sm:w-auto"
        >
          <CheckCircle className={`size-3.5 ${isSent ? "text-green-500" : ""}`} />
          {isSent ? "Sent" : "Mark Sent"}
        </Button>
      </div>
    </div>
  );
}
