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
  Monitor,
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
import { useDesktopIgWatcherControl } from "@/lib/desktop/useDesktopIgWatcher";
import { deriveImapDefaultsFromSmtp } from "@/lib/inboxDefaults";

interface ReplyObservationCardProps {
  smtpHost: string;
  smtpUser: string;
  smtpPassword?: string;
  smtpHasSavedPassword?: boolean;
}

export function ReplyObservationCard({
  smtpHost,
  smtpUser,
  smtpPassword = "",
  smtpHasSavedPassword = false,
}: ReplyObservationCardProps) {
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
  const [useSmtpPassword, setUseSmtpPassword] = useState(false);
  const [imapTls, setImapTls] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const igWatcher = useDesktopIgWatcherControl();

  useEffect(() => {
    if (!server || initialized) return;
    setImapHost(server.imapHost || "");
    setImapPort(server.imapPort || "993");
    setImapUsername(server.imapUsername || "");
    setImapTls(server.imapTls);
    setInitialized(true);
  }, [server, initialized]);

  const handleAutoFillFromSmtp = () => {
    const guess = deriveImapDefaultsFromSmtp(smtpHost);
    if (!guess.imapHost && !smtpUser && !smtpPassword.trim() && !smtpHasSavedPassword) {
      toast.info("Enter your SMTP settings above first, or type your IMAP host manually.");
      return;
    }
    if (guess.imapHost) setImapHost(guess.imapHost);
    setImapPort(guess.imapPort);
    setImapTls(guess.imapTls);
    if (smtpUser) setImapUsername(smtpUser);

    let passwordNote = "";
    if (smtpPassword.trim()) {
      setImapPassword(smtpPassword);
      setUseSmtpPassword(false);
      passwordNote = " + App Password";
    } else if (smtpHasSavedPassword) {
      setImapPassword("");
      setUseSmtpPassword(true);
      passwordNote = " + saved SMTP App Password";
    }

    toast.success(`Synced host, email${passwordNote} from SMTP (IMAP uses port 993 TLS).`);
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
        useSmtpPassword: useSmtpPassword && !imapPassword ? true : undefined,
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
        useSmtpPassword: useSmtpPassword && !imapPassword ? true : undefined,
        imapTls,
        igEmailAlertsEnabled: false,
        enabled: true,
      });
      setImapPassword("");
      setUseSmtpPassword(false);
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
      setUseSmtpPassword(false);
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
              Watch your inbox for email replies 24/7 and connect Instagram once in the MAST Desktop app for live DM notifications.
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
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-muted-foreground">App Password / Password</label>
                {useSmtpPassword && !imapPassword && (
                  <span className="text-[10px] font-medium text-brand">Using saved SMTP password</span>
                )}
              </div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={imapPassword}
                  onChange={(e) => {
                    setImapPassword(e.target.value);
                    if (e.target.value) setUseSmtpPassword(false);
                  }}
                  placeholder={
                    useSmtpPassword && !imapPassword
                      ? "•••••••• Using saved SMTP password"
                      : server?.hasPassword
                        ? "•••••••• saved (leave blank to keep)"
                        : "••••••••"
                  }
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

          {fullWebhookUrl && (
            <details className="pt-1">
              <summary className="text-[11px] font-medium text-muted-foreground hover:text-foreground cursor-pointer select-none">
                Optional: Inbound Forwarding / Webhook URL
              </summary>
              <div className="mt-2 space-y-1">
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
                <p className="text-[11px] text-muted-foreground">
                  Use with Resend, Postmark, or Cloudflare Email Worker if you prefer forwarding over IMAP.
                </p>
              </div>
            </details>
          )}
        </div>

        {/* Right: Built-in Desktop Instagram Reply Watcher */}
        <div className="space-y-3.5 border-t lg:border-t-0 lg:border-l border-border/60 pt-4 lg:pt-0 lg:pl-6">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Instagram className="size-4 text-pink-400" />
              <h3 className="text-sm font-semibold text-foreground">
                Instagram Reply Watcher
              </h3>
            </div>

            {igWatcher.desktop && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                  igWatcher.status?.state === "watching"
                    ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-400"
                    : igWatcher.status?.state === "needs_login"
                      ? "bg-amber-500/10 border-amber-500/25 text-amber-300"
                      : igWatcher.status?.enabled
                        ? "bg-blue-500/10 border-blue-500/25 text-blue-300"
                        : "bg-muted/60 border-border text-muted-foreground"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    igWatcher.status?.state === "watching"
                      ? "bg-emerald-400"
                      : igWatcher.status?.state === "needs_login"
                        ? "bg-amber-400"
                        : igWatcher.status?.enabled
                          ? "bg-blue-400"
                          : "bg-muted-foreground"
                  }`}
                />
                {igWatcher.status?.state === "watching"
                  ? "Connected & Watching"
                  : igWatcher.status?.state === "needs_login"
                    ? "Sign-in Required"
                    : igWatcher.status?.enabled
                      ? "Connecting..."
                      : "Not Connected"}
              </span>
            )}
          </div>

          {igWatcher.desktop ? (
            <div className="rounded-xl border border-border/70 bg-background/60 p-4 space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Sign in to Instagram <strong className="text-foreground">once</strong> inside the MAST Desktop app. No Chrome extension or copy-paste needed—your session stays saved locally and quietly notifies <strong className="text-foreground">both the app and website</strong> whenever a contacted lead replies in DMs.
              </p>

              {igWatcher.status?.lastCheckedMs && (
                <p className="text-[11px] text-muted-foreground">
                  Last checked: {new Date(igWatcher.status.lastCheckedMs).toLocaleTimeString()}
                </p>
              )}

              {igWatcher.status?.lastError && (
                <p className="text-xs text-rose-400">{igWatcher.status.lastError}</p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={igWatcher.connect}
                  disabled={igWatcher.busy}
                  className="px-3.5 py-1.5 rounded-xl bg-brand hover:bg-brand/90 text-brand-foreground text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  {igWatcher.busy && <Loader2 className="size-3.5 animate-spin" />}
                  <Instagram className="size-3.5" />
                  {igWatcher.status?.state === "needs_login"
                    ? "Reconnect Instagram"
                    : igWatcher.status?.connected
                      ? "Open Instagram Window"
                      : "Connect Instagram"}
                </button>

                {igWatcher.status?.enabled && (
                  <>
                    <button
                      type="button"
                      onClick={igWatcher.checkNow}
                      disabled={igWatcher.busy}
                      className="px-3 py-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw className="size-3.5" />
                      Check Now
                    </button>
                    <button
                      type="button"
                      onClick={igWatcher.disconnect}
                      disabled={igWatcher.busy}
                      className="px-2.5 py-1.5 rounded-xl text-xs text-muted-foreground hover:text-rose-400 cursor-pointer"
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-background/60 p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Monitor className="size-4 text-brand" />
                Connect once inside the MAST Desktop app
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Built-in Instagram reply watching runs natively in the <strong className="text-foreground">MAST Desktop app</strong>—no browser extension, no Developer Mode, and no config copy-paste. Open MAST Desktop → Settings and click <strong className="text-foreground">Connect Instagram</strong> once; whenever the desktop app is open on your PC, replies appear live on both the app and here on the website.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
