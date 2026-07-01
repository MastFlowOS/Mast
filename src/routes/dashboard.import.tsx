import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Upload,
  XCircle,
  Download,
  Filter,
  Users,
  BarChart3,
  Clock,
  FileSpreadsheet,
  Globe,
  Package,
  Zap,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { useBulkImportLeads, useLeads, useMe } from "@/hooks/use-mast-api";
import type { CreateLeadBody, Lead } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getPlan } from "@/lib/plans";

export const Route = createFileRoute("/dashboard/import")({
  head: () => ({ meta: [{ title: "Data Import / Export — Mast" }] }),
  component: ImportExportPage,
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
  "new", "priority", "warm", "contacted", "instagram_sent", "email_sent",
  "contact_form_sent", "replied", "follow_up_due", "interested",
  "meeting_booked", "closed", "won", "dead", "lost",
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

    if (char === '"' && inQuotes && next === '"') { current += '"'; index += 1; continue; }
    if (char === '"') { inQuotes = !inQuotes; continue; }
    if (char === "," && !inQuotes) { row.push(current.trim()); current = ""; continue; }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = []; current = ""; continue;
    }
    current += char;
  }

  row.push(current.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  if (rows.length === 0) return { columns: [], rows: [] as CsvRow[] };

  const columns = rows[0].map((column) => column.trim()).filter(Boolean);
  const dataRows = rows.slice(1).map((cells) => {
    const entry: CsvRow = {};
    columns.forEach((column, index) => { entry[column] = cells[index] ?? ""; });
    return entry;
  });

  return { columns, rows: dataRows };
}

function leadsToCSV(leads: Lead[]): string {
  const headers = [
    "Business Name", "Instagram Handle", "Email", "Website", "Phone",
    "Niche", "Location", "Status", "IG Followers", "IG Bio",
    "Tags", "Priority", "Notes", "Created At",
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
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PreviewMetric({ label, value, tone, large }: { label: string; value: number | string; tone?: "success" | "warning" | "info"; large?: boolean }) {
  const color = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "info" ? "text-brand" : "text-muted-foreground";
  return (
    <div className="text-center">
      <p className={`${large ? "text-3xl" : "text-2xl"} font-bold ${color}`}>{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Warning({ children, icon: Icon }: { children: React.ReactNode; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
      <Icon className="size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10">
        <Icon className="size-4 text-brand" />
      </div>
      <div>
        <h2 className="font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, message }: { icon: React.ComponentType<{ className?: string }>; title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-muted/50 mb-3">
        <Icon className="size-5 text-muted-foreground/50" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground/60">{message}</p>
    </div>
  );
}

// ─── Export Section ───────────────────────────────────────────────────────────

function ExportSection({
  planId,
  onExportComplete,
}: {
  planId: string;
  onExportComplete: (entry: ExportHistoryEntry) => void;
}) {
  const isStarterPlus = planId !== "free";

  const [exportScope, setExportScope] = useState<ExportScope>("all");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [filterValue, setFilterValue] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const { data: leadsData } = useLeads({ limit: 5000 });
  const allLeads: Lead[] = Array.isArray(leadsData) ? leadsData : (leadsData as { leads?: Lead[] })?.leads ?? [];

  const getFilteredLeads = (): Lead[] => {
    if (exportScope === "all") return allLeads;
    if (exportScope === "status" && filterValue) return allLeads.filter((l) => l.status === filterValue);
    if (exportScope === "niche" && filterValue) return allLeads.filter((l) => (l.niche ?? "").toLowerCase().includes(filterValue.toLowerCase()));
    if (exportScope === "region" && filterValue) return allLeads.filter((l) => (l.location ?? "").toLowerCase().includes(filterValue.toLowerCase()));
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
  };

  const filteredLeads = getFilteredLeads();
  const previewCount = filteredLeads.length;

  const handleExport = async () => {
    if (previewCount === 0) { toast.error("No opportunities match your filter."); return; }
    setIsExporting(true);
    try {
      const timestamp = new Date().toISOString().split("T")[0];
      const scopeLabel = exportScope === "all" ? "all-leads"
        : exportScope === "status" ? `status-${filterValue}`
        : exportScope === "niche" ? `niche-${filterValue || "all"}`
        : exportScope === "region" ? `region-${filterValue || "all"}`
        : exportScope === "pipeline" ? `pipeline-${filterValue || "all"}`
        : "selected-leads";

      if (exportFormat === "csv") {
        const csvContent = leadsToCSV(filteredLeads);
        downloadFile(csvContent, `mast-export-${scopeLabel}-${timestamp}.csv`, "text/csv");
      } else if (exportFormat === "xlsx" && isStarterPlus) {
        // For xlsx, we export as CSV with .xlsx extension for now — structured for future XLSX library
        const csvContent = leadsToCSV(filteredLeads);
        downloadFile(csvContent, `mast-export-${scopeLabel}-${timestamp}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      }

      toast.success(`${previewCount.toLocaleString()} opportunities exported`);
      onExportComplete({
        id: Date.now().toString(),
        date: new Date().toISOString(),
        recordCount: previewCount,
        format: exportFormat === "xlsx" ? "Excel" : "CSV",
        filter: exportScope === "all" ? "All Opportunities"
          : exportScope === "status" ? `Status: ${filterValue}`
          : exportScope === "niche" ? `Niche: ${filterValue || "all"}`
          : exportScope === "region" ? `Region: ${filterValue || "all"}`
          : exportScope === "pipeline" ? `Pipeline: ${filterValue || "all"}`
          : "Selected",
      });
    } catch {
      toast.error("Export failed. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  const uniqueNiches = [...new Set(allLeads.map((l) => l.niche).filter(Boolean))] as string[];
  const uniqueRegions = [...new Set(allLeads.map((l) => l.location).filter(Boolean))] as string[];

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-background/50 px-5 py-4">
        <SectionHeader icon={Download} title="Export Opportunities" subtitle="Download your relationship data in your preferred format" />
      </div>

      <div className="p-5 space-y-5">
        {/* Scope selector */}
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Export Scope</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[
              { value: "all", label: "All Opportunities", icon: Users },
              { value: "status", label: "By Status", icon: Filter },
              { value: "niche", label: "By Niche", icon: Package },
              { value: "region", label: "By Region", icon: Globe },
              { value: "pipeline", label: "By Pipeline Stage", icon: BarChart3 },
            ].map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => { setExportScope(value as ExportScope); setFilterValue(""); }}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  exportScope === value
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border bg-background text-muted-foreground hover:border-brand/40 hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Filter input */}
        {exportScope !== "all" && exportScope !== "selected" && (
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {exportScope === "status" ? "Select Status" : exportScope === "niche" ? "Select Niche" : exportScope === "region" ? "Select Region" : "Select Stage"}
            </label>
            {exportScope === "status" ? (
              <Select value={filterValue} onValueChange={setFilterValue}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choose a status…" />
                </SelectTrigger>
                <SelectContent>
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : exportScope === "niche" ? (
              <Select value={filterValue} onValueChange={setFilterValue}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choose a niche…" />
                </SelectTrigger>
                <SelectContent>
                  {uniqueNiches.length === 0
                    ? <SelectItem value="__none__" disabled>No niches found</SelectItem>
                    : uniqueNiches.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)
                  }
                </SelectContent>
              </Select>
            ) : exportScope === "region" ? (
              <Select value={filterValue} onValueChange={setFilterValue}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choose a region…" />
                </SelectTrigger>
                <SelectContent>
                  {uniqueRegions.length === 0
                    ? <SelectItem value="__none__" disabled>No regions found</SelectItem>
                    : uniqueRegions.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)
                  }
                </SelectContent>
              </Select>
            ) : exportScope === "pipeline" ? (
              <Select value={filterValue} onValueChange={setFilterValue}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choose a pipeline stage…" />
                </SelectTrigger>
                <SelectContent>
                  {PIPELINE_STAGES.map((stage) => (
                    <SelectItem key={stage.value} value={stage.value}>{stage.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        )}

        {/* Format selector */}
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Export Format</label>
          <div className="flex gap-2">
            <button
              onClick={() => setExportFormat("csv")}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                exportFormat === "csv" ? "border-brand bg-brand/10 text-brand" : "border-border bg-background text-muted-foreground hover:border-brand/40"
              }`}
            >
              <FileText className="size-3.5" /> CSV
            </button>

            <button
              onClick={() => {
                if (!isStarterPlus) { toast.error("Upgrade to Starter or higher for Excel export."); return; }
                setExportFormat("xlsx");
              }}
              className={`relative flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                exportFormat === "xlsx" && isStarterPlus
                  ? "border-brand bg-brand/10 text-brand"
                  : isStarterPlus
                  ? "border-border bg-background text-muted-foreground hover:border-brand/40"
                  : "border-border bg-muted/30 text-muted-foreground/50 cursor-not-allowed"
              }`}
            >
              <FileSpreadsheet className="size-3.5" /> Excel (.xlsx)
              {!isStarterPlus && <Lock className="size-3 ml-0.5 text-muted-foreground/50" />}
            </button>

            <button
              disabled
              className="relative flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-4 py-2.5 text-sm font-medium text-muted-foreground/40 cursor-not-allowed"
              title="Coming soon"
            >
              <Globe className="size-3.5" /> Google Sheets
              <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">Soon</span>
            </button>
          </div>
          {!isStarterPlus && (
            <p className="text-xs text-muted-foreground">
              <Lock className="inline size-3 mr-1" />
              Excel export requires Starter plan or higher.{" "}
              <a href="/dashboard/subscription" className="text-brand hover:underline">Upgrade →</a>
            </p>
          )}
        </div>

        {/* Preview count + Export button */}
        <div className="flex items-center justify-between rounded-xl border border-border bg-background/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-brand" />
            <span className="text-sm font-semibold">{previewCount.toLocaleString()} leads ready to export</span>
          </div>
          <Button
            onClick={() => void handleExport()}
            disabled={isExporting || previewCount === 0}
            className="gap-2 bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {isExporting ? (
              <><span className="size-3.5 border-2 border-brand-foreground/30 border-t-brand-foreground rounded-full animate-spin" /> Exporting…</>
            ) : (
              <><Download className="size-4" /> Export {previewCount > 0 ? previewCount.toLocaleString() : ""} Opportunities</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function ImportExportPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const bulkImport = useBulkImportLeads();
  const { data: auth } = useMe();
  const planId = auth?.user?.plan ?? "free";

  const [csvColumns, setCsvColumns] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [step, setStep] = useState<"upload" | "map" | "done">("upload");
  const [draggingOver, setDraggingOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
    errors: Array<{ row: number; reason: string }>;
  } | null>(null);

  // Histories (stored in component state — no backend yet)
  const [importHistory, setImportHistory] = useState<ImportHistoryEntry[]>([]);
  const [exportHistory, setExportHistory] = useState<ExportHistoryEntry[]>([]);

  const preview = csvRows.length > 0 ? buildPreview(csvRows, mapping) : null;
  const hasBusinessName = Object.values(mapping).includes("businessName");

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Please upload a CSV file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsv(String(reader.result ?? ""));
        if (parsed.rows.length === 0) { toast.error("This CSV has no data rows."); return; }
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

  const reset = () => {
    setCsvColumns([]); setCsvRows([]); setMapping({}); setStep("upload");
    setDraggingOver(false); setFileName(""); setShowErrors(false); setImportResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const runImport = async () => {
    if (!preview || preview.parsed.length === 0) return;
    try {
      const result = await bulkImport.mutateAsync({ leads: preview.parsed.map((row) => row.data) });
      const failed = result.failed ?? result.errors?.length ?? 0;
      setImportResult({ imported: result.imported, skipped: result.skipped, failed, errors: result.errors ?? [] });
      setStep("done");
      toast.success(`${result.imported} opportunities imported`);
      setImportHistory((prev) => [{
        id: Date.now().toString(),
        fileName,
        date: new Date().toISOString(),
        leadsImported: result.imported,
        duplicatesSkipped: result.skipped,
      }, ...prev]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    }
  };

  const plan = getPlan(planId);

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Data Import / Export</h1>
        <p className="text-sm text-muted-foreground">Move data into and out of Mast — cleanly, quickly, completely.</p>
      </div>

      {/* ── IMPORT SECTION ── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-background/50 px-5 py-4">
          <SectionHeader icon={Upload} title="Import Opportunities" subtitle="Upload a CSV, map columns, then bulk-import into Mast" />
        </div>

        <div className="p-5 space-y-5">
          {step === "upload" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
              onDragLeave={() => setDraggingOver(false)}
              onDrop={(e) => { e.preventDefault(); setDraggingOver(false); const file = e.dataTransfer.files[0]; if (file) handleFile(file); }}
              onClick={() => fileRef.current?.click()}
              className={`cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${
                draggingOver ? "border-brand bg-brand/5" : "border-border hover:border-brand/40"
              }`}
            >
              <Upload className="mx-auto mb-3 size-10 text-muted-foreground" />
              <p className="font-semibold text-foreground">Drop your CSV here</p>
              <p className="mt-1 text-sm text-muted-foreground">or click to browse</p>
              <Button variant="outline" className="mt-5 gap-2" onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>
                <FileText className="size-4" /> Choose File
              </Button>
              <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFile(file); }} />
              <p className="mt-5 text-xs text-muted-foreground">Required column: Business Name or an equivalent alias.</p>
            </div>
          )}

          {step === "map" && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <FileText className="size-4" />
                <span className="font-semibold text-foreground">{fileName}</span>
                <span>{csvRows.length} rows detected</span>
              </div>

              {/* IMPROVED: Import preview summary up top */}
              {preview && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: "Opportunities Found", value: preview.total, tone: undefined },
                    { label: "New Opportunities", value: preview.parsed.length, tone: "success" as const },
                    { label: "Duplicates", value: preview.duplicates, tone: preview.duplicates > 0 ? "warning" as const : undefined },
                    { label: "Invalid Rows", value: preview.invalid, tone: preview.invalid > 0 ? "warning" as const : undefined },
                  ].map(({ label, value, tone }) => (
                    <div key={label} className={`rounded-xl border p-4 text-center ${
                      tone === "success" ? "border-success/20 bg-success/5"
                      : tone === "warning" && value > 0 ? "border-warning/20 bg-warning/5"
                      : "border-border bg-background/50"
                    }`}>
                      <p className={`text-2xl font-bold ${
                        tone === "success" ? "text-success" : tone === "warning" && value > 0 ? "text-warning" : "text-foreground"
                      }`}>{value.toLocaleString()}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-2xl border border-border bg-background/30 p-5">
                <h2 className="font-semibold">Map Columns</h2>
                <p className="mt-1 text-xs text-muted-foreground">Auto-detected columns are preselected. Adjust anything that looks off.</p>
                <div className="mt-4 space-y-2">
                  {csvColumns.map((column) => (
                    <div key={column} className="grid items-center gap-3 text-sm sm:grid-cols-[180px_20px_1fr]">
                      <span className="truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">{column}</span>
                      <span className="text-muted-foreground">to</span>
                      <Select value={mapping[column] ?? SKIP_VALUE} onValueChange={(value) => setMapping((cur) => ({ ...cur, [column]: value }))}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SKIP_VALUE}>Skip this column</SelectItem>
                          {LEAD_FIELDS.map((field) => (
                            <SelectItem key={field.key} value={field.key}>{field.label}{field.required ? " *" : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>

              {preview && preview.parsed.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border bg-background/50 px-5 py-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Preview — First 3 Rows</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border">
                          {csvColumns.slice(0, 5).map((column) => (
                            <th key={column} className="px-3 py-2 text-left font-semibold text-muted-foreground">{column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0, 3).map((row, index) => (
                          <tr key={index} className="border-b border-border/40 last:border-0">
                            {csvColumns.slice(0, 5).map((column) => (
                              <td key={column} className="max-w-[160px] truncate px-3 py-2">{row[column] ?? ""}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!hasBusinessName && <Warning icon={AlertCircle}>Map at least one column to Business Name to continue.</Warning>}
              {hasBusinessName && preview && preview.parsed.length === 0 && (
                <Warning icon={AlertTriangle}>No importable rows found after duplicate and validation checks.</Warning>
              )}

              <div className="flex gap-3">
                <Button variant="outline" onClick={reset}>Start Over</Button>
                <Button
                  onClick={() => void runImport()}
                  disabled={bulkImport.isPending || !hasBusinessName || !preview || preview.parsed.length === 0}
                  className="bg-brand text-brand-foreground hover:bg-brand/90"
                >
                  {bulkImport.isPending ? "Importing…" : `Import ${preview?.parsed.length ?? 0} Opportunit${(preview?.parsed.length ?? 0) === 1 ? "y" : "ies"}`}
                </Button>
              </div>
            </div>
          )}

          {step === "done" && importResult && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-success/30 bg-success/5 p-8 text-center">
                <div className="mx-auto grid size-12 place-items-center rounded-full bg-success/10">
                  <Check className="size-6 text-success" />
                </div>
                <h2 className="mt-4 text-lg font-semibold">Import Complete</h2>
                <div className="mt-5 flex justify-center gap-8">
                  <PreviewMetric label="imported" value={importResult.imported} tone="success" large />
                  <PreviewMetric label="duplicates skipped" value={importResult.skipped} />
                  <PreviewMetric label="failed" value={importResult.failed} tone={importResult.failed > 0 ? "warning" : undefined} />
                </div>
                <div className="mt-6 flex justify-center gap-3">
                  <Button variant="outline" onClick={reset}>Import Another File</Button>
                  <Button onClick={() => navigate({ to: "/dashboard/relationships" })} className="gap-2 bg-brand text-brand-foreground hover:bg-brand/90">
                    <ArrowRight className="size-4" /> View Relationships
                  </Button>
                </div>
              </div>

              {importResult.errors.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-warning/30 bg-warning/5">
                  <button
                    className="flex w-full items-center justify-between px-5 py-3 text-sm font-semibold text-warning"
                    onClick={() => setShowErrors((cur) => !cur)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <AlertTriangle className="size-4" /> {importResult.errors.length} failed rows
                    </span>
                    {showErrors ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  </button>
                  {showErrors && (
                    <div className="max-h-56 overflow-y-auto border-t border-warning/20">
                      {importResult.errors.map((error) => (
                        <div key={`${error.row}-${error.reason}`} className="flex items-center gap-3 border-b border-warning/10 px-5 py-2 text-xs last:border-0">
                          <XCircle className="size-3.5 shrink-0 text-warning" />
                          <span className="w-16 font-semibold">Row {error.row}</span>
                          <span>{error.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── EXPORT SECTION ── */}
      <ExportSection planId={planId} onExportComplete={(entry) => setExportHistory((prev) => [entry, ...prev])} />

      {/* ── IMPORT HISTORY ── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border bg-background/50 px-5 py-4">
          <SectionHeader icon={Clock} title="Recent Imports" subtitle="History of CSV files imported into Mast" />
        </div>
        {importHistory.length === 0 ? (
          <EmptyState icon={Upload} title="No imports yet" message="Once you import a CSV file, it will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-background/30">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">File Name</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Opportunities Imported</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duplicates Skipped</th>
                </tr>
              </thead>
              <tbody>
                {importHistory.map((entry) => (
                  <tr key={entry.id} className="border-b border-border/40 last:border-0 hover:bg-card/50">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-medium text-foreground">{entry.fileName}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{formatDate(entry.date)}</td>
                    <td className="px-5 py-3 text-right">
                      <span className="font-semibold text-success">{entry.leadsImported.toLocaleString()}</span>
                    </td>
                    <td className="px-5 py-3 text-right text-muted-foreground">{entry.duplicatesSkipped.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── EXPORT HISTORY ── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border bg-background/50 px-5 py-4">
          <SectionHeader icon={Clock} title="Recent Exports" subtitle="History of relationship data exported from Mast" />
        </div>
        {exportHistory.length === 0 ? (
          <EmptyState icon={Download} title="No exports yet" message="Once you export your leads, the history will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-background/30">
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Filter</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Records</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Format</th>
                </tr>
              </thead>
              <tbody>
                {exportHistory.map((entry) => (
                  <tr key={entry.id} className="border-b border-border/40 last:border-0 hover:bg-card/50">
                    <td className="px-5 py-3 text-muted-foreground">{formatDate(entry.date)}</td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        <Filter className="size-3" /> {entry.filter}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-foreground">{entry.recordCount.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right">
                      <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${
                        entry.format === "Excel" ? "bg-green-500/10 text-green-500" : "bg-brand/10 text-brand"
                      }`}>
                        {entry.format === "Excel" ? <FileSpreadsheet className="size-3" /> : <FileText className="size-3" />}
                        {entry.format}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
