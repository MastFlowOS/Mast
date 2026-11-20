import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  useAddSuppression,
  useCheckDomainDeliverability,
  useDeleteSuppression,
  useMe,
  useSaveSettings,
  useSettings,
  useSuppressions,
} from "@/hooks/use-mast-api";
import type { DomainCheckStatus, SuppressionKind, SuppressionSource } from "@/lib/api";

interface SafetyDeliverabilityCardProps {
  defaultSenderEmail?: string;
}

const SOURCE_LABELS: Record<SuppressionSource, string> = {
  manual: "Manual",
  bounce: "Bounced",
  unsubscribe: "Unsubscribed",
  reply_optout: "Opt-out Reply",
};

function StatusPill({ label, status }: { label: string; status: DomainCheckStatus }) {
  const styles =
    status === "pass"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
      : status === "warn"
        ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
        : "bg-red-500/10 text-red-300 border-red-500/30";
  const Icon = status === "pass" ? CheckCircle2 : status === "warn" ? AlertTriangle : XCircle;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${styles}`}>
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

export function SafetyDeliverabilityCard({ defaultSenderEmail }: SafetyDeliverabilityCardProps) {
  const { data: auth } = useMe();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const suppressionsQuery = useSuppressions(!!auth?.user);
  const addSuppression = useAddSuppression();
  const deleteSuppression = useDeleteSuppression();
  const domainCheck = useCheckDomainDeliverability();

  const [domainInput, setDomainInput] = useState(defaultSenderEmail ?? "");
  const [kind, setKind] = useState<SuppressionKind>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (defaultSenderEmail && !domainInput) {
      setDomainInput(defaultSenderEmail);
    }
  }, [defaultSenderEmail, domainInput]);

  const includeFooter = settings?.includeUnsubscribeFooter === "true";
  const suppressions = suppressionsQuery.data?.suppressions ?? [];

  const handleToggleFooter = async () => {
    const nextVal = includeFooter ? "false" : "true";
    try {
      await saveSettings.mutateAsync({ includeUnsubscribeFooter: nextVal });
      toast.success(
        nextVal === "true"
          ? "1-click unsubscribe footer turned on for outreach emails"
          : "1-click unsubscribe footer turned off",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update opt-out footer setting");
    }
  };

  const handleDomainCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = domainInput.trim();
    if (!target) {
      toast.error("Enter your sender email or domain first.");
      return;
    }
    try {
      await domainCheck.mutateAsync(target);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run domain check");
    }
  };

  const handleAddSuppression = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = value.trim();
    if (!clean) return;
    try {
      await addSuppression.mutateAsync({
        kind,
        value: clean,
        reason: reason.trim() || null,
      });
      setValue("");
      setReason("");
      toast.success("Added to Do-Not-Contact list");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add blocklist entry");
    }
  };

  const handleDeleteSuppression = async (id: string) => {
    try {
      await deleteSuppression.mutateAsync(id);
      toast.success("Removed from Do-Not-Contact list");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove entry");
    }
  };

  const report = domainCheck.data;

  return (
    <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm space-y-6">
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 grid place-items-center shrink-0">
          <ShieldCheck className="size-5" />
        </div>
        <div>
          <h2 className="text-base font-bold text-foreground">Deliverability &amp; Do-Not-Contact Safety</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Keep your sender domain out of spam folders and make sure nobody on your team messages opt-outs or blocked leads.
          </p>
        </div>
      </div>

      {/* 1. Domain Health Check */}
      <div className="rounded-xl border border-border/70 bg-background/60 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Sender Domain Check (SPF, DKIM, DMARC &amp; MX)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Test the email domain you send from to spot missing DNS records before launching campaigns.
          </p>
        </div>

        <form onSubmit={handleDomainCheck} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            placeholder="you@yourdomain.com or yourdomain.com"
            className="flex-1 bg-background border border-border/80 focus:border-amber-500 outline-none px-3.5 py-2 rounded-xl text-sm"
          />
          <button
            type="submit"
            disabled={domainCheck.isPending}
            className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
          >
            {domainCheck.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Check Domain Health
          </button>
        </form>

        {report && (
          <div className="space-y-3 pt-2 border-t border-border/50">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label={`MX: ${report.mx.status.toUpperCase()}`} status={report.mx.status} />
              <StatusPill label={`SPF: ${report.spf.status.toUpperCase()}`} status={report.spf.status} />
              <StatusPill label={`DMARC: ${report.dmarc.status.toUpperCase()}`} status={report.dmarc.status} />
              <StatusPill label={`DKIM: ${report.dkim.status.toUpperCase()}`} status={report.dkim.status} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-muted-foreground">
              <p><strong className="text-foreground">MX:</strong> {report.mx.detail}</p>
              <p><strong className="text-foreground">SPF:</strong> {report.spf.detail}</p>
              <p><strong className="text-foreground">DMARC:</strong> {report.dmarc.detail}</p>
              <p><strong className="text-foreground">DKIM:</strong> {report.dkim.detail}</p>
            </div>
          </div>
        )}
      </div>

      {/* 2. Optional 1-click unsubscribe footer */}
      <div className="rounded-xl border border-border/70 bg-background/60 p-4 flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-foreground">Add 1-Click Unsubscribe Footer to Emails</p>
          <p className="text-xs text-muted-foreground">
            Appends a clean opt-out link to outreach emails. Anyone who clicks it is automatically blocked across your workspace.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={includeFooter}
          disabled={saveSettings.isPending}
          onClick={handleToggleFooter}
          className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer ${
            includeFooter ? "bg-emerald-500" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
              includeFooter ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* 3. Do-Not-Contact Blocklist */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Ban className="size-4 text-red-400" />
            Do-Not-Contact Blocklist ({suppressions.length})
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Bounced addresses, 1-click unsubscribes, and opt-out replies are added here automatically. You can also block any email, domain, or Instagram handle manually.
          </p>
        </div>

        <form onSubmit={handleAddSuppression} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SuppressionKind)}
            className="sm:col-span-3 bg-background border border-border/80 outline-none px-3 py-2 rounded-xl text-sm"
          >
            <option value="email">Email</option>
            <option value="domain">Domain</option>
            <option value="instagram">Instagram</option>
          </select>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              kind === "email"
                ? "owner@company.com"
                : kind === "domain"
                  ? "company.com"
                  : "@brandhandle"
            }
            className="sm:col-span-4 bg-background border border-border/80 outline-none px-3 py-2 rounded-xl text-sm"
          />
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="sm:col-span-3 bg-background border border-border/80 outline-none px-3 py-2 rounded-xl text-sm"
          />
          <button
            type="submit"
            disabled={addSuppression.isPending || !value.trim()}
            className="sm:col-span-2 px-3 py-2 rounded-xl bg-red-600/90 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center justify-center gap-1 cursor-pointer"
          >
            {addSuppression.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Block
          </button>
        </form>

        {suppressions.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            Your blocklist is empty right now.
          </p>
        ) : (
          <div className="max-h-56 overflow-y-auto divide-y divide-border/50 rounded-xl border border-border/70 bg-background/50">
            {suppressions.map((item) => (
              <div key={item.id} className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="uppercase text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {item.kind}
                  </span>
                  <span className="font-medium text-foreground truncate">{item.value}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-border/70 text-muted-foreground">
                    {SOURCE_LABELS[item.source] ?? item.source}
                  </span>
                  {item.reason && (
                    <span className="text-muted-foreground truncate">— {item.reason}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteSuppression(item.id)}
                  disabled={deleteSuppression.isPending}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 cursor-pointer"
                  title="Remove from Do-Not-Contact"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
