import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Inbox,
  Instagram,
  Loader2,
  RefreshCw,
  Wand2,
} from "lucide-react";
import {
  useDeleteInboxSettings,
  useInboxSettings,
  useSaveInboxSettings,
  useSyncInboxNow,
  useTestInboxConnection,
} from "@/hooks/use-mast-api";
import { getBackendBaseUrl } from "@/lib/api";
import { deriveImapDefaultsFromSmtp } from "@/lib/inboxDefaults";
import { supabase } from "@/lib/supabase";

interface ReplyObservationCardProps {
  smtpHost: string;
  smtpUser: string;
}

export function ReplyObservationCard({ smtpHost, smtpUser }: ReplyObservationCardProps) {
  const inboxQuery = useInboxSettings(true);
  const saveInbox = useSaveInboxSettings();
  const testInbox = useTestInboxConnection();
  const syncNow = useSyncInboxNow();
  const deleteInbox = useDeleteInboxSettings();

  const server = inboxQuery.data;

  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [imapTls, setImapTls] = useState(true);
  const [igEmailAlerts, setIgEmailAlerts] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!server || initialized) return;
    setImapHost(server.imapHost || "");
    setImapPort(server.imapPort || "993");
    setImapUsername(server.imapUsername || "");
    setImapTls(server.imapTls);
    setIgEmailAlerts(server.igEmailAlertsEnabled);
    setInitialized(true);
  }, [server, initialized]);

  const handleAutoFillFromSmtp = () => {
    const guess = deriveImapDefaultsFromSmtp(smtpHost);
    if (!guess.imapHost && !smtpUser) {
      toast.info("Enter your SMTP settings above first, or type your IMAP host manually.");
      return;
    }
    if (guess.imapHost) setImapHost(guess.imapHost);
    setImapPort(guess.imapPort);
    setImapTls(guess.imapTls);
    if (smtpUser && !imapUsername) setImapUsername(smtpUser);
    toast.success("Filled IMAP defaults from your SMTP settings.");
  };

  const handleTest = async () => {
    if (!imapHost.trim() || !imapUsername.trim()) {
      toast.error("Enter IMAP host and username first.");
      return;
    }
    try {
      await testInbox.mutateAsync({
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort || 993),
        imapUsername: imapUsername.trim(),
        imapPassword: imapPassword || undefined,
        imapTls,
      });
      toast.success("IMAP connection verified!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "IMAP connection test failed.");
    }
  };

  const handleSave = async () => {
    const hasImapFields = Boolean(imapHost.trim() && imapUsername.trim());
    try {
      await saveInbox.mutateAsync({
        provider: hasImapFields ? "imap" : "inbound_only",
        imapHost: hasImapFields ? imapHost.trim() : undefined,
        imapPort: hasImapFields ? Number(imapPort || 993) : undefined,
        imapUsername: hasImapFields ? imapUsername.trim() : undefined,
        imapPassword: imapPassword || undefined,
        imapTls,
        igEmailAlertsEnabled: igEmailAlerts,
        enabled: true,
      });
      setImapPassword("");
      toast.success("Reply observation settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save reply observation settings.");
    }
  };

  const handleSyncNow = async () => {
    try {
      const res = await syncNow.mutateAsync();
      if (res.recorded > 0) {
        toast.success(`Synced inbox: ${res.recorded} new client ${res.recorded === 1 ? "reply" : "replies"} found.`);
      } else {
        toast.success(`Inbox synced (${res.fetched} checked, no new client replies).`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Inbox sync failed.");
    }
  };

  const handleDisconnect = async () => {
    try {
      await deleteInbox.mutateAsync();
      setImapHost("");
      setImapPort("993");
      setImapUsername("");
      setImapPassword("");
      toast.success("IMAP inbox credentials removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect IMAP.");
    }
  };

  const copyText = async (key: string, value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  const handleCopyExtensionSession = async () => {
    if (!supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      toast.error("Not signed in");
      return;
    }
    const baseUrl = getBackendBaseUrl() || "";
    const payload = JSON.stringify({ apiBaseUrl: baseUrl, token: session.access_token }, null, 2);
    await copyText("ext", payload, "Extension config");
  };

  const backendBase = getBackendBaseUrl();
  const fullWebhookUrl =
    backendBase && server?.inboundWebhookPath
      ? `${backendBase}${server.inboundWebhookPath}`
      : server?.inboundWebhookPath || "";

  return (
    <div className="bg-card/40 border border-border/80 rounded-2xl p-5 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-xl bg-emerald-500/12 border border-emerald-500/25 text-emerald-400 grid place-items-center shrink-0">
            <Inbox className="size-4" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground tracking-tight">
              Client Reply Observation (Email &amp; Instagram)
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Watch your inbox for lead replies in the background and detect personal Instagram DM notifications automatically.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {server?.configured ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              {server.lastSyncStatus === "failed" ? "Sync Error" : "IMAP Active"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              Inbound Ready
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: IMAP Watcher */}
        <div className="space-y-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">IMAP Inbox Sync</h3>
            <button
              type="button"
              onClick={handleAutoFillFromSmtp}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline cursor-pointer"
            >
              <Wand2 className="size-3" />
              Auto-fill from SMTP
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-semibold text-muted-foreground mb-1">IMAP Host</label>
              <input
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.gmail.com"
                className="w-full bg-background border border-border/80 focus:border-blue-500 outline-none px-3 py-2 rounded-xl text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">Port</label>
              <input
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
                placeholder="993"
                className="w-full bg-background border border-border/80 focus:border-blue-500 outline-none px-3 py-2 rounded-xl text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">IMAP Username / Email</label>
              <input
                value={imapUsername}
                onChange={(e) => setImapUsername(e.target.value)}
                placeholder="you@gmail.com"
                className="w-full bg-background border border-border/80 focus:border-blue-500 outline-none px-3 py-2 rounded-xl text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">App Password / Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={imapPassword}
                  onChange={(e) => setImapPassword(e.target.value)}
                  placeholder={server?.hasPassword ? "•••••••• saved (leave blank to keep)" : "••••••••"}
                  className="w-full bg-background border border-border/80 focus:border-blue-500 outline-none px-3 py-2 pr-9 rounded-xl text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={imapTls}
              onChange={(e) => setImapTls(e.target.checked)}
              className="rounded border-border"
            />
            Use TLS/SSL (recommended for port 993)
          </label>

          {server?.lastSyncStatus === "failed" && server?.lastSyncError && (
            <p className="text-xs text-rose-400">Last sync error: {server.lastSyncError}</p>
          )}
          {server?.lastSyncedAt && (
            <p className="text-[11px] text-muted-foreground">
              Last synced: {new Date(server.lastSyncedAt).toLocaleString()}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleTest}
              disabled={testInbox.isPending}
              className="px-3 py-1.5 rounded-xl border border-border/80 bg-background hover:bg-muted text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              {testInbox.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Test IMAP
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveInbox.isPending}
              className="px-3.5 py-1.5 rounded-xl bg-brand hover:bg-brand/90 text-brand-foreground text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              {saveInbox.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save Observation Settings
            </button>
            {server?.configured && (
              <>
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncNow.isPending}
                  className="px-3 py-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`size-3.5 ${syncNow.isPending ? "animate-spin" : ""}`} />
                  Sync Now
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={deleteInbox.isPending}
                  className="px-2.5 py-1.5 rounded-xl text-xs text-muted-foreground hover:text-rose-400 cursor-pointer"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </div>

        {/* Right: Personal IG Observation (Zero Business Account Needed) */}
        <div className="space-y-3.5 border-t lg:border-t-0 lg:border-l border-border/60 pt-4 lg:pt-0 lg:pl-6">
          <div className="flex items-center gap-2">
            <Instagram className="size-4 text-pink-400" />
            <h3 className="text-sm font-semibold text-foreground">
              Instagram Reply Detection (Personal Accounts)
            </h3>
          </div>

          <label className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-background/60 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={igEmailAlerts}
              onChange={(e) => setIgEmailAlerts(e.target.checked)}
              className="mt-0.5 rounded border-border"
            />
            <span className="text-xs leading-relaxed">
              <strong className="block text-foreground">Detect Instagram DM email alerts (Zero IG risk)</strong>
              <span className="text-muted-foreground">
                Works on any brand-new personal IG account. Keep email notifications enabled in Instagram → Notifications → Email → Direct Messages.
              </span>
            </span>
          </label>

          {fullWebhookUrl && (
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Inbound Forwarding / Webhook URL
              </label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={fullWebhookUrl}
                  className="flex-1 bg-background border border-border/80 px-3 py-1.5 rounded-xl text-xs font-mono text-muted-foreground select-all"
                />
                <button
                  type="button"
                  onClick={() => copyText("webhook", fullWebhookUrl, "Webhook URL")}
                  className="p-2 rounded-xl border border-border/80 bg-background hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Copy Webhook URL"
                >
                  {copiedKey === "webhook" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Optional: use this with Resend/Postmark/Cloudflare Email Worker if you prefer forwarding over IMAP.
              </p>
            </div>
          )}

          <div className="rounded-xl border border-border/60 bg-background/40 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                Live Browser IG Bridge (Chrome Extension)
              </span>
              <button
                type="button"
                onClick={handleCopyExtensionSession}
                className="inline-flex items-center gap-1 rounded-lg border border-border/80 bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-muted cursor-pointer"
              >
                {copiedKey === "ext" ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                Copy Extension Config
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Load <code className="text-foreground">extensions/mast-ig-bridge</code> in Chrome to passively sync unread replies from contacted leads whenever you have Instagram DMs open—no IG password ever leaves your browser.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
