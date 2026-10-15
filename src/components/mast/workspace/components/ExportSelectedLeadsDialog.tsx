import { useEffect, useMemo, useState } from "react";
import { Download, Search, X, Check, FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Lead } from "@/lib/api";
import { exportLeadsAsCSV } from "@/lib/leadExport";
import { cn } from "@/lib/utils";

interface ExportSelectedLeadsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentLead: Lead;
  candidateLeads: Lead[];
  collectionLabel?: string;
}

export function ExportSelectedLeadsDialog({
  isOpen,
  onClose,
  currentLead,
  candidateLeads,
  collectionLabel = "collection",
}: ExportSelectedLeadsDialogProps) {
  // Ensure the list of candidates always includes currentLead even if candidateLeads is empty
  const allCandidates = useMemo(() => {
    const list = candidateLeads && candidateLeads.length > 0 ? candidateLeads : [currentLead];
    const exists = list.some((l) => l.id === currentLead.id);
    if (!exists) {
      return [currentLead, ...list];
    }
    // Put current lead first for immediate clarity
    return [
      currentLead,
      ...list.filter((l) => l.id !== currentLead.id),
    ];
  }, [candidateLeads, currentLead]);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set([currentLead.id]));
  const [searchTerm, setSearchTerm] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  // Reset selection to preselect current lead when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set([currentLead.id]));
      setSearchTerm("");
      setIsExporting(false);
    }
  }, [isOpen, currentLead.id]);

  // Handle escape key to cancel
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Filter candidates based on search
  const filteredCandidates = useMemo(() => {
    if (!searchTerm.trim()) return allCandidates;
    const term = searchTerm.toLowerCase().trim();
    return allCandidates.filter((l) => {
      const name = (l.businessName || "").toLowerCase();
      const email = (l.email || "").toLowerCase();
      const ig = (l.instagramHandle || "").toLowerCase();
      const niche = (l.niche || "").toLowerCase();
      const loc = (l.location || "").toLowerCase();
      return (
        name.includes(term) ||
        email.includes(term) ||
        ig.includes(term) ||
        niche.includes(term) ||
        loc.includes(term)
      );
    });
  }, [allCandidates, searchTerm]);

  const allFilteredSelected =
    filteredCandidates.length > 0 &&
    filteredCandidates.every((lead) => selectedIds.has(lead.id));

  const handleToggleSelectAll = () => {
    if (allFilteredSelected) {
      // Unselect all currently filtered
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const lead of filteredCandidates) {
          next.delete(lead.id);
        }
        return next;
      });
    } else {
      // Select all currently filtered
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const lead of filteredCandidates) {
          next.add(lead.id);
        }
        return next;
      });
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleToggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleExport = () => {
    if (selectedIds.size === 0) return;

    setIsExporting(true);
    try {
      const leadsToExport = allCandidates.filter((lead) => selectedIds.has(lead.id));

      if (leadsToExport.length === 0) {
        toast.error("No valid leads found in selection");
        setIsExporting(false);
        return;
      }

      exportLeadsAsCSV(leadsToExport);
      toast.success(
        `Exported ${leadsToExport.length} lead${leadsToExport.length === 1 ? "" : "s"} to CSV`,
      );
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to export selected leads",
      );
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-[#101726] p-6 shadow-2xl flex flex-col max-h-[85vh] animate-scale-in">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-brand/10 border border-brand/20 grid place-items-center">
              <FileSpreadsheet className="size-5 text-brand" />
            </div>
            <div>
              <h2 id="export-dialog-title" className="font-semibold text-base text-foreground">
                Export Selected Leads
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Choose leads from your {collectionLabel} to export as CSV.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close export dialog"
            className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search & Selection Controls */}
        <div className="pt-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search leads by name, email, niche, or location..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-xl border border-border/70 bg-background/50 pl-9 pr-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand transition-colors"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between text-xs px-1 text-muted-foreground">
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all-candidates"
                aria-label="Select all"
                checked={allFilteredSelected}
                onCheckedChange={handleToggleSelectAll}
                className="data-[state=checked]:bg-brand data-[state=checked]:border-brand"
              />
              <label
                htmlFor="select-all-candidates"
                className="cursor-pointer font-medium text-foreground select-none"
              >
                Select all {filteredCandidates.length > 0 ? `(${filteredCandidates.length})` : ""}
              </label>
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline ml-2 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <div data-testid="selected-count-label" className="font-mono text-[11px] text-muted-foreground">
              <span className="text-foreground font-semibold">{selectedIds.size}</span> of{" "}
              {allCandidates.length} selected
            </div>
          </div>
        </div>

        {/* Scrollable Candidates List */}
        <div className="flex-1 min-h-[160px] max-h-[320px] overflow-y-auto my-3 space-y-1.5 pr-1 border rounded-xl border-border/40 p-2 bg-[#090D18]/50">
          {filteredCandidates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-xs text-muted-foreground">No leads match your search.</p>
            </div>
          ) : (
            filteredCandidates.map((lead) => {
              const isCurrent = lead.id === currentLead.id;
              const isSelected = selectedIds.has(lead.id);

              return (
                <div
                  key={lead.id}
                  onClick={() => handleToggleOne(lead.id)}
                  className={cn(
                    "flex items-center gap-3 p-2.5 rounded-lg border transition-all cursor-pointer select-none",
                    isSelected
                      ? "border-brand/40 bg-brand/5 hover:bg-brand/10"
                      : "border-border/40 bg-card/20 hover:bg-card/40 hover:border-border/70",
                    isCurrent && !isSelected && "border-indigo-500/30",
                  )}
                >
                  <Checkbox
                    id={`lead-${lead.id}`}
                    aria-label={`Select ${lead.businessName}`}
                    checked={isSelected}
                    onCheckedChange={() => handleToggleOne(lead.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="data-[state=checked]:bg-brand data-[state=checked]:border-brand shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground truncate">
                        {lead.businessName}
                      </span>
                      {isCurrent && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                          Current lead
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground truncate mt-0.5">
                      {lead.niche && <span>{lead.niche}</span>}
                      {lead.niche && lead.location && <span>•</span>}
                      {lead.location && <span className="truncate">{lead.location}</span>}
                      {(lead.email || lead.instagramHandle) && (
                        <>
                          <span>•</span>
                          <span className="truncate">{lead.email || `@${lead.instagramHandle}`}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-border/60">
          <span className="text-xs text-muted-foreground">
            {selectedIds.size === 0
              ? "Select at least 1 lead"
              : `${selectedIds.size} lead${selectedIds.size === 1 ? "" : "s"} ready`}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isExporting}
              className="h-9 px-4 text-xs font-medium border-border/60 hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleExport}
              disabled={selectedIds.size === 0 || isExporting}
              className="h-9 px-4 text-xs font-medium gap-1.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white shadow-sm shadow-indigo-500/25 transition-all"
            >
              {isExporting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              <span>
                {isExporting
                  ? "Exporting..."
                  : `Export ${selectedIds.size} Lead${selectedIds.size === 1 ? "" : "s"}`}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
