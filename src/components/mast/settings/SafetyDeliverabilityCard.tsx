import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  MailCheck,
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
  reply_optout: "Said Stop",
};

function CheckBadge({
  name,
  meaning,
  status,
}: {
  name: string;
  meaning: string;
  status: DomainCheckStatus;
}) {
  const styles =
    status === "pass"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
      : status === "warn"
        ? "bg-amber-500/10 text-amber-300 border-amber-500/25"
        : "bg-red-500/10 text-red-300 border-red-500/25";
  const label = status === "pass" ? "Ready" : status === "warn" ? "Recommended" : "Missing";
  const Icon = status === "pass" ? CheckCircle2 : status === "warn" ? AlertTriangle : XCircle;

  return (
    <div className="rounded-xl border border-border/70 bg-background/60 p-3 flex items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold text-foreground">{name}</p>
        <p className="text-[11px] text-muted-foreground">{meaning}</p>
      </div>
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border shrink-0 ${styles}`}>
        <Icon className="size-3.5" />
        {label}
      </span>
    </div>
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

  useEffect(() => {
    if (defaultSenderEmail && !domainInput) {
      setDomainInput(defaultSenderEmail);
    }
  }, [defaultSenderEmail, domainInput]);

  const includeFooterFromSettings = settings?.includeUnsubscribeFooter === "true";
  const [includeFooter, setIncludeFooter] = useState(includeFooterFromSettings);
  useEffect(() => {
    setIncludeFooter(includeFooterFromSettings);
  }, [includeFooterFromSettings]);

  const suppressions = suppressionsQuery.data?.suppressions ?? [];

  const handleToggleFooter = async () => {
    const prev = includeFooter;
    const nextVal = prev ? "false" : "true";
    setIncludeFooter(!prev);
    try {
      await saveSettings.mutateAsync({
        settings: { includeUnsubscribeFooter: nextVal },
      });
      toast.success(nextVal === "true" ? "Unsubscribe link enabled" : "Unsubscribe link disabled");
    } catch (err) {
      setIncludeFooter(prev);
      toast.error(err instanceof Error ? err.message : "Could not update setting");
    }
  };

  const handleDomainCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = domainInput.trim();
    if (!target) {
      toast.error("Enter your email or domain first.");
      return;
    }
    try {
      await domainCheck.mutateAsync(target);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check domain");
    }
  };

  const handleAddSuppression = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = value.trim();
    if (!clean) return;
    try {
      await addSuppression.mutateAsync({ kind, value: clean });
      setValue("");
      toast.success("Added to Do-Not-Contact list");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add entry");
    }
  };

  const handleDeleteSuppression = async (id: string) => {
    try {
      await deleteSuppression.mutateAsync(id);
      toast.success("Removed from list");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove entry");
    }
  };

  const report = domainCheck.data;

  return (
    <div className="space-y-6">
      {/* 1. Email Domain Health Check */}
      <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 grid place-items-center shrink-0">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Email Domain Check</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Checks if your domain is properly verified so cold emails land in the inbox, not spam.
            </p>
          </div>
        </div>

        <form onSubmit={handleDomainCheck} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            placeholder="you@yourdomain.com"
            className="flex-1 bg-background border border-border/80 focus:border-blue-500 outline-none px-3.5 py-2 rounded-xl text-sm"
          />
          <button
            type="submit"
            disabled={domainCheck.isPending}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
          >
            {domainCheck.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Check Domain
          </button>
        </form>

        {report && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
            <CheckBadge name="MX (Receiving)" meaning="Can receive replies" status={report.mx.status} />
            <CheckBadge name="SPF (Sending)" meaning="Proves you can send" status={report.spf.status} />
            <CheckBadge name="DKIM (Signature)" meaning="Verifies your emails" status={report.dkim.status} />
            <CheckBadge name="DMARC (Protection)" meaning="Protects domain trust" status={report.dmarc.status} />
          </div>
        )}
      </div>

      {/* 2. Unsubscribe Link Toggle */}
      <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm flex items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 grid place-items-center shrink-0">
            <MailCheck className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Unsubscribe Link</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Adds a 1-click opt-out link to your emails. Anyone who clicks it is blocked automatically.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={includeFooter}
          disabled={saveSettings.isPending}
          onClick={handleToggleFooter}
          className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors cursor-pointer ${
            includeFooter ? "bg-blue-600" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
              includeFooter ? "translate-x-5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* 3. Do-Not-Contact List */}
      <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 grid place-items-center shrink-0">
            <Ban className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">
              Do-Not-Contact List ({suppressions.length})
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Nobody on your team can email or DM anyone on this list. Bounces and opt-outs are added here automatically.
            </p>
          </div>
        </div>

        <form onSubmit={handleAddSuppression} className="flex flex-col sm:flex-row gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SuppressionKind)}
            className="sm:w-36 bg-background border border-border/80 outline-none px-3 py-2 rounded-xl text-sm"
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
                  : "@handle"
            }
            className="flex-1 bg-background border border-border/80 outline-none px-3.5 py-2 rounded-xl text-sm"
          />
          <button
            type="submit"
            disabled={addSuppression.isPending || !value.trim()}
            className="px-4 py-2 rounded-xl bg-red-600/90 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
          >
            {addSuppression.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Block
          </button>
        </form>

        {suppressions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No blocked contacts yet.</p>
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
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteSuppression(item.id)}
                  disabled={deleteSuppression.isPending}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 cursor-pointer"
                  title="Remove"
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
