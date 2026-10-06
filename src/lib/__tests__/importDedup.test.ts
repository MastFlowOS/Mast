/**
 * Import / Export Deduplication — Round-Trip Tests
 *
 * Validates the core identity-matching logic that both the client preview
 * (buildPreview) and the server-side bulkImportLeads rely on.
 *
 * Uses node:test runner compatible with tsx --test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Lead type (subset used in import/export) ────────────────────────────────

interface Lead {
  id: number;
  businessName: string;
  businessId?: string | null;
  instagramHandle?: string | null;
  email?: string | null;
  website?: string | null;
  phone?: string | null;
  niche?: string | null;
  location?: string | null;
  status: string;
  igFollowers?: string | null;
  igBio?: string | null;
  tags?: string | null;
  priority?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Normalization helpers (must match dashboard.import.tsx exactly) ──────────

function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase();
}

function normalizeHandle(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/^@/, "");
}

function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  let url = raw.trim().toLowerCase();
  url = url.replace(/^https?:\/\//, "");
  url = url.replace(/^www\./, "");
  url = url.split(/[/?#]/)[0] ?? "";
  url = url.replace(/[./]+$/, "");
  return url;
}

function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.length > 7 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

function normalizeBusinessName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Identity index (must match dashboard.import.tsx) ────────────────────────

interface LeadIdentityIndex {
  byMastId: Set<string>;
  byBusinessId: Set<string>;
  byEmail: Set<string>;
  byHandle: Set<string>;
  byDomain: Set<string>;
  byPhone: Set<string>;
  byNameKey: Set<string>;
}

function buildExistingLeadIndex(leads: Lead[]): LeadIdentityIndex {
  const idx: LeadIdentityIndex = {
    byMastId: new Set(),
    byBusinessId: new Set(),
    byEmail: new Set(),
    byHandle: new Set(),
    byDomain: new Set(),
    byPhone: new Set(),
    byNameKey: new Set(),
  };
  for (const l of leads) {
    if (l.id != null) idx.byMastId.add(String(l.id));
    if (l.businessId) idx.byBusinessId.add(l.businessId.trim().toLowerCase());
    const email = normalizeEmail(l.email);
    if (email) idx.byEmail.add(email);
    const handle = normalizeHandle(l.instagramHandle);
    if (handle) idx.byHandle.add(handle);
    const domain = normalizeDomain(l.website);
    if (domain) idx.byDomain.add(domain);
    const phone = normalizePhone(l.phone);
    if (phone) idx.byPhone.add(phone);
    const nameKey = normalizeBusinessName(l.businessName);
    if (nameKey) idx.byNameKey.add(nameKey);
  }
  return idx;
}

function isExistingLead(
  mapped: Record<string, string>,
  existingIndex: LeadIdentityIndex,
): boolean {
  const mastId = (mapped.mastId ?? "").trim();
  if (mastId && existingIndex.byMastId.has(mastId)) return true;
  const bizId = (mapped.businessId ?? "").trim().toLowerCase();
  if (bizId && existingIndex.byBusinessId.has(bizId)) return true;
  const email = normalizeEmail(mapped.email);
  if (email && existingIndex.byEmail.has(email)) return true;
  const handle = normalizeHandle(mapped.instagramHandle);
  if (handle && existingIndex.byHandle.has(handle)) return true;
  const domain = normalizeDomain(mapped.website);
  if (domain && existingIndex.byDomain.has(domain)) return true;
  const phone = normalizePhone(mapped.phone);
  if (phone && existingIndex.byPhone.has(phone)) return true;
  const hasAnyStrongerField = email || handle || domain || phone || mastId || bizId;
  if (!hasAnyStrongerField) {
    const nameKey = normalizeBusinessName(mapped.businessName);
    if (nameKey && existingIndex.byNameKey.has(nameKey)) return true;
  }
  return false;
}

// ─── CSV export simulation (must match dashboard.import.tsx) ─────────────────

function leadsToCSV(leads: Lead[]): string {
  const headers = [
    "Mast ID",
    "Business ID",
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
    lead.id != null ? String(lead.id) : "",
    lead.businessId ?? "",
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

// ─── CSV parser (must match dashboard.import.tsx) ────────────────────────────

type CsvRow = Record<string, string>;

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
      row.push(current.trim()); if (row.some((c) => c.length > 0)) rows.push(row); row = []; current = ""; continue;
    }
    current += char;
  }
  row.push(current.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);
  if (rows.length === 0) return { columns: [], rows: [] as CsvRow[] };
  const columns = rows[0].map((c) => c.trim()).filter(Boolean);
  const dataRows = rows.slice(1).map((cells) => {
    const entry: CsvRow = {};
    columns.forEach((col, i) => { entry[col] = cells[i] ?? ""; });
    return entry;
  });
  return { columns, rows: dataRows };
}

// ─── Field aliases (must match dashboard.import.tsx) ──────────────────────────

const FIELD_ALIASES: Record<string, string> = {
  "mast id": "mastId", "mastid": "mastId", "mast_id": "mastId", "id": "mastId", "lead id": "mastId",
  "business id": "businessId", "businessid": "businessId", "business_id": "businessId", "opportunity id": "businessId",
  "business name": "businessName", business: "businessName", company: "businessName",
  instagram: "instagramHandle", handle: "instagramHandle", "ig handle": "instagramHandle", "instagram handle": "instagramHandle",
  email: "email", "email address": "email",
  website: "website", url: "website",
  phone: "phone", "phone number": "phone",
  niche: "niche", category: "niche",
  location: "location", city: "location",
  followers: "igFollowers", "ig followers": "igFollowers",
  bio: "igBio", "ig bio": "igBio",
  notes: "notes", tags: "tags", priority: "priority",
  status: "status",
};

const SKIP_VALUE = "__skip__";

function guessField(column: string): string | null {
  const key = column.toLowerCase().trim().replace(/[\s_\-/\\]+/g, " ");
  return FIELD_ALIASES[key] ?? null;
}

// ─── buildPreview (must match dashboard.import.tsx) ──────────────────────────

interface CreateLeadBody {
  businessName: string;
  instagramHandle?: string;
  email?: string;
  [key: string]: unknown;
}

interface ParsedRow {
  rowIndex: number;
  data: CreateLeadBody;
  businessName: string;
  instagramHandle: string;
  email: string;
  isDuplicate: boolean;
  mastId: string;
}

function buildPreview(rows: CsvRow[], mapping: Record<string, string>, existingLeads: Lead[]) {
  const existingIndex = buildExistingLeadIndex(existingLeads);
  const seenInCsv = new Set<string>();
  const seenEmailsInCsv = new Set<string>();
  const parsed: ParsedRow[] = [];
  let invalid = 0;
  let duplicates = 0;

  rows.forEach((row, index) => {
    const mapped: Record<string, string> = {};
    for (const [column, field] of Object.entries(mapping)) {
      if (field && field !== SKIP_VALUE && row[column]) mapped[field] = row[column].trim();
    }
    const businessName = mapped.businessName ?? "";
    if (!businessName) { invalid += 1; return; }
    const instagramHandle = mapped.instagramHandle ?? "";
    const email = normalizeEmail(mapped.email);
    const mastId = (mapped.mastId ?? "").trim();

    if (isExistingLead(mapped, existingIndex)) { duplicates += 1; return; }

    const duplicateKey = `${normalizeBusinessName(businessName)}|${normalizeHandle(instagramHandle)}`;
    if (seenInCsv.has(duplicateKey) || (email && seenEmailsInCsv.has(email))) { duplicates += 1; return; }

    seenInCsv.add(duplicateKey);
    if (email) seenEmailsInCsv.add(email);
    parsed.push({
      rowIndex: index, businessName, instagramHandle, email, isDuplicate: false, mastId,
      data: { ...mapped, businessName, instagramHandle: instagramHandle || undefined, email: email || undefined, source: "csv_import" } as CreateLeadBody,
    });
  });

  return { parsed, invalid, duplicates, total: rows.length };
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

function makeLead(partial: Partial<Lead> & { id: number; businessName: string }): Lead {
  return {
    status: "new",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("Normalization helpers", () => {
  it("normalizeEmail lowercases and trims", () => {
    assert.equal(normalizeEmail("  Alice@Example.COM  "), "alice@example.com");
    assert.equal(normalizeEmail(null), "");
    assert.equal(normalizeEmail(undefined), "");
  });

  it("normalizeHandle strips @, lowercases", () => {
    assert.equal(normalizeHandle("@MyBrand"), "mybrand");
    assert.equal(normalizeHandle("mybrand"), "mybrand");
    assert.equal(normalizeHandle(null), "");
  });

  it("normalizeDomain extracts host, strips www", () => {
    assert.equal(normalizeDomain("https://www.example.com/page?q=1"), "example.com");
    assert.equal(normalizeDomain("http://Example.COM/"), "example.com");
    assert.equal(normalizeDomain("example.com"), "example.com");
    assert.equal(normalizeDomain(null), "");
  });

  it("normalizePhone keeps digits only and strips leading country code 1", () => {
    assert.equal(normalizePhone("+1 (555) 123-4567"), "5551234567");
    assert.equal(normalizePhone("555.123.4567"), "5551234567");
    assert.equal(normalizePhone(null), "");
  });

  it("normalizeBusinessName strips non-alphanumeric", () => {
    assert.equal(normalizeBusinessName("Joe's Coffee & Co."), "joescoffeeco");
    assert.equal(normalizeBusinessName("  JOE'S COFFEE  "), "joescoffee");
    assert.equal(normalizeBusinessName(null), "");
  });
});

describe("buildExistingLeadIndex", () => {
  it("indexes all identity fields", () => {
    const leads = [
      makeLead({ id: 1, businessName: "Acme Corp", email: "hello@acme.com", instagramHandle: "@acme", website: "https://acme.com", phone: "555-1234" }),
      makeLead({ id: 2, businessName: "Beta LLC", businessId: "uuid-123" }),
    ];
    const idx = buildExistingLeadIndex(leads);
    assert.equal(idx.byMastId.has("1"), true);
    assert.equal(idx.byMastId.has("2"), true);
    assert.equal(idx.byEmail.has("hello@acme.com"), true);
    assert.equal(idx.byHandle.has("acme"), true);
    assert.equal(idx.byDomain.has("acme.com"), true);
    assert.equal(idx.byPhone.has("5551234"), true);
    assert.equal(idx.byBusinessId.has("uuid-123"), true);
    assert.equal(idx.byNameKey.has("acmecorp"), true);
    assert.equal(idx.byNameKey.has("betallc"), true);
  });
});

describe("isExistingLead", () => {
  const leads = [
    makeLead({ id: 42, businessName: "Acme Corp", email: "hello@acme.com", instagramHandle: "@acme", website: "https://www.acme.com", phone: "+1-555-1234", businessId: "biz-uuid-1" }),
  ];
  const idx = buildExistingLeadIndex(leads);

  it("matches by Mast ID", () => {
    assert.equal(isExistingLead({ mastId: "42" }, idx), true);
    assert.equal(isExistingLead({ mastId: "999" }, idx), false);
  });

  it("matches by business ID", () => {
    assert.equal(isExistingLead({ businessId: "biz-uuid-1" }, idx), true);
    assert.equal(isExistingLead({ businessId: "BIZ-UUID-1" }, idx), true);
  });

  it("matches by email (case insensitive)", () => {
    assert.equal(isExistingLead({ email: "Hello@ACME.com", businessName: "Completely Different" }, idx), true);
  });

  it("matches by Instagram handle (strips @)", () => {
    assert.equal(isExistingLead({ instagramHandle: "@Acme", businessName: "Whatever" }, idx), true);
    assert.equal(isExistingLead({ instagramHandle: "acme", businessName: "Whatever" }, idx), true);
  });

  it("matches by website domain (strips protocol and www)", () => {
    assert.equal(isExistingLead({ website: "http://acme.com/about", businessName: "Different" }, idx), true);
    assert.equal(isExistingLead({ website: "https://www.acme.com", businessName: "Different" }, idx), true);
  });

  it("matches by phone (digits only)", () => {
    assert.equal(isExistingLead({ phone: "1 555 1234", businessName: "Diff" }, idx), true);
    assert.equal(isExistingLead({ phone: "(555) 1234", businessName: "Diff" }, idx), true);
  });

  it("falls back to business name when no stronger signal", () => {
    assert.equal(isExistingLead({ businessName: "Acme Corp" }, idx), true);
    assert.equal(isExistingLead({ businessName: "  acme  corp  " }, idx), true);
    assert.equal(isExistingLead({ businessName: "New Company" }, idx), false);
  });

  it("does NOT match by name alone when stronger fields differ", () => {
    assert.equal(isExistingLead({ businessName: "Acme Corp", email: "different@other.com" }, idx), false);
  });

  it("returns false for completely new leads", () => {
    assert.equal(isExistingLead({ businessName: "Brand New Co", email: "new@new.com", instagramHandle: "@brandnew" }, idx), false);
  });
});

describe("Export → Import round-trip (the bug scenario)", () => {
  const existingLeads: Lead[] = [
    makeLead({ id: 1, businessName: "Alpha Studio", email: "alpha@studio.com", instagramHandle: "@alphastudio", website: "https://alphastudio.com", phone: "+1-100-0001" }),
    makeLead({ id: 2, businessName: "Beta Designs", email: "contact@beta.design", instagramHandle: "@betadesigns", website: "https://www.beta.design" }),
    makeLead({ id: 3, businessName: "Gamma Works", email: "hello@gamma.works", phone: "200-0003", businessId: "gamma-uuid" }),
    makeLead({ id: 4, businessName: "Delta Agency", instagramHandle: "@delta_agency" }),
    makeLead({ id: 5, businessName: "Epsilon Co", email: "e@epsilon.co", website: "epsilon.co", phone: "300-0005" }),
  ];

  it("all exported rows are recognized as duplicates on re-import", () => {
    const csvText = leadsToCSV(existingLeads);
    const { columns, rows } = parseCsv(csvText);
    assert.equal(rows.length, 5);

    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }

    assert.equal(mapping["Mast ID"], "mastId");
    assert.equal(mapping["Business Name"], "businessName");
    assert.equal(mapping["Email"], "email");
    assert.equal(mapping["Instagram Handle"], "instagramHandle");

    const preview = buildPreview(rows, mapping, existingLeads);

    assert.equal(preview.total, 5);
    assert.equal(preview.duplicates, 5);
    assert.equal(preview.parsed.length, 0);
    assert.equal(preview.invalid, 0);
  });

  it("scaled test: 152 leads exported and re-imported yield 0 new, 152 duplicates", () => {
    const manyLeads: Lead[] = Array.from({ length: 152 }, (_, i) =>
      makeLead({
        id: 100 + i,
        businessName: `Business ${i}`,
        email: i % 2 === 0 ? `biz${i}@example.com` : null,
        instagramHandle: i % 3 === 0 ? `@biz${i}` : null,
        website: i % 4 === 0 ? `https://biz${i}.com` : null,
        phone: i % 5 === 0 ? `555-${String(i).padStart(4, "0")}` : null,
        businessId: i % 7 === 0 ? `uuid-${i}` : null,
      }),
    );

    const csvText = leadsToCSV(manyLeads);
    const { columns, rows } = parseCsv(csvText);
    assert.equal(rows.length, 152);

    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }

    const preview = buildPreview(rows, mapping, manyLeads);
    assert.equal(preview.total, 152);
    assert.equal(preview.duplicates, 152);
    assert.equal(preview.parsed.length, 0);
    assert.equal(preview.invalid, 0);
  });
});

describe("Genuinely new leads are still imported", () => {
  const existingLeads: Lead[] = [
    makeLead({ id: 1, businessName: "Existing Co", email: "existing@co.com" }),
  ];

  it("new rows pass through as non-duplicates", () => {
    const csvText = [
      '"Business Name","Email","Instagram Handle"',
      '"Brand New LLC","brand@new.com","@brandnew"',
      '"Another Fresh","fresh@company.io","@fresh"',
    ].join("\n");

    const { columns, rows } = parseCsv(csvText);
    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }

    const preview = buildPreview(rows, mapping, existingLeads);
    assert.equal(preview.total, 2);
    assert.equal(preview.duplicates, 0);
    assert.equal(preview.parsed.length, 2);
    assert.equal(preview.invalid, 0);
  });

  it("mix of new and duplicate rows is partitioned correctly", () => {
    const csvText = [
      '"Business Name","Email","Instagram Handle"',
      '"Existing Co","existing@co.com","@existingco"',
      '"Brand New LLC","brand@new.com","@brandnew"',
    ].join("\n");

    const { columns, rows } = parseCsv(csvText);
    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }

    const preview = buildPreview(rows, mapping, existingLeads);
    assert.equal(preview.total, 2);
    assert.equal(preview.duplicates, 1);
    assert.equal(preview.parsed.length, 1);
    assert.equal(preview.parsed[0].businessName, "Brand New LLC");
    assert.equal(preview.invalid, 0);
  });
});

describe("Within-CSV deduplication still works", () => {
  it("catches duplicate rows within the same CSV (no existing leads)", () => {
    const csvText = [
      '"Business Name","Email"',
      '"Acme","acme@test.com"',
      '"Acme","acme@test.com"',
      '"Beta","beta@test.com"',
    ].join("\n");

    const { columns, rows } = parseCsv(csvText);
    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }

    const preview = buildPreview(rows, mapping, []);
    assert.equal(preview.total, 3);
    assert.equal(preview.duplicates, 1);
    assert.equal(preview.parsed.length, 2);
    assert.equal(preview.invalid, 0);
  });
});

describe("CSV export includes MAST ID and Business ID columns", () => {
  it("exported CSV contains the ID columns", () => {
    const leads = [
      makeLead({ id: 99, businessName: "Test", businessId: "uuid-abc" }),
    ];
    const csv = leadsToCSV(leads);
    assert.ok(csv.includes('"Mast ID"'));
    assert.ok(csv.includes('"Business ID"'));
    assert.ok(csv.includes('"99"'));
    assert.ok(csv.includes('"uuid-abc"'));
  });
});

describe("Edge cases", () => {
  it("empty CSV produces no results", () => {
    const preview = buildPreview([], {}, []);
    assert.equal(preview.total, 0);
    assert.equal(preview.parsed.length, 0);
    assert.equal(preview.duplicates, 0);
    assert.equal(preview.invalid, 0);
  });

  it("CSV with missing business name marks rows as invalid", () => {
    const csvText = '"Email"\n"nobody@test.com"';
    const { columns, rows } = parseCsv(csvText);
    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }
    const preview = buildPreview(rows, mapping, []);
    assert.equal(preview.invalid, 1);
    assert.equal(preview.parsed.length, 0);
  });

  it("handles leads with only business name (no other identity fields)", () => {
    const existing = [makeLead({ id: 1, businessName: "Solo Name Lead" })];
    const csvText = '"Business Name"\n"Solo Name Lead"';
    const { columns, rows } = parseCsv(csvText);
    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const guess = guessField(col);
      if (guess) mapping[col] = guess;
    }
    const preview = buildPreview(rows, mapping, existing);
    assert.equal(preview.duplicates, 1);
    assert.equal(preview.parsed.length, 0);
  });
});
