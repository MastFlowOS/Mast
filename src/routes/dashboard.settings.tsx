import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Mail,
  Globe2,
  Bell,
  Shield,
  CreditCard,
  Cpu,
  Power,
  Trash2,
  Lock,
  Smartphone,
  ChevronDown,
  Check,
  X,
  AlertTriangle,
  User,
  Eye,
  EyeOff,
  Upload,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ApiError } from "@/lib/api";
import {
  useMe,
  useSaveSettings,
  useSettings,
  usePauseWorkspace,
  useEnableWorkspace,
  useDeleteWorkspace,
  useTestSmtpConnection,
} from "@/hooks/use-mast-api";
import { cn } from "@/lib/utils";


export const Route = createFileRoute("/dashboard/settings")({
  head: () => ({ meta: [{ title: "Settings — Mast" }] }),
  component: SettingsPage,
});

// ─── Constants ────────────────────────────────────────────────────────────────

const REGIONS = [
  "North America",
  "South America",
  "Europe",
  "Asia",
  "Africa",
  "Oceania",
  "Global",
] as const;

type Region = (typeof REGIONS)[number];

// ─── Main Page ────────────────────────────────────────────────────────────────

function SettingsPage() {
  const { data: auth } = useMe();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const pauseWorkspaceMut = usePauseWorkspace();
  const enableWorkspaceMut = useEnableWorkspace();
  const deleteWorkspaceMut = useDeleteWorkspace();
  const testSmtp = useTestSmtpConnection();

  // Profile
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");

  // Workspace
  const [workspaceName, setWorkspaceName] = useState("");

  // Default regions (multi-select)
  const [defaultRegions, setDefaultRegions] = useState<Region[]>(["North America"]);

  // Notifications
  const [notifyNewLeads, setNotifyNewLeads] = useState(true);
  const [notifyCreditLimit, setNotifyCreditLimit] = useState(true);
  const [notifyCreditsReset, setNotifyCreditsReset] = useState(true);
  const [notifyPlanChanges, setNotifyPlanChanges] = useState(true);
  const [notifyBilling, setNotifyBilling] = useState(true);
  const [notifyAnnouncements, setNotifyAnnouncements] = useState(true);

  // Sender identity
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [signature, setSignature] = useState("");

  // SMTP Settings
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpEncryption, setSmtpEncryption] = useState("None");
  const [smtpSenderName, setSmtpSenderName] = useState("");
  const [smtpSenderEmail, setSmtpSenderEmail] = useState("");

  // Test status
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [smtpError, setSmtpError] = useState("");

  // Modals & destructive states
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteNameConfirm, setDeleteNameConfirm] = useState("");

  // Change Password state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // Mutating loading states
  const [pausingWorkspace, setPausingWorkspace] = useState(false);
  const [enablingWorkspace, setEnablingWorkspace] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);

  useEffect(() => {
    setFullName(auth?.user?.fullName ?? "");
    setEmail(auth?.user?.email ?? "");
  }, [auth?.user]);

  useEffect(() => {
    if (!settings) return;
    setWorkspaceName(settings.workspaceName ?? "");
    setSenderName(settings.senderName ?? auth?.user?.fullName ?? "");
    setSenderEmail(settings.senderEmail ?? auth?.user?.email ?? "");
    setSignature(settings.signature ?? "");
    setNotifyNewLeads(settings.notifyNewLead !== "false");
    setNotifyCreditLimit(settings.notifyCreditLimit !== "false");
    setNotifyCreditsReset(settings.notifyCreditsReset !== "false");
    setNotifyPlanChanges(settings.notifyPlanChanges !== "false");
    setNotifyBilling(settings.notifyBilling !== "false");
    setNotifyAnnouncements(settings.notifyAnnouncements !== "false");

    // Load SMTP Settings
    setSmtpHost(settings.smtpHost ?? "");
    setSmtpPort(settings.smtpPort ?? "");
    setSmtpUser(settings.smtpUser ?? "");
    setSmtpPassword(settings.smtpPassword ?? "");
    setSmtpEncryption(settings.smtpEncryption ?? "None");
    setSmtpSenderName(settings.smtpSenderName ?? "");
    setSmtpSenderEmail(settings.smtpSenderEmail ?? "");

    // Sync notification preferences
    const prefs = {
      notifyNewLead: settings.notifyNewLead !== "false",
      notifyCreditLimit: settings.notifyCreditLimit !== "false",
      notifyCreditsReset: settings.notifyCreditsReset !== "false",
      notifyPlanChanges: settings.notifyPlanChanges !== "false",
      notifyBilling: settings.notifyBilling !== "false",
      notifyAnnouncements: settings.notifyAnnouncements !== "false",
    };
    localStorage.setItem("mast_notification_preferences", JSON.stringify(prefs));

    // Parse stored regions
    if (settings.defaultRegions) {
      const stored = settings.defaultRegions
        .split(",")
        .map((r) => r.trim())
        .filter((r) => REGIONS.includes(r as Region)) as Region[];
      if (stored.length > 0) setDefaultRegions(stored);
    }
  }, [settings, auth?.user]);

  const toggleRegion = (r: Region) => {
    if (r === "Global") {
      setDefaultRegions(["Global"]);
    } else {
      setDefaultRegions((prev) => {
        const withoutGlobal = prev.filter((x) => x !== "Global");
        if (withoutGlobal.includes(r)) {
          const next = withoutGlobal.filter((x) => x !== r);
          return next.length === 0 ? [r] : next;
        }
        return [...withoutGlobal, r];
      });
    }
  };

  const handleTestConnection = async () => {
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
      toast.error("All connection details (host, port, username, password) are required to test.");
      return;
    }
    setConnectionStatus("testing");
    setSmtpError("");
    try {
      await testSmtp.mutateAsync({
        host: smtpHost,
        port: smtpPort,
        user: smtpUser,
        pass: smtpPassword,
        encryption: smtpEncryption,
      });
      setConnectionStatus("success");
      toast.success("✓ Connected successfully.");
    } catch (err: any) {
      setConnectionStatus("error");
      const errMsg = err.message || "Failed to establish connection.";
      setSmtpError(errMsg);
      toast.error(`SMTP Test Failed: ${errMsg}`);
    }
  };

  const handlePauseWorkspace = async () => {
    setPausingWorkspace(true);
    try {
      await pauseWorkspaceMut.mutateAsync();
      setShowDisableModal(false);
      toast.success("Workspace paused. Access is now restricted.");
    } catch (err: any) {
      toast.error(err.message || "Failed to pause workspace.");
    } finally {
      setPausingWorkspace(false);
    }
  };

  const handleEnableWorkspace = async () => {
    setEnablingWorkspace(true);
    try {
      await enableWorkspaceMut.mutateAsync();
      toast.success("Workspace re-enabled. Full access restored.");
    } catch (err: any) {
      toast.error(err.message || "Failed to enable workspace.");
    } finally {
      setEnablingWorkspace(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    setDeletingWorkspace(true);
    try {
      await deleteWorkspaceMut.mutateAsync();
      // Cleanup notifications
      localStorage.removeItem("mast_notifications");
      localStorage.removeItem("mast_notification_preferences");
      setShowDeleteModal(false);
      toast.success("Workspace deleted. Redirecting…");
      // Redirect to landing page
      window.location.assign("/");
    } catch (err: any) {
      toast.error(err.message || "Failed to delete workspace.");
    } finally {
      setDeletingWorkspace(false);
    }
  };

  const save = async () => {
    try {
      await saveSettings.mutateAsync({
        settings: {
          workspaceName,
          defaultRegions: defaultRegions.join(", "),
          senderName,
          senderEmail,
          signature,
          notifyNewLead: notifyNewLeads ? "true" : "false",
          notifyCreditLimit: notifyCreditLimit ? "true" : "false",
          notifyCreditsReset: notifyCreditsReset ? "true" : "false",
          notifyPlanChanges: notifyPlanChanges ? "true" : "false",
          notifyBilling: notifyBilling ? "true" : "false",
          notifyAnnouncements: notifyAnnouncements ? "true" : "false",
          // Store SMTP Settings
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPassword,
          smtpEncryption,
          smtpSenderName,
          smtpSenderEmail,
        },
        fullName,
      });

      // Synchronize notification preferences locally
      const prefs = {
        notifyNewLead: notifyNewLeads,
        notifyCreditLimit: notifyCreditLimit,
        notifyCreditsReset: notifyCreditsReset,
        notifyPlanChanges: notifyPlanChanges,
        notifyBilling: notifyBilling,
        notifyAnnouncements: notifyAnnouncements,
      };
      localStorage.setItem("mast_notification_preferences", JSON.stringify(prefs));

      toast.success("Your settings have been updated.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save settings");
    }
  };

  // Workspace metadata from auth
  const createdDate = auth?.user
    ? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "—";
  const currentPlan = auth?.user?.plan ?? "Free";

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Command center for your account, identity, notifications, security, and integrations.
        </p>
      </div>

      {/* ── Profile ─────────────────────────────────────────────────────── */}
      <SectionCard
        icon={User}
        title="Profile"
        desc="Update your personal information"
      >
        <Field
          label="Full Name"
          value={fullName}
          onChange={setFullName}
          placeholder="Your full name"
        />
        <Field
          label="Email"
          value={email}
          onChange={() => {}}
          disabled
          hint="Email cannot be changed"
        />
      </SectionCard>

      {/* ── Workspace ───────────────────────────────────────────────────── */}
      <SectionCard icon={Cpu} title="Workspace" desc="Visible to your team">
        <Field
          label="Workspace name"
          value={workspaceName}
          onChange={setWorkspaceName}
          placeholder="My Workspace"
        />
      </SectionCard>

      {/* ── Default Regions ──────────────────────────────────────────────── */}
      <SectionCard
        icon={Globe2}
        title="Default Regions"
        desc="Pre-selected regions when opening Discover"
      >
        <div>
          <span className="block text-xs font-semibold text-muted-foreground mb-2">
            Select one or more target regions
          </span>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {REGIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => toggleRegion(r)}
                className={
                  defaultRegions.includes(r)
                    ? "px-3 py-2 rounded-lg border-2 border-brand bg-brand/10 text-foreground text-sm font-medium text-center"
                    : "px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 text-sm font-medium text-center transition-colors"
                }
              >
                {r}
              </button>
            ))}
          </div>
          {defaultRegions.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2">
              Selected:{" "}
              <span className="text-foreground font-medium">
                {defaultRegions.join(", ")}
              </span>
            </p>
          )}
        </div>
      </SectionCard>

      {/* ── SMTP Configuration ──────────────────────────────────── */}
      <div className="bg-card border border-border rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="size-11 rounded-xl bg-brand/10 border border-brand/25 grid place-items-center shrink-0">
            <Mail className="size-5 text-brand shrink-0" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-base text-foreground flex items-center gap-2">
              SMTP Configuration
              {connectionStatus === "success" && (
                <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20 shrink-0">
                  ✓ Connected
                </span>
              )}
            </h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Configure any SMTP compatible email provider for sending outreach campaigns securely.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
              <Field
                label="SMTP Host"
                value={smtpHost}
                onChange={setSmtpHost}
                placeholder="smtp.example.com"
              />
              <Field
                label="SMTP Port"
                value={smtpPort}
                onChange={setSmtpPort}
                placeholder="587"
              />
              <Field
                label="SMTP Username"
                value={smtpUser}
                onChange={setSmtpUser}
                placeholder="user@example.com"
              />
              <label className="block">
                <span className="block text-xs font-semibold text-muted-foreground mb-1.5">App Password</span>
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-background border border-border focus:border-brand outline-none px-3.5 py-2.5 rounded-lg text-sm"
                />
              </label>
              <Field
                label="Sender Name"
                value={smtpSenderName}
                onChange={setSmtpSenderName}
                placeholder="John Doe"
              />
              <Field
                label="Sender Email"
                value={smtpSenderEmail}
                onChange={setSmtpSenderEmail}
                placeholder="sender@example.com"
              />
              
              <div>
                <span className="block text-xs font-semibold text-muted-foreground mb-1.5">Encryption</span>
                <div className="flex gap-2">
                  {["None", "SSL", "TLS"].map((enc) => (
                    <button
                      key={enc}
                      type="button"
                      onClick={() => setSmtpEncryption(enc)}
                      className={cn(
                        "flex-1 py-2 rounded-lg border text-sm font-medium transition-colors",
                        smtpEncryption === enc
                          ? "border-brand bg-brand/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {enc}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-end justify-between md:col-span-2 mt-2">
                <button
                  type="button"
                  disabled={connectionStatus === "testing"}
                  onClick={handleTestConnection}
                  className="px-4 py-2.5 rounded-lg bg-foreground/10 text-foreground text-xs font-semibold border border-border hover:bg-foreground/15 disabled:opacity-40 transition-colors"
                >
                  {connectionStatus === "testing" ? "Testing..." : "Test Connection"}
                </button>
                
                {connectionStatus === "success" && (
                  <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2.5 py-1 rounded-lg">
                    <Check className="size-4 shrink-0" />
                    Connected
                  </span>
                )}
                {connectionStatus === "error" && (
                  <div className="text-right">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-destructive bg-destructive/10 border border-destructive/20 px-2.5 py-1 rounded-lg">
                      <X className="size-4 shrink-0" />
                      Failed
                    </span>
                  </div>
                )}
              </div>
              
              {connectionStatus === "error" && smtpError && (
                <p className="text-[11px] text-destructive md:col-span-2 mt-1 whitespace-pre-wrap leading-relaxed">
                  Error: {smtpError}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Sender Identity ─────────────────────────────────────────────── */}
      <SectionCard
        icon={Mail}
        title="Sender Identity"
        desc="Used by outreach email and message generation"
      >
        <Field
          label="Sender name"
          value={senderName}
          onChange={setSenderName}
        />
        <Field
          label="Sender email"
          value={senderEmail}
          onChange={setSenderEmail}
        />
        <label className="block">
          <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
            Signature
          </span>
          <textarea
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            className="min-h-24 w-full bg-background border border-border focus:border-brand outline-none px-3.5 py-2.5 rounded-lg text-sm"
            placeholder="Your email signature…"
          />
        </label>
      </SectionCard>

      {/* ── Notifications ────────────────────────────────────────────────── */}
      <SectionCard
        icon={Bell}
        title="Notifications"
        desc="Choose what we notify you about"
      >
        <Toggle
          label="New Leads Available"
          on={notifyNewLeads}
          onChange={setNotifyNewLeads}
        />
        <Toggle
          label="Credit Limit Reached"
          on={notifyCreditLimit}
          onChange={setNotifyCreditLimit}
        />
        <Toggle
          label="Daily Credits Reset"
          on={notifyCreditsReset}
          onChange={setNotifyCreditsReset}
        />
        <Toggle
          label="Plan Changes"
          on={notifyPlanChanges}
          onChange={setNotifyPlanChanges}
        />
        <Toggle
          label="Billing Updates"
          on={notifyBilling}
          onChange={setNotifyBilling}
        />
        <Toggle
          label="System Announcements"
          on={notifyAnnouncements}
          onChange={setNotifyAnnouncements}
        />
        {/* Coming Soon toggles */}
        <Toggle
          label="Outreach Replies"
          on={false}
          onChange={() => {}}
          comingSoon
          disabled
        />
        <Toggle
          label="Weekly Summary"
          on={false}
          onChange={() => {}}
          comingSoon
          disabled
        />
      </SectionCard>

      {/* ── Security ─────────────────────────────────────────────────────── */}
      <SectionCard
        icon={Shield}
        title="Security"
        desc="Manage your account security"
      >
        <SecurityRow
          icon={Lock}
          label="Change Password"
          desc="Update your account password"
          action={
            <button
              type="button"
              onClick={() => setShowPasswordModal(true)}
              className="px-3 py-1.5 rounded-lg border border-border text-sm font-semibold hover:bg-card transition-colors"
            >
              Change
            </button>
          }
        />
        <SecurityRow
          icon={Shield}
          label="Two-Factor Authentication"
          desc="Add an extra layer of security to your account"
          action={<ComingSoonBadge />}
        />
        <SecurityRow
          icon={Smartphone}
          label="Phone Verification"
          desc="Verify your identity via SMS"
          action={<ComingSoonBadge />}
        />
      </SectionCard>

      {/* ── Workspace Status ─────────────────────────────────────────────── */}
      <SectionCard
        icon={Cpu}
        title="Workspace Status"
        desc="Your current workspace information"
      >
        <div className="space-y-3">
          <StatusRow label="Status">
            {auth?.user?.workspaceStatus === "disabled" ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-400">
                <span className="size-2 rounded-full bg-orange-400 shrink-0 animate-pulse" />
                Paused
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400">
                <span className="size-2 rounded-full bg-emerald-400 shrink-0" />
                Active
              </span>
            )}
          </StatusRow>
          <StatusRow label="Created Date">
            <span className="text-sm font-medium">{createdDate}</span>
          </StatusRow>
          <StatusRow label="Current Plan">
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <span className="text-[10px] font-bold uppercase tracking-wider bg-brand/15 text-brand px-2 py-0.5 rounded border border-brand/20">
                {currentPlan}
              </span>
            </span>
          </StatusRow>
        </div>
      </SectionCard>

      {/* ── Save Button ──────────────────────────────────────────────────── */}
      <button
        onClick={save}
        disabled={saveSettings.isPending}
        className="px-5 py-2.5 rounded-lg bg-brand text-brand-foreground text-sm font-semibold shadow-brand hover:bg-brand-dark disabled:opacity-60"
      >
        {saveSettings.isPending ? "Saving…" : "Save settings"}
      </button>

      {/* ── Danger Zone ──────────────────────────────────────────────────── */}
      <div className="bg-card border border-destructive/30 rounded-2xl p-6">
        <h2 className="font-bold text-destructive">Danger Zone</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Irreversible or high-impact actions
        </p>
        <div className="mt-5 space-y-4">
          {/* Pause Workspace */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background p-4">
            <div>
              <p className="text-sm font-semibold">Pause Workspace</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Temporarily pause your workspace. This is reversible.
              </p>
            </div>
            {auth?.user?.workspaceStatus === "disabled" ? (
              <button
                type="button"
                disabled={enablingWorkspace}
                onClick={handleEnableWorkspace}
                className="shrink-0 px-4 py-2 rounded-lg border border-brand/40 text-brand text-sm font-semibold hover:bg-brand/10 transition-colors inline-flex items-center gap-2"
              >
                <Check className="size-4" />
                {enablingWorkspace ? "Enabling..." : "Enable"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowDisableModal(true)}
                className="shrink-0 px-4 py-2 rounded-lg border border-orange-500/40 text-orange-400 text-sm font-semibold hover:bg-orange-500/10 transition-colors inline-flex items-center gap-2"
              >
                <Power className="size-4" />
                Pause
              </button>
            )}
          </div>

          {/* Delete Workspace */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background p-4">
            <div>
              <p className="text-sm font-semibold">Delete Workspace</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently delete your workspace and all data. Cannot be undone.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="shrink-0 px-4 py-2 rounded-lg border border-destructive/40 text-destructive text-sm font-semibold hover:bg-destructive/10 transition-colors inline-flex items-center gap-2"
            >
              <Trash2 className="size-4" />
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* ── Pause Modal ────────────────────────────────────────────────── */}
      {showDisableModal && (
        <Modal
          onClose={() => setShowDisableModal(false)}
          title="Pause Workspace?"
          icon={<Power className="size-5 text-orange-400" />}
          iconBg="bg-orange-500/10 border-orange-500/20"
        >
          <p className="text-sm text-muted-foreground">
            Your workspace will be temporarily paused. All data is preserved
            and you can re-enable it at any time.
          </p>
          <div className="mt-5 flex gap-3 justify-end">
            <button
              onClick={() => setShowDisableModal(false)}
              className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={pausingWorkspace}
              onClick={handlePauseWorkspace}
              className="px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 transition-colors disabled:opacity-50"
            >
              {pausingWorkspace ? "Pausing..." : "Pause Workspace"}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Delete Modal ─────────────────────────────────────────────────── */}
      {showDeleteModal && (
        <Modal
          onClose={() => {
            setShowDeleteModal(false);
            setDeleteConfirm("");
            setDeleteNameConfirm("");
          }}
          title="Delete Workspace?"
          icon={<Trash2 className="size-5 text-destructive" />}
          iconBg="bg-destructive/10 border-destructive/20"
        >
          <p className="text-sm text-muted-foreground">
            This will{" "}
            <span className="text-foreground font-semibold">
              permanently delete
            </span>{" "}
            your workspace, all leads, campaigns, and data. This action cannot
            be undone.
          </p>
          <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 p-3 flex items-start gap-2">
            <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">
              All your opportunities, relationship data, campaigns, and settings will be erased.
            </p>
          </div>
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Type workspace name{" "}
                <span className="font-mono text-foreground font-bold">
                  {workspaceName || "My Workspace"}
                </span>{" "}
                to confirm
              </label>
              <input
                value={deleteNameConfirm}
                onChange={(e) => setDeleteNameConfirm(e.target.value)}
                placeholder={workspaceName || "My Workspace"}
                className="w-full bg-background border border-border focus:border-destructive outline-none px-3.5 py-2.5 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Type{" "}
                <span className="font-mono text-foreground font-bold">
                  DELETE
                </span>{" "}
                to confirm
              </label>
              <input
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="DELETE"
                className="w-full bg-background border border-border focus:border-destructive outline-none px-3.5 py-2.5 rounded-lg text-sm font-mono"
              />
            </div>
          </div>
          <div className="mt-5 flex gap-3 justify-end">
            <button
              onClick={() => {
                setShowDeleteModal(false);
                setDeleteConfirm("");
                setDeleteNameConfirm("");
              }}
              className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={deleteConfirm !== "DELETE" || deleteNameConfirm !== (workspaceName || "My Workspace") || deletingWorkspace}
              onClick={handleDeleteWorkspace}
              className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-45"
            >
              {deletingWorkspace ? "Deleting..." : "Delete Workspace"}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Change Password Modal ────────────────────────────────────────── */}
      {showPasswordModal && (
        <Modal
          onClose={() => {
            setShowPasswordModal(false);
            setNewPassword("");
            setConfirmNewPassword("");
            setShowNewPassword(false);
            setShowConfirmNewPassword(false);
            setPasswordError("");
          }}
          title="Change Password"
          icon={<Lock className="size-5 text-brand" />}
          iconBg="bg-brand/10 border-brand/20"
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setPasswordError("");

              if (newPassword.length < 8) {
                setPasswordError("Password must be at least 8 characters long.");
                return;
              }

              if (newPassword !== confirmNewPassword) {
                setPasswordError("Passwords do not match.");
                return;
              }

              setPasswordLoading(true);

              try {
                const { error: updateErr } = await supabase.auth.updateUser({
                  password: newPassword,
                });

                if (updateErr) throw updateErr;

                toast.success("Password updated successfully");
                setShowPasswordModal(false);
                setNewPassword("");
                setConfirmNewPassword("");
              } catch (err) {
                setPasswordError(
                  err instanceof Error ? err.message : "Failed to update password."
                );
              } finally {
                setPasswordLoading(false);
              }
            }}
            className="space-y-4"
          >
            <label className="block">
              <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                New password
              </span>
              <div className="relative">
                <input
                  type={showNewPassword ? "text" : "password"}
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-background border border-border focus:border-brand outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                >
                  {showNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Confirm new password
              </span>
              <div className="relative">
                <input
                  type={showConfirmNewPassword ? "text" : "password"}
                  required
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-background border border-border focus:border-brand outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmNewPassword(!showConfirmNewPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                >
                  {showConfirmNewPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </label>

            {passwordError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {passwordError}
              </div>
            )}

            <div className="mt-5 flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowPasswordModal(false);
                  setNewPassword("");
                  setConfirmNewPassword("");
                  setPasswordError("");
                }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-card transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={passwordLoading}
                className="px-4 py-2 rounded-lg bg-brand text-brand-foreground text-sm font-semibold hover:bg-brand-dark transition-colors disabled:opacity-60"
              >
                {passwordLoading ? "Updating..." : "Update Password"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}




// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="size-9 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
          <Icon className="size-4 text-brand shrink-0" />
        </div>

        <div>
          <h2 className="font-bold">{title}</h2>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-background border border-border focus:border-brand outline-none px-3.5 py-2.5 rounded-lg text-sm disabled:opacity-60"
      />
      {hint && (
        <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>
      )}
    </label>
  );
}

function Toggle({
  label,
  on,
  onChange,
  comingSoon,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (checked: boolean) => void;
  comingSoon?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!on)}
      className={cn(
        "flex w-full items-center justify-between gap-4 px-4 py-3 rounded-xl border border-border/50 bg-background/50 text-left transition-all duration-200",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/30 hover:border-border cursor-pointer"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {comingSoon && <ComingSoonBadge />}
      </div>
      <div
        className={cn(
          "relative shrink-0 w-10 h-6 rounded-full transition-colors duration-200",
          on ? "bg-brand" : "bg-zinc-800"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-5 bg-background rounded-full transition-all duration-200 shadow-sm",
            on ? "left-[18px]" : "left-0.5"
          )}
        />
      </div>
    </button>
  );
}


function SecurityRow({
  icon: Icon,
  label,
  desc,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
          <Icon className="size-4 text-brand shrink-0" />
        </div>

        <div className="min-w-0">
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function SettingsLink({
  to,
  label,
  desc,
}: {
  to: string;
  label: string;
  desc: string;
}) {
  return (
    <Link
      to={to as "/dashboard/settings"}
      className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3 hover:bg-card transition-colors"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
      <span className="text-xs font-semibold text-brand">Open</span>
    </Link>
  );
}

function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      {children}
    </div>
  );
}

function ComingSoonBadge() {
  return (
    <span className="text-[9px] font-bold uppercase tracking-wider bg-muted-foreground/15 text-muted-foreground px-1.5 py-0.5 rounded border border-muted-foreground/20">
      Soon
    </span>
  );
}

function Modal({
  title,
  icon,
  iconBg,
  children,
  onClose,
}: {
  title: string;
  icon: React.ReactNode;
  iconBg: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div
              className={`size-9 rounded-lg border grid place-items-center shrink-0 ${iconBg}`}
            >
              {icon}
            </div>
            <h3 className="font-bold">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="size-7 grid place-items-center rounded-lg hover:bg-card border border-transparent hover:border-border transition-colors text-muted-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}


