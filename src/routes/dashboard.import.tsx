import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Globe,
  Info,
  Lock,
  MapPin,
  Tag,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useBulkImportLeads, useLeads, useMe } from "@/hooks/use-mast-api";
import type { CreateLeadBody, Lead } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FeatureGate } from "@/components/mast/FeatureGate";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/import")({
  head: () => ({ meta: [{ title: "Data Import / Export — Mast" }] }),
  component: () => (
    <FeatureGate feature="importExport">
      <ImportExportPage />
    </FeatureGate>
  ),
});

// ─── Constants ────────────────────────────────────────────────────────────────

const LEAD_FIELDS = [
  { key: "businessName", label: "Business Name", required: true },
  { key: "instagramHandle", label: "Instagram Handle" },
  { key: "email", label: "Email" },
  { key: "website", label: "Website" },
  { key: "phone", label: "Phone" },
  { key: "niche", label: "Niche" },
  { key: "location", label: "Location" },
  { key: "igFollowers", label: "IG Followers" },
  { key: "igBio", label: "IG Bio" },
  { key: "igLastPost", label: "Last IG Post" },
  { key: "igPostDescription", label: "Post Description" },
  { key: "brandingNotes", label: "Branding Notes" },
  { key: "websiteNotes", label: "Website Notes" },
  { key: "notes", label: "Notes" },
  { key: "tags", label: "Tags" },
  { key: "priority", label: "Priority" },
] as const;

type LeadFieldKey = (typeof LEAD_FIELDS)[number]["key"];

const FIELD_ALIASES: Record<string, LeadFieldKey> = {
  "business name": "businessName",
  business: "businessName",
  company: "businessName",
  "company name": "businessName",
  "brand name": "businessName",
  name: "businessName",
  account: "businessName",
  instagram: "instagramHandle",
  handle: "instagramHandle",
  "ig handle": "instagramHandle",
  "instagram handle": "instagramHandle",
  insta: "instagramHandle",
  "@": "instagramHandle",
  email: "email",
  "email address": "email",
  "e-mail": "email",
  website: "website",
  url: "website",
  site: "website",
  link: "website",
  phone: "phone",
  "phone number": "phone",
  telephone: "phone",
  mobile: "phone",
  niche: "niche",
  category: "niche",
  industry: "niche",
  vertical: "niche",
  location: "location",
  city: "location",
  region: "location",
  followers: "igFollowers",
  "ig followers": "igFollowers",
  bio: "igBio",
  "ig bio": "igBio",
  "last post": "igLastPost",
  "recent post": "igLastPost",
  "post description": "igPostDescription",
  caption: "igPostDescription",
  "branding notes": "brandingNotes",
  branding: "brandingNotes",
  "website notes": "websiteNotes",
  notes: "notes",
  comments: "notes",
  tags: "tags",
  labels: "tags",
  priority: "priority",
};

const SKIP_VALUE = "__skip__";

const ALL_STATUSES = [
  "new",
  "priority",
  "warm",
  "contacted",
  "instagram_sent",
  "email_sent",
  "contact_form_sent",
  "replied",
  "follow_up_due",
  "interested",
  "meeting_booked",
  "closed",
  "won",
  "dead",
  "lost",
];

const PIPELINE_STAGES = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "interested", label: "Interested" },
  { value: "meeting", label: "Meeting" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type CsvRow = Record<string, string>;

interface ParsedRow {
  rowIndex: number;
  data: CreateLeadBody;
  businessName: string;
  instagramHandle: string;
  email: string;
}

interface ImportHistoryEntry {
  id: string;
  fileName: string;
  date: string;
  leadsImported: number;
  duplicatesSkipped: number;
}

interface ExportHistoryEntry {
  id: string;
  date: string;
  recordCount: number;
  format: "CSV" | "Excel";
  filter: string;
}

type ExportScope = "all" | "selected" | "status" | "niche" | "region" | "pipeline";
type ExportFormat = "csv" | "xlsx";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function guessField(column: string): LeadFieldKey | null {
  const key = column.toLowerCase().trim().replace(/[\s_\-/\\]+/g, " ");
  return FIELD_ALIASES[key] ?? null;
}

function buildPreview(rows: CsvRow[], mapping: Record<string, string>) {
  const seen = new Set<string>();
  const seenEmails = new Set<string>();
  const parsed: ParsedRow[] = [];
  let invalid = 0;
  let duplicates = 0;

  rows.forEach((row, index) => {
    const mapped: Record<string, string> = {};
    for (const [column, field] of Object.entries(mapping)) {
      if (field && field !== SKIP_VALUE && row[column]) mapped[field] = row[column].trim();
    }

    const businessName = mapped.businessName ?? "";
    if (!businessName) {
      invalid += 1;
      return;
    }

    const instagramHandle = mapped.instagramHandle ?? "";
    const email = (mapped.email ?? "").toLowerCase();
    const duplicateKey = `${businessName.toLowerCase()}|${instagramHandle.toLowerCase()}`;
    if (seen.has(duplicateKey) || (email && seenEmails.has(email))) {
      duplicates += 1;
      return;
    }

    seen.add(duplicateKey);
    if (email) seenEmails.add(email);
    parsed.push({
      rowIndex: index,
      businessName,
      instagramHandle,
      email,
      data: {
        ...mapped,
        businessName,
        instagramHandle: instagramHandle || undefined,
        email: email || undefined,
        source: "csv_import",
      } as CreateLeadBody,
    });
  });

  return { parsed, invalid, duplicates, total: rows.length };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(current.trim());
      current = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      current = "";
      continue;
    }
    current += char;
  }

  row.push(current.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  if (rows.length === 0) return { columns: [], rows: [] as CsvRow[] };

  const columns = rows[0].map((column) => column.trim()).filter(Boolean);
  const dataRows = rows.slice(1).map((cells) => {
    const entry: CsvRow = {};
    columns.forEach((column, index) => {
      entry[column] = cells[index] ?? "";
    });
    return entry;
  });

  return { columns, rows: dataRows };
}

function leadsToCSV(leads: Lead[]): string {
  const headers = [
    "Business Name",
    "Instagram Handle",
    "Email",
    "Website",
    "Phone",
    "Niche",
    "Location",
    "Status",
    "IG Followers",
    "IG Bio",
    "Tags",
    "Priority",
    "Notes",
    "Created At",
  ];
  const rows = leads.map((lead) => [
    lead.businessName,
    lead.instagramHandle ?? "",
    lead.email ?? "",
    lead.website ?? "",
    lead.phone ?? "",
    lead.niche ?? "",
    lead.location ?? "",
    lead.status ?? "",
    lead.igFollowers ?? "",
    lead.igBio ?? "",
    lead.tags ?? "",
    lead.priority ?? "",
    lead.notes ?? "",
    lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : "",
  ]);

  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Shared UI Elements ───────────────────────────────────────────────────────

function CsvIconBadge({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center size-14 rounded-2xl border border-border/80 bg-background/60 shadow-inner",
        className
      )}
    >
      <svg
        className="size-6 text-brand/90"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-[10px] font-black tracking-wider text-muted-foreground font-mono mt-0.5">
        CSV
      </span>
    </div>
  );
}

function WarningBox({
  children,
  icon: Icon,
}: {
  children: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs sm:text-sm text-warning">
      <Icon className="size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function HistoryEmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <div className="grid size-11 place-items-center rounded-xl border border-border/60 bg-muted/20 mb-2.5">
        <FileText className="size-5 text-muted-foreground/40" />
      </div>
      <p className="text-xs sm:text-sm font-semibold text-foreground/80">{title}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground/60">{message}</p>
    </div>
  );
}

// ─── Main Page Component ──────────────────────────────────────────────────────

function ImportExportPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const bulkImport = useBulkImportLeads();
  const { data: auth } = useMe();
  const planId = auth?.user?.plan ?? "free";
  const isStarterPlus = planId !== "free";

  // Tab switch: "import" | "export"
  const [activeWorkflow, setActiveWorkflow] = useState<"import" | "export">("import");

  // Import State
  const [step, setStep] = useState<"upload" | "map" | "done">("upload");
  const [draggingOver, setDraggingOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [csvColumns, setCsvColumns] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
    errors: Array<{ row: number; reason: string }>;
  } | null>(null);

  // Export State
  const [exportScope, setExportScope] = useState<ExportScope>("all");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [filterValue, setFilterValue] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  // Leads data for export calculation
  const { data: leadsData } = useLeads({ limit: 5000 });
  const allLeads: Lead[] = Array.isArray(leadsData)
    ? leadsData
    : (leadsData as { leads?: Lead[] })?.leads ?? [];

  // History State
  const [importHistory, setImportHistory] = useState<ImportHistoryEntry[]>([]);
  const [exportHistory, setExportHistory] = useState<ExportHistoryEntry[]>([]);
  const [showAllImports, setShowAllImports] = useState(false);
  const [showAllExports, setShowAllExports] = useState(false);

  // Dynamic header date
  const currentDateStr = useMemo(() => {
    return new Date().toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, []);

  // Filtered Leads calculation for Export
  const filteredLeads = useMemo(() => {
    if (exportScope === "all") return allLeads;
    if (exportScope === "status" && filterValue) {
      return allLeads.filter((l) => l.status === filterValue);
    }
    if (exportScope === "niche" && filterValue) {
      return allLeads.filter((l) =>
        (l.niche ?? "").toLowerCase().includes(filterValue.toLowerCase())
      );
    }
    if (exportScope === "region" && filterValue) {
      return allLeads.filter((l) =>
        (l.location ?? "").toLowerCase().includes(filterValue.toLowerCase())
      );
    }
    if (exportScope === "pipeline" && filterValue) {
      const statusMap: Record<string, string[]> = {
        new: ["new", "priority", "warm"],
        contacted: ["contacted", "instagram_sent", "email_sent", "contact_form_sent"],
        interested: ["interested", "replied"],
        meeting: ["meeting_booked", "follow_up_due"],
        proposal: ["closed"],
        won: ["won"],
      };
      const statuses = statusMap[filterValue] ?? [];
      return allLeads.filter((l) => statuses.includes(l.status));
    }
    return allLeads;
  }, [allLeads, exportScope, filterValue]);

  const previewCount = filteredLeads.length;

  const uniqueNiches = useMemo(() => {
    return [...new Set(allLeads.map((l) => l.niche).filter(Boolean))] as string[];
  }, [allLeads]);

  const uniqueRegions = useMemo(() => {
    return [...new Set(allLeads.map((l) => l.location).filter(Boolean))] as string[];
  }, [allLeads]);

  // Import preview calculation
  const preview = useMemo(() => {
    return csvRows.length > 0 ? buildPreview(csvRows, mapping) : null;
  }, [csvRows, mapping]);

  const hasBusinessName = Object.values(mapping).includes("businessName");

  // File Upload Handlers
  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsv(String(reader.result ?? ""));
        if (parsed.rows.length === 0) {
          toast.error("This CSV has no data rows.");
          return;
        }
        const initialMapping: Record<string, string> = {};
        for (const column of parsed.columns) {
          const guess = guessField(column);
          if (guess) initialMapping[column] = guess;
        }
        setFileName(file.name);
        setCsvColumns(parsed.columns);
        setCsvRows(parsed.rows);
        setMapping(initialMapping);
        setStep("map");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not parse CSV");
      }
    };
    reader.readAsText(file);
  }, []);

  const resetImport = () => {
    setCsvColumns([]);
    setCsvRows([]);
    setMapping({});
    setStep("upload");
    setDraggingOver(false);
    setFileName("");
    setShowErrors(false);
    setImportResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const runImport = async () => {
    if (!preview || preview.parsed.length === 0) return;
    try {
      const result = await bulkImport.mutateAsync({
        leads: preview.parsed.map((row) => row.data),
      });
      const failed = result.failed ?? result.errors?.length ?? 0;
      setImportResult({
        imported: result.imported,
        skipped: result.skipped,
        failed,
        errors: result.errors ?? [],
      });
      setStep("done");
      toast.success(`${result.imported} opportunities imported`);
      setImportHistory((prev: ImportHistoryEntry[]) => [
        {
          id: Date.now().toString(),
          fileName,
          date: new Date().toISOString(),
          leadsImported: result.imported,
          duplicatesSkipped: result.skipped,
        },
        ...prev,
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    }
  };

  // Export Action Handler
  const handleExport = async () => {
    if (previewCount === 0) {
      toast.error("No opportunities match your filter.");
      return;
    }
    setIsExporting(true);
    try {
      const timestamp = new Date().toISOString().split("T")[0];
      const scopeLabel =
        exportScope === "all"
          ? "all-leads"
          : exportScope === "status"
          ? `status-${filterValue}`
          : exportScope === "niche"
          ? `niche-${filterValue || "all"}`
          : exportScope === "region"
          ? `region-${filterValue || "all"}`
          : exportScope === "pipeline"
          ? `pipeline-${filterValue || "all"}`
          : "selected-leads";

      if (exportFormat === "csv") {
        const csvContent = leadsToCSV(filteredLeads);
        downloadFile(csvContent, `mast-export-${scopeLabel}-${timestamp}.csv`, "text/csv");
      } else if (exportFormat === "xlsx" && isStarterPlus) {
        const csvContent = leadsToCSV(filteredLeads);
        downloadFile(
          csvContent,
          `mast-export-${scopeLabel}-${timestamp}.xlsx`,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
      }

      toast.success(`${previewCount.toLocaleString()} opportunities exported`);
      setExportHistory((prev: ExportHistoryEntry[]) => [
        {
          id: Date.now().toString(),
          date: new Date().toISOString(),
          recordCount: previewCount,
          format: exportFormat === "xlsx" ? "Excel" : "CSV",
          filter:
            exportScope === "all"
              ? "All Opportunities"
              : exportScope === "status"
              ? `Status: ${filterValue}`
              : exportScope === "niche"
              ? `Niche: ${filterValue || "all"}`
              : exportScope === "region"
              ? `Region: ${filterValue || "all"}`
              : exportScope === "pipeline"
              ? `Pipeline: ${filterValue || "all"}`
              : "Selected",
        },
        ...prev,
      ]);
    } catch {
      toast.error("Export failed. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  // Render Scope Card helper
  const renderScopeOption = (
    value: ExportScope,
    label: string,
    description: string,
    Icon: React.ComponentType<{ className?: string }>,
    className?: string
  ) => {
    const isSelected = exportScope === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => {
          setExportScope(value);
          setFilterValue("");
        }}
        className={cn(
          "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all duration-150 cursor-pointer select-none",
          isSelected
            ? "border-brand/70 bg-brand/10 shadow-sm ring-1 ring-brand/30"
            : "border-border/70 bg-background/40 hover:border-border hover:bg-card/50",
          className
        )}
      >
        <div
          className={cn(
            "size-4 rounded-full flex items-center justify-center shrink-0 transition-colors",
            isSelected ? "bg-brand text-brand-foreground" : "border border-muted-foreground/40"
          )}
        >
          {isSelected && <Check className="size-2.5 stroke-[3]" />}
        </div>
        <Icon className={cn("size-4 shrink-0", isSelected ? "text-brand" : "text-muted-foreground")} />
        <div className="min-w-0">
          <p className="text-xs sm:text-sm font-semibold text-foreground truncate">{label}</p>
          <p className="text-[11px] text-muted-foreground truncate">{description}</p>
        </div>
      </button>
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      {/* ── Page Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-1">
            Data Management
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            Import / Export
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Move data into and out of Mast — cleanly, quickly, completely.
          </p>
        </div>

        {/* Date Pill Matching Reference */}
        <div className="flex items-center gap-2 self-start sm:self-auto rounded-xl border border-border/80 bg-card/60 backdrop-blur-sm px-3.5 py-2 text-xs font-medium text-muted-foreground shadow-sm">
          <Calendar className="size-3.5 text-muted-foreground/80" />
          <span>{currentDateStr}</span>
        </div>
      </div>

      {/* ── Main Workspace Card ── */}
      <div className="rounded-2xl border border-border/80 bg-card/60 backdrop-blur-sm shadow-xl shadow-black/20 overflow-hidden">
        {/* Workspace Card Header with Switch */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/70 bg-background/30 px-6 py-4">
          <div className="flex items-center gap-3">
            {activeWorkflow === "import" ? (
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
                <Upload className="size-5" />
              </div>
            ) : (
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <Download className="size-5" />
              </div>
            )}
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {activeWorkflow === "import" ? "Import Opportunities" : "Export Opportunities"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {activeWorkflow === "import"
                  ? "Bring your leads into Mast from a CSV file."
                  : "Download your leads from Mast."}
              </p>
            </div>
          </div>

          {/* Import / Export Switch */}
          <div className="flex items-center self-start sm:self-auto p-1 rounded-xl bg-background/80 border border-border/80 shadow-inner">
            <button
              type="button"
              onClick={() => setActiveWorkflow("import")}
              className={cn(
                "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer",
                activeWorkflow === "import"
                  ? "bg-brand/20 text-brand border border-brand/40 shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Upload className="size-3.5" />
              Import
            </button>
            <button
              type="button"
              onClick={() => setActiveWorkflow("export")}
              className={cn(
                "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer",
                activeWorkflow === "export"
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/40 shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Download className="size-3.5" />
              Export
            </button>
          </div>
        </div>

        {/* ── Workspace Body ── */}
        <div className="p-6">
          {activeWorkflow === "import" ? (
            /* ── IMPORT WORKFLOW ── */
            <div>
              {step === "upload" && (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDraggingOver(true);
                  }}
                  onDragLeave={() => setDraggingOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDraggingOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) handleFile(file);
                  }}
                  onClick={() => fileRef.current?.click()}
                  className={cn(
                    "cursor-pointer rounded-2xl border-2 border-dashed p-8 sm:p-12 text-center transition-all flex flex-col items-center justify-center relative",
                    draggingOver
                      ? "border-brand bg-brand/5 ring-2 ring-brand/20"
                      : "border-border/80 bg-background/40 hover:border-brand/50 hover:bg-background/60"
                  )}
                >
                  <CsvIconBadge />
                  <p className="mt-3.5 font-semibold text-sm sm:text-base text-foreground">
                    Drag and drop your CSV file here
                  </p>
                  <p className="my-1.5 text-xs text-muted-foreground/60">or</p>
                  <Button
                    type="button"
                    className="rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:via-indigo-500 hover:to-purple-500 text-white font-medium px-6 py-2.5 shadow-lg shadow-indigo-600/25 transition-all cursor-pointer text-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileRef.current?.click();
                    }}
                  >
                    Choose File
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFile(file);
                    }}
                  />
                  <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground/80">
                    <Info className="size-3.5 text-brand shrink-0" />
                    <span>Required: Business Name column</span>
                    <Info className="size-3.5 text-muted-foreground/40 shrink-0" />
                  </div>
                </div>
              )}

              {step === "map" && (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/40 px-4 py-2.5 text-xs sm:text-sm">
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 text-brand" />
                      <span className="font-semibold text-foreground">{fileName}</span>
                      <span className="text-muted-foreground">({csvRows.length} rows detected)</span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={resetImport} className="text-xs h-7 text-muted-foreground hover:text-foreground">
                      Change File
                    </Button>
                  </div>

                  {/* Summary Metric Cards */}
                  {preview && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        { label: "Opportunities Found", value: preview.total, tone: undefined },
                        { label: "New Opportunities", value: preview.parsed.length, tone: "success" as const },
                        { label: "Duplicates", value: preview.duplicates, tone: preview.duplicates > 0 ? "warning" as const : undefined },
                        { label: "Invalid Rows", value: preview.invalid, tone: preview.invalid > 0 ? "warning" as const : undefined },
                      ].map(({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) => (
                        <div
                          key={label}
                          className={cn(
                            "rounded-xl border p-3.5 text-center transition-colors",
                            tone === "success"
                              ? "border-success/20 bg-success/5"
                              : tone === "warning" && value > 0
                              ? "border-warning/20 bg-warning/5"
                              : "border-border/70 bg-background/40"
                          )}
                        >
                          <p
                            className={cn(
                              "text-xl sm:text-2xl font-bold",
                              tone === "success"
                                ? "text-success"
                                : tone === "warning" && value > 0
                                ? "text-warning"
                                : "text-foreground"
                            )}
                          >
                            {value.toLocaleString()}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Column Mapper */}
                  <div className="rounded-xl border border-border/70 bg-background/30 p-4 sm:p-5">
                    <h3 className="text-sm font-semibold text-foreground">Map Columns</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Auto-detected columns are preselected. Adjust anything that looks off.
                    </p>
                    <div className="mt-3.5 space-y-2 max-h-64 overflow-y-auto pr-1">
                      {csvColumns.map((column) => (
                        <div
                          key={column}
                          className="grid items-center gap-3 text-xs sm:text-sm sm:grid-cols-[180px_20px_1fr]"
                        >
                          <span className="truncate rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 font-mono text-xs text-foreground">
                            {column}
                          </span>
                          <span className="text-muted-foreground text-center">to</span>
                          <Select
                            value={mapping[column] ?? SKIP_VALUE}
                            onValueChange={(value) =>
                              setMapping((cur) => ({ ...cur, [column]: value }))
                            }
                          >
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SKIP_VALUE}>Skip this column</SelectItem>
                              {LEAD_FIELDS.map((field) => (
                                <SelectItem key={field.key} value={field.key}>
                                  {field.label}
                                  {field.required ? " *" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Preview Table */}
                  {preview && preview.parsed.length > 0 && (
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/60">
                      <div className="border-b border-border/70 bg-background/40 px-4 py-2.5">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                          Preview — First 3 Rows
                        </p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border/70 bg-background/20">
                              {csvColumns.slice(0, 5).map((column) => (
                                <th
                                  key={column}
                                  className="px-3 py-2 text-left font-semibold text-muted-foreground"
                                >
                                  {column}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {csvRows.slice(0, 3).map((row, index) => (
                              <tr
                                key={index}
                                className="border-b border-border/40 last:border-0 hover:bg-card/40"
                              >
                                {csvColumns.slice(0, 5).map((column) => (
                                  <td
                                    key={column}
                                    className="max-w-[160px] truncate px-3 py-2 text-muted-foreground"
                                  >
                                    {row[column] ?? ""}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {!hasBusinessName && (
                    <WarningBox icon={AlertCircle}>
                      Map at least one column to Business Name to continue.
                    </WarningBox>
                  )}
                  {hasBusinessName && preview && preview.parsed.length === 0 && (
                    <WarningBox icon={AlertTriangle}>
                      No importable rows found after duplicate and validation checks.
                    </WarningBox>
                  )}

                  <div className="flex items-center justify-end gap-3 pt-2">
                    <Button variant="outline" onClick={resetImport}>
                      Start Over
                    </Button>
                    <Button
                      onClick={() => void runImport()}
                      disabled={
                        bulkImport.isPending ||
                        !hasBusinessName ||
                        !preview ||
                        preview.parsed.length === 0
                      }
                      className="gap-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:via-indigo-500 hover:to-purple-500 text-white font-medium px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                    >
                      {bulkImport.isPending
                        ? "Importing…"
                        : `Import ${preview?.parsed.length ?? 0} Opportunit${
                            (preview?.parsed.length ?? 0) === 1 ? "y" : "ies"
                          }`}
                    </Button>
                  </div>
                </div>
              )}

              {step === "done" && importResult && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-success/30 bg-success/5 p-8 text-center">
                    <div className="mx-auto grid size-12 place-items-center rounded-full bg-success/10 border border-success/20">
                      <Check className="size-6 text-success" />
                    </div>
                    <h2 className="mt-3.5 text-lg font-semibold text-foreground">Import Complete</h2>
                    <div className="mt-4 flex justify-center gap-8">
                      <div className="text-center">
                        <p className="text-3xl font-bold text-success">
                          {importResult.imported.toLocaleString()}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">imported</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-muted-foreground">
                          {importResult.skipped.toLocaleString()}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">duplicates skipped</p>
                      </div>
                      <div className="text-center">
                        <p
                          className={cn(
                            "text-2xl font-bold",
                            importResult.failed > 0 ? "text-warning" : "text-muted-foreground"
                          )}
                        >
                          {importResult.failed.toLocaleString()}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">failed</p>
                      </div>
                    </div>
                    <div className="mt-6 flex justify-center gap-3">
                      <Button variant="outline" onClick={resetImport}>
                        Import Another File
                      </Button>
                      <Button
                        onClick={() => navigate({ to: "/dashboard/relationships" })}
                        className="gap-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:via-indigo-500 hover:to-purple-500 text-white font-medium px-5 py-2.5 rounded-xl shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                      >
                        <ArrowRight className="size-4" /> View Relationships
                      </Button>
                    </div>
                  </div>

                  {importResult.errors.length > 0 && (
                    <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning/5">
                      <button
                        className="flex w-full items-center justify-between px-4 py-2.5 text-xs sm:text-sm font-semibold text-warning"
                        onClick={() => setShowErrors((cur) => !cur)}
                      >
                        <span className="inline-flex items-center gap-2">
                          <AlertTriangle className="size-4" /> {importResult.errors.length} failed rows
                        </span>
                        {showErrors ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                      </button>
                      {showErrors && (
                        <div className="max-h-52 overflow-y-auto border-t border-warning/20">
                          {importResult.errors.map((error) => (
                            <div
                              key={`${error.row}-${error.reason}`}
                              className="flex items-center gap-3 border-b border-warning/10 px-4 py-2 text-xs last:border-0"
                            >
                              <XCircle className="size-4 shrink-0 text-warning" />
                              <span className="w-16 font-semibold">Row {error.row}</span>
                              <span className="text-muted-foreground">{error.reason}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* ── EXPORT WORKFLOW ── */
            <div className="space-y-5">
              {/* Scope Selector */}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Scope
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {renderScopeOption("all", "All Opportunities", "Export all your leads", Database)}
                  {renderScopeOption("status", "By Status", "Filter by lead status", Filter)}
                  {renderScopeOption("niche", "By Niche", "Filter by niche", Tag)}
                  {renderScopeOption("region", "By Region", "Filter by region", MapPin)}
                  {renderScopeOption(
                    "pipeline",
                    "By Pipeline Stage",
                    "Filter by pipeline stage",
                    BarChart3,
                    "sm:col-span-2"
                  )}
                </div>
              </div>

              {/* Sub-filter Selection Dropdown */}
              {exportScope !== "all" && exportScope !== "selected" && (
                <div className="rounded-xl border border-border/70 bg-background/40 p-3.5 space-y-2 animate-in fade-in-50 duration-200">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {exportScope === "status"
                      ? "Select Status"
                      : exportScope === "niche"
                      ? "Select Niche"
                      : exportScope === "region"
                      ? "Select Region"
                      : "Select Pipeline Stage"}
                  </label>
                  {exportScope === "status" ? (
                    <Select value={filterValue} onValueChange={setFilterValue}>
                      <SelectTrigger className="h-9 text-xs sm:text-sm">
                        <SelectValue placeholder="Choose a status…" />
                      </SelectTrigger>
                      <SelectContent>
                        {ALL_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : exportScope === "niche" ? (
                    <Select value={filterValue} onValueChange={setFilterValue}>
                      <SelectTrigger className="h-9 text-xs sm:text-sm">
                        <SelectValue placeholder="Choose a niche…" />
                      </SelectTrigger>
                      <SelectContent>
                        {uniqueNiches.length === 0 ? (
                          <SelectItem value="__none__" disabled>
                            No niches found
                          </SelectItem>
                        ) : (
                          uniqueNiches.map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  ) : exportScope === "region" ? (
                    <Select value={filterValue} onValueChange={setFilterValue}>
                      <SelectTrigger className="h-9 text-xs sm:text-sm">
                        <SelectValue placeholder="Choose a region…" />
                      </SelectTrigger>
                      <SelectContent>
                        {uniqueRegions.length === 0 ? (
                          <SelectItem value="__none__" disabled>
                            No regions found
                          </SelectItem>
                        ) : (
                          uniqueRegions.map((r) => (
                            <SelectItem key={r} value={r}>
                              {r}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  ) : exportScope === "pipeline" ? (
                    <Select value={filterValue} onValueChange={setFilterValue}>
                      <SelectTrigger className="h-9 text-xs sm:text-sm">
                        <SelectValue placeholder="Choose a pipeline stage…" />
                      </SelectTrigger>
                      <SelectContent>
                        {PIPELINE_STAGES.map((stage) => (
                          <SelectItem key={stage.value} value={stage.value}>
                            {stage.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              )}

              {/* Format Selector */}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Format
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setExportFormat("csv")}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer select-none",
                      exportFormat === "csv"
                        ? "border-brand/70 bg-brand/10 shadow-sm ring-1 ring-brand/30"
                        : "border-border/70 bg-background/40 hover:border-border hover:bg-card/50"
                    )}
                  >
                    <div className="size-9 rounded-lg bg-brand/15 border border-brand/25 flex items-center justify-center shrink-0">
                      <FileText className="size-4 text-brand" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold text-foreground">CSV</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        Best for most use cases
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (!isStarterPlus) {
                        toast.error("Upgrade to Starter or higher for Excel export.");
                        return;
                      }
                      setExportFormat("xlsx");
                    }}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer select-none relative",
                      exportFormat === "xlsx" && isStarterPlus
                        ? "border-brand/70 bg-brand/10 shadow-sm ring-1 ring-brand/30"
                        : isStarterPlus
                        ? "border-border/70 bg-background/40 hover:border-border hover:bg-card/50"
                        : "border-border/40 bg-muted/10 opacity-70 cursor-not-allowed"
                    )}
                  >
                    <div className="size-9 rounded-lg bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center shrink-0">
                      <FileSpreadsheet className="size-4 text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs sm:text-sm font-semibold text-foreground">Excel (.xlsx)</p>
                        {!isStarterPlus && <Lock className="size-3 text-muted-foreground" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">
                        For advanced analysis
                      </p>
                    </div>
                  </button>

                  <div
                    className="flex items-center gap-3 rounded-xl border border-border/40 bg-muted/10 p-3 text-left opacity-60 cursor-not-allowed select-none"
                    title="Coming soon"
                  >
                    <div className="size-9 rounded-lg bg-teal-500/15 border border-teal-500/25 flex items-center justify-center shrink-0">
                      <Globe className="size-4 text-teal-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs sm:text-sm font-semibold text-foreground">Google Sheets</p>
                        <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-bold text-blue-400 uppercase tracking-wider">
                          SOON
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">
                        Export directly to Sheets
                      </p>
                    </div>
                  </div>
                </div>

                {!isStarterPlus && (
                  <p className="text-xs text-muted-foreground pt-0.5">
                    <Lock className="inline size-3.5 mr-1" />
                    Excel export requires Starter plan or higher.{" "}
                    <a href="/dashboard/subscription" className="text-brand hover:underline font-medium">
                      Upgrade →
                    </a>
                  </p>
                )}
              </div>

              {/* Bottom Action Bar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-3 border-t border-border/60">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <div className="size-9 rounded-xl bg-brand/15 border border-brand/25 flex items-center justify-center shrink-0">
                    <Database className="size-4 text-brand" />
                  </div>
                  <div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xl sm:text-2xl font-bold text-foreground">
                        {previewCount.toLocaleString()}
                      </span>
                      <span className="text-xs sm:text-sm text-muted-foreground">
                        leads ready to export
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/70">
                      Based on your current filters
                    </p>
                  </div>
                </div>

                <Button
                  onClick={() => void handleExport()}
                  disabled={isExporting || previewCount === 0}
                  className="w-full sm:w-auto gap-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:via-indigo-500 hover:to-purple-500 text-white font-medium px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-600/20 transition-all cursor-pointer"
                >
                  {isExporting ? (
                    <>
                      <span className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Exporting…
                    </>
                  ) : (
                    <>
                      <Download className="size-4" />
                      Export Opportunities
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Compact History Section (Recent Imports & Recent Exports Side-by-Side) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Recent Imports Card */}
        <div className="rounded-2xl border border-border/80 bg-card/60 backdrop-blur-sm overflow-hidden shadow-lg shadow-black/10">
          <div className="flex items-center justify-between border-b border-border/70 bg-background/30 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
                <Upload className="size-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Recent Imports</h3>
                <p className="text-[11px] text-muted-foreground">Your latest imported files.</p>
              </div>
            </div>
            {importHistory.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAllImports((prev: boolean) => !prev)}
                className="rounded-lg border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card transition-colors cursor-pointer"
              >
                {showAllImports ? "Show Less" : "View All"}
              </button>
            )}
          </div>

          {importHistory.length === 0 ? (
            <HistoryEmptyState
              title="No imports yet"
              message="Your imported files will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/70 bg-background/20">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">File Name</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Leads</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllImports ? importHistory : importHistory.slice(0, 4)).map((entry: ImportHistoryEntry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-border/40 last:border-0 hover:bg-card/40 transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2 max-w-[160px] truncate">
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium text-foreground truncate">{entry.fileName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-semibold text-success">
                        {entry.leadsImported.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center rounded-md bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success border border-success/20">
                          Completed
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">
                        {formatDate(entry.date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent Exports Card */}
        <div className="rounded-2xl border border-border/80 bg-card/60 backdrop-blur-sm overflow-hidden shadow-lg shadow-black/10">
          <div className="flex items-center justify-between border-b border-border/70 bg-background/30 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <Download className="size-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Recent Exports</h3>
                <p className="text-[11px] text-muted-foreground">Your latest exported files.</p>
              </div>
            </div>
            {exportHistory.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAllExports((prev: boolean) => !prev)}
                className="rounded-lg border border-border/60 bg-background/50 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-card transition-colors cursor-pointer"
              >
                {showAllExports ? "Show Less" : "View All"}
              </button>
            )}
          </div>

          {exportHistory.length === 0 ? (
            <HistoryEmptyState
              title="No exports yet"
              message="Your exported files will appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/70 bg-background/20">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">File Name</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Leads</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Format</th>
                    <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllExports ? exportHistory : exportHistory.slice(0, 4)).map((entry: ExportHistoryEntry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-border/40 last:border-0 hover:bg-card/40 transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2 max-w-[160px] truncate">
                          <Download className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium text-foreground truncate">{entry.filter}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-semibold text-foreground">
                        {entry.recordCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold border",
                            entry.format === "Excel"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : "bg-brand/10 text-brand border-brand/20"
                          )}
                        >
                          {entry.format === "Excel" ? (
                            <FileSpreadsheet className="size-3" />
                          ) : (
                            <FileText className="size-3" />
                          )}
                          {entry.format}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">
                        {formatDate(entry.date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
