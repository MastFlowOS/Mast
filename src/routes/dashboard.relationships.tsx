import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  EllipsisVertical,
  Instagram,
  Link2,
  Mail,
  Phone,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, type CreateLeadBody, type Lead, type LeadStatus } from "@/lib/api";
import {
  useBulkDeleteLeads,
  useBulkUpdateLeads,
  useCreateLead,
  useLeads,
} from "@/hooks/use-mast-api";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  leadMatchesNicheFilter,
  leadNicheDisplay,
  leadStatusColor,
  leadStatusLabel,
  normalizeLeadStatus,
} from "@/lib/lead-workspace";
import { FeatureGate } from "@/components/mast/FeatureGate";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/relationships")({
  head: () => ({ meta: [{ title: "Relationships — Mast" }] }),
  component: () => (
    <FeatureGate feature="relationships">
      <Relationships />
    </FeatureGate>
  ),
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
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveStarred(ids: Set<number>) {
  try {
    localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    /* ignore */
  }
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

// ─── Presentation tokens ─────────────────────────────────────────────────────

// One grid shared by every row so columns line up down the whole list.
// Contact icons appear at xl, last interaction at md, status/star/menu always.
const ROW_GRID =
  "grid items-center gap-x-4 " +
  "grid-cols-[20px_minmax(0,1fr)_28px_28px] " +
  "md:grid-cols-[20px_minmax(0,1fr)_144px_120px_28px_28px] " +
  "xl:grid-cols-[20px_minmax(0,1fr)_136px_148px_132px_28px_28px]";

const CONTROL_SURFACE =
  "rounded-xl border border-border bg-card/40 text-sm font-medium transition-colors " +
  "hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

const GHOST_ACTION =
  "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted-foreground " +
  "transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

// Status reads as a small coloured dot + label. Colours follow the existing
// status meaning (outreach sent / replied / meeting / closed / dead), only the
// treatment changes.
const STATUS_STYLE: Record<LeadStatus, { dot: string; text: string; bg: string }> = {
  new: { dot: "bg-sky-400", text: "text-sky-300", bg: "bg-sky-500/10" },
  email_sent: { dot: "bg-teal-400", text: "text-teal-300", bg: "bg-teal-500/10" },
  called: { dot: "bg-teal-400", text: "text-teal-300", bg: "bg-teal-500/10" },
  instagram_sent: { dot: "bg-teal-400", text: "text-teal-300", bg: "bg-teal-500/10" },
  replied: { dot: "bg-violet-400", text: "text-violet-300", bg: "bg-violet-500/12" },
  meeting_booked: { dot: "bg-amber-400", text: "text-amber-300", bg: "bg-amber-500/10" },
  closed: { dot: "bg-emerald-400", text: "text-emerald-300", bg: "bg-emerald-500/10" },
  dead: { dot: "bg-rose-400", text: "text-rose-300", bg: "bg-rose-500/10" },
};

const PAGE_BUTTON =
  "grid h-9 min-w-9 place-items-center rounded-lg border border-border/70 px-2 text-[13px] font-medium text-muted-foreground " +
  "transition-colors hover:bg-white/[0.04] hover:text-foreground disabled:pointer-events-none disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

const CHECKBOX_STYLE =
  "size-[18px] rounded-[6px] border-muted-foreground/40 bg-transparent shadow-none " +
  "data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground " +
  "data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand/30";

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
          n.value.toLowerCase().includes(search.toLowerCase()),
      ),
    [search],
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

  const selectedLabels = selected.map((v) => NICHES.find((n) => n.value === v)?.label ?? v);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedLabels.join(", ") || undefined}
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className={cn(
          CONTROL_SURFACE,
          "flex h-11 w-48 items-center justify-between gap-2 px-4 text-left",
        )}
      >
        {selected.length === 0 ? (
          <span className="truncate">All Niches</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-brand/25 bg-brand/10 px-1.5 py-0.5 text-[12px] font-semibold text-brand">
              <span className="truncate">{selectedLabels[0]}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Remove ${selectedLabels[0]}`}
                onClick={(e) => removeChip(selected[0], e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onChange(selected.filter((v) => v !== selected[0]));
                  }
                }}
                className="shrink-0 hover:text-brand-dark"
              >
                <X className="size-3.5" />
              </span>
            </span>
            {selected.length > 1 && (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground">
                +{selected.length - 1}
              </span>
            )}
          </span>
        )}
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-xl border border-border bg-card shadow-lg">
            <div className="p-2 border-b border-border">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
                <Search className="size-4 text-muted-foreground shrink-0" />
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

// ─── Star Button ──────────────────────────────────────────────────────────────

function StarButton({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={starred}
      title={starred ? "Remove from starred" : "Star this relationship"}
      className={cn(
        "grid size-7 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        starred
          ? "text-amber-400 hover:text-amber-300"
          : "text-muted-foreground/50 hover:text-amber-400/80",
      )}
    >
      <Star className="size-[18px]" fill={starred ? "currentColor" : "none"} strokeWidth={1.7} />
    </button>
  );
}

// ─── Row parts ────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLE[normalizeLeadStatus(status)];
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-2 whitespace-nowrap rounded-full pl-2.5 pr-3 text-[13px] font-medium",
        style.bg,
        style.text,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", style.dot)} />
      {leadStatusLabel(status)}
    </span>
  );
}

function websiteHref(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Email / phone / website / Instagram. Channels the business doesn't have stay
// as a faint placeholder so the icons keep their column across every row.
function ContactActions({ lead }: { lead: Lead }) {
  const handle = lead.instagramHandle?.replace(/^@/, "");
  const channels = [
    {
      key: "email",
      label: "Email",
      Icon: Mail,
      value: lead.email,
      href: lead.email ? `mailto:${lead.email}` : null,
    },
    {
      key: "phone",
      label: "Call",
      Icon: Phone,
      value: lead.phone,
      href: lead.phone ? `tel:${lead.phone.replace(/\s+/g, "")}` : null,
    },
    {
      key: "website",
      label: "Website",
      Icon: Link2,
      value: lead.website,
      href: lead.website ? websiteHref(lead.website) : null,
    },
    {
      key: "instagram",
      label: "Instagram",
      Icon: Instagram,
      value: handle ? `@${handle}` : null,
      href: handle ? `https://instagram.com/${handle}` : null,
    },
  ];

  return (
    <div className="hidden items-center gap-0.5 xl:flex" onClick={(e) => e.stopPropagation()}>
      {channels.map(({ key, label, Icon, value, href }) =>
        href ? (
          <a
            key={key}
            href={href}
            target={key === "email" || key === "phone" ? undefined : "_blank"}
            rel="noopener noreferrer"
            title={`${label}: ${value}`}
            aria-label={`${label} ${lead.businessName}`}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-brand/10 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <Icon className="size-[18px]" strokeWidth={1.6} />
          </a>
        ) : (
          <span
            key={key}
            aria-hidden="true"
            className="grid size-8 place-items-center text-muted-foreground/20"
          >
            <Icon className="size-[18px]" strokeWidth={1.6} />
          </span>
        ),
      )}
    </div>
  );
}

function RelationshipRow({
  lead,
  selected,
  starred,
  onOpen,
  onToggleSelect,
  onToggleStar,
}: {
  lead: Lead;
  selected: boolean;
  starred: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggleStar: () => void;
}) {
  const dead = normalizeLeadStatus(lead.status) === "dead";
  const nicheLabel = leadNicheDisplay(lead.niche);

  const lastRelative = lead.lastContactedAt ? formatRelative(lead.lastContactedAt) : "-";
  const contacted = lastRelative !== "-";
  const addedRelative = formatRelative(lead.createdAt);
  const addedLabel =
    addedRelative === "-"
      ? null
      : `Added ${addedRelative === "Today" || addedRelative === "Yesterday" ? addedRelative.toLowerCase() : addedRelative}`;

  return (
    <li
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") onOpen();
      }}
      className={cn(
        ROW_GRID,
        "cursor-pointer border-b border-border/40 px-3 py-3 outline-none transition-colors",
        "hover:bg-white/[0.025] focus-visible:bg-white/[0.04]",
        selected && "bg-brand/[0.07] hover:bg-brand/[0.09]",
        dead && "opacity-50",
      )}
    >
      <div
        className="grid w-5 place-items-center"
        onClick={(event) => {
          event.stopPropagation();
          onToggleSelect();
        }}
      >
        <Checkbox
          className={CHECKBOX_STYLE}
          aria-label={`Select ${lead.businessName}`}
          checked={selected}
          onCheckedChange={() => undefined}
        />
      </div>

      <div className="min-w-0">
        <div className="truncate text-[15px] font-semibold leading-5 text-foreground">
          {lead.businessName}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[13px] leading-4 text-muted-foreground">
          <span className="max-w-[55%] shrink-0 truncate">{nicheLabel}</span>
          {lead.location && (
            <>
              <span
                aria-hidden="true"
                className="size-[3px] shrink-0 rounded-full bg-muted-foreground/50"
              />
              <span className="min-w-0 truncate">{lead.location}</span>
            </>
          )}
        </div>
        <div className="mt-2 md:hidden">
          <StatusPill status={lead.status} />
        </div>
      </div>

      <ContactActions lead={lead} />

      <div className="hidden md:flex">
        <StatusPill status={lead.status} />
      </div>

      <div className="hidden min-w-0 md:block">
        <div
          className={cn(
            "truncate text-[13px] leading-5",
            contacted ? "text-foreground/90" : "text-muted-foreground",
          )}
        >
          {contacted ? lastRelative : "Not contacted"}
        </div>
        {!contacted && addedLabel && (
          <div className="truncate text-[12px] leading-4 text-muted-foreground/70">
            {addedLabel}
          </div>
        )}
      </div>

      <div onClick={(e) => e.stopPropagation()}>
        <StarButton starred={starred} onToggle={onToggleStar} />
      </div>

      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${lead.businessName}`}
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:bg-white/[0.06] data-[state=open]:text-foreground"
            >
              <EllipsisVertical className="size-[18px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onOpen}>Open relationship</DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleStar}>
              {starred ? "Remove from starred" : "Star relationship"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function SkeletonRow() {
  return (
    <li className={cn(ROW_GRID, "border-b border-border/40 px-3 py-3")}>
      <Skeleton className="size-[18px] rounded-md" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-56 max-w-full" />
      </div>
      <div className="hidden xl:flex xl:gap-2">
        <Skeleton className="size-5" />
        <Skeleton className="size-5" />
        <Skeleton className="size-5" />
        <Skeleton className="size-5" />
      </div>
      <Skeleton className="h-7 w-24 rounded-full" />
      <div className="hidden space-y-2 md:block">
        <Skeleton className="h-3.5 w-16" />
      </div>
      <Skeleton className="size-4" />
      <Skeleton className="size-4" />
    </li>
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

  const [focusAnimating, setFocusAnimating] = useState(false);
  const focusMounted = useRef(false);
  useEffect(() => {
    if (!focusMounted.current) {
      focusMounted.current = true;
      return;
    }
    setFocusAnimating(true);
    const t = setTimeout(() => setFocusAnimating(false), 600);
    return () => clearTimeout(t);
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
    // Filter options are NICHES slugs; stored niches may be a slug (manual
    // leads) or the exact discovery string ("Coffee Shop"). Both sides go
    // through the same key — see leadMatchesNicheFilter().
    return allLeads.filter((lead) => leadMatchesNicheFilter(lead.niche, nicheFilters));
  }, [allLeads, nicheFilters]);

  // Starred filter
  const starFiltered = useMemo(() => {
    if (!starredOnly) return nicheFiltered;
    return nicheFiltered.filter((lead) => starred.has(lead.id));
  }, [nicheFiltered, starredOnly, starred]);

  const visibleLeads = useMemo(
    () => starFiltered.filter((lead) => showDead || normalizeLeadStatus(lead.status) !== "dead"),
    [starFiltered, showDead],
  );

  const deadCount = starFiltered.filter(
    (lead) => normalizeLeadStatus(lead.status) === "dead",
  ).length;

  // Pagination
  const totalLeads = visibleLeads.length;
  const totalPages = Math.max(1, Math.ceil(totalLeads / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalLeads);
  const pageLeads = visibleLeads.slice(pageStart, pageEnd);

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

  const toggleStar = (id: number) => {
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
        `Updated ${selectedIds.length} relationship${selectedIds.length === 1 ? "" : "s"} to ${leadStatusLabel(status)}`,
      );
      clearSelection();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk update failed");
    }
  };

  const doBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    const ok = window.confirm(
      `Remove ${selectedIds.length} relationship${selectedIds.length === 1 ? "" : "s"}?`,
    );
    if (!ok) return;
    try {
      await bulkDelete.mutateAsync({ ids: selectedIds });
      toast.success(
        `${selectedIds.length} relationship${selectedIds.length === 1 ? "" : "s"} removed`,
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
      toast.success("Relationship added");
      setAddOpen(false);
      setNewLead(emptyLeadForm);
      navigate({
        to: "/dashboard/leads/$leadId",
        params: { leadId: String(lead.id) },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add relationship");
    }
  };

  const openLead = (id: number) =>
    navigate({
      to: "/dashboard/leads/$leadId",
      params: { leadId: String(id) },
    });

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

  const starredCount = allLeads.filter((l) => starred.has(l.id)).length;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Top section (header + search/filters). Focus Mode collapses all of it. */}
      <div
        aria-hidden={focusMode}
        inert={focusMode}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          focusMode
            ? "pointer-events-none grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className={cn("min-h-0", (focusMode || focusAnimating) && "overflow-hidden")}>
          {/* Header */}
          <div className="px-6 pt-8 md:px-8">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/80">
                  Relationships
                </p>
                <h1 className="text-[32px] font-semibold leading-none tracking-tight text-foreground">
                  Relationships
                </h1>
                <p className="mt-3 text-[15px] text-muted-foreground">
                  Manage and grow your business relationships.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setFocusMode(true)}
                  className={GHOST_ACTION}
                  title="Focus Mode"
                >
                  <ChevronUp className="size-4" />
                  <span>Focus Mode</span>
                </button>

                <Link to="/dashboard/import" className={GHOST_ACTION}>
                  Import / Export
                </Link>

                <Dialog open={addOpen} onOpenChange={setAddOpen}>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-brand-foreground shadow-brand transition-colors hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <Plus className="size-[18px] shrink-0" strokeWidth={2} /> Add Relationship
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
                        disabled={!newLead.businessName.trim() || createLead.isPending}
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

          {/* Search + filters */}
          <div>
            <div className="flex flex-wrap items-center gap-3 px-6 pb-5 pt-6 md:px-8">
              <label
                className={cn(
                  CONTROL_SURFACE,
                  "flex h-11 min-w-[240px] flex-1 items-center gap-3 px-4 focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/20",
                )}
              >
                <Search className="size-[18px] shrink-0 text-muted-foreground" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-sm font-normal outline-none placeholder:text-muted-foreground"
                  placeholder="Search relationships…"
                  aria-label="Search relationships"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    clearSelection();
                    resetPage();
                  }}
                />
              </label>

              <Select
                value={statusFilter}
                onValueChange={(value) => {
                  setStatusFilter(value);
                  clearSelection();
                  resetPage();
                }}
              >
                <SelectTrigger
                  aria-label="Filter by status"
                  className={cn(CONTROL_SURFACE, "h-11 w-44 px-4 shadow-none")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All Statuses</SelectItem>
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

              <button
                type="button"
                aria-pressed={starredOnly}
                onClick={() => {
                  setStarredOnly((s) => !s);
                  clearSelection();
                  resetPage();
                }}
                className={cn(
                  CONTROL_SURFACE,
                  "inline-flex h-11 items-center gap-2.5 px-4",
                  starredOnly &&
                    "border-amber-400/40 bg-amber-400/10 text-amber-200 hover:border-amber-400/50",
                )}
                title="Show starred relationships"
              >
                <Star
                  className="size-[18px] shrink-0 text-amber-400"
                  fill="currentColor"
                  strokeWidth={1.8}
                />
                {starredOnly ? `Starred (${starredCount})` : "Starred"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Focus Mode: only a slim exit control stays visible */}
      <div
        aria-hidden={!focusMode}
        inert={!focusMode}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          focusMode
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex justify-end px-6 pb-1 pt-3 md:px-8">
            <button
              type="button"
              onClick={() => setFocusMode(false)}
              className={GHOST_ACTION}
              title="Exit Focus Mode"
            >
              <ChevronDown className="size-4" />
              <span>Exit Focus Mode</span>
            </button>
          </div>
        </div>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/25 bg-brand/[0.07] px-4 py-2.5 md:mx-8">
          <span className="mr-1 text-sm font-semibold">{selected.size} selected</span>
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
          <Select onValueChange={(value) => void doBulkStatus(value as LeadStatus)}>
            <SelectTrigger className="h-8 w-40 rounded-lg border-border/80 bg-background/60 text-xs shadow-none">
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
            <Trash2 className="size-4 shrink-0" /> Remove
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-auto px-3 md:px-5">
        <div className="sticky top-0 z-10 flex items-center gap-4 border-b border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur">
          <div className="grid w-5 place-items-center">
            <Checkbox
              className={CHECKBOX_STYLE}
              aria-label="Select all relationships on this page"
              checked={someSelected ? "indeterminate" : allSelected}
              onCheckedChange={toggleAll}
            />
          </div>
          <span className="text-[12px] text-muted-foreground">Select all on page</span>
        </div>

        <ul>
          {isLoading
            ? Array.from({ length: 8 }).map((_, index) => <SkeletonRow key={index} />)
            : pageLeads.map((lead) => (
                <RelationshipRow
                  key={lead.id}
                  lead={lead}
                  selected={selected.has(lead.id)}
                  starred={starred.has(lead.id)}
                  onOpen={() => openLead(lead.id)}
                  onToggleSelect={() => toggleOne(lead.id)}
                  onToggleStar={() => toggleStar(lead.id)}
                />
              ))}
        </ul>

        {!isLoading && visibleLeads.length === 0 && (
          <div className="py-20 text-center">
            {starredOnly ? (
              <>
                <p className="text-sm text-muted-foreground">No starred relationships yet.</p>
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
                <p className="text-sm text-muted-foreground">No relationships found.</p>
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
      <div className="border-t border-border/50 px-6 py-4 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">
            {isLoading
              ? "Loading relationships…"
              : totalLeads === 0
                ? "No relationships"
                : `Showing ${pageStart + 1}–${pageEnd} of ${totalLeads.toLocaleString()} relationship${totalLeads === 1 ? "" : "s"}${selected.size > 0 ? ` · ${selected.size} selected` : ""}`}
          </span>

          <div className="flex items-center gap-1.5">
            {deadCount > 0 && statusFilter === ALL_VALUE && (
              <button
                className="mr-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
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
                  aria-label="Previous page"
                  className={PAGE_BUTTON}
                >
                  <ChevronLeft className="size-4" />
                </button>

                {pageButtons.map((btn, idx) =>
                  btn === "…" ? (
                    <span
                      key={`ellipsis-${idx}`}
                      className="px-1.5 text-[13px] text-muted-foreground"
                    >
                      …
                    </span>
                  ) : (
                    <button
                      key={btn}
                      onClick={() => setPage(btn as number)}
                      aria-current={btn === safePage ? "page" : undefined}
                      className={cn(
                        PAGE_BUTTON,
                        btn === safePage &&
                          "border-brand/70 bg-brand/15 text-foreground hover:bg-brand/20",
                      )}
                    >
                      {btn}
                    </button>
                  ),
                )}

                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  aria-label="Next page"
                  className={PAGE_BUTTON}
                >
                  <ChevronRight className="size-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined): Lead[] {
  return Array.isArray(payload) ? payload : (payload?.leads ?? []);
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
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/80 bg-background/60 px-3 text-xs font-semibold transition-colors hover:bg-card disabled:opacity-60"
    >
      <Icon className="size-4 shrink-0" /> {children}
    </button>
  );
}
