import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Star,
  Bookmark,
  Send,
  Loader2,
  Archive,
  Trash2,
  Copy,
  AlertTriangle,
  X,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCreateLead, useRecordLeadActivity, useUpdateLead, useLeads } from "@/hooks/use-mast-api";
import { ApiError, type Lead, type LeadStatus } from "@/lib/api";
import { isRelationshipLead, normalizeLeadStatus } from "@/lib/lead-workspace";

type ConfirmAction = "archive" | "delete" | null;

export function LeadWorkspaceHeader({ lead }: { lead: Lead }) {
  const navigate = useNavigate();
  const recordActivity = useRecordLeadActivity();
  const createLead = useCreateLead();
  const updateLeadMutation = useUpdateLead();
  const { data: allLeads } = useLeads();

  const [saved, setSaved] = useState(isRelationshipLead(lead));
  const [status, setStatus] = useState<LeadStatus>(normalizeLeadStatus(lead.status));
  const [isStarred, setIsStarred] = useState(lead.priority === "high");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPending, setMenuPending] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSaved(isRelationshipLead(lead));
    setStatus(normalizeLeadStatus(lead.status));
    setIsStarred(lead.priority === "high");
  }, [lead.status, lead.userId, lead.source, lead.lastContactedAt, lead.priority]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  // Lead switcher pagination
  const leadList = Array.isArray(allLeads) ? allLeads : [];
  const currentIndex = leadList.findIndex((item) => item.id === lead.id);
  const displayIndex = currentIndex >= 0 ? currentIndex + 1 : 1;
  const totalCount = leadList.length > 0 ? leadList.length : 1;

  const handlePrevLead = () => {
    if (currentIndex > 0) {
      const prevId = leadList[currentIndex - 1].id;
      navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(prevId) } });
    }
  };

  const handleNextLead = () => {
    if (currentIndex >= 0 && currentIndex < leadList.length - 1) {
      const nextId = leadList[currentIndex + 1].id;
      navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(nextId) } });
    }
  };

  const toggleStar = async () => {
    const nextStarred = !isStarred;
    const nextPriority = nextStarred ? "high" : "normal";
    setIsStarred(nextStarred);
    try {
      await updateLeadMutation.mutateAsync({ id: lead.id, body: { priority: nextPriority } });
      toast.success(nextStarred ? "Opportunity starred" : "Opportunity unstarred");
    } catch {
      setIsStarred(!nextStarred);
      toast.error("Could not update star status");
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
          content: `Status changed to ${nextStatus}`,
          metadata: { from: previousStatus, to: nextStatus },
        },
        patch: { status: nextStatus },
      });
      toast.success("Lead status updated");
    } catch (error) {
      setStatus(previousStatus);
      toast.error(error instanceof ApiError ? error.message : "Failed to update status");
    }
  };

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
      toast.success(`${lead.businessName} saved to pipeline`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to update lead");
    }
  };

  const handleMarkAsSent = async () => {
    const sentAt = new Date().toISOString();
    try {
      await recordActivity.mutateAsync({
        lead,
        activity: {
          type: "email_sent",
          channel: "email",
          timestamp: sentAt,
          content: "Marked as sent from workspace header",
        },
        patch: { status: "email_sent", lastContactedAt: sentAt },
      });
      setStatus("email_sent");
      toast.success("Opportunity marked as sent");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to mark as sent");
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
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Action failed — please try again");
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
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Action failed — please try again");
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
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to duplicate lead");
    } finally {
      setMenuPending(null);
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-[#0b0f17] px-4 backdrop-blur-xl sticky top-0 z-20 select-none lg:px-6">
      {/* Left: Back button + Pagination */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate({ to: "/dashboard/pipeline" })}
          className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-card hover:text-white"
        >
          <ArrowLeft className="size-3.5 text-muted-foreground" />
          <span>Back to leads</span>
        </button>

        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/30 px-2 py-1 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={handlePrevLead}
            disabled={currentIndex <= 0}
            className="p-0.5 rounded hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground transition-colors"
            title="Previous lead"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="font-mono text-xs text-foreground px-1.5">
            {displayIndex} / {totalCount}
          </span>
          <button
            type="button"
            onClick={handleNextLead}
            disabled={currentIndex < 0 || currentIndex >= leadList.length - 1}
            className="p-0.5 rounded hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground transition-colors"
            title="Next lead"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Right: Star + Save + Mark as sent + More */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleStar}
          className={`size-8 rounded-lg border border-border/60 bg-card/40 grid place-items-center transition-colors ${
            isStarred ? "text-amber-400 border-amber-500/40 bg-amber-500/10" : "text-muted-foreground hover:text-foreground"
          }`}
          title={isStarred ? "Starred lead" : "Star lead"}
        >
          <Star className={`size-4 ${isStarred ? "fill-amber-400" : ""}`} />
        </button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleSaveToCRM}
          disabled={recordActivity.isPending || saved}
          className="h-8 gap-1.5 border-border/60 bg-card/40 text-xs font-medium hover:bg-card text-foreground"
        >
          {saved ? <Check className="size-3.5 text-emerald-400" /> : <Bookmark className="size-3.5 text-muted-foreground" />}
          <span>{saved ? "Saved" : "Save"}</span>
        </Button>

        <Button
          size="sm"
          onClick={handleMarkAsSent}
          disabled={recordActivity.isPending || status === "email_sent"}
          className="h-8 gap-1.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white text-xs font-medium px-3.5 rounded-lg shadow-sm shadow-indigo-500/25 transition-all"
        >
          <Send className="size-3.5" />
          <span>{status === "email_sent" ? "Sent" : "Mark as sent"}</span>
        </Button>

        {/* Three-dot dropdown menu */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={menuPending !== null}
            className="size-8 rounded-lg border border-border/60 bg-card/40 grid place-items-center text-muted-foreground hover:text-foreground transition-colors"
            title="More actions"
          >
            {menuPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MoreVertical className="size-3.5" />
            )}
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-xl border border-border bg-[#101726] shadow-2xl animate-scale-in-fast">
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
                <div className="my-1 h-px bg-border/60" />
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
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
              <div className="w-full max-w-sm rounded-2xl border border-border bg-[#101726] p-6 shadow-2xl space-y-5 animate-scale-in">
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
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 ${
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
