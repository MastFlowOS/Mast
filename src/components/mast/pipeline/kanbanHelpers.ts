/**
 * Pure helpers for the Pipeline "Kanban" view (formatting, bucketing, best-effort parsing),
 * kept apart from the components so they are easy to test and fast-refresh stays happy.
 */

export type ScoreBand = "all" | "hot" | "good" | "low" | "unscored";
export const SCORE_BANDS: { id: ScoreBand; label: string }[] = [
  { id: "all", label: "All scores" },
  { id: "hot", label: "80 and above" },
  { id: "good", label: "60 – 79" },
  { id: "low", label: "Below 60" },
  { id: "unscored", label: "Unscored" },
];

export function scoreBandOf(score: number | null | undefined): Exclude<ScoreBand, "all"> {
  if (score == null) return "unscored";
  if (score >= 80) return "hot";
  if (score >= 60) return "good";
  return "low";
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

const COUNTRIES = [
  "USA",
  "UK",
  "Canada",
  "Australia",
  "Egypt",
  "UAE",
  "Germany",
  "France",
  "Spain",
  "Italy",
  "Netherlands",
  "Ireland",
  "New Zealand",
  "India",
  "Singapore",
  "Brazil",
  "Mexico",
  "South Africa",
  "Saudi Arabia",
  "Qatar",
  "Kuwait",
  "Turkey",
  "Sweden",
  "Norway",
  "Denmark",
  "Portugal",
  "Poland",
  "Japan",
];
const COUNTRY_ALIAS: Record<string, string> = {
  us: "USA",
  usa: "USA",
  "united states": "USA",
  "united states of america": "USA",
  uk: "UK",
  gb: "UK",
  "united kingdom": "UK",
  "great britain": "UK",
  england: "UK",
  "united arab emirates": "UAE",
};

/** Best-effort country from a free-text location ("Austin, TX, United States"). Null when unsure. */
export function countryOf(location?: string | null): string | null {
  if (!location) return null;
  const parts = location
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const key = parts[i].toLowerCase();
    if (COUNTRY_ALIAS[key]) return COUNTRY_ALIAS[key];
    const hit = COUNTRIES.find((c) => c.toLowerCase() === key);
    if (hit) return hit;
  }
  return null;
}

export function sourceLabel(source?: string | null): string | null {
  if (!source) return null;
  const s = source.trim();
  if (!s) return null;
  if (s.toLowerCase() === "google_maps") return "Google Maps";
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
