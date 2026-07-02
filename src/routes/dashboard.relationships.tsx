import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Filter,
  Instagram,
  Mail,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  ApiError,
  type CreateLeadBody,
  type Lead,
  type LeadStatus,
} from "@/lib/api";
import {
  useBulkDeleteLeads,
  useBulkUpdateLeads,
  useCreateLead,
  useLeads,
} from "@/hooks/use-mast-api";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LEAD_STATUSES,
  NICHES,
  formatRelative,
  leadStatusColor,
  leadStatusLabel,
  normalizeLeadStatus,
} from "@/lib/lead-workspace";

export const Route = createFileRoute("/dashboard/relationships")({
  head: () => ({ meta: [{ title: "Relationships — Mast" }] }),
  component: Relationships,
});

const ALL_VALUE = "__all__";
const NONE_VALUE = "__none__";
const PAGE_SIZE = 100;
const STARRED_STORAGE_KEY = "mast_starred_relationships";

// ─── Starred persistence (localStorage) ──────────────────────────────────────

function loadStarred(): Set<number> {
  try {
    const raw = localStorage.getItem(STARRED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as number[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveStarred(ids: Set<number>) {
  try {
    localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* ignore */ }
}

// ─── Bulk status options (communication-oriented) ─────────────────────────────

const BULK_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: "new", label: "Mark New" },
  { value: "email_sent", label: "Mark Email Sent" },
  { value: "called", label: "Mark Called" },
  { value: "instagram_sent", label: "Mark Instagram Sent" },
  { value: "replied", label: "Mark Replied" },
  { value: "meeting_booked", label: "Mark Meeting Booked" },
  { value: "closed", label: "Mark Closed" },
  { value: "dead", label: "Mark Dead" },
];

const emptyLeadForm = {
  businessName: "",
  instagramHandle: "",
  email: "",
  website: "",
  phone: "",
  niche: NONE_VALUE,
  location: "",
};

// ─── Niche Multi-Select ───────────────────────────────────────────────────────

function NicheMultiSelect({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () =>
      NICHES.filter(
        (n) =>
          n.label.toLowerCase().includes(search.toLowerCase()) ||
          n.value.toLowerCase().includes(search.toLowerCase())
      ),
    [search]
  );

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const removeChip = (value: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selected.filter((v) => v !== value));
  };

  const selectedLabels = selected.map(
    (v) => NICHES.find((n) => n.value === v)?.label ?? v
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="flex min-h-10 w-48 flex-wrap items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-left hover:border-muted-foreground/40 focus-visible:outline-none"
      >
        <Filter className="size-4 shrink-0 text-muted-foreground" />
        {selected.length === 0 ? (
          <span className="text-muted-foreground text-sm ml-1">All niches</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selectedLabels.slice(0, 2).map((label, i) => (
              <span
                key={selected[i]}
                className="inline-flex items-center gap-1 rounded bg-brand/10 border border-brand/20 px-1.5 py-0.5 text-[11px] font-semibold text-brand"
              >
                {label}
                <button
                  type="button"
                  onClick={(e) => removeChip(selected[i], e)}
                  className="hover:text-brand-dark"
                >
                  <X className="size-2.5 shrink-0" />

                </button>
              </span>
            ))}
            {selected.length > 2 && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                +{selected.length - 2}
              </span>
            )}
          </div>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-xl border border-border bg-card shadow-lg">
            <div className="p-2 border-b border-border">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
                <Search className="size-3.5 text-muted-foreground shrink-0" />
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search niches…"
                  className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <div className="max-h-60 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No niches found
                </p>
              ) : (
                filtered.map((niche) => {
                  const checked = selected.includes(niche.value);
                  return (
                    <button
                      key={niche.value}
                      type="button"
                      onClick={() => toggle(niche.value)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-muted/50 ${
                        checked ? "text-brand font-semibold" : "text-foreground"
                      }`}
                    >
                      <div
                        className={`size-3.5 shrink-0 rounded border flex items-center justify-center ${
                          checked ? "bg-brand border-brand" : "border-border"
                        }`}
                      >
                        {checked && (
                          <svg
                            viewBox="0 0 8 6"
                            className="size-2 text-brand-foreground fill-current"
                          >
                            <path
                              d="M1 3l2 2 4-4"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              fill="none"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                      {niche.label}
                    </button>
                  );
                })
              )}
            </div>
            {selected.length > 0 && (
              <div className="border-t border-border p-2">
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="w-full rounded-lg px-3 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted"
                >
                  Clear all ({selected.length})
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({ leads }: { leads: Lead[] }) {
  const total = leads.length;
  const newCount = leads.filter(
    (l) => normalizeLeadStatus(l.status) === "new"
  ).length;
  const contactedCount = leads.filter((l) =>
    ["email_sent", "called", "instagram_sent"].includes(
      normalizeLeadStatus(l.status)
    )
  ).length;
  const repliedCount = leads.filter((l) =>
    ["replied", "meeting_booked"].includes(normalizeLeadStatus(l.status))
  ).length;
  const closedCount = leads.filter(
    (l) => normalizeLeadStatus(l.status) === "closed"
  ).length;

  const stats = [
    { label: "Total", value: total, color: "text-foreground" },
    { label: "New", value: newCount, color: "text-blue-400" },
    { label: "Contacted", value: contactedCount, color: "text-indigo-400" },
    { label: "Replied", value: repliedCount, color: "text-brand" },
    { label: "Closed", value: closedCount, color: "text-success" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-0 border-b border-border bg-background/60">
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          className={`flex flex-col items-center px-5 py-2.5 ${
            index < stats.length - 1 ? "border-r border-border" : ""
          }`}
        >
          <span className={`text-lg font-bold tabular-nums ${stat.color}`}>
            {stat.value.toLocaleString()}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {stat.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Star Button ──────────────────────────────────────────────────────────────

function StarButton({
  starred,
  onToggle,
}: {
  starred: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={starred ? "Remove from starred" : "Star this relationship"}
      className={`transition-all duration-150 rounded p-0.5 hover:scale-110 ${
        starred
          ? "text-amber-400 hover:text-amber-300"
          : "text-muted-foreground/30 hover:text-amber-400/70"
      }`}
    >
      <Star
        className="size-3.5"
        fill={starred ? "currentColor" : "none"}
        strokeWidth={1.8}
      />
    </button>
  );
}

// ─── Main Relationships Component ─────────────────────────────────────────────

function Relationships() {
  const navigate = useNavigate();
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("mast_relationships_focus_mode") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem("mast_relationships_focus_mode", String(focusMode));
    } catch (e) {
      console.error(e);
    }
  }, [focusMode]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL_VALUE);
  const [nicheFilters, setNicheFilters] = useState<string[]>([]);
  const [starredOnly, setStarredOnly] = useState(false);
  const [starred, setStarred] = useState<Set<number>>(() => loadStarred());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [showDead, setShowDead] = useState(false);
  const [newLead, setNewLead] = useState(emptyLeadForm);
  const [page, setPage] = useState(1);

  // Sync starred to localStorage whenever it changes
  useEffect(() => {
    saveStarred(starred);
  }, [starred]);

  const params = {
    search,
    status: statusFilter === ALL_VALUE ? undefined : statusFilter,
    limit: 5000,
  };

  const { data: leadsPayload, isLoading } = useLeads(params);
  const createLead = useCreateLead();
  const bulkUpdate = useBulkUpdateLeads();
  const bulkDelete = useBulkDeleteLeads();

  const allLeads = normalizeLeads(leadsPayload);

  // Client-side niche filtering
  const nicheFiltered = useMemo(() => {
    if (nicheFilters.length === 0) return allLeads;
    return allLeads.filter(
      (lead) => lead.niche && nicheFilters.includes(lead.niche)
    );
  }, [allLeads, nicheFilters]);

  // Starred filter
  const starFiltered = useMemo(() => {
    if (!starredOnly) return nicheFiltered;
    return nicheFiltered.filter((lead) => starred.has(lead.id));
  }, [nicheFiltered, starredOnly, starred]);

  const visibleLeads = useMemo(
    () =>
      starFiltered.filter(
        (lead) => showDead || normalizeLeadStatus(lead.status) !== "dead"
      ),
    [starFiltered, showDead]
  );

  const deadCount = starFiltered.filter(
    (lead) => normalizeLeadStatus(lead.status) === "dead"
  ).length;

  // Pagination
  const totalLeads = visibleLeads.length;
  const totalPages = Math.max(1, Math.ceil(totalLeads / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalLeads);
  const pageLeads = visibleLeads.slice(pageStart, pageEnd);

  const resetPage = () => setPage(1);

  const allSelected =
    pageLeads.length > 0 && pageLeads.every((lead) => selected.has(lead.id));
  const someSelected =
    pageLeads.some((lead) => selected.has(lead.id)) && !allSelected;
  const selectedIds = Array.from(selected);

  const clearSelection = () => setSelected(new Set());

  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(pageLeads.map((lead) => lead.id))
    );
  };

  const toggleOne = (id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleStar = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setStarred((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doBulkStatus = async (status: LeadStatus) => {
    if (selectedIds.length === 0) return;
    try {
      await bulkUpdate.mutateAsync({ ids: selectedIds, updates: { status } });
      toast.success(
        `Updated ${selectedIds.length} relationship${selectedIds.length === 1 ? "" : "s"} to ${leadStatusLabel(status)}`
      );
      clearSelection();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk update failed");
    }
  };

  const doBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    const ok = window.confirm(
      `Remove ${selectedIds.length} relationship${selectedIds.length === 1 ? "" : "s"}?`
    );
    if (!ok) return;
    try {
      await bulkDelete.mutateAsync({ ids: selectedIds });
      toast.success(
        `${selectedIds.length} relationship${selectedIds.length === 1 ? "" : "s"} removed`
      );
      clearSelection();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk delete failed");
    }
  };

  const addLead = async () => {
    if (!newLead.businessName.trim()) return;
    const body: CreateLeadBody = {
      businessName: newLead.businessName.trim(),
      instagramHandle: cleanOptional(
        newLead.instagramHandle.replace(/^@/, "")
      ),
      email: cleanOptional(newLead.email),
      website: cleanOptional(newLead.website),
      phone: cleanOptional(newLead.phone),
      niche: newLead.niche === NONE_VALUE ? undefined : newLead.niche,
      location: cleanOptional(newLead.location),
      source: "manual",
    };

    try {
      const lead = await createLead.mutateAsync(body);
      toast.success("Relationship added");
      setAddOpen(false);
      setNewLead(emptyLeadForm);
      navigate({
        to: "/dashboard/leads/$leadId",
        params: { leadId: String(lead.id) },
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not add relationship"
      );
    }
  };

  const pageButtons = useMemo(() => {
    if (totalPages <= 7)
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "…")[] = [];
    pages.push(1);
    if (safePage > 3) pages.push("…");
    for (
      let p = Math.max(2, safePage - 1);
      p <= Math.min(totalPages - 1, safePage + 1);
      p++
    ) {
      pages.push(p);
    }
    if (safePage < totalPages - 2) pages.push("…");
    pages.push(totalPages);
    return pages;
  }, [totalPages, safePage]);

  const starredCount = allLeads.filter((l) => starred.has(l.id)).length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Relationships</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Find, organise, and continue working with every business you've discovered.
              </p>
            </div>
            {/* Focus Mode Toggle */}
            <button
              onClick={() => setFocusMode((prev) => !prev)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 shadow-sm shrink-0"
              title={focusMode ? "Exit Focus Mode" : "Focus Mode"}
            >
              {focusMode ? (
                <>
                  <ChevronDown className="size-3.5" />
                  <span>Exit Focus Mode</span>
                </>
              ) : (
                <>
                  <ChevronUp className="size-3.5" />
                  <span>Focus Mode</span>
                </>
              )}
            </button>
          </div>

          <div
            className={`transition-all duration-300 ease-in-out origin-top overflow-hidden ${
              focusMode
                ? "max-h-0 opacity-0 pointer-events-none -mt-4"
                : "max-h-[300px] opacity-100"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {/* Search */}
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                <Search className="size-4 text-muted-foreground shrink-0" />

                <input
                  className="w-48 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  placeholder="Search relationships…"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    clearSelection();
                    resetPage();
                  }}
                />
              </div>

              {/* Status filter */}
              <Select
                value={statusFilter}
                onValueChange={(value) => {
                  setStatusFilter(value);
                  clearSelection();
                  resetPage();
                }}
              >
                <SelectTrigger className="h-10 w-44 bg-background text-sm">
                  <Filter className="mr-2 size-4 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All statuses</SelectItem>
                  {LEAD_STATUSES.map((status) => (
                    <SelectItem key={status.value} value={status.value}>
                      {status.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Niche filter */}
              <NicheMultiSelect
                selected={nicheFilters}
                onChange={(next) => {
                  setNicheFilters(next);
                  clearSelection();
                  resetPage();
                }}
              />

              {/* Starred filter */}
              <button
                type="button"
                onClick={() => {
                  setStarredOnly((s) => !s);
                  clearSelection();
                  resetPage();
                }}
                className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
                  starredOnly
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
                title="Show starred relationships"
              >
                <Star
                  className="size-4 shrink-0"
                  fill={starredOnly ? "currentColor" : "none"}
                  strokeWidth={1.8}
                />

                {starredOnly ? `Starred (${starredCount})` : "Starred"}
              </button>

              <Link
                to="/dashboard/import"
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-background"
              >
                Import / Export
              </Link>

              <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogTrigger asChild>
                  <button className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark">
                    <Plus className="size-4 shrink-0" /> Add Relationship

                  </button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add Relationship</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label>Business name</Label>
                      <Input
                        value={newLead.businessName}
                        onChange={(event) =>
                          setNewLead((current) => ({
                            ...current,
                            businessName: event.target.value,
                          }))
                        }
                        placeholder="Acme Studio"
                        autoFocus
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Instagram"
                        value={newLead.instagramHandle}
                        onChange={(value) =>
                          setNewLead((current) => ({
                            ...current,
                            instagramHandle: value,
                          }))
                        }
                        placeholder="@handle"
                      />
                      <Field
                        label="Email"
                        value={newLead.email}
                        onChange={(value) =>
                          setNewLead((current) => ({ ...current, email: value }))
                        }
                        placeholder="hello@example.com"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Website"
                        value={newLead.website}
                        onChange={(value) =>
                          setNewLead((current) => ({
                            ...current,
                            website: value,
                          }))
                        }
                        placeholder="https://example.com"
                      />
                      <Field
                        label="Phone"
                        value={newLead.phone}
                        onChange={(value) =>
                          setNewLead((current) => ({ ...current, phone: value }))
                        }
                        placeholder="+1 555 0100"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Niche</Label>
                        <Select
                          value={newLead.niche}
                          onValueChange={(value) =>
                            setNewLead((current) => ({
                              ...current,
                              niche: value,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>No niche</SelectItem>
                            {NICHES.map((niche) => (
                              <SelectItem key={niche.value} value={niche.value}>
                                {niche.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Field
                        label="Location"
                        value={newLead.location}
                        onChange={(value) =>
                          setNewLead((current) => ({
                            ...current,
                            location: value,
                          }))
                        }
                        placeholder="City, State"
                      />
                    </div>
                    <button
                      onClick={addLead}
                      disabled={
                        !newLead.businessName.trim() || createLead.isPending
                      }
                      className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark disabled:opacity-60"
                    >
                      {createLead.isPending ? "Adding…" : "Add Relationship"}
                    </button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div
        className={`transition-all duration-300 ease-in-out origin-top overflow-hidden ${
          focusMode
            ? "max-h-0 opacity-0 pointer-events-none border-b-0"
            : "max-h-[100px] opacity-100"
        }`}
      >
        {!isLoading && allLeads.length > 0 && <StatsBar leads={allLeads} />}
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-brand/5 px-6 py-3">
          <span className="mr-1 text-sm font-semibold">
            {selected.size} selected
          </span>
          <BulkButton
            onClick={() => void doBulkStatus("instagram_sent")}
            disabled={bulkUpdate.isPending}
            icon={Instagram}
          >
            IG Sent
          </BulkButton>
          <BulkButton
            onClick={() => void doBulkStatus("email_sent")}
            disabled={bulkUpdate.isPending}
            icon={Mail}
          >
            Email Sent
          </BulkButton>
          <Select
            onValueChange={(value) => void doBulkStatus(value as LeadStatus)}
          >
            <SelectTrigger className="h-8 w-40 bg-background text-xs">
              <SelectValue placeholder="Set status…" />
            </SelectTrigger>
            <SelectContent>
              {BULK_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={() => void doBulkDelete()}
            disabled={bulkDelete.isPending}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-destructive px-3 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
          >
            <Trash2 className="size-3.5 shrink-0" /> Remove

          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
            <tr>
              <th className="w-10 px-4 py-3 text-left">
                <Checkbox
                  checked={someSelected ? "indeterminate" : allSelected}
                  onCheckedChange={toggleAll}
                />
              </th>
              {/* Star column */}
              <th className="w-8 px-2 py-3" />
              <Th>Business</Th>
              <Th className="hidden md:table-cell">Niche</Th>
              <Th>Status</Th>
              <Th className="hidden lg:table-cell">Last Contact</Th>
              <Th className="hidden lg:table-cell">Location</Th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, index) => (
                <tr key={index} className="border-b border-border/50">
                  <td className="px-4 py-3">
                    <Skeleton className="size-4" />
                  </td>
                  <td className="px-2 py-3">
                    <Skeleton className="size-3.5" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-48" />
                  </td>
                  <td className="hidden px-3 py-3 md:table-cell">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-5 w-24" />
                  </td>
                  <td className="hidden px-3 py-3 lg:table-cell">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="hidden px-3 py-3 lg:table-cell">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="px-3 py-3" />
                </tr>
              ))
            ) : (
              pageLeads.map((lead) => {
                const selectedRow = selected.has(lead.id);
                const dead = normalizeLeadStatus(lead.status) === "dead";
                const isStarred = starred.has(lead.id);
                const nicheLabel =
                  NICHES.find((n) => n.value === lead.niche)?.label ??
                  lead.niche;
                return (
                  <tr
                    key={lead.id}
                    className={`cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/25 ${
                      selectedRow ? "bg-brand/5" : ""
                    } ${dead ? "opacity-50" : ""}`}
                    onClick={() =>
                      navigate({
                        to: "/dashboard/leads/$leadId",
                        params: { leadId: String(lead.id) },
                      })
                    }
                  >
                    <td
                      className="px-4 py-3"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleOne(lead.id);
                      }}
                    >
                      <Checkbox
                        checked={selectedRow}
                        onCheckedChange={() => undefined}
                      />
                    </td>
                    {/* Star */}
                    <td
                      className="px-2 py-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <StarButton
                        starred={isStarred}
                        onToggle={(e) => toggleStar(lead.id, e)}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-foreground">
                        {lead.businessName}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {lead.instagramHandle && (
                          <span className="inline-flex items-center gap-1">
                            <Instagram className="size-3 shrink-0" />@
                            {lead.instagramHandle.replace(/^@/, "")}
                          </span>
                        )}
                        {lead.email && (
                          <span className="inline-flex items-center gap-1">
                            <Mail className="size-3 shrink-0" />
                            {lead.email}
                          </span>
                        )}

                      </div>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                      {nicheLabel ?? "—"}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${leadStatusColor(lead.status)}`}
                      >
                        {leadStatusLabel(lead.status)}
                      </span>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">
                      {formatRelative(lead.lastContactedAt)}
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">
                      {lead.location ?? "—"}
                    </td>
                    <td className="px-3 py-3">
                      <ArrowRight className="size-4 text-muted-foreground shrink-0" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {!isLoading && visibleLeads.length === 0 && (
          <div className="py-16 text-center">
            {starredOnly ? (
              <>
                <p className="text-sm text-muted-foreground">
                  No starred relationships yet.
                </p>
                <button
                  type="button"
                  onClick={() => setStarredOnly(false)}
                  className="mt-2 inline-block text-sm font-semibold text-brand hover:text-brand-dark"
                >
                  Show all relationships
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  No relationships found.
                </p>
                <Link
                  to="/dashboard/import"
                  className="mt-2 inline-block text-sm font-semibold text-brand hover:text-brand-dark"
                >
                  Import / Export from CSV

                </Link>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer: showing range + pagination */}
      <div className="border-t border-border bg-background/80 px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {isLoading ? (
              "Loading relationships…"
            ) : totalLeads === 0 ? (
              "No relationships"
            ) : (
              `Showing ${pageStart + 1}–${pageEnd} of ${totalLeads.toLocaleString()} relationship${totalLeads === 1 ? "" : "s"}${selected.size > 0 ? ` · ${selected.size} selected` : ""}`
            )}
          </span>

          <div className="flex items-center gap-1.5">
            {deadCount > 0 && statusFilter === ALL_VALUE && (
              <button
                className="mr-3 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setShowDead((current) => !current);
                  resetPage();
                }}
              >
                {showDead ? `Hide ${deadCount} dead` : `Show ${deadCount} dead`}
              </button>
            )}

            {totalPages > 1 && (
              <>
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2 text-xs font-medium hover:bg-muted disabled:opacity-40"
                >
                  <ChevronLeft className="size-3.5 shrink-0" /> Prev
                </button>

                {pageButtons.map((btn, idx) =>
                  btn === "…" ? (
                    <span
                      key={`ellipsis-${idx}`}
                      className="px-1 text-xs text-muted-foreground"
                    >
                      …
                    </span>
                  ) : (
                    <button
                      key={btn}
                      onClick={() => setPage(btn as number)}
                      className={`h-7 min-w-7 rounded-lg border px-2 text-xs font-medium ${
                        btn === safePage
                          ? "border-brand bg-brand text-brand-foreground"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      {btn}
                    </button>
                  )
                )}

                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2 text-xs font-medium hover:bg-muted disabled:opacity-40"
                >
                  Next <ChevronRight className="size-3.5 shrink-0" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function normalizeLeads(
  payload: Lead[] | { leads?: Lead[] } | undefined
): Lead[] {
  return Array.isArray(payload) ? payload : payload?.leads ?? [];
}

function cleanOptional(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ${className}`}
    >
      {children}
    </th>
  );
}

function BulkButton({
  children,
  onClick,
  disabled,
  icon: Icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold hover:bg-card disabled:opacity-60"
    >
      <Icon className="size-3.5 shrink-0" /> {children}
    </button>
  );
}
