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
import { useMe, useSaveSettings, useSettings } from "@/hooks/use-mast-api";

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

  // Modals
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // Change Password state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");

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

    // Parse stored regions (comma-separated)
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

  const save = async () => {
    try {
      await saveSettings.mutateAsync({
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
      });
      toast.success("Settings saved");
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

      {/* ── Google / Gmail Integration ──────────────────────────────────── */}
      <GmailIntegration />

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

      {/* ── Billing ─────────────────────────────────────────────────────── */}
      <SectionCard
        icon={CreditCard}
        title="Billing"
        desc="Manage subscriptions, invoices, and plan access"
      >
        <SettingsLink
          to="/dashboard/subscription"
          label="Subscription"
          desc="Review your plan, limits, and upgrade options"
        />
        <SettingsLink
          to="/dashboard/billing"
          label="Billing"
          desc="View billing details and payment history"
        />
      </SectionCard>

      {/* ── Data Import / Export ────────────────────────────────────────── */}
      <SectionCard
        icon={Upload}
        title="Data Import / Export"
        desc="Move opportunity data into and out of Mast"
      >
        <SettingsLink
          to="/dashboard/import"
          label="Open Data Import / Export"
          desc="Upload CSVs, map fields, and export relationship data"
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
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400">
              <span className="size-2 rounded-full bg-emerald-400 shrink-0" />
              Active
            </span>
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
          {/* Disable Workspace */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background p-4">
            <div>
              <p className="text-sm font-semibold">Disable Workspace</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Temporarily disable your workspace. This is reversible.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowDisableModal(true)}
              className="shrink-0 px-4 py-2 rounded-lg border border-orange-500/40 text-orange-400 text-sm font-semibold hover:bg-orange-500/10 transition-colors inline-flex items-center gap-2"
            >
              <Power className="size-4" />
              Disable
            </button>
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

      {/* ── Disable Modal ────────────────────────────────────────────────── */}
      {showDisableModal && (
        <Modal
          onClose={() => setShowDisableModal(false)}
          title="Disable Workspace?"
          icon={<Power className="size-5 text-orange-400" />}
          iconBg="bg-orange-500/10 border-orange-500/20"
        >
          <p className="text-sm text-muted-foreground">
            Your workspace will be temporarily disabled. All data is preserved
            and you can re-enable it at any time from your account.
          </p>
          <div className="mt-5 flex gap-3 justify-end">
            <button
              onClick={() => setShowDisableModal(false)}
              className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setShowDisableModal(false);
                toast.success("Workspace disabled. You can re-enable it from your account.");
              }}
              className="px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 transition-colors"
            >
              Disable Workspace
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
          <div className="mt-4">
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
          <div className="mt-5 flex gap-3 justify-end">
            <button
              onClick={() => {
                setShowDeleteModal(false);
                setDeleteConfirm("");
              }}
              className="px-4 py-2 rounded-lg border border-border text-sm font-semibold hover:bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={deleteConfirm !== "DELETE"}
              onClick={() => {
                setShowDeleteModal(false);
                setDeleteConfirm("");
                toast.error("Workspace deleted. Redirecting…");
              }}
              className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-40"
            >
              Delete Workspace
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

// ─── Gmail / Google Integration ───────────────────────────────────────────────

function GmailIntegration() {
  return (
    <div className="bg-card border border-border rounded-2xl p-6">
      <div className="flex items-start gap-4">
        <div className="size-11 rounded-xl bg-background border border-border grid place-items-center shrink-0">
          <GoogleIcon />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-bold flex items-center gap-2">
              Google Integration
              <span className="text-[10px] font-bold uppercase tracking-wider bg-brand/15 text-brand px-2 py-0.5 rounded border border-brand/20">
                Gmail
              </span>
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">
            Connect Gmail to send outreach from your own inbox. Used for sender
            identity, SMTP relay, and outreach automation.
          </p>

          {/* Status row */}
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-3">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Status
              </p>
              <p className="mt-0.5 text-sm font-semibold text-muted-foreground">
                Not Connected
              </p>
            </div>
            <button
              type="button"
              disabled
              className="shrink-0 px-4 py-2 rounded-lg bg-foreground/10 text-foreground/40 text-sm font-semibold inline-flex items-center gap-2 cursor-not-allowed border border-border"
            >
              <GoogleIcon />
              Connect Gmail
              <span className="ml-1 text-[9px] font-bold uppercase tracking-wider bg-muted-foreground/20 text-muted-foreground px-1.5 py-0.5 rounded">
                Soon
              </span>
            </button>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            Gmail integration is coming soon. We'll notify you when it's ready.
          </p>
        </div>
      </div>
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
          <Icon className="size-4 text-brand" />
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
      className={`flex w-full items-center justify-between gap-3 ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm">{label}</span>
        {comingSoon && <ComingSoonBadge />}
      </div>
      <div
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${on ? "bg-brand" : "bg-border"}`}
      >
        <span
          className={`absolute top-0.5 size-5 bg-background rounded-full transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`}
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
          <Icon className="size-4 text-brand" />
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

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.8-2 13.3-5.2l-6.2-5.2C29.1 35 26.7 36 24 36c-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.1 4-3.9 5.3l6.2 5.2C41 35 44 30 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}
