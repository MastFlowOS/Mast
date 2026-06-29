import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, ChevronLeft, ChevronRight, Filter, Instagram, Mail, Plus, Search, Star, Trash2, X } from "lucide-react";
import { ApiError, type CreateLeadBody, type Lead, type LeadStatus } from "@/lib/api";
import { useBulkDeleteLeads, useBulkUpdateLeads, useCreateLead, useLeads } from "@/hooks/use-mast-api";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { LEAD_STATUSES, NICHES, formatRelative, leadStatusColor, leadStatusLabel, normalizeLeadStatus } from "@/lib/lead-workspace";

export const Route = createFileRoute("/dashboard/crm")({
  head: () => ({ meta: [{ title: "Opportunity Network — Mast" }] }),
  component: CRM,
});

const ALL_VALUE = "__all__";
const NONE_VALUE = "__none__";
const PAGE_SIZE = 100;

const BULK_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: "priority", label: "Mark Priority" },
  { value: "warm", label: "Mark Warm" },
  { value: "contacted", label: "Mark Contacted" },
  { value: "instagram_sent", label: "Mark IG Sent" },
  { value: "email_sent", label: "Mark Email Sent" },
  { value: "replied", label: "Mark Replied" },
  { value: "interested", label: "Mark Interested" },
  { value: "follow_up_due", label: "Follow-up Due" },
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
      NICHES.filter((n) =>
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
        className="flex min-h-10 w-52 flex-wrap items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-left hover:border-muted-foreground/40 focus-visible:outline-none"
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
                  <X className="size-2.5" />
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
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">No niches found</p>
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
                          <svg viewBox="0 0 8 6" className="size-2 text-brand-foreground fill-current">
                            <path d="M1 3l2 2 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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

// ─── CRM Stats Bar ────────────────────────────────────────────────────────────

function StatsBar({ leads }: { leads: Lead[] }) {
  const total = leads.length;
  const newCount = leads.filter((l) => normalizeLeadStatus(l.status) === "new").length;
  const contactedCount = leads.filter((l) =>
    ["contacted", "email_sent", "instagram_sent", "contact_form_sent"].includes(normalizeLeadStatus(l.status))
  ).length;
  const repliedCount = leads.filter((l) =>
    ["replied", "interested", "meeting_booked"].includes(normalizeLeadStatus(l.status))
  ).length;
  const closedCount = leads.filter((l) => normalizeLeadStatus(l.status) === "closed").length;

  const stats = [
    { label: "Total Opportunities", value: total, color: "text-foreground" },
    { label: "New", value: newCount, color: "text-blue-400" },
    { label: "Contacted", value: contactedCount, color: "text-warning" },
    { label: "Replied", value: repliedCount, color: "text-brand" },
    { label: "Closed", value: closedCount, color: "text-success" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-0 border-b border-border bg-background/60">
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          className={`flex flex-col items-center px-5 py-2.5 ${index < stats.length - 1 ? "border-r border-border" : ""}`}
        >
          <span className={`text-lg font-bold tabular-nums ${stat.color}`}>{stat.value.toLocaleString()}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main CRM Component ───────────────────────────────────────────────────────

function CRM() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL_VALUE);
  const [nicheFilters, setNicheFilters] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [showDead, setShowDead] = useState(false);
  const [newLead, setNewLead] = useState(emptyLeadForm);
  const [page, setPage] = useState(1);

  // Fetch a large batch — the backend supports up to whatever limit we give it
  // We fetch 5000 and paginate client-side so the table never renders 5000 rows
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

  // Client-side niche filtering (the backend may not support multi-niche queries)
  const nicheFiltered = useMemo(() => {
    if (nicheFilters.length === 0) return allLeads;
    return allLeads.filter((lead) => lead.niche && nicheFilters.includes(lead.niche));
  }, [allLeads, nicheFilters]);

  const visibleLeads = useMemo(
    () => nicheFiltered.filter((lead) => showDead || normalizeLeadStatus(lead.status) !== "dead"),
    [nicheFiltered, showDead]
  );

  const deadCount = nicheFiltered.filter((lead) => normalizeLeadStatus(lead.status) === "dead").length;

  // Pagination
  const totalLeads = visibleLeads.length;
  const totalPages = Math.max(1, Math.ceil(totalLeads / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalLeads);
  const pageLeads = visibleLeads.slice(pageStart, pageEnd);

  // Reset page when filters change
  const resetPage = () => setPage(1);

  const allSelected = pageLeads.length > 0 && pageLeads.every((lead) => selected.has(lead.id));
  const someSelected = pageLeads.some((lead) => selected.has(lead.id)) && !allSelected;
  const selectedIds = Array.from(selected);

  const clearSelection = () => setSelected(new Set());

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(pageLeads.map((lead) => lead.id)));
  };

  const toggleOne = (id: number) => {
    setSelected((current) => {
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
      toast.success(`Updated ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"} to ${leadStatusLabel(status)}`);
      clearSelection();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk update failed");
    }
  };

  const doBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    const ok = window.confirm(`Delete ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"}?`);
    if (!ok) return;
    try {
      await bulkDelete.mutateAsync({ ids: selectedIds });
      toast.success(`${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"} removed`);
      clearSelection();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk delete failed");
    }
  };

  const addLead = async () => {
    if (!newLead.businessName.trim()) return;
    const body: CreateLeadBody = {
      businessName: newLead.businessName.trim(),
      instagramHandle: cleanOptional(newLead.instagramHandle.replace(/^@/, "")),
      email: cleanOptional(newLead.email),
      website: cleanOptional(newLead.website),
      phone: cleanOptional(newLead.phone),
      niche: newLead.niche === NONE_VALUE ? undefined : newLead.niche,
      location: cleanOptional(newLead.location),
      source: "manual",
    };

    try {
      const lead = await createLead.mutateAsync(body);
      toast.success("Lead added");
      setAddOpen(false);
      setNewLead(emptyLeadForm);
      navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(lead.id) } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add lead");
    }
  };

  // Page buttons to show (max 5 around current)
  const pageButtons = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "…")[] = [];
    pages.push(1);
    if (safePage > 3) pages.push("…");
    for (let p = Math.max(2, safePage - 1); p <= Math.min(totalPages - 1, safePage + 1); p++) {
      pages.push(p);
    }
    if (safePage < totalPages - 2) pages.push("…");
    pages.push(totalPages);
    return pages;
  }, [totalPages, safePage]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Opportunity Network</h1>
            <p className="text-sm text-muted-foreground">Search, select, import, and bulk-manage your relationship data.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <Search className="size-4 text-muted-foreground" />
              <input
                className="w-52 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                placeholder="Search leads"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  clearSelection();
                  resetPage();
                }}
              />
            </div>

            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value);
                clearSelection();
                resetPage();
              }}
            >
              <SelectTrigger className="h-10 w-40 bg-background text-sm">
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

            <NicheMultiSelect
              selected={nicheFilters}
              onChange={(next) => {
                setNicheFilters(next);
                clearSelection();
                resetPage();
              }}
            />

            <Link
              to="/dashboard/import"
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-background"
            >
              Data Import / Export
            </Link>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <button className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark">
                  <Plus className="size-4" /> Add Opportunity
                </button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add Opportunity</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>Business name</Label>
                    <Input
                      value={newLead.businessName}
                      onChange={(event) => setNewLead((current) => ({ ...current, businessName: event.target.value }))}
                      placeholder="Acme Studio"
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Instagram" value={newLead.instagramHandle} onChange={(value) => setNewLead((current) => ({ ...current, instagramHandle: value }))} placeholder="@handle" />
                    <Field label="Email" value={newLead.email} onChange={(value) => setNewLead((current) => ({ ...current, email: value }))} placeholder="hello@example.com" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Website" value={newLead.website} onChange={(value) => setNewLead((current) => ({ ...current, website: value }))} placeholder="https://example.com" />
                    <Field label="Phone" value={newLead.phone} onChange={(value) => setNewLead((current) => ({ ...current, phone: value }))} placeholder="+1 555 0100" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Niche</Label>
                      <Select value={newLead.niche} onValueChange={(value) => setNewLead((current) => ({ ...current, niche: value }))}>
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
                    <Field label="Location" value={newLead.location} onChange={(value) => setNewLead((current) => ({ ...current, location: value }))} placeholder="City, State" />
                  </div>
                  <button
                    onClick={addLead}
                    disabled={!newLead.businessName.trim() || createLead.isPending}
                    className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-brand hover:bg-brand-dark disabled:opacity-60"
                  >
                    {createLead.isPending ? "Adding..." : "Add Opportunity"}
                  </button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      {!isLoading && allLeads.length > 0 && <StatsBar leads={allLeads} />}

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-brand/5 px-6 py-3">
          <span className="mr-1 text-sm font-semibold">{selected.size} selected</span>
          <BulkButton onClick={() => void doBulkStatus("priority")} disabled={bulkUpdate.isPending} icon={Star}>
            Priority
          </BulkButton>
          <BulkButton onClick={() => void doBulkStatus("instagram_sent")} disabled={bulkUpdate.isPending} icon={Instagram}>
            IG Sent
          </BulkButton>
          <BulkButton onClick={() => void doBulkStatus("email_sent")} disabled={bulkUpdate.isPending} icon={Mail}>
            Email Sent
          </BulkButton>
          <Select onValueChange={(value) => void doBulkStatus(value as LeadStatus)}>
            <SelectTrigger className="h-8 w-40 bg-background text-xs">
              <SelectValue placeholder="Set status..." />
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
            <Trash2 className="size-3.5" /> Delete
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
            <tr>
              <th className="w-10 px-4 py-3 text-left">
                <Checkbox checked={someSelected ? "indeterminate" : allSelected} onCheckedChange={toggleAll} />
              </th>
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
                  <td className="px-4 py-3"><Skeleton className="size-4" /></td>
                  <td className="px-3 py-3"><Skeleton className="h-4 w-48" /></td>
                  <td className="hidden px-3 py-3 md:table-cell"><Skeleton className="h-4 w-20" /></td>
                  <td className="px-3 py-3"><Skeleton className="h-5 w-24" /></td>
                  <td className="hidden px-3 py-3 lg:table-cell"><Skeleton className="h-4 w-20" /></td>
                  <td className="hidden px-3 py-3 lg:table-cell"><Skeleton className="h-4 w-24" /></td>
                  <td className="px-3 py-3" />
                </tr>
              ))
            ) : (
              pageLeads.map((lead) => {
                const selectedRow = selected.has(lead.id);
                const dead = normalizeLeadStatus(lead.status) === "dead";
                const nicheLabel = NICHES.find((n) => n.value === lead.niche)?.label ?? lead.niche;
                return (
                  <tr
                    key={lead.id}
                    className={`cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/25 ${selectedRow ? "bg-brand/5" : ""} ${dead ? "opacity-50" : ""}`}
                    onClick={() => navigate({ to: "/dashboard/leads/$leadId", params: { leadId: String(lead.id) } })}
                  >
                    <td
                      className="px-4 py-3"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleOne(lead.id);
                      }}
                    >
                      <Checkbox checked={selectedRow} onCheckedChange={() => undefined} />
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-foreground">{lead.businessName}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {lead.instagramHandle && <span className="inline-flex items-center gap-1"><Instagram className="size-3" />@{lead.instagramHandle.replace(/^@/, "")}</span>}
                        {lead.email && <span className="inline-flex items-center gap-1"><Mail className="size-3" />{lead.email}</span>}
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">{nicheLabel ?? "-"}</td>
                    <td className="px-3 py-3">
                      <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${leadStatusColor(lead.status)}`}>
                        {leadStatusLabel(lead.status)}
                      </span>
                    </td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">{formatRelative(lead.lastContactedAt)}</td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell">{lead.location ?? "-"}</td>
                    <td className="px-3 py-3">
                      <ArrowRight className="size-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {!isLoading && visibleLeads.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">No opportunities found.</p>
            <Link to="/dashboard/import" className="mt-2 inline-block text-sm font-semibold text-brand hover:text-brand-dark">
              Import opportunities from CSV
            </Link>
          </div>
        )}
      </div>

      {/* Footer: showing range + pagination */}
      <div className="border-t border-border bg-background/80 px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {isLoading ? (
              "Loading..."
            ) : totalLeads === 0 ? (
              "No opportunities"
            ) : (
              `Showing ${pageStart + 1}–${pageEnd} of ${totalLeads.toLocaleString()} opportunit${totalLeads === 1 ? "y" : "ies"}${selected.size > 0 ? ` · ${selected.size} selected` : ""}`
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
                  <ChevronLeft className="size-3.5" /> Prev
                </button>

                {pageButtons.map((btn, idx) =>
                  btn === "…" ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-xs text-muted-foreground">…</span>
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
                  Next <ChevronRight className="size-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined) {
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
      <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ${className}`}>
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
      <Icon className="size-3.5" /> {children}
    </button>
  );
}
