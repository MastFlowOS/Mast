/**
 * Discovery METHOD — what actually happens when a user launches Discover.
 *
 * The method is derived from the user's PLAN on the server, not chosen per
 * request ("MAST decides, not the user" — see api.ts generateLeads and
 * src/server/routes/discover.ts, which sets `mode: plan.discoveryMode` and
 * never reads a request-supplied mode). The server's plan table
 * (src/config/plans.ts) is the single source of truth and is what this
 * module reads, so the UI can never claim something the backend doesn't do:
 *
 *   free            → live                 real scrape, results streamed
 *   starter         → instant_pool         pool first; any shortfall is
 *                                          scraped live in the background
 *   pro / premium   → instant_pool_ranked  same, ordered by Opportunity Score
 */
import { getPlan, type DiscoveryMode, type PlanId } from "../config/plans.js";
import type { GenerationMode } from "./plans.js";

export type DiscoveryMethod = {
  id: DiscoveryMode;
  label: string;
  shortLabel: string;
  desc: string;
  /** One line of extra truth, shown only for the method the plan uses. */
  note: string;
  timeLabel: string;
  /** Lowest plan that runs this method, for the comparison tag. */
  minPlan: PlanId;
  minPlanLabel: string;
  /** Short pitch used by the compact upgrade strip. */
  pitch: string;
};

export const DISCOVERY_METHODS: readonly DiscoveryMethod[] = [
  {
    id: "live",
    label: "Live Scraping",
    shortLabel: "Live scraping",
    desc: "Fresh businesses discovered from the web in real time",
    note: "Results stream in as they are found",
    timeLabel: "10–30 min",
    minPlan: "free",
    minPlanLabel: "Free",
    pitch: "Fresh businesses from the web",
  },
  {
    id: "instant_pool",
    label: "Instant Pool Access",
    shortLabel: "Instant pool",
    desc: "Pre-verified businesses from MAST's curated pool",
    note: "Any shortfall is scraped live in the background",
    timeLabel: "Instant",
    minPlan: "starter",
    minPlanLabel: "Starter",
    pitch: "Pre-verified businesses, delivered instantly",
  },
  {
    id: "instant_pool_ranked",
    label: "Ranked Instant Results",
    shortLabel: "Ranked instant",
    desc: "Instant pool results ordered by Opportunity Score",
    note: "Best-scoring opportunities first; any shortfall is scraped live",
    timeLabel: "Instant",
    minPlan: "pro",
    minPlanLabel: "Pro",
    pitch: "Best-scoring opportunities first",
  },
];

/** The method the backend will actually run for this plan. */
export function discoveryMethodForPlan(planId: string | null | undefined): DiscoveryMethod {
  const mode = getPlan(planId).discoveryMode;
  return DISCOVERY_METHODS.find((m) => m.id === mode) ?? DISCOVERY_METHODS[0];
}

/** The next method up the plan ladder, or null if already on the top one. */
export function nextDiscoveryMethod(planId: string | null | undefined): DiscoveryMethod | null {
  const current = discoveryMethodForPlan(planId);
  const idx = DISCOVERY_METHODS.findIndex((m) => m.id === current.id);
  return DISCOVERY_METHODS[idx + 1] ?? null;
}

/** Client request `mode` value matching what the server will do (mirrors
 * api.ts backendModeToGenerationMode). Informational only — the server
 * derives the real mode from the plan. */
export function generationModeFor(mode: DiscoveryMode): GenerationMode {
  if (mode === "live") return "scrape";
  if (mode === "instant_pool_ranked") return "premium";
  return "pool";
}
