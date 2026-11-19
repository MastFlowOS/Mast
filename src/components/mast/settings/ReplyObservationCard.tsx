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
    <div className="bg-card border border-border/80 rounded-2xl p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3.5">
          <div className="size-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 grid place-items-center shrink-0">
            <Inbox className="size-5" />
          </div>
          <div>
            <h2 className="font-bold text-base text-foreground tracking-tight">
              Reply Observation
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Track client replies from email and Instagram.
            </p>
          </div>
        </div>

        {server?.configured ? (
          <div
            className={`flex items-center gap-1.5 text-xs font-medium ${
              server.lastSyncStatus === "failed" ? "text-destructive" : "text-emerald-400"
            }`}
          >
            <span
              className={`size-2 rounded-full shrink-0 ${
                server.lastSyncStatus === "failed" ? "bg-destructive" : "bg-emerald-400"
              }`}
            />
            <span>{server.lastSyncStatus === "failed" ? "Sync failed" : "IMAP Active"}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="size-2 rounded-full bg-muted-foreground/60 shrink-0" />
            <span>Not configured</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: IMAP Inbox Sync */}
        <div className="space-y-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">IMAP Configuration</h3>
            <button
              type="button"
              onClick={handleAutoFillFromSmtp}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
            >
              <Wand2 className="size-3" />
              Auto-fill from SMTP
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                IMAP Host
              </span>
              <input
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.gmail.com"
                className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 rounded-xl text-sm transition-colors"
              />
            </div>
            <div className="col-span-1">
              <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Port
              </span>
              <input
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
                placeholder="993"
                className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 rounded-xl text-sm transition-colors"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Username
              </span>
              <input
                value={imapUsername}
                onChange={(e) => setImapUsername(e.target.value)}
                placeholder="you@gmail.com"
                className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 rounded-xl text-sm transition-colors"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="block text-xs font-semibold text-muted-foreground">
                  Password
                </span>
                {useSmtpPassword && !imapPassword && (
                  <span className="text-[11px] font-medium text-blue-400">From SMTP</span>
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
                      ? "•••••••• using SMTP password"
                      : server?.hasPassword
                        ? "•••••••• saved"
                        : "••••••••••••"
                  }
                  className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 pr-10 rounded-xl text-sm transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          </div>

          <div className="pt-1 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={imapTls}
                onClick={() => setImapTls((v) => !v)}
                className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 cursor-pointer ${
                  imapTls ? "bg-blue-600" : "bg-zinc-800"
                }`}
              >
                <span
                  className={`inline-block size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out pointer-events-none ${
                    imapTls ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
              <span className="text-sm font-medium text-foreground">Use SSL/TLS</span>
            </div>

            {server?.lastSyncedAt && (
              <span className="text-xs text-muted-foreground">
                Synced {new Date(server.lastSyncedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {server?.lastSyncStatus === "failed" && server?.lastSyncError && (
            <p className="text-xs text-destructive">Error: {server.lastSyncError}</p>
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saveInbox.isPending}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/25 transition-all inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {saveInbox.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testInbox.isPending}
              className="px-4 py-2 rounded-xl bg-card border border-border/80 hover:bg-muted text-foreground text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm inline-flex items-center gap-1.5 cursor-pointer"
            >
              {testInbox.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Test Connection
            </button>
            {server?.configured && (
              <>
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncNow.isPending}
                  className="px-4 py-2 rounded-xl bg-card border border-border/80 hover:bg-muted text-foreground text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`size-3.5 ${syncNow.isPending ? "animate-spin" : ""}`} />
                  Sync Now
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={deleteInbox.isPending}
                  className="px-3 py-2 rounded-xl text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>

          {fullWebhookUrl && (
            <details className="pt-1">
              <summary className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer select-none">
                Inbound Webhook URL
              </summary>
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={fullWebhookUrl}
                  className="flex-1 bg-background border border-border/80 px-3.5 py-2 rounded-xl text-xs font-mono text-muted-foreground select-all"
                />
                <button
                  type="button"
                  onClick={() => copyText("webhook", fullWebhookUrl, "Webhook URL")}
                  className="p-2.5 rounded-xl border border-border/80 bg-card hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  title="Copy Webhook URL"
                >
                  {copiedKey === "webhook" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                </button>
              </div>
            </details>
          )}
        </div>

        {/* Right: Instagram Watcher */}
        <div className="space-y-3.5 border-t lg:border-t-0 lg:border-l border-border/60 pt-5 lg:pt-0 lg:pl-6 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Instagram</h3>

              {igWatcher.desktop && (
                <div
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    igWatcher.status?.state === "watching"
                      ? "text-emerald-400"
                      : igWatcher.status?.state === "needs_login"
                        ? "text-amber-400"
                        : igWatcher.status?.enabled
                          ? "text-blue-400"
                          : "text-muted-foreground"
                  }`}
                >
                  <span
                    className={`size-2 rounded-full shrink-0 ${
                      igWatcher.status?.state === "watching"
                        ? "bg-emerald-400"
                        : igWatcher.status?.state === "needs_login"
                          ? "bg-amber-400"
                          : igWatcher.status?.enabled
                            ? "bg-blue-400 animate-pulse"
                            : "bg-muted-foreground/60"
                    }`}
                  />
                  <span>
                    {igWatcher.status?.state === "watching"
                      ? "Connected"
                      : igWatcher.status?.state === "needs_login"
                        ? "Sign-in required"
                        : igWatcher.status?.enabled
                          ? "Connecting..."
                          : "Not connected"}
                  </span>
                </div>
              )}
            </div>

            {igWatcher.desktop ? (
              <>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Watches Instagram DMs in the background while MAST Desktop is open.
                </p>

                {igWatcher.status?.lastCheckedMs && (
                  <p className="text-xs text-muted-foreground">
                    Last checked {new Date(igWatcher.status.lastCheckedMs).toLocaleTimeString()}
                  </p>
                )}

                {igWatcher.status?.lastError && (
                  <p className="text-xs text-destructive">Error: {igWatcher.status.lastError}</p>
                )}

                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={igWatcher.connect}
                    disabled={igWatcher.busy}
                    className={
                      igWatcher.status?.connected && igWatcher.status?.state === "watching"
                        ? "px-4 py-2 rounded-xl bg-card border border-border/80 hover:bg-muted text-foreground text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm inline-flex items-center gap-1.5 cursor-pointer"
                        : "px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/25 transition-all inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                    }
                  >
                    {igWatcher.busy && <Loader2 className="size-3.5 animate-spin" />}
                    <Instagram className="size-3.5" />
                    {igWatcher.status?.state === "needs_login"
                      ? "Reconnect Instagram"
                      : igWatcher.status?.connected
                        ? "Open Instagram"
                        : "Connect Instagram"}
                  </button>

                  {igWatcher.status?.enabled && (
                    <>
                      {igWatcher.status.connected && (
                        <button
                          type="button"
                          onClick={igWatcher.checkNow}
                          disabled={igWatcher.busy}
                          className="px-4 py-2 rounded-xl bg-card border border-border/80 hover:bg-muted text-foreground text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <RefreshCw className="size-3.5" />
                          Check Now
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={igWatcher.disconnect}
                        disabled={igWatcher.busy}
                        className="px-3 py-2 rounded-xl text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        Disconnect
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-start gap-2.5 text-xs text-muted-foreground leading-relaxed">
                <Monitor className="size-4 text-blue-400 shrink-0 mt-0.5" />
                <span>
                  Connect once inside the MAST Desktop app to sync Instagram DM replies here.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
