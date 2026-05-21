import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Mail } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useGoogleLogin, useMe, useSaveSettings, useSettings } from "@/hooks/use-mast-api";

export const Route = createFileRoute("/dashboard/settings")({
  head: () => ({ meta: [{ title: "Settings — Mast" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { data: auth } = useMe();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const googleLogin = useGoogleLogin();
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    workspaceName: "",
    defaultRegion: "United States",
    notifyNewLead: "true",
    notifyReplies: "true",
    notifyWeeklySummary: "false",
    senderName: "",
    senderEmail: "",
    signature: "",
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      fullName: auth?.user?.fullName ?? current.fullName,
      email: auth?.user?.email ?? current.email,
      workspaceName: settings?.workspaceName ?? current.workspaceName,
      defaultRegion: settings?.defaultRegion ?? current.defaultRegion,
      notifyNewLead: settings?.notifyNewLead ?? current.notifyNewLead,
      notifyReplies: settings?.notifyReplies ?? current.notifyReplies,
      notifyWeeklySummary: settings?.notifyWeeklySummary ?? current.notifyWeeklySummary,
      senderName: settings?.senderName ?? auth?.user?.fullName ?? current.senderName,
      senderEmail: settings?.senderEmail ?? auth?.user?.email ?? current.senderEmail,
      signature: settings?.signature ?? current.signature,
    }));
  }, [auth?.user, settings]);

  const update = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    try {
      await saveSettings.mutateAsync({
        workspaceName: form.workspaceName,
        defaultRegion: form.defaultRegion,
        notifyNewLead: form.notifyNewLead,
        notifyReplies: form.notifyReplies,
        notifyWeeklySummary: form.notifyWeeklySummary,
        senderName: form.senderName,
        senderEmail: form.senderEmail,
        signature: form.signature,
      });
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save settings");
    }
  };

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your workspace, account, and outreach identity.</p>
      </div>

      <Card title="Profile" desc="Update your personal info">
        <Field label="Full name" value={form.fullName} onChange={(value) => update("fullName", value)} disabled />
        <Field label="Email" value={form.email} onChange={(value) => update("email", value)} disabled />
      </Card>

      <Card title="Workspace" desc="Visible to your team">
        <Field label="Workspace name" value={form.workspaceName} onChange={(value) => update("workspaceName", value)} />
        <Field label="Default region" value={form.defaultRegion} onChange={(value) => update("defaultRegion", value)} />
      </Card>

      <GoogleIntegration
        connecting={googleLogin.isPending}
        onConnect={async () => {
          try {
            await googleLogin.mutateAsync();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : "Google auth is not configured");
          }
        }}
        senderEmail={form.senderEmail || auth?.user?.email || ""}
      />

      <Card title="Sender Identity" desc="Used by outreach email and message generation">
        <Field label="Sender name" value={form.senderName} onChange={(value) => update("senderName", value)} />
        <Field label="Sender email" value={form.senderEmail} onChange={(value) => update("senderEmail", value)} />
        <label className="block">
          <span className="block text-xs font-semibold text-muted-foreground mb-1.5">Signature</span>
          <textarea
            value={form.signature}
            onChange={(event) => update("signature", event.target.value)}
            className="min-h-24 w-full bg-background border border-border focus:border-brand outline-none px-3.5 py-2.5 rounded-lg text-sm"
          />
        </label>
      </Card>

      <Card title="Notifications" desc="Choose what we email you about">
        <Toggle label="New lead delivered" on={form.notifyNewLead === "true"} onChange={(checked) => update("notifyNewLead", checked ? "true" : "false")} />
        <Toggle label="Outreach replies" on={form.notifyReplies === "true"} onChange={(checked) => update("notifyReplies", checked ? "true" : "false")} />
        <Toggle label="Weekly summary" on={form.notifyWeeklySummary === "true"} onChange={(checked) => update("notifyWeeklySummary", checked ? "true" : "false")} />
      </Card>

      <button
        onClick={save}
        disabled={saveSettings.isPending}
        className="px-5 py-2.5 rounded-lg bg-brand text-brand-foreground text-sm font-semibold shadow-brand hover:bg-brand-dark disabled:opacity-60"
      >
        {saveSettings.isPending ? "Saving..." : "Save settings"}
      </button>

      <Card title="Danger Zone" desc="Irreversible actions" danger>
        <button className="px-4 py-2 rounded-lg border border-destructive/40 text-destructive text-sm font-semibold hover:bg-destructive/10">
          Delete workspace
        </button>
      </Card>
    </div>
  );
}

function GoogleIntegration({
  connecting,
  onConnect,
  senderEmail,
}: {
  connecting: boolean;
  onConnect: () => void;
  senderEmail: string;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="size-11 rounded-xl bg-background border border-border grid place-items-center shrink-0">
            <GoogleIcon />
          </div>
          <div>
            <h2 className="font-bold flex items-center gap-2">
              Google Account
              <span className="text-[10px] font-bold uppercase tracking-wider bg-brand/15 text-brand px-2 py-0.5 rounded border border-brand/20">
                Outreach
              </span>
            </h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Connect Gmail to send outreach from your own inbox. Used for sender identity, SMTP relay, and outreach automation.
            </p>
          </div>
        </div>
        <button
          onClick={onConnect}
          disabled={connecting}
          className="shrink-0 px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:bg-foreground/90 inline-flex items-center gap-2 disabled:opacity-60"
        >
          <GoogleIcon />
          {connecting ? "Connecting..." : "Connect"}
        </button>
      </div>

      <div className="mt-5 grid sm:grid-cols-2 gap-3 text-sm">
        <Capability icon={Mail} label="Sender identity" desc={senderEmail ? `Send from ${senderEmail}` : "Use your saved sender email"} />
        <Capability icon={CheckCircle2} label="SMTP relay" desc="High-deliverability sending" />
      </div>

      <div className="mt-4 rounded-xl border border-dashed border-border bg-background/40 p-4">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Outreach automation</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Once connected, Mast can auto-send sequences, track opens & replies, and pause on response — all from your Google account.
        </p>
      </div>
    </div>
  );
}

function Capability({
  icon: Icon,
  label,
  desc,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-3 flex items-start gap-3">
      <div className="size-8 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center shrink-0">
        <Icon className="size-4 text-brand" />
      </div>
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
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

function Card({
  title,
  desc,
  children,
  danger,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className={`bg-card border ${danger ? "border-destructive/30" : "border-border"} rounded-2xl p-6`}>
      <h2 className="font-bold">{title}</h2>
      <p className="text-xs text-muted-foreground mt-1">{desc}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-muted-foreground mb-1.5">{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full bg-background border border-border focus:border-brand outline-none px-3.5 py-2.5 rounded-lg text-sm disabled:opacity-60"
      />
    </label>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex w-full items-center justify-between">
      <span className="text-sm">{label}</span>
      <div className={`relative w-11 h-6 rounded-full ${on ? "bg-brand" : "bg-border"}`}>
        <span className={`absolute top-0.5 size-5 bg-background rounded-full ${on ? "translate-x-5" : "translate-x-0.5"}`} />
      </div>
    </button>
  );
}
