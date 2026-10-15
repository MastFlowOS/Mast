import type { Lead } from "./api";

/**
 * Converts an array of Lead objects into CSV formatted string.
 * Mirrors the canonical field mapping and escaping used in MAST import/export.
 */
export function leadsToCSV(leads: Lead[]): string {
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
    lead.businessName ?? "",
    lead.instagramHandle ?? "",
    lead.email ?? "",
    lead.website ?? "",
    lead.phone ?? "",
    lead.niche ?? "",
    lead.location ?? "",
    lead.status ?? "",
    lead.igFollowers != null ? String(lead.igFollowers) : "",
    lead.igBio ?? "",
    lead.tags ?? "",
    lead.priority ?? "",
    lead.notes ?? "",
    lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : "",
  ]);

  return [headers, ...rows]
    .map((row) =>
      row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
}

/**
 * Triggers a client-side browser file download for text/blob content.
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Helper to export one or more leads directly as a CSV file.
 */
export function exportLeadsAsCSV(leads: Lead[], customFilename?: string): { success: boolean; count: number; filename: string } {
  if (!leads || leads.length === 0) {
    throw new Error("No leads selected for export");
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  let filename = customFilename;

  if (!filename) {
    if (leads.length === 1) {
      const sanitizedName = (leads[0].businessName || "lead")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      filename = `mast-lead-${sanitizedName || leads[0].id}-${timestamp}.csv`;
    } else {
      filename = `mast-leads-export-${leads.length}-${timestamp}.csv`;
    }
  }

  const csvContent = leadsToCSV(leads);
  downloadFile(csvContent, filename, "text/csv;charset=utf-8;");

  return { success: true, count: leads.length, filename };
}
