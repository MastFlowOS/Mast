import { useState, useRef } from "react";
import {
  Mail,
  Instagram,
  Phone,
  Link as LinkIcon,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Quote,
  Sparkles,
  Copy,
  ExternalLink,
  Send,
  ChevronDown,
  Loader2,
  Check,
  CheckCircle,
  Wand2,
  Plus,
  Minus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";
import { useRecordLeadActivity, useSendLeadEmail } from "@/hooks/use-mast-api";
import { ApiError, isMissingBackendEndpoint } from "@/lib/api";
import { getDraftProvenance } from "@/lib/outreach/draftProvenance";
import { normalizeInstagram } from "@/lib/instagram";
import { TEMPLATES } from "@/lib/lead-workspace";

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
  onRewrite,
}: CenterWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const sendEmail = useSendLeadEmail();
  const recordActivity = useRecordLeadActivity();

  // Word count
  const wordCount = body.trim() ? body.trim().split(/\s+/).filter(Boolean).length : 0;

  // Insert or wrap text formatting
  const applyFormat = (formatType: "bold" | "italic" | "underline" | "bullet" | "number" | "quote" | "link") => {
    const el = textareaRef.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selectedText = body.substring(start, end);

    let replacement = "";
    let newCursorPos = end;

    switch (formatType) {
      case "bold":
        replacement = selectedText ? `**${selectedText}**` : "**bold text**";
        newCursorPos = selectedText ? end + 4 : start + 13;
        break;
      case "italic":
        replacement = selectedText ? `*${selectedText}*` : "*italic text*";
        newCursorPos = selectedText ? end + 2 : start + 13;
        break;
      case "underline":
        replacement = selectedText ? `<u>${selectedText}</u>` : "<u>underlined text</u>";
        newCursorPos = selectedText ? end + 7 : start + 21;
        break;
      case "bullet":
        replacement = selectedText ? `\n• ${selectedText}` : "\n• ";
        newCursorPos = start + replacement.length;
        break;
      case "number":
        replacement = selectedText ? `\n1. ${selectedText}` : "\n1. ";
        newCursorPos = start + replacement.length;
        break;
      case "quote":
        replacement = selectedText ? `\n> ${selectedText}` : "\n> ";
        newCursorPos = start + replacement.length;
        break;
      case "link":
        replacement = selectedText ? `[${selectedText}](https://)` : "[link text](https://)";
        newCursorPos = start + replacement.length;
        break;
    }

    const newBody = body.substring(0, start) + replacement + body.substring(end);
    setBody(newBody);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleCopy = async () => {
    if (!body.trim()) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      toast.success("Message copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy message");
    }
  };

  const handleOpenGmail = async () => {
    if (!lead.email) {
      toast.error("No email address recorded for this lead");
      return;
    }
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
      lead.email,
    )}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(gmailUrl, "_blank", "noopener,noreferrer");

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
    toast.success("Opening in Gmail…");
  };

  const handleOpenMailClient = async () => {
    if (!lead.email) {
      toast.error("No email address recorded for this lead");
      return;
    }
    const mailto = `mailto:${lead.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

  const handleOpenChannel = async () => {
    if (channel === "email") {
      await handleOpenGmail();
    } else if (channel === "instagram") {
      const ig = normalizeInstagram(lead.instagramHandle);
      if (!ig) {
        toast.error("No Instagram handle recorded for this lead");
        return;
      }
      if (body.trim()) await handleCopy();
      window.open(ig.dmUrl, "_blank", "noopener,noreferrer");
      try {
        await recordActivity.mutateAsync({
          lead,
          activity: {
            type: "instagram_opened",
            channel: "instagram",
            body,
            content: `Instagram opened for @${ig.handle}`,
          },
        });
      } catch {
        // Non-critical
      }
      toast.success("Instagram opened");
    } else if (channel === "phone") {
      if (!lead.phone) {
        toast.error("No phone number recorded for this lead");
        return;
      }
      window.location.href = `tel:${lead.phone}`;
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
      if (body.trim()) await handleCopy();
      window.open(websiteUrl, "_blank", "noopener,noreferrer");
      toast.success("Opening website…");
    }
  };

  const handleSendConnected = async () => {
    if (!lead.email) {
      toast.error("No email address recorded for this lead");
      return;
    }
    if (!subject.trim() || !body.trim()) {
      toast.error("Please provide both subject and body");
      return;
    }

    const sentAt = new Date().toISOString();
    try {
      await sendEmail.mutateAsync({ leadId: lead.id, body: { subject, body } });
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "email_sent",
          channel: "email",
          subject,
          body,
          timestamp: sentAt,
          content: "Email sent via connected account",
          metadata: getDraftProvenance(lead.id, "email"),
        },
        patch: { status: "email_sent", lastContactedAt: sentAt },
      });
      toast.success("Email sent successfully");
    } catch (error) {
      if (isMissingBackendEndpoint(error)) {
        await handleOpenGmail();
        toast.info("Connected email unavailable; opened Gmail instead.");
        return;
      }
      toast.error(error instanceof Error ? error.message : "Failed to send email");
    }
  };

  const handleMarkSent = async () => {
    const sentAt = new Date().toISOString();
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: channel === "email" ? "email_sent" : channel === "instagram" ? "instagram_sent" : channel === "phone" ? "call_completed" : "contact_form_sent",
          channel,
          subject: channel === "email" ? subject : undefined,
          body,
          timestamp: sentAt,
          content: `${channel.replace(/_/g, " ")} marked as sent`,
          metadata: getDraftProvenance(lead.id, channel),
        },
        patch: {
          status: channel === "email" ? "email_sent" : channel === "instagram" ? "instagram_sent" : channel === "phone" ? "called" : "email_sent",
          lastContactedAt: sentAt,
        },
      });
      toast.success("Marked as sent");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not mark as sent");
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
            {channel === "instagram" ? `${body.length}/1000 characters` : `${wordCount} words`}
          </span>
        </div>
      )}

      {/* ─── 4. RICH-TEXT MESSAGE EDITOR ─── */}
      <div className="flex-1 min-h-[320px] rounded-2xl border border-border/80 bg-card/30 flex flex-col overflow-hidden shadow-sm focus-within:border-[#4f46e5]/60 focus-within:ring-1 focus-within:ring-[#4f46e5]/30 transition-all">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card/50 px-3 py-2 select-none">
          {/* Formatting buttons */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => applyFormat("bold")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors text-xs font-bold"
              title="Bold"
            >
              <Bold className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => applyFormat("italic")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors text-xs italic"
              title="Italic"
            >
              <Italic className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => applyFormat("underline")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors text-xs underline"
              title="Underline"
            >
              <Underline className="size-3.5" />
            </button>
            <div className="h-4 w-px bg-border/60 mx-1" />
            <button
              type="button"
              onClick={() => applyFormat("bullet")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors"
              title="Bullet list"
            >
              <List className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => applyFormat("number")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors"
              title="Numbered list"
            >
              <ListOrdered className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => applyFormat("quote")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors"
              title="Quote"
            >
              <Quote className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => applyFormat("link")}
              className="size-7 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground grid place-items-center transition-colors"
              title="Link"
            >
              <LinkIcon className="size-3.5" />
            </button>
          </div>

          {/* Inline Transformation Actions */}
          <div className="flex items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => void onRewrite("rewrite")}
              disabled={isGenerating || !body.trim()}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Wand2 className="size-3" />
              <span>Rewrite</span>
            </button>
            <button
              type="button"
              onClick={() => void onRewrite("expand")}
              disabled={isGenerating || !body.trim()}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Plus className="size-3" />
              <span>Expand</span>
            </button>
            <button
              type="button"
              onClick={() => void onRewrite("shorten")}
              disabled={isGenerating || !body.trim()}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Minus className="size-3" />
              <span>Shorten</span>
            </button>
          </div>
        </div>

        {/* Textarea body */}
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi there, write your message or generate one with the AI Assistant..."
          className="flex-1 w-full bg-transparent p-4 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/40 resize-none outline-none font-sans"
        />

        {/* Editor bottom status bar */}
        <div className="flex items-center justify-end px-4 py-2 border-t border-border/40 text-[11px] text-muted-foreground">
          <span>{wordCount} words</span>
        </div>
      </div>

      {/* ─── 5. BOTTOM ACTION BAR ─── */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        {/* Left actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void onGenerate()}
            disabled={isGenerating}
            className="h-10 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-medium px-4 rounded-xl shadow-md shadow-indigo-500/25"
          >
            {isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            <span>Generate with AI</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={handleCopy}
            disabled={!body.trim()}
            className="h-10 gap-2 border-border/70 bg-card/40 text-xs font-medium hover:bg-card text-foreground rounded-xl"
          >
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4 text-muted-foreground" />}
            <span>{copied ? "Copied" : "Copy Message"}</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={handleOpenChannel}
            className="h-10 gap-2 border-border/70 bg-card/40 text-xs font-medium hover:bg-card text-foreground rounded-xl"
          >
            <span>
              {channel === "email"
                ? "Open in Gmail"
                : channel === "instagram"
                  ? "Open Instagram"
                  : channel === "phone"
                    ? "Call Phone"
                    : "Open Website"}
            </span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </Button>
        </div>

        {/* Right action: Send button / split dropdown */}
        <div className="relative">
          <div className="flex items-center rounded-xl overflow-hidden shadow-md shadow-indigo-500/20">
            <Button
              type="button"
              onClick={channel === "email" ? handleSendConnected : handleMarkSent}
              disabled={sendEmail.isPending || recordActivity.isPending || !body.trim()}
              className="h-10 gap-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-medium px-4 rounded-r-none border-r border-indigo-400/30"
            >
              {sendEmail.isPending || recordActivity.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              <span>{channel === "email" ? "Send Email" : "Mark as sent"}</span>
            </Button>
            <button
              type="button"
              onClick={() => setSendMenuOpen(!sendMenuOpen)}
              className="h-10 px-2.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white grid place-items-center transition-colors"
              title="More send options"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>

          {sendMenuOpen && (
            <div className="absolute right-0 bottom-full mb-1 w-56 rounded-xl border border-border bg-[#101726] shadow-2xl p-1 z-30 animate-scale-in-fast">
              {channel === "email" && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setSendMenuOpen(false);
                      void handleSendConnected();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Send className="size-3.5 text-indigo-400" />
                    <span>Send via Connected Email</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSendMenuOpen(false);
                      void handleOpenGmail();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <ExternalLink className="size-3.5 text-blue-400" />
                    <span>Open in Gmail Web</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSendMenuOpen(false);
                      void handleOpenMailClient();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Mail className="size-3.5 text-sky-400" />
                    <span>Open in Default Mail Client</span>
                  </button>
                  <div className="my-1 h-px bg-border/60" />
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setSendMenuOpen(false);
                  void handleMarkSent();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted/60 transition-colors"
              >
                <CheckCircle className="size-3.5 text-emerald-400" />
                <span>Mark as Sent (Manual)</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
