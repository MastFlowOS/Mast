import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, MoreVertical, Check, Loader2, Archive, Trash2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateLead, useRecordLeadActivity, useUpdateLead } from "@/hooks/use-mast-api";
import type { Lead, LeadStatus } from "@/lib/api";
import { LEAD_STATUSES, leadStatusColor, leadStatusLabel, normalizeLeadStatus } from "@/lib/lead-workspace";

export function LeadWorkspaceHeader({ lead }: { lead: Lead }) {
  const navigate = useNavigate();
  const recordActivity = useRecordLeadActivity();
  const createLead = useCreateLead();
  const updateLeadMutation = useUpdateLead();
  const [saved, setSaved] = useState(Boolean(lead.userId) || lead.status === "crm");
  const [status, setStatus] = useState<LeadStatus>(normalizeLeadStatus(lead.status));
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPending, setMenuPending] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSaved(Boolean(lead.userId) || lead.status === "crm");
    setStatus(normalizeLeadStatus(lead.status));
  }, [lead.status, lead.userId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const handleSaveToCRM = async () => {
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "status_changed",
          content: "Lead saved to CRM",
          metadata: { saved: true },
        },
        patch: { status },
      });
      setSaved(true);
      toast.success(`${lead.businessName} saved to CRM`);
    } catch {
      toast.error("Failed to update lead");
    }
  };

  const handleStatusChange = async (nextStatus: LeadStatus) => {
    if (nextStatus === status) return;
    const previousStatus = status;
    setStatus(nextStatus);

    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "status_changed",
          content: `Status changed from ${leadStatusLabel(previousStatus)} to ${leadStatusLabel(nextStatus)}`,
          metadata: { from: previousStatus, to: nextStatus },
        },
        patch: { status: nextStatus },
      });
      toast.success("Lead status updated");
    } catch {
      setStatus(previousStatus);
      toast.error("Failed to update status");
    }
  };

  const handleArchive = async () => {
    setMenuOpen(false);
    const ok = window.confirm(`Archive ${lead.businessName}? This will mark them as Dead.`);
    if (!ok) return;
    setMenuPending("archive");
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "status_changed",
          content: "Lead archived",
          metadata: { from: status, to: "dead" },
        },
        patch: { status: "dead" },
      });
      setStatus("dead");
      toast.success(`${lead.businessName} archived`);
    } catch {
      toast.error("Failed to archive lead");
    } finally {
      setMenuPending(null);
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    const ok = window.confirm(`Permanently delete ${lead.businessName}? This cannot be undone.`);
    if (!ok) return;
    setMenuPending("delete");
    try {
      await updateLeadMutation.mutateAsync({ id: lead.id, body: { status: "dead" } });
      toast.success("Lead deleted");
      navigate({ to: "/dashboard/crm" });
    } catch {
      toast.error("Failed to delete lead");
    } finally {
      setMenuPending(null);
    }
  };

  const handleDuplicate = async () => {
    setMenuOpen(false);
    setMenuPending("duplicate");
    try {
      const dup = await createLead.mutateAsync({
        businessName: `${lead.businessName} (copy)`,
        instagramHandle: lead.instagramHandle ?? undefined,
        email: lead.email ?? undefined,
        website: lead.website ?? undefined,
        phone: lead.phone ?? undefined,
        niche: lead.niche ?? undefined,
        location: lead.location ?? undefined,
        source: lead.source ?? "manual",
      });
      toast.success("Lead duplicated");
      navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(dup.id) } });
    } catch {
      toast.error("Failed to duplicate lead");
    } finally {
      setMenuPending(null);
    }
  };

  const statusColor = leadStatusColor(status);
  const initials =
    lead.businessName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "L";

  return (
    <header className="flex min-h-16 flex-col items-stretch justify-between gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur-xl sticky top-0 z-20 sm:flex-row sm:items-center lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          onClick={() => navigate({ to: "/dashboard/crm" })}
          className="p-2 hover:bg-card rounded-lg transition-colors text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-5" />
        </button>

        <div className="size-9 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center text-sm font-bold text-brand shrink-0">
          {initials}
        </div>

        <div className="min-w-0">
          <h1 className="truncate font-semibold text-base leading-tight">{lead.businessName}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-0.5">
            <span className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${statusColor}`}>
              {leadStatusLabel(status)}
            </span>
            {lead.niche && (
              <span className="truncate text-xs text-muted-foreground">{lead.niche}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select value={status} onValueChange={(value) => void handleStatusChange(value as LeadStatus)}>
          <SelectTrigger className="h-9 w-full bg-card text-xs sm:w-[164px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEAD_STATUSES.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Three-dot menu */}
        <div ref={menuRef} className="relative">
          <Button
            variant="outline"
            size="icon"
            className="hover:bg-card"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={menuPending !== null}
          >
            {menuPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreVertical className="size-4" />
            )}
          </Button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-border bg-card shadow-lg">
              <div className="p-1">
                <MenuAction
                  icon={Archive}
                  label="Archive Lead"
                  onClick={handleArchive}
                  description="Mark as Dead"
                />
                <MenuAction
                  icon={Copy}
                  label="Duplicate Lead"
                  onClick={handleDuplicate}
                  description="Create a copy"
                />
                <div className="my-1 h-px bg-border" />
                <MenuAction
                  icon={Trash2}
                  label="Delete Lead"
                  onClick={handleDelete}
                  description="Permanent removal"
                  danger
                />
              </div>
            </div>
          )}
        </div>

        <Button
          onClick={handleSaveToCRM}
          disabled={recordActivity.isPending || saved}
          className={saved ? "bg-success/15 border border-success/30 text-success hover:bg-success/15" : "bg-brand hover:bg-brand/90 text-brand-foreground shadow-brand"}
        >
          {recordActivity.isPending ? (
            <><Loader2 className="size-4 mr-1.5 animate-spin" /> Saving…</>
          ) : saved ? (
            <><Check className="size-4 mr-1.5" /> In CRM</>
          ) : (
            "Save to CRM"
          )}
        </Button>
      </div>
    </header>
  );
}

function MenuAction({
  icon: Icon,
  label,
  description,
  onClick,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60 ${
        danger ? "text-destructive" : "text-foreground"
      }`}
    >
      <Icon className={`size-4 shrink-0 ${danger ? "text-destructive" : "text-muted-foreground"}`} />
      <div>
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
