import { updateSettings } from "@/lib/api";

export interface ImportHistoryEntry {
  id: string;
  fileName: string;
  date: string;
  leadsImported: number;
  duplicatesSkipped: number;
}

export interface ExportHistoryEntry {
  id: string;
  date: string;
  recordCount: number;
  format: "CSV" | "Excel";
  filter: string;
}

export const MAX_IMPORT_EXPORT_HISTORY = 50;

const LOCAL_IMPORT_PREFIX = "mast_import_history_v1";
const LOCAL_EXPORT_PREFIX = "mast_export_history_v1";

function localKey(prefix: string, userId: string): string {
  return `${prefix}:${userId}`;
}

export function createHistoryEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toTimestamp(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function isValidImportEntry(value: unknown): value is ImportHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.fileName === "string" &&
    typeof v.date === "string" &&
    typeof v.leadsImported === "number" &&
    Number.isFinite(v.leadsImported) &&
    typeof v.duplicatesSkipped === "number" &&
    Number.isFinite(v.duplicatesSkipped)
  );
}

function isValidExportEntry(value: unknown): value is ExportHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.date === "string" &&
    typeof v.recordCount === "number" &&
    Number.isFinite(v.recordCount) &&
    (v.format === "CSV" || v.format === "Excel") &&
    typeof v.filter === "string"
  );
}

function parseHistoryArray<T>(raw: unknown, guard: (value: unknown) => value is T): T[] {
  let decoded: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(decoded)) return [];
  return decoded.filter(guard);
}

export function parseImportHistory(raw: unknown): ImportHistoryEntry[] {
  return parseHistoryArray(raw, isValidImportEntry);
}

export function parseExportHistory(raw: unknown): ExportHistoryEntry[] {
  return parseHistoryArray(raw, isValidExportEntry);
}

export function mergeHistoryEntries<T extends { id: string; date: string }>(...lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => toTimestamp(b.date) - toTimestamp(a.date))
    .slice(0, MAX_IMPORT_EXPORT_HISTORY);
}

function readLocalRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalRaw(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore quota / restricted storage errors; remote profile settings still persist history.
  }
}

export function loadLocalImportHistory(userId: string): ImportHistoryEntry[] {
  if (!userId) return [];
  return mergeHistoryEntries(parseImportHistory(readLocalRaw(localKey(LOCAL_IMPORT_PREFIX, userId))));
}

export function loadLocalExportHistory(userId: string): ExportHistoryEntry[] {
  if (!userId) return [];
  return mergeHistoryEntries(parseExportHistory(readLocalRaw(localKey(LOCAL_EXPORT_PREFIX, userId))));
}

export function saveLocalImportHistory(userId: string, entries: ImportHistoryEntry[]): ImportHistoryEntry[] {
  const normalized = mergeHistoryEntries(entries);
  if (userId) {
    writeLocalRaw(localKey(LOCAL_IMPORT_PREFIX, userId), JSON.stringify(normalized));
  }
  return normalized;
}

export function saveLocalExportHistory(userId: string, entries: ExportHistoryEntry[]): ExportHistoryEntry[] {
  const normalized = mergeHistoryEntries(entries);
  if (userId) {
    writeLocalRaw(localKey(LOCAL_EXPORT_PREFIX, userId), JSON.stringify(normalized));
  }
  return normalized;
}

// Serialize remote settings writes so rapid back-to-back imports/exports never clobber each other.
let remoteSyncChain: Promise<unknown> = Promise.resolve();

export function enqueueHistoryRemoteSync(payload: {
  importHistory?: ImportHistoryEntry[];
  exportHistory?: ExportHistoryEntry[];
}): Promise<void> {
  const body: Record<string, string> = {};
  if (payload.importHistory !== undefined) {
    body.importHistory = JSON.stringify(mergeHistoryEntries(payload.importHistory));
  }
  if (payload.exportHistory !== undefined) {
    body.exportHistory = JSON.stringify(mergeHistoryEntries(payload.exportHistory));
  }
  if (Object.keys(body).length === 0) return Promise.resolve();

  const nextTask = remoteSyncChain.then(
    () => updateSettings(body),
    () => updateSettings(body),
  );
  remoteSyncChain = nextTask.catch(() => undefined);
  return nextTask.then(() => undefined);
}
