import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Instagram, Copy, Check, CheckCircle, Ban, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useAddSuppression,
  useLeadSafetyCheck,
  useOutreachPacing,
  useRecordLeadActivity,
} from "@/hooks/use-mast-api";
import { ApiError, type Lead } from "@/lib/api";
import { getDraftProvenance } from "@/lib/outreach/draftProvenance";

import { normalizeInstagram } from "@/lib/instagram";
import { openExternalPopup } from "@/lib/externalPopup";

interface InstagramFormProps {
  lead: Lead;
  body: string;
  setBody: (v: string) => void;
}

export function InstagramForm({ lead, body, setBody }: InstagramFormProps) {
  const [isSent, setIsSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const recordActivity = useRecordLeadActivity();
  const safetyQuery = useLeadSafetyCheck(lead.id);
  const pacingQuery = useOutreachPacing();
  const addSuppression = useAddSuppression();

  const isBlocked = Boolean(safetyQuery?.data?.blocked);
  const blockMatch = safetyQuery?.data?.match;
  const igPacing = pacingQuery?.data?.instagram;

  const handleQuickBlockIg = async () => {
    const ig = normalizeInstagram(lead.instagramHandle);
    if (!ig) return;
    try {
      await addSuppression.mutateAsync({
        kind: "instagram",
        value: ig.handle,
        reason: `Blocked from ${lead.businessName} workspace`,
      });
      toast.success(`@${ig.handle} added to Do-Not-Contact list`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not block handle");
    }
  };

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
    const ig = normalizeInstagram(lead.instagramHandle);
    if (!ig) {
      toast.error("No valid Instagram handle for this lead");
      return;
    }

    // Auto-copy message synchronously, then open Instagram popup immediately
    const copyPromise = body.trim() ? copyToClipboard(body) : Promise.resolve(false);
    openExternalPopup(ig.dmUrl);
    const didCopy = await copyPromise;

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "instagram_opened",
          channel: "instagram",
          body,
          content: `Instagram opened for @${ig.handle}${didCopy ? " (message copied to clipboard)" : ""}`,
        },
      });
    } catch {
      // Non-critical
    }

    if (body.trim()) {
      if (didCopy) {
        toast.success("Instagram opened · Message copied");
      } else {
        toast.error("Instagram opened · Copy manually");
      }
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
          metadata: getDraftProvenance(lead.id, "instagram"),
        },
        patch: {
          status: "instagram_sent",
          lastContactedAt: sentAt,
        },
      });
      setIsSent(true);
      toast.success("Marked as sent");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not mark Instagram DM as sent");
    }
  };

  return (
    <div className="space-y-5">
      {isBlocked && (
        <div
          data-testid="dnc-blocked-banner"
          className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-200 flex items-start gap-2.5"
        >
          <Ban className="size-4 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-semibold text-red-100">Do-Not-Contact: Outreach Blocked</p>
            <p className="text-red-200/85">
              Matched {blockMatch?.kind ?? "handle"} ({blockMatch?.value ?? lead.instagramHandle}).
              {blockMatch?.reason ? ` Reason: ${blockMatch.reason}.` : ""} Manage your blocklist in Settings.
            </p>
          </div>
        </div>
      )}

      {!isBlocked && igPacing && igPacing.level !== "ok" && igPacing.message && (
        <div
          data-testid="ig-pacing-warning"
          className={`rounded-xl border px-4 py-2.5 text-xs flex items-start gap-2.5 ${
            igPacing.level === "danger"
              ? "border-red-500/35 bg-red-500/10 text-red-200"
              : "border-amber-500/35 bg-amber-500/10 text-amber-200"
          }`}
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{igPacing.message}</span>
        </div>
      )}

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
          {copied ? <><Check className="size-4" /> Copied</> : <><Copy className="size-4" /> Copy DM</>}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleOpen}
          disabled={isBlocked || !lead.instagramHandle || recordActivity.isPending}
          className="w-full gap-1.5 sm:w-auto"
        >
          <Instagram className="size-4" />
          Open Instagram{body.trim() ? " + Copy Message" : ""}
        </Button>

        {lead.instagramHandle && !isBlocked && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleQuickBlockIg}
            disabled={addSuppression.isPending}
            className="w-full gap-1.5 text-muted-foreground hover:text-red-400 sm:w-auto"
            title="Add this Instagram handle to your Do-Not-Contact list"
          >
            <Ban className="size-3.5" />
            Do Not Contact
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleMarkSent}
          disabled={isSent || recordActivity.isPending}
          className="w-full gap-1.5 text-muted-foreground hover:text-foreground sm:ml-auto sm:w-auto"
        >
          <CheckCircle className={`size-4 ${isSent ? "text-green-500" : ""}`} />
          {isSent ? "Sent" : "Mark Sent"}
        </Button>
      </div>
    </div>
  );
}
