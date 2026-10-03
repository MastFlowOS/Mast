/**
 * "What to search next" — the four setup suggestions shown beside the main
 * recommendation in the Discover AI Overview.
 *
 * Everything here is derived from the user's own leads and plan limits; nothing
 * is invented. When there is no data to base a suggestion on, that suggestion is
 * simply `null` and the UI says so. Pure (no React / no network) so it can be
 * tested, and so a real AI service can later return the same `NextSearchSuggestions`
 * shape without any UI change.
 */
import type { Lead } from "./api";
import { normalizeLeadStatus } from "./lead-workspace";

export type Suggestion<T> = {
  value: T;
  /** One short, factual line explaining the suggestion. */
  reason: string;
};

export type NextSearchSuggestions = {
  niche: Suggestion<string> | null;
  region: Suggestion<string> | null;
  /** `null` when there is no capacity left to run anything. */
  amount: Suggestion<number> | null;
  /** A single channel: requesting several makes the match stricter (AND). */
  channel: Suggestion<string> | null;
};

export type SuggestionContext = {
  leads: readonly Lead[];
  /** Niche names the form can actually select. */
  nicheCatalog: readonly string[];
  /** True if a region token is valid AND allowed on the user's plan. */
  isUsableRegion: (token: string) => boolean;
  quantitySteps: readonly number[];
  maxQuantity: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  /** Channel ids the user's plan may use, in preference order (cheapest first). */
  allowedChannels: readonly string[];
};

const REPLIED = new Set([
  "conversation", "replied", "interested", "meeting", "proposal",
  "negotiation", "closed_won", "meeting_booked",
]);
const MEETING = new Set(["meeting", "proposal", "negotiation", "closed_won", "meeting_booked"]);
const UNCONTACTED = new Set(["discovered", "ready", "new"]);

const contacted = (l: Lead) => !UNCONTACTED.has(normalizeLeadStatus(l.status)) || Boolean(l.lastContactedAt);
const replied = (l: Lead) => REPLIED.has(normalizeLeadStatus(l.status));
const meeting = (l: Lead) => MEETING.has(normalizeLeadStatus(l.status));

type Tally = { total: number; contacted: number; replied: number; meetings: number };

/** Rank buckets: best reply rate (≥2 contacted) → most meetings → most businesses. */
function pickBest(
  buckets: Map<string, Tally>,
  noun: string,
): { key: string; reason: string } | null {
  const all = [...buckets.entries()];
  if (all.length === 0) return null;

  const byRate = all
    .filter(([, t]) => t.contacted >= 2 && t.replied > 0)
    .sort((a, b) => b[1].replied / b[1].contacted - a[1].replied / a[1].contacted || b[1].meetings - a[1].meetings);
  if (byRate[0]) return { key: byRate[0][0], reason: `Your best reply rate so far.` };

  const byMeetings = all.filter(([, t]) => t.meetings > 0).sort((a, b) => b[1].meetings - a[1].meetings);
  if (byMeetings[0]) return { key: byMeetings[0][0], reason: `Most meetings booked so far.` };

  const byVolume = all.sort((a, b) => b[1].total - a[1].total);
  return { key: byVolume[0][0], reason: `Most ${noun} found so far.` };
}

function tally(map: Map<string, Tally>, key: string, lead: Lead) {
  const t = map.get(key) ?? { total: 0, contacted: 0, replied: 0, meetings: 0 };
  t.total++;
  if (contacted(lead)) t.contacted++;
  if (replied(lead)) t.replied++;
  if (meeting(lead)) t.meetings++;
  map.set(key, t);
}

export function buildNextSearchSuggestions(ctx: SuggestionContext): NextSearchSuggestions {
  const { leads } = ctx;

  // ── Niche ──
  const catalogByLower = new Map(ctx.nicheCatalog.map((n) => [n.toLowerCase(), n]));
  const niches = new Map<string, Tally>();
  for (const lead of leads) {
    const first = lead.niche?.split(",")[0]?.trim().toLowerCase();
    const name = first ? catalogByLower.get(first) : undefined;
    if (name) tally(niches, name, lead);
  }
  const bestNiche = pickBest(niches, "businesses");

  // ── Region: the first valid country / continent in a lead's location ──
  const regions = new Map<string, Tally>();
  for (const lead of leads) {
    const parts = (lead.location ?? "").split(",").map((p) => p.trim()).filter(Boolean).reverse();
    const token = parts.find((p) => ctx.isUsableRegion(p));
    if (token) tally(regions, token, lead);
  }
  const bestRegion = pickBest(regions, "businesses");

  // ── Amount: a batch you can follow up on, never above what's left ──
  const cap = Math.min(ctx.maxQuantity, ctx.dailyRemaining, ctx.monthlyRemaining);
  const target = leads.length === 0 ? 10 : 25;
  const fitting = ctx.quantitySteps.filter((s) => s <= Math.min(target, cap));
  const amount = fitting.length
    ? {
        value: fitting[fitting.length - 1],
        reason:
          cap < target
            ? "Fits your remaining capacity."
            : leads.length === 0
              ? "A focused first batch."
              : "A batch you can follow up on.",
      }
    : null;

  // ── Channel: whichever one most of your businesses already have ──
  let channel: Suggestion<string> | null = null;
  if (ctx.allowedChannels.length > 0) {
    const has: Record<string, (l: Lead) => boolean> = {
      email: (l) => Boolean(l.email),
      phone: (l) => Boolean(l.phone),
      instagram: (l) => Boolean(l.instagramHandle),
      website: (l) => Boolean(l.website),
    };
    const scored = ctx.allowedChannels.map((id, order) => ({
      id,
      order,
      n: has[id] ? leads.filter(has[id]).length : 0,
    }));
    const best = scored.sort((a, b) => b.n - a.n || a.order - b.order)[0];
    channel = {
      value: best.id,
      reason: best.n > 0 ? "Found for most of your businesses." : "Lowest cost — fewer filters, more results.",
    };
  }

  return {
    niche: bestNiche ? { value: bestNiche.key, reason: bestNiche.reason } : null,
    region: bestRegion ? { value: bestRegion.key, reason: bestRegion.reason } : null,
    amount,
    channel,
  };
}
