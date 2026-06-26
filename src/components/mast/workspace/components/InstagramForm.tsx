import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Instagram, Copy, Check, CheckCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRecordLeadActivity } from "@/hooks/use-mast-api";
import type { Lead } from "@/lib/api";

interface InstagramFormProps {
  lead: Lead;
  body: string;
  setBody: (v: string) => void;
}

export function InstagramForm({ lead, body, setBody }: InstagramFormProps) {
  const [isSent, setIsSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const recordActivity = useRecordLeadActivity();

  useEffect(() => {
    setCopied(false);
  }, [body, lead.id]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      return true;
    } catch {
      return false;
    }
  };

  const handleCopy = async () => {
    if (!body.trim()) return;
    const ok = await copyToClipboard(body);
    if (ok) {
      toast.success("Copied to clipboard");
    } else {
      toast.error("Could not copy DM");
    }
  };

  const handleOpen = async () => {
    if (!lead.instagramHandle) {
      toast.error("No Instagram handle for this lead");
      return;
    }

    const handle = lead.instagramHandle.replace(/^@/, "");

    // Auto-copy message before opening Instagram
    let didCopy = false;
    if (body.trim()) {
      didCopy = await copyToClipboard(body);
    }

    // Try to open a DM link; Instagram's direct message link works in the app
    // but not on web. We open profile + copied message is the best we can do on web.
    const profileUrl = `https://www.instagram.com/${handle}/`;
    window.open(profileUrl, "_blank", "noopener,noreferrer");

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "instagram_opened",
          channel: "instagram",
          body,
          content: `Instagram profile opened for @${handle}${didCopy ? " (message copied to clipboard)" : ""}`,
        },
      });
    } catch {
      // Non-critical
    }

    if (didCopy) {
      toast.success("Message copied — paste it in the DM after Instagram opens");
    } else {
      toast.success("Instagram opened");
    }
  };

  const handleMarkSent = async () => {
    const sentAt = new Date().toISOString();
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "instagram_sent",
          channel: "instagram",
          body,
          timestamp: sentAt,
          content: "Instagram DM marked sent",
        },
        patch: {
          status: "outreach",
          lastContactedAt: sentAt,
        },
      });
      setIsSent(true);
      toast.success("Marked as sent");
    } catch {
      toast.error("Could not mark Instagram DM as sent");
    }
  };

  return (
    <div className="space-y-5">
      {!lead.instagramHandle && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          No Instagram handle recorded for this lead.
        </div>
      )}

      <div className="space-y-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          Direct Message
        </label>
        <Textarea
          placeholder="Write your DM, or use the AI Assistant → to generate one…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-[260px] resize-y text-sm leading-relaxed"
        />
        <p className="text-[11px] text-muted-foreground">
          {body.length} / 1000 characters
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={!body}
          className="w-full gap-1.5 sm:w-auto"
        >
          {copied ? <><Check className="size-3.5" /> Copied</> : <><Copy className="size-3.5" /> Copy DM</>}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleOpen}
          disabled={!lead.instagramHandle || recordActivity.isPending}
          className="w-full gap-1.5 sm:w-auto"
        >
          <Instagram className="size-3.5" />
          Open Instagram{body.trim() ? " + Copy" : ""}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleMarkSent}
          disabled={isSent || recordActivity.isPending}
          className="w-full gap-1.5 text-muted-foreground hover:text-foreground sm:ml-auto sm:w-auto"
        >
          <CheckCircle className={`size-3.5 ${isSent ? "text-green-500" : ""}`} />
          {isSent ? "Sent" : "Mark Sent"}
        </Button>
      </div>
    </div>
  );
}
