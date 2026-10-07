import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Mail,
  Globe2,
  Bell,
  Trash2,
  Lock,
  Eye,
  EyeOff,
  Check,
  X,
  AlertTriangle,
  User,
  Building2,
  Copy,
  Save,
  Calendar,
  ChevronDown,
  Power,
  Layers,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ApiError } from "@/lib/api";
import {
  useMe,
  useAccount,
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

const AVAILABLE_REGIONS = [
  "United States",
  "Canada",
  "United Kingdom",
  "North America",
  "Europe",
  "Asia",
  "Australia",
  "South America",
  "Africa",
  "Oceania",
  "Global",
] as const;

interface SettingsBaseline {
  fullName: string;
  workspaceName: string;
  website: string;
  defaultRegions: string[];
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPassword: string;
  smtpEncryption: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  signature: string;
  notifyBilling: boolean;
  notifyNewLeads: boolean;
  notifyCreditLimit: boolean;
  notifyAnnouncements: boolean;
  notifyCreditsReset: boolean;
  notifyPlanChanges: boolean;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function SettingsPage() {
  const { data: auth } = useMe();
  const { data: settings } = useSettings();
  const { data: account } = useAccount(!!auth?.user);
  const saveSettings = useSaveSettings();
  const pauseWorkspaceMut = usePauseWorkspace();
  const enableWorkspaceMut = useEnableWorkspace();
  const deleteWorkspaceMut = useDeleteWorkspace();
  const testSmtp = useTestSmtpConnection();

  // Baseline for dirty tracking
  const [baseline, setBaseline] = useState<SettingsBaseline | null>(null);

  // Profile
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");

  // Workspace
  const [workspaceName, setWorkspaceName] = useState("");
  const [website, setWebsite] = useState("");

  // Default regions (multi-select)
  const [defaultRegions, setDefaultRegions] = useState<string[]>([
    "United States",
    "Canada",
    "United Kingdom",
  ]);

  // Notifications
  const [notifyBilling, setNotifyBilling] = useState(true);
  const [notifyNewLeads, setNotifyNewLeads] = useState(true);
  const [notifyCreditLimit, setNotifyCreditLimit] = useState(false);
  const [notifyAnnouncements, setNotifyAnnouncements] = useState(true);
  const [notifyCreditsReset, setNotifyCreditsReset] = useState(false);
  const [notifyPlanChanges, setNotifyPlanChanges] = useState(true);

  // Sender identity
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [signature, setSignature] = useState("");

  // SMTP Settings
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpEncryption, setSmtpEncryption] = useState("None");
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);

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

  // File upload ref for avatar
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasInitializedRef = useRef(false);

  // Initialize values and baseline once settings and auth are available
  useEffect(() => {
    if (hasInitializedRef.current) return;
    if (!settings) return;

    const initialFullName = auth?.user?.fullName ?? "";
    const initialEmail = auth?.user?.email ?? "";
    setFullName(initialFullName);
    setEmail(initialEmail);

    const initialWorkspaceName = settings.workspaceName ?? "MAST Workspace";
    const initialWebsite = settings.website ?? "";
    const initialSenderName = settings.senderName ?? auth?.user?.fullName ?? "";
    const initialSenderEmail = settings.senderEmail ?? auth?.user?.email ?? "";
    const initialReplyTo = settings.replyTo ?? "";
    const initialSignature = settings.signature ?? "";

    const initialNotifyBilling = settings.notifyBilling !== "false";
    const initialNotifyNewLeads = settings.notifyNewLead !== "false";
    const initialNotifyCreditLimit = settings.notifyCreditLimit === "true";
    const initialNotifyAnnouncements = settings.notifyAnnouncements !== "false";
    const initialNotifyCreditsReset = settings.notifyCreditsReset === "true";
    const initialNotifyPlanChanges = settings.notifyPlanChanges !== "false";

    const initialSmtpHost = settings.smtpHost ?? "";
    const initialSmtpPort = settings.smtpPort ?? "";
    const initialSmtpUser = settings.smtpUser ?? "";
    const initialSmtpPassword = settings.smtpPassword ?? "";
    const initialSmtpEncryption = settings.smtpEncryption ?? "None";

    let initialRegions = ["United States", "Canada", "United Kingdom"];
    if (settings.defaultRegions) {
      const parsed = settings.defaultRegions
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      if (parsed.length > 0) {
        initialRegions = parsed;
      }
    }

    setWorkspaceName(initialWorkspaceName);
    setWebsite(initialWebsite);
    setSenderName(initialSenderName);
    setSenderEmail(initialSenderEmail);
    setReplyTo(initialReplyTo);
    setSignature(initialSignature);

    setNotifyBilling(initialNotifyBilling);
    setNotifyNewLeads(initialNotifyNewLeads);
    setNotifyCreditLimit(initialNotifyCreditLimit);
    setNotifyAnnouncements(initialNotifyAnnouncements);
    setNotifyCreditsReset(initialNotifyCreditsReset);
    setNotifyPlanChanges(initialNotifyPlanChanges);

    setSmtpHost(initialSmtpHost);
    setSmtpPort(initialSmtpPort);
    setSmtpUser(initialSmtpUser);
    setSmtpPassword(initialSmtpPassword);
    setSmtpEncryption(initialSmtpEncryption);
    setDefaultRegions(initialRegions);

    setBaseline({
      fullName: initialFullName,
      workspaceName: initialWorkspaceName,
      website: initialWebsite,
      defaultRegions: initialRegions,
      smtpHost: initialSmtpHost,
      smtpPort: initialSmtpPort,
      smtpUser: initialSmtpUser,
      smtpPassword: initialSmtpPassword,
      smtpEncryption: initialSmtpEncryption,
      senderName: initialSenderName,
      senderEmail: initialSenderEmail,
      replyTo: initialReplyTo,
      signature: initialSignature,
      notifyBilling: initialNotifyBilling,
      notifyNewLeads: initialNotifyNewLeads,
      notifyCreditLimit: initialNotifyCreditLimit,
      notifyAnnouncements: initialNotifyAnnouncements,
      notifyCreditsReset: initialNotifyCreditsReset,
      notifyPlanChanges: initialNotifyPlanChanges,
    });
    hasInitializedRef.current = true;
  }, [settings, auth?.user]);

  // Dirty detection: checks if any setting differs from baseline
  const isDirty = useMemo(() => {
    if (!baseline) return false;
    if (fullName !== baseline.fullName) return true;
    if (workspaceName !== baseline.workspaceName) return true;
    if (website !== baseline.website) return true;
    if (smtpHost !== baseline.smtpHost) return true;
    if (smtpPort !== baseline.smtpPort) return true;
    if (smtpUser !== baseline.smtpUser) return true;
    if (smtpPassword !== baseline.smtpPassword) return true;
    if (smtpEncryption !== baseline.smtpEncryption) return true;
    if (senderName !== baseline.senderName) return true;
    if (senderEmail !== baseline.senderEmail) return true;
    if (replyTo !== baseline.replyTo) return true;
    if (signature !== baseline.signature) return true;
    if (notifyBilling !== baseline.notifyBilling) return true;
    if (notifyNewLeads !== baseline.notifyNewLeads) return true;
    if (notifyCreditLimit !== baseline.notifyCreditLimit) return true;
    if (notifyAnnouncements !== baseline.notifyAnnouncements) return true;
    if (notifyCreditsReset !== baseline.notifyCreditsReset) return true;
    if (notifyPlanChanges !== baseline.notifyPlanChanges) return true;
    if (
      JSON.stringify([...defaultRegions].sort()) !==
      JSON.stringify([...baseline.defaultRegions].sort())
    ) {
      return true;
    }
    return false;
  }, [
    baseline,
    fullName,
    workspaceName,
    website,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPassword,
    smtpEncryption,
    senderName,
    senderEmail,
    replyTo,
    signature,
    notifyBilling,
    notifyNewLeads,
    notifyCreditLimit,
    notifyAnnouncements,
    notifyCreditsReset,
    notifyPlanChanges,
    defaultRegions,
  ]);

  const toggleRegion = (r: string) => {
    if (r === "Global") {
      setDefaultRegions(["Global"]);
    } else {
      setDefaultRegions((prev) => {
        const withoutGlobal = prev.filter((x) => x !== "Global");
        if (withoutGlobal.includes(r)) {
          return withoutGlobal.filter((x) => x !== r);
        }
        return [...withoutGlobal, r];
      });
    }
  };

  const removeRegion = (r: string) => {
    setDefaultRegions((prev) => prev.filter((x) => x !== r));
  };

  const handleTestConnection = async () => {
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
      toast.error("Host, port, username, and password are required to test.");
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
      toast.success("Connected successfully.");
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
      localStorage.removeItem("mast_notifications");
      localStorage.removeItem("mast_notification_preferences");
      setShowDeleteModal(false);
      toast.success("Workspace deleted. Redirecting…");
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
          website,
          defaultRegions: defaultRegions.join(", "),
          senderName,
          senderEmail,
          replyTo,
          signature,
          notifyNewLead: notifyNewLeads ? "true" : "false",
          notifyCreditLimit: notifyCreditLimit ? "true" : "false",
          notifyCreditsReset: notifyCreditsReset ? "true" : "false",
          notifyPlanChanges: notifyPlanChanges ? "true" : "false",
          notifyBilling: notifyBilling ? "true" : "false",
          notifyAnnouncements: notifyAnnouncements ? "true" : "false",
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPassword,
          smtpEncryption,
          smtpSenderName: senderName,
          smtpSenderEmail: senderEmail,
        },
        fullName,
      });

      const prefs = {
        notifyNewLead: notifyNewLeads,
        notifyCreditLimit: notifyCreditLimit,
        notifyCreditsReset: notifyCreditsReset,
        notifyPlanChanges: notifyPlanChanges,
        notifyBilling: notifyBilling,
        notifyAnnouncements: notifyAnnouncements,
      };
      localStorage.setItem("mast_notification_preferences", JSON.stringify(prefs));

      // Reset baseline to current values so save bar hides immediately
      setBaseline({
        fullName,
        workspaceName,
        website,
        defaultRegions: [...defaultRegions],
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPassword,
        smtpEncryption,
        senderName,
        senderEmail,
        replyTo,
        signature,
        notifyBilling,
        notifyNewLeads,
        notifyCreditLimit,
        notifyAnnouncements,
        notifyCreditsReset,
        notifyPlanChanges,
      });

      toast.success("Settings saved successfully.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save settings");
    }
  };

  const discard = () => {
    if (!baseline) return;
    setFullName(baseline.fullName);
    setWorkspaceName(baseline.workspaceName);
    setWebsite(baseline.website);
    setDefaultRegions([...baseline.defaultRegions]);
    setSmtpHost(baseline.smtpHost);
    setSmtpPort(baseline.smtpPort);
    setSmtpUser(baseline.smtpUser);
    setSmtpPassword(baseline.smtpPassword);
    setSmtpEncryption(baseline.smtpEncryption);
    setSenderName(baseline.senderName);
    setSenderEmail(baseline.senderEmail);
    setReplyTo(baseline.replyTo);
    setSignature(baseline.signature);
    setNotifyBilling(baseline.notifyBilling);
    setNotifyNewLeads(baseline.notifyNewLeads);
    setNotifyCreditLimit(baseline.notifyCreditLimit);
    setNotifyAnnouncements(baseline.notifyAnnouncements);
    setNotifyCreditsReset(baseline.notifyCreditsReset);
    setNotifyPlanChanges(baseline.notifyPlanChanges);
    toast.info("Changes discarded.");
  };

  // Workspace metadata
  const createdDate = "Aug 7, 2026";
  const currentPlan = auth?.user?.plan
    ? auth.user.plan.charAt(0).toUpperCase() + auth.user.plan.slice(1)
    : "Free";

  const monthlyLimit = account?.credits?.limit ?? auth?.user?.creditsLimit ?? 300;
  const monthlyUsed = account?.credits?.used ?? auth?.user?.creditsUsed ?? 0;
  const monthlyPct = monthlyLimit > 0 ? Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100)) : 0;

  const dailyLimit = account?.dailyUsage?.limit ?? 20;
  const dailyUsed = account?.dailyUsage?.used ?? auth?.user?.dailyLeadsUsed ?? 0;
  const dailyPct = dailyLimit > 0 ? Math.min(100, Math.round((dailyUsed / dailyLimit) * 100)) : 0;

  const rawWsId = auth?.user?.id ? `ws_${auth.user.id.replace(/-/g, "").slice(0, 10)}` : "ws_8f3a2c1d9e";
  const displayWsId = `${rawWsId}...`;

  const copyWorkspaceId = () => {
    navigator.clipboard.writeText(auth?.user?.id ? `ws_${auth.user.id}` : rawWsId);
    toast.success("Workspace ID copied to clipboard");
  };

  const avatarInitial = (fullName?.trim()?.[0] || auth?.user?.fullName?.trim()?.[0] || email?.trim()?.[0] || "M").toUpperCase();

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      toast.success("Profile photo updated.");
    }
  };

  // Current date formatted e.g. "Mon, Sep 29, 2026"
  const formattedToday = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="relative min-h-full p-6 md:p-8 max-w-6xl mx-auto space-y-6 pb-28">
      {/* ── Top Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your account, workspace, and preferences.
          </p>
        </div>

        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border/80 bg-card/60 text-xs font-medium text-muted-foreground self-start sm:self-auto shrink-0 shadow-sm">
          <Calendar className="size-3.5 text-muted-foreground shrink-0" />
          <span>{formattedToday}</span>
        </div>
      </div>

      {/* ── Row 1: Account (Left) + Workspace (Right) ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Account Card */}
        <SettingsCard
          icon={User}
          title="Account"
          desc="Manage your personal information."
        >
          <div className="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-6">
            <div className="flex-1 w-full space-y-4">
              <SettingsInput
                label="Name"
                value={fullName}
                onChange={setFullName}
                placeholder="Beboo"
              />

              <div>
                <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                  Email
                </span>
                <div className="relative">
                  <input
                    value={email}
                    disabled
                    readOnly
                    className="w-full bg-background border border-border/80 px-3.5 py-2.5 pr-10 rounded-xl text-sm text-muted-foreground cursor-not-allowed select-all"
                  />
                  <button
                    type="button"
                    title="Change password"
                    onClick={() => setShowPasswordModal(true)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                  >
                    <Lock className="size-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Avatar & Change Photo */}
            <div className="flex flex-col items-center justify-center shrink-0 sm:pt-2 sm:pl-2">
              <div className="size-16 rounded-full bg-blue-600 text-white font-bold text-2xl grid place-items-center shadow-lg shadow-blue-600/30 ring-4 ring-blue-600/10">
                {avatarInitial}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoUpload}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 px-3.5 py-1.5 rounded-lg border border-border/80 bg-card hover:bg-muted text-xs font-medium text-foreground transition-colors"
              >
                Change Photo
              </button>
            </div>
          </div>
        </SettingsCard>

        {/* Workspace Card */}
        <SettingsCard
          icon={Building2}
          title="Workspace"
          desc="Manage your workspace details."
        >
          <div className="space-y-4">
            <SettingsInput
              label="Workspace Name"
              value={workspaceName}
              onChange={setWorkspaceName}
              placeholder="MAST Workspace"
            />
            <SettingsInput
              label="Website (optional)"
              value={website}
              onChange={setWebsite}
              placeholder="https://yourwebsite.com"
            />
          </div>
        </SettingsCard>
      </div>

      {/* ── Row 2: Discovery (Full Width) ──────────────────────────────────── */}
      <SettingsCard
        icon={Globe2}
        title="Discovery"
        desc="Set default regions for lead discovery."
      >
        <div>
          <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
            Default Regions
          </span>
          <RegionMultiSelect
            selected={defaultRegions}
            options={AVAILABLE_REGIONS}
            onToggle={toggleRegion}
            onRemove={removeRegion}
          />
          <p className="text-xs text-muted-foreground mt-2">
            These regions will be pre-selected when discovering new leads.
          </p>
        </div>
      </SettingsCard>

      {/* ── Row 3: Outreach (Left) + Sender Identity (Right) ────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Outreach Card */}
        <SettingsCard
          icon={Mail}
          title="Outreach"
          desc="Configure your email settings for outreach."
        >
          <div>
            <h3 className="text-sm font-semibold text-foreground mb-3">
              SMTP Configuration
            </h3>

            <div className="space-y-3.5">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <SettingsInput
                    label="SMTP Host"
                    value={smtpHost}
                    onChange={setSmtpHost}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div className="col-span-1">
                  <SettingsInput
                    label="Port"
                    value={smtpPort}
                    onChange={setSmtpPort}
                    placeholder="587"
                  />
                </div>
              </div>

              <SettingsInput
                label="Username"
                value={smtpUser}
                onChange={setSmtpUser}
                placeholder="your-email@example.com"
              />

              <div>
                <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                  Password
                </span>
                <div className="relative">
                  <input
                    type={showSmtpPassword ? "text" : "password"}
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 pr-10 rounded-xl text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSmtpPassword(!showSmtpPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                  >
                    {showSmtpPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              {/* Use SSL/TLS Toggle */}
              <div className="pt-1">
                <div className="flex items-center gap-3">
                  <SettingsSwitch
                    checked={smtpEncryption !== "None"}
                    onChange={(checked) => setSmtpEncryption(checked ? "TLS" : "None")}
                  />
                  <span className="text-sm font-medium text-foreground">Use SSL/TLS</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Used for sending emails directly from your own SMTP server.
                </p>
              </div>

              {/* Test Connection Action */}
              <div className="flex items-center gap-4 pt-2">
                <button
                  type="button"
                  disabled={connectionStatus === "testing"}
                  onClick={handleTestConnection}
                  className="px-4 py-2 rounded-xl bg-card border border-border/80 hover:bg-muted text-foreground text-xs font-semibold disabled:opacity-50 transition-colors shadow-sm"
                >
                  {connectionStatus === "testing" ? "Testing..." : "Test Connection"}
                </button>

                {connectionStatus === "idle" && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                    <span className="size-2 rounded-full bg-amber-400 shrink-0" />
                    <span>Not tested</span>
                  </div>
                )}
                {connectionStatus === "testing" && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-blue-400">
                    <span className="size-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
                    <span>Testing...</span>
                  </div>
                )}
                {connectionStatus === "success" && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <span className="size-2 rounded-full bg-emerald-400 shrink-0" />
                    <span>Connected</span>
                  </div>
                )}
                {connectionStatus === "error" && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <span className="size-2 rounded-full bg-destructive shrink-0" />
                    <span>Failed</span>
                  </div>
                )}
              </div>

              {connectionStatus === "error" && smtpError && (
                <p className="text-[11px] text-destructive whitespace-pre-wrap leading-relaxed">
                  Error: {smtpError}
                </p>
              )}
            </div>
          </div>
        </SettingsCard>

        {/* Sender Identity Card */}
        <SettingsCard
          icon={Mail}
          title="Sender Identity"
          desc="Set your default sender information."
        >
          <div className="space-y-4">
            <SettingsInput
              label="From Name"
              value={senderName}
              onChange={setSenderName}
              placeholder="Beboo"
            />
            <SettingsInput
              label="From Email"
              value={senderEmail}
              onChange={setSenderEmail}
              placeholder="bebo@example.com"
            />
            <SettingsInput
              label="Reply To (optional)"
              value={replyTo}
              onChange={setReplyTo}
              placeholder="reply@example.com"
            />
            <div>
              <span className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Signature (optional)
              </span>
              <textarea
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                rows={3}
                className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 rounded-xl text-sm resize-none"
                placeholder="Best regards,&#10;Beboo"
              />
              <p className="text-xs text-muted-foreground mt-1">
                This signature will be used in your outreach emails.
              </p>
            </div>
          </div>
        </SettingsCard>
      </div>

      {/* ── Row 4: Notifications (Left) + Workspace Info (Right) ────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Notifications Card */}
        <SettingsCard
          icon={Bell}
          title="Notifications"
          desc="Choose what notifications you want to receive."
        >
          <div className="divide-y divide-border/40 -my-1">
            <NotificationRow
              label="Email notifications"
              desc="Get notified about important updates."
              checked={notifyBilling}
              onChange={setNotifyBilling}
            />
            <NotificationRow
              label="Lead discovery complete"
              desc="When your lead discovery is finished."
              checked={notifyNewLeads}
              onChange={setNotifyNewLeads}
            />
            <NotificationRow
              label="New opportunities"
              desc="Get notified about new opportunities."
              checked={notifyCreditLimit}
              onChange={setNotifyCreditLimit}
            />
            <NotificationRow
              label="Product updates"
              desc="Receive updates about new features."
              checked={notifyAnnouncements}
              onChange={setNotifyAnnouncements}
            />
            <NotificationRow
              label="Marketing emails"
              desc="Receive tips, guides, and promotional content."
              checked={notifyCreditsReset}
              onChange={setNotifyCreditsReset}
            />
          </div>
        </SettingsCard>

        {/* Workspace Info Card */}
        <SettingsCard
          icon={Layers}
          title="Workspace Info"
          desc="View your workspace details."
        >
          <div className="space-y-4 py-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs font-medium">Workspace ID</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-foreground font-medium">{displayWsId}</span>
                <button
                  type="button"
                  onClick={copyWorkspaceId}
                  title="Copy workspace ID"
                  className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs font-medium">Created Date</span>
              <span className="text-xs font-medium text-foreground">{createdDate}</span>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground text-xs font-medium">Current Plan</span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {currentPlan}
              </span>
            </div>

            {/* Opportunities Monthly */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">Opportunities (Monthly)</span>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-foreground">
                    {monthlyUsed} / {monthlyLimit}
                  </span>
                  <span className="text-muted-foreground font-medium w-8 text-right">{monthlyPct}%</span>
                </div>
              </div>
              <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-300"
                  style={{ width: `${monthlyPct}%` }}
                />
              </div>
            </div>

            {/* Opportunities Daily */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">Opportunities (Daily)</span>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-foreground">
                    {dailyUsed} / {dailyLimit}
                  </span>
                  <span className="text-muted-foreground font-medium w-8 text-right">{dailyPct}%</span>
                </div>
              </div>
              <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-300"
                  style={{ width: `${dailyPct}%` }}
                />
              </div>
            </div>
          </div>
        </SettingsCard>
      </div>

      {/* ── Row 5: Danger Zone (Full Width) ─────────────────────────────────── */}
      <div className="border border-destructive/20 bg-card rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3">
            <div className="size-10 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive grid place-items-center shrink-0">
              <Trash2 className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-destructive">Danger Zone</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently delete your workspace and all associated data.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-end sm:self-auto shrink-0">
            {auth?.user?.workspaceStatus === "disabled" ? (
              <button
                type="button"
                disabled={enablingWorkspace}
                onClick={handleEnableWorkspace}
                className="px-3.5 py-2 rounded-xl border border-brand/40 text-brand text-xs font-semibold hover:bg-brand/10 transition-colors inline-flex items-center gap-1.5"
              >
                <Check className="size-3.5" />
                {enablingWorkspace ? "Enabling..." : "Enable Workspace"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowDisableModal(true)}
                className="px-3.5 py-2 rounded-xl border border-border/80 bg-background hover:bg-muted text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5"
              >
                <Power className="size-3.5 text-orange-400" />
                Pause Workspace
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="px-4 py-2 rounded-xl border border-destructive/40 text-destructive text-xs font-semibold hover:bg-destructive/10 transition-colors inline-flex items-center gap-2"
            >
              <Trash2 className="size-3.5" />
              Delete Workspace
            </button>
          </div>
        </div>
      </div>

      {/* ── CRITICAL SAVE BEHAVIOR: Sticky Floating Save / Discard Bar ──────── */}
      {isDirty && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-xl bg-card/95 border border-border shadow-2xl backdrop-blur-xl rounded-2xl px-5 py-3.5 flex items-center justify-between gap-4 transition-all duration-200 animate-in fade-in slide-in-from-bottom-5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saveSettings.isPending}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-lg shadow-blue-600/25 transition-all inline-flex items-center gap-2 active:scale-95 disabled:opacity-50"
            >
              <Save className="size-4" />
              {saveSettings.isPending ? "Saving..." : "Save Settings"}
            </button>
            <button
              type="button"
              onClick={discard}
              disabled={saveSettings.isPending}
              className="px-4 py-2 rounded-xl border border-border/80 bg-background/80 hover:bg-muted text-foreground text-sm font-medium transition-colors active:scale-95"
            >
              Discard Changes
            </button>
          </div>

          <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-2">
            <span className="size-2 rounded-full bg-amber-400 animate-pulse" />
            <span>Unsaved changes</span>
          </div>
        </div>
      )}

      {/* ── Pause Modal ──────────────────────────────────────────────────────── */}
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

      {/* ── Delete Modal ─────────────────────────────────────────────────────── */}
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

      {/* ── Change Password Modal ────────────────────────────────────────────── */}
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
          icon={<Lock className="size-5 text-blue-500" />}
          iconBg="bg-blue-500/10 border-blue-500/20"
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
                  className="w-full bg-background border border-border focus:border-blue-500 outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm"
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
                  className="w-full bg-background border border-border focus:border-blue-500 outline-none pl-3.5 pr-10 py-2.5 rounded-lg text-sm"
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
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 transition-colors disabled:opacity-60"
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

function SettingsCard({
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
    <div className="bg-card border border-border/80 rounded-2xl p-6 shadow-sm">
      <div className="flex items-center gap-3.5 mb-5">
        <div className="size-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 grid place-items-center shrink-0">
          <Icon className="size-5" />
        </div>
        <div>
          <h2 className="font-bold text-base text-foreground tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function SettingsInput({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
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
        className="w-full bg-background border border-border/80 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none px-3.5 py-2.5 rounded-xl text-sm disabled:opacity-60 transition-colors"
      />
    </label>
  );
}

function SettingsSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-blue-600" : "bg-zinc-800"
      )}
    >
      <span
        className={cn(
          "inline-block size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out pointer-events-none",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

function NotificationRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-3 gap-4">
      <div className="min-w-0 pr-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
      <SettingsSwitch checked={checked} onChange={onChange} />
    </div>
  );
}

function RegionMultiSelect({
  selected,
  options,
  onToggle,
  onRemove,
}: {
  selected: string[];
  options: readonly string[];
  onToggle: (r: string) => void;
  onRemove: (r: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        onClick={() => setOpen(!open)}
        className="min-h-[46px] w-full bg-background border border-border/80 focus-within:border-blue-500 rounded-xl px-3 py-2 flex items-center justify-between gap-2 flex-wrap cursor-pointer transition-colors"
      >
        <div className="flex flex-wrap items-center gap-1.5 flex-1">
          {selected.length === 0 ? (
            <span className="text-sm text-muted-foreground">Select default regions...</span>
          ) : (
            selected.map((r) => (
              <span
                key={r}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-secondary/80 border border-border/60 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
              >
                <span>{r}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(r);
                  }}
                  className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))
          )}
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground shrink-0 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </div>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-40 w-full max-h-60 overflow-y-auto bg-card border border-border/90 rounded-xl shadow-2xl p-1.5 space-y-0.5 animate-in fade-in zoom-in-95 duration-150">
          {options.map((opt) => {
            const isSelected = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onToggle(opt)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left",
                  isSelected
                    ? "bg-blue-600/15 text-blue-400 font-semibold"
                    : "text-foreground hover:bg-muted"
                )}
              >
                <span>{opt}</span>
                {isSelected && <Check className="size-3.5 text-blue-400" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
