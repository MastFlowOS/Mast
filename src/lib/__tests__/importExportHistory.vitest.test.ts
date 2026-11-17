import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdateSettings } = vi.hoisted(() => ({
  mockUpdateSettings: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  updateSettings: mockUpdateSettings,
}));

import {
  MAX_IMPORT_EXPORT_HISTORY,
  enqueueHistoryRemoteSync,
  loadLocalExportHistory,
  loadLocalImportHistory,
  mergeHistoryEntries,
  parseExportHistory,
  parseImportHistory,
  saveLocalExportHistory,
  saveLocalImportHistory,
  type ExportHistoryEntry,
  type ImportHistoryEntry,
} from "@/lib/importExportHistory";

describe("importExportHistory persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockUpdateSettings.mockReset();
    mockUpdateSettings.mockResolvedValue({});
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("persists import and export history in localStorage per user across reloads", () => {
    const imp: ImportHistoryEntry = {
      id: "imp-1",
      fileName: "leads.csv",
      date: "2026-11-17T06:00:00.000Z",
      leadsImported: 24,
      duplicatesSkipped: 3,
    };
    const exp: ExportHistoryEntry = {
      id: "exp-1",
      date: "2026-11-17T06:05:00.000Z",
      recordCount: 24,
      format: "CSV",
      filter: "All Opportunities",
    };

    saveLocalImportHistory("user-a", [imp]);
    saveLocalExportHistory("user-a", [exp]);

    expect(loadLocalImportHistory("user-a")).toEqual([imp]);
    expect(loadLocalExportHistory("user-a")).toEqual([exp]);
    expect(loadLocalImportHistory("user-b")).toEqual([]);
    expect(loadLocalExportHistory("user-b")).toEqual([]);
  });

  it("merges local and remote history, deduplicates by id, sorts newest first, and caps entries", () => {
    const older: ImportHistoryEntry = {
      id: "imp-old",
      fileName: "old.csv",
      date: "2026-11-15T10:00:00.000Z",
      leadsImported: 5,
      duplicatesSkipped: 0,
    };
    const newer: ImportHistoryEntry = {
      id: "imp-new",
      fileName: "new.csv",
      date: "2026-11-17T07:00:00.000Z",
      leadsImported: 12,
      duplicatesSkipped: 1,
    };

    const merged = mergeHistoryEntries([older], [older, newer]);
    expect(merged.map((e) => e.id)).toEqual(["imp-new", "imp-old"]);

    const many: ImportHistoryEntry[] = Array.from({ length: MAX_IMPORT_EXPORT_HISTORY + 10 }, (_, idx) => ({
      id: `imp-${idx}`,
      fileName: `batch-${idx}.csv`,
      date: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
      leadsImported: 1,
      duplicatesSkipped: 0,
    }));
    const capped = mergeHistoryEntries(many);
    expect(capped).toHaveLength(MAX_IMPORT_EXPORT_HISTORY);
    expect(capped[0].id).toBe(`imp-${MAX_IMPORT_EXPORT_HISTORY + 9}`);
  });

  it("ignores malformed or corrupted stored JSON gracefully", () => {
    expect(parseImportHistory("not-json")).toEqual([]);
    expect(parseImportHistory(JSON.stringify([{ id: "bad" }, null, 42]))).toEqual([]);
    expect(parseExportHistory(JSON.stringify([{ id: "e1", date: "2026-11-17", recordCount: 2, format: "PDF", filter: "All" }]))).toEqual([]);
  });

  it("serializes remote settings sync calls so rapid updates do not overlap", async () => {
    const events: string[] = [];
    mockUpdateSettings.mockImplementation(async (body: Record<string, string>) => {
      const key = Object.keys(body)[0];
      events.push(`start:${key}`);
      await new Promise((r) => setTimeout(r, 15));
      events.push(`end:${key}`);
      return body;
    });

    await Promise.all([
      enqueueHistoryRemoteSync({
        importHistory: [
          {
            id: "imp-seq",
            fileName: "a.csv",
            date: "2026-11-17T07:00:00.000Z",
            leadsImported: 1,
            duplicatesSkipped: 0,
          },
        ],
      }),
      enqueueHistoryRemoteSync({
        exportHistory: [
          {
            id: "exp-seq",
            date: "2026-11-17T07:01:00.000Z",
            recordCount: 1,
            format: "CSV",
            filter: "All Opportunities",
          },
        ],
      }),
    ]);

    expect(events).toEqual([
      "start:importHistory",
      "end:importHistory",
      "start:exportHistory",
      "end:exportHistory",
    ]);
  });
});
