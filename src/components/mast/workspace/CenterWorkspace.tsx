import { useState, useEffect } from "react";
import {
  Mail,
  Instagram,
  Phone,
  Link as LinkIcon,
  Sparkles,
  Copy,
  ExternalLink,
  Send,
  ChevronDown,
  Loader2,
  Check,
  CheckCircle,
  MessageSquareReply,
  Ban,
  AlertTriangle,
  AlertCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import {
  useAddSuppression,
  useLeadActivities,
  useLeadSafetyCheck,
  useOutreachPacing,
  useRecordLeadActivity,
  useSendLeadEmail,
} from "@/hooks/use-mast-api";
import { ApiError, isMissingBackendEndpoint } from "@/lib/api";
import { getDraftProvenance } from "@/lib/outreach/draftProvenance";
import { normalizeInstagram } from "@/lib/instagram";
import { openExternalPopup, openGmailComposePopup } from "@/lib/externalPopup";
import { TEMPLATES } from "@/lib/lead-workspace";
import { htmlToPlainText, countWords } from "@/lib/richText";
import { RichTextEditor } from "./components/RichTextEditor";

interface CenterWorkspaceProps {
  lead: Lead;
  channel: Channel;
  setChannel: (c: Channel) => void;
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  template: string;
  setTemplate: (v: string) => void;
  tone: string;
  setTone: (v: string) => void;
  onGenerate: () => Promise<void>;
  isGenerating: boolean;
  generateStatus?: { tone: "success" | "error"; text: string; id: number } | null;
  onRewrite: (type?: "rewrite" | "expand" | "shorten") => Promise<void>;
}

const CHANNELS = [
  { id: "email" as const, label: "Email", icon: Mail },
  { id: "instagram" as const, label: "Instagram DM", icon: Instagram },
  { id: "phone" as const, label: "Phone", icon: Phone },
  { id: "contact_form" as const, label: "Contact Form", icon: LinkIcon },
];

const TONES = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "direct", label: "Direct" },
  { value: "casual", label: "Casual" },
  { value: "urgent", label: "Urgent" },
];

export function CenterWorkspace({
  lead,
  channel,
  setChannel,
  subject,
  setSubject,
  body,
  setBody,
  template,
  setTemplate,
  tone,
  setTone,
  onGenerate,
  isGenerating,
  generateStatus,
  onRewrite,
}: CenterWorkspaceProps) {
  const [copied, setCopied] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [inlineStatus, setInlineStatus] = useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);
  const sendEmail = useSendLeadEmail();
  const recordActivity = useRecordLeadActivity();
  const safetyQuery = useLeadSafetyCheck(lead.id);
  const pacingQuery = useOutreachPacing();
  const addSuppression = useAddSuppression();
  const { data: activities = [] } = useLeadActivities(lead);

  const isBlocked = Boolean(safetyQuery?.data?.blocked);
  const blockMatch = safetyQuery?.data?.match;
  const activePacing =
    channel === "email"
      ? pacingQuery?.data?.email
      : channel === "instagram"
        ? pacingQuery?.data?.instagram
        : null;

  const handleQuickBlockLead = async () => {
    const ig = normalizeInstagram(lead.instagramHandle);
    const kind = channel === "instagram" && ig ? "instagram" : lead.email ? "email" : ig ? "instagram" : null;
    const value = kind === "email" ? lead.email : kind === "instagram" ? ig?.handle : null;
    if (!kind || !value) {
      toast.error("No email or Instagram handle to block for this lead");
      return;
    }
    try {
      await addSuppression.mutateAsync({
        kind,
        value,
        reason: `Blocked from ${lead.businessName} workspace`,
      });
      toast.success(`${kind === "instagram" ? `@${value}` : value} added to Do-Not-Contact list`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add to Do-Not-Contact list");
    }
  };
  const latestReply = activities.find((a) => a.type === "reply_received");
  const latestReplyMeta = (latestReply?.metadata as Record<string, unknown> | null) || null;
  const replyIntent = typeof latestReplyMeta?.intent === "string" ? latestReplyMeta.intent : null;
  const suggestedReply = typeof latestReplyMeta?.suggestedReply === "string" ? latestReplyMeta.suggestedReply : null;

  // Close the bottom action menu and clear status when switching leads or channels
  useEffect(() => {
    setSendMenuOpen(false);
    setInlineStatus(null);
  }, [lead.id, channel]);

  // Sync generation status from parent into inline feedback
  useEffect(() => {
    if (!generateStatus) return;
    setInlineStatus({ tone: generateStatus.tone, text: generateStatus.text });
  }, [generateStatus]);

  // Auto-fade success messages after 4.5s; keep errors visible until next action or dismiss
  useEffect(() => {
    if (!inlineStatus || inlineStatus.tone !== "success") return;
    const timer = window.setTimeout(() => setInlineStatus(null), 4500);
    return () => window.clearTimeout(timer);
  }, [inlineStatus]);

  // Word and character count calculated from clean text
  const plainText = htmlToPlainText(body);
  const wordCount = countWords(body);

  const handleCopy = async () => {
    const textToCopy = plainText.trim();
    if (!textToCopy) return;

    let success = false;
    if (navigator.clipboard?.write) {
      try {
        const textBlob = new Blob([textToCopy], { type: "text/plain" });
        const htmlBlob = new Blob([body], { type: "text/html" });
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": textBlob,
            "text/html": htmlBlob,
          }),
        ]);
        success = true;
      } catch {
        // Fallback to writeText below
      }
    }

    if (!success) {
      try {
        await navigator.clipboard.writeText(textToCopy);
        success = true;
      } catch {
        try {
          const tempEl = document.createElement("textarea");
          tempEl.value = textToCopy;
          tempEl.style.position = "fixed";
          tempEl.style.opacity = "0";
          document.body.appendChild(tempEl);
          tempEl.focus();
          tempEl.select();
          success = document.execCommand("copy");
          document.body.removeChild(tempEl);
        } catch {
          success = false;
        }
      }
    }

    if (success) {
      setCopied(true);
      toast.success("Message copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Could not copy message");
    }
  };

  const handleOpenGmail = async () => {
    if (!lead.email) {
      toast.error("No email address recorded for this lead");
      return;
    }
    const cleanBody = htmlToPlainText(body);
    const popupResult = openGmailComposePopup({
      to: lead.email,
      subject,
      body: cleanBody,
    });

    if (!popupResult.opened && popupResult.url) {
      setInlineStatus({ tone: "warning", text: "Popup blocked — allow popups or try again." });
      toast.info("Popup blocked. Click below to open Gmail.", {
        action: {
          label: "Open Gmail",
          onClick: () => openExternalPopup(popupResult.url!),
        },
      });
    } else {
      setInlineStatus({ tone: "success", text: "Gmail opened" });
      toast.success("Opening Gmail popup…");
    }

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "email_opened",
          channel: "email",
          subject,
          body,
          content: `Gmail composer opened for ${lead.email}`,
        },
      });
    } catch {
      // Non-critical
    }
  };

  const handleOpenMailClient = async () => {
    if (!lead.email) {
      toast.error("No email address recorded for this lead");
      return;
    }
    const cleanBody = htmlToPlainText(body);
    const mailto = `mailto:${lead.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(cleanBody)}`;
    window.location.href = mailto;

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
    toast.success("Opening mail client…");
  };

  const handleOpenInstagram = async () => {
    const ig = normalizeInstagram(lead.instagramHandle);
    if (!ig) {
      toast.error("No Instagram handle recorded for this lead");
      return;
    }

    // 1. Read current message including user's latest edits
    const messageText = htmlToPlainText(body).trim();

    // 2. Start clipboard copy synchronously, then open popup immediately before awaiting
    const copyPromise: Promise<boolean> = messageText
      ? navigator.clipboard
          .writeText(messageText)
          .then(() => true)
          .catch(() => {
            try {
              const tempEl = document.createElement("textarea");
              tempEl.value = messageText;
              tempEl.style.position = "fixed";
              tempEl.style.opacity = "0";
              document.body.appendChild(tempEl);
              tempEl.focus();
              tempEl.select();
              const ok = document.execCommand("copy");
              document.body.removeChild(tempEl);
              return ok;
            } catch {
              return false;
            }
          })
      : Promise.resolve(false);

    // 3. Open Instagram destination in a Chrome popup window
    const popupResult = openExternalPopup(ig.dmUrl);
    const copiedSuccessfully = await copyPromise;

    // 4. Clear feedback and graceful fallbacks
    if (copiedSuccessfully) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (!popupResult.opened) {
        setInlineStatus({ tone: "warning", text: "Message copied — popup blocked, click Open Instagram again." });
        toast.info("Message copied! Your browser blocked opening Instagram automatically.", {
          action: {
            label: "Open Instagram",
            onClick: () => openExternalPopup(ig.dmUrl),
          },
        });
      } else {
        setInlineStatus({ tone: "success", text: "Copied & opened Instagram DM" });
        toast.success("Message copied to clipboard · Opening Instagram DM…");
      }
    } else if (messageText) {
      setInlineStatus({ tone: "warning", text: "Opened Instagram — use Copy Message to copy manually." });
      toast.warning("Opening Instagram DM. Could not access clipboard; use 'Copy Message' to copy manually.", {
        action: {
          label: "Copy Message",
          onClick: handleCopy,
        },
      });
    } else {
      setInlineStatus({ tone: "success", text: "Opened Instagram DM" });
      toast.info("Opening Instagram DM…");
    }

    // 5. Record activity
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "instagram_opened",
          channel: "instagram",
          body: messageText,
          content: `Instagram opened for @${ig.handle}${copiedSuccessfully ? " (message copied to clipboard)" : ""}`,
        },
      });
    } catch {
      // Non-critical
    }
  };

  const handleOpenChannel = async () => {
    if (channel === "email") {
      await handleOpenGmail();
    } else if (channel === "instagram") {
      await handleOpenInstagram();
    } else if (channel === "contact_form") {
      const websiteUrl = lead.website
        ? lead.website.startsWith("http")
          ? lead.website
          : `https://${lead.website}`
        : "";
      if (!websiteUrl) {
        toast.error("No website recorded for this lead");
        return;
      }
      const cleanBody = htmlToPlainText(body).trim();
      const copyPromise = cleanBody
        ? navigator.clipboard.writeText(cleanBody).then(() => true).catch(() => false)
        : Promise.resolve(false);
      openExternalPopup(websiteUrl);
      const didCopy = await copyPromise;
      if (didCopy) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
      try {
        await recordActivity.mutateAsync({
          lead,
          activity: {
            type: "contact_form_opened",
            channel: "contact_form",
            body,
            content: `Website opened for ${lead.businessName}${didCopy ? " (message copied to clipboard)" : ""}`,
          },
        });
      } catch {
        // Non-critical: opening website must not fail merely because activity persistence failed
      }
      setInlineStatus({ tone: "success", text: didCopy ? "Draft copied · Website opened" : "Website opened" });
      toast.success(didCopy ? "Draft copied · Opening website…" : "Opening website…");
    }
  };

  const handleSendConnected = async () => {
    if (!lead.email) {
      setInlineStatus({ tone: "error", text: "No email address on file for this lead." });
      toast.error("No email address recorded for this lead");
      return;
    }
    if (!subject.trim() || !plainText.trim()) {
      setInlineStatus({ tone: "error", text: "Add both a subject line and message body first." });
      toast.error("Please provide both subject and body");
      return;
    }

    setInlineStatus(null);
    try {
      const res = await sendEmail.mutateAsync({ leadId: lead.id, body: { subject, body } });
      if (res?.warning) {
        setInlineStatus({ tone: "warning", text: res.warning });
        toast.warning(res.warning);
      } else {
        setInlineStatus({ tone: "success", text: `Email sent to ${lead.email}` });
        toast.success("Email sent successfully");
      }
    } catch (error) {
      if (isMissingBackendEndpoint(error)) {
        await handleOpenGmail();
        setInlineStatus({ tone: "warning", text: "Connected email unavailable — opened Gmail instead." });
        toast.info("Connected email unavailable; opened Gmail instead.");
        return;
      }
      const errMsg = error instanceof Error ? error.message : "Failed to send email";
      setInlineStatus({ tone: "error", text: errMsg });
      toast.error(errMsg);
    }
  };

  const handleMarkSent = async () => {
    const sentAt = new Date().toISOString();
    setInlineStatus(null);
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type:
            channel === "email"
              ? "email_sent"
              : channel === "instagram"
                ? "instagram_sent"
                : channel === "phone"
                  ? "call_completed"
                  : "contact_form_sent",
          channel,
          subject: channel === "email" ? subject : undefined,
          body,
          timestamp: sentAt,
          content: `${channel.replace(/_/g, " ")} marked as sent`,
          metadata: getDraftProvenance(lead.id, channel),
        },
        patch: {
          status:
            channel === "email"
              ? "email_sent"
              : channel === "instagram"
                ? "instagram_sent"
                : channel === "phone"
                  ? "called"
                  : "email_sent",
          lastContactedAt: sentAt,
        },
      });
      setInlineStatus({
        tone: "success",
        text: channel === "phone" ? "Marked as called" : "Marked as sent",
      });
      toast.success("Marked as sent");
    } catch (error) {
      const errMsg = error instanceof ApiError ? error.message : "Could not mark as sent";
      setInlineStatus({ tone: "error", text: errMsg });
      toast.error(errMsg);
    }
  };

  return (
    <main className="flex-1 min-w-0 flex flex-col bg-[#0b0f17] p-5 lg:p-7 overflow-y-auto space-y-4">
      {/* ─── 1. CHANNEL SELECTOR PILLS ─── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CHANNELS.map((ch) => {
          const isActive = channel === ch.id;
          const Icon = ch.icon;
          return (
            <button
              key={ch.id}
              type="button"
              onClick={() => setChannel(ch.id)}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                isActive
                  ? "bg-[#4f46e5] text-white shadow-md shadow-indigo-500/25 border border-indigo-400/40"
                  : "bg-card/40 border border-border/70 text-muted-foreground hover:bg-card/70 hover:text-foreground"
              }`}
            >
              <Icon className="size-4 shrink-0" />
              <span>{ch.label}</span>
            </button>
          );
        })}
      </div>

      {/* ─── 2. TEMPLATE & TONE SELECTORS ─── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Template</label>
          <Select value={template} onValueChange={setTemplate}>
            <SelectTrigger className="h-10 rounded-xl bg-card/40 border-border/70 text-xs text-foreground focus:ring-1 focus:ring-brand">
              <SelectValue placeholder="Select template" />
            </SelectTrigger>
            <SelectContent className="bg-[#101726] border-border text-xs">
              {TEMPLATES.map((t) => (
                <SelectItem key={t.value} value={t.value} className="text-xs">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">Tone</label>
          <Select value={tone} onValueChange={setTone}>
            <SelectTrigger className="h-10 rounded-xl bg-card/40 border-border/70 text-xs text-foreground focus:ring-1 focus:ring-brand">
              <SelectValue placeholder="Select tone" />
            </SelectTrigger>
            <SelectContent className="bg-[#101726] border-border text-xs">
              {TONES.map((t) => (
                <SelectItem key={t.value} value={t.value} className="text-xs">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ─── DO-NOT-CONTACT & PACING SAFETY BANNERS ─── */}
      {isBlocked && (
        <div
          data-testid="dnc-blocked-banner"
          className="rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-200 flex items-start gap-2.5"
        >
          <Ban className="size-4 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-semibold text-red-100">Do-Not-Contact: Outreach Blocked</p>
            <p className="text-red-200/85">
              Matched {blockMatch?.kind ?? "contact"} ({blockMatch?.value ?? lead.email ?? lead.instagramHandle}).
              {blockMatch?.reason ? ` Reason: ${blockMatch.reason}.` : ""} Manage your blocklist in Settings.
            </p>
          </div>
        </div>
      )}

      {!isBlocked && activePacing && activePacing.level !== "ok" && activePacing.message && (
        <div
          data-testid="outreach-pacing-warning"
          className={`rounded-xl border px-3.5 py-2.5 text-xs flex items-start gap-2.5 ${
            activePacing.level === "danger"
              ? "border-red-500/35 bg-red-500/10 text-red-200"
              : "border-amber-500/35 bg-amber-500/10 text-amber-200"
          }`}
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{activePacing.message}</span>
        </div>
      )}

      {/* ─── CLIENT REPLY BANNER (when a reply has been observed) ─── */}
      {latestReply && (
        <div
          data-testid="client-reply-banner"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] px-3.5 py-2.5 space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <MessageSquareReply className="size-4 text-emerald-400 shrink-0" />
              <span className="text-xs font-semibold text-emerald-300">
                Client replied via {latestReply.channel === "instagram" ? "Instagram" : "Email"}
              </span>
              {replyIntent && replyIntent !== "other" && (
                <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                  {replyIntent.replace(/_/g, " ")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {suggestedReply && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBody(suggestedReply);
                    toast.success("Inserted suggested reply");
                  }}
                  className="h-7 text-[11px] border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200"
                >
                  Use Suggested Reply
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setTemplate("follow_up");
                  void onGenerate();
                }}
                disabled={isGenerating}
                className="h-7 text-[11px] border-border/70 bg-card/60"
              >
                <Sparkles className="size-3 mr-1" />
                Draft AI Reply
              </Button>
            </div>
          </div>
          <p className="text-xs text-foreground/90 leading-relaxed line-clamp-3">
            {latestReply.body || latestReply.content}
          </p>
        </div>
      )}

      {/* ─── 3. SUBJECT LINE (EMAIL) ─── */}
      {channel === "email" ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-foreground">Subject</label>
            <span className="text-[11px] font-mono text-muted-foreground">{subject.length}/100</span>
          </div>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="e.g. Great coffee and a quick idea"
            className="h-10 rounded-xl bg-card/40 border-border/70 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-brand"
            maxLength={100}
          />
        </div>
      ) : (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-0.5">
          <span className="font-medium text-foreground">
            {channel === "instagram" ? "Direct Message" : channel === "phone" ? "Call Script" : "Contact Form Note"}
          </span>
          <span className="font-mono text-[11px]">
            {channel === "instagram" ? `${plainText.length}/1000 characters` : `${wordCount} words`}
          </span>
        </div>
      )}

      {/* ─── 4. RICH-TEXT MESSAGE EDITOR (APPLE NOTES EXPERIENCE) ─── */}
      <RichTextEditor
        value={body}
        onChange={setBody}
        onRewrite={onRewrite}
        isGenerating={isGenerating}
        placeholder="Hi there, write your message or generate one with the AI Assistant..."
      />

      {/* ─── 5. BOTTOM ACTION BAR ─── */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        {/* Left actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void onGenerate()}
            disabled={isGenerating}
            className="h-10 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-medium px-4 rounded-xl shadow-md shadow-indigo-500/25 cursor-pointer"
          >
            {isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            <span>Generate with AI</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={handleCopy}
            disabled={!plainText.trim()}
            className="h-10 gap-2 border-border/70 bg-card/40 text-xs font-medium hover:bg-card text-foreground rounded-xl cursor-pointer"
          >
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4 text-muted-foreground" />}
            <span>{copied ? "Copied" : "Copy Message"}</span>
          </Button>

          {/* Call Phone button is removed from middle composer; remaining actions stay correctly aligned */}
          {channel !== "phone" && (
            <Button
              type="button"
              variant="outline"
              onClick={handleOpenChannel}
              disabled={isBlocked}
              className="h-10 gap-2 border-border/70 bg-card/40 text-xs font-medium hover:bg-card text-foreground rounded-xl cursor-pointer"
            >
              <span>
                {channel === "email"
                  ? "Open in Gmail"
                  : channel === "instagram"
                    ? "Open Instagram"
                    : "Copy & Open Website"}
              </span>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </Button>
          )}
        </div>

        {/* Right action: Send button / split dropdown with dismissible popover */}
        <div className="relative">
          <div className="flex items-center rounded-xl overflow-hidden shadow-md shadow-indigo-500/20">
            <Button
              type="button"
              onClick={channel === "email" ? handleSendConnected : handleMarkSent}
              disabled={isBlocked || sendEmail.isPending || recordActivity.isPending || !plainText.trim()}
              className="h-10 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-medium px-4 rounded-r-none border-r border-indigo-400/30 cursor-pointer"
            >
              {sendEmail.isPending || recordActivity.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              <span>
                {channel === "email"
                  ? "Send Email"
                  : channel === "phone"
                    ? "Mark as Called"
                    : "Mark as Sent"}
              </span>
            </Button>

            <DropdownMenu open={sendMenuOpen} onOpenChange={setSendMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="h-10 px-2.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white grid place-items-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-300 cursor-pointer"
                  title="More send options"
                  aria-label="More send options"
                >
                  <ChevronDown className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={8}
                className="w-56 rounded-xl border border-border bg-[#101726] shadow-2xl p-1 z-50 text-xs"
              >
                {channel === "email" && (
                  <>
                    <DropdownMenuItem
                      onClick={() => void handleSendConnected()}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                    >
                      <Send className="size-3.5 text-indigo-400" />
                      <span>Send via Connected Email</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleOpenGmail()}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                    >
                      <ExternalLink className="size-3.5 text-blue-400" />
                      <span>Open in Gmail Web</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleOpenMailClient()}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                    >
                      <Mail className="size-3.5 text-sky-400" />
                      <span>Open in Default Mail Client</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="my-1 bg-border/60" />
                  </>
                )}

                {/* Outreach sent path test assertion relies on manual send button not invoking connected send */}
                <DropdownMenuItem
                  onClick={() => void handleMarkSent()}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                >
                  <CheckCircle className="size-3.5 text-emerald-400" />
                  <span>{channel === "phone" ? "Mark as Called (Manual)" : "Mark as Sent (Manual)"}</span>
                </DropdownMenuItem>
                {!isBlocked && (lead.email || lead.instagramHandle) && (
                  <>
                    <DropdownMenuSeparator className="my-1 bg-border/60" />
                    <DropdownMenuItem
                      onClick={() => void handleQuickBlockLead()}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer"
                    >
                      <Ban className="size-3.5 text-red-400" />
                      <span>Block / Do Not Contact</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Inline action feedback (replaces noisy toasts without touching Dynamic Island) */}
      {inlineStatus && (
        <div
          data-testid="composer-inline-status"
          role={inlineStatus.tone === "error" ? "alert" : "status"}
          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${
            inlineStatus.tone === "error"
              ? "border-rose-500/35 bg-rose-500/10 text-rose-200"
              : inlineStatus.tone === "warning"
                ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {inlineStatus.tone === "error" ? (
              <AlertCircle className="size-3.5 text-rose-400 shrink-0" />
            ) : inlineStatus.tone === "warning" ? (
              <AlertTriangle className="size-3.5 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle className="size-3.5 text-emerald-400 shrink-0" />
            )}
            <span className="truncate font-medium">{inlineStatus.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setInlineStatus(null)}
            aria-label="Dismiss status"
            className="text-current/60 hover:text-current transition-colors shrink-0 cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </main>
  );
}
