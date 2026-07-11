import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, MoreVertical, Check, Loader2, Archive, Trash2, Copy, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateLead, useRecordLeadActivity, useUpdateLead } from "@/hooks/use-mast-api";
import type { Lead, LeadStatus } from "@/lib/api";
import { LEAD_STATUSES, isRelationshipLead, leadStatusColor, leadStatusLabel, normalizeLeadStatus } from "@/lib/lead-workspace";

type ConfirmAction = "archive" | "delete" | null;

export function LeadWorkspaceHeader({ lead }: { lead: Lead }) {
  const navigate = useNavigate();
  const recordActivity = useRecordLeadActivity();
  const createLead = useCreateLead();
  const updateLeadMutation = useUpdateLead();
  const [saved, setSaved] = useState(isRelationshipLead(lead));
  const [status, setStatus] = useState<LeadStatus>(normalizeLeadStatus(lead.status));
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPending, setMenuPending] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSaved(isRelationshipLead(lead));
    setStatus(normalizeLeadStatus(lead.status));
  }, [lead.status, lead.userId, lead.source, lead.lastContactedAt]);

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
          content: "Opportunity added to pipeline",
          metadata: { saved: true },
        },
        patch: { status },
      });
      setSaved(true);
      toast.success(`${lead.businessName} added to pipeline`);
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
    setConfirmAction(null);
    setMenuPending("archive");
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "status_changed",
          content: "Opportunity closed — no further action",
          metadata: { from: status, to: "dead" },
        },
        patch: { status: "dead" },
      });
      setStatus("dead");
      toast.success(`${lead.businessName} closed out`);
    } catch {
      toast.error("Action failed — please try again");
    } finally {
      setMenuPending(null);
    }
  };

  const handleDelete = async () => {
    setConfirmAction(null);
    setMenuPending("delete");
    try {
      await updateLeadMutation.mutateAsync({ id: lead.id, body: { status: "dead" } });
      toast.success("Opportunity removed");
      navigate({ to: "/dashboard/pipeline" });
    } catch {
      toast.error("Action failed — please try again");
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
          onClick={() => navigate({ to: "/dashboard/pipeline" })}
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
            <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-xl border border-border bg-card shadow-xl animate-scale-in-fast">
              <div className="p-1">
                <MenuAction
                  icon={Archive}
                  label="Close Opportunity"
                  onClick={() => { setMenuOpen(false); setConfirmAction("archive"); }}
                  description="Mark as no longer active"
                />
                <MenuAction
                  icon={Copy}
                  label="Duplicate"
                  onClick={handleDuplicate}
                  description="Create a copy of this opportunity"
                />
                <div className="my-1 h-px bg-border" />
                <MenuAction
                  icon={Trash2}
                  label="Remove"
                  onClick={() => { setMenuOpen(false); setConfirmAction("delete"); }}
                  description="Permanently remove"
                  danger
                />
              </div>
            </div>
          )}

          {/* Inline Confirmation Dialog */}
          {confirmAction && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
              <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-5 animate-scale-in">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="size-10 rounded-xl bg-destructive/10 border border-destructive/20 grid place-items-center">
                      <AlertTriangle className="size-5 text-destructive" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">
                        {confirmAction === "archive" ? "Close this opportunity?" : "Remove this opportunity?"}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {confirmAction === "archive"
                          ? "It will be marked inactive. You can reopen it from your pipeline."
                          : "This is permanent and cannot be undone."}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setConfirmAction(null)}
                    className="p-1 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setConfirmAction(null)}
                    className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium hover:bg-muted transition-colors"
                  >
                    Keep it
                  </button>
                  <button
                    onClick={confirmAction === "archive" ? handleArchive : handleDelete}
                    className="flex-1 py-2.5 rounded-xl bg-destructive text-white text-sm font-semibold hover:bg-destructive/90 transition-colors"
                  >
                    {confirmAction === "archive" ? "Close" : "Remove"}
                  </button>
                </div>
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
            <><Check className="size-4 mr-1.5" /> Saved</>
          ) : (
            "Save to Relationships"
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
