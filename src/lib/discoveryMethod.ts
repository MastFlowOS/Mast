/**
 * Discovery METHOD — what actually happens when a user launches Discover.
 *
 * The user picks one of the three methods below in the Discover UI; the
 * server re-validates that choice against the plan's ceiling before
 * honoring it (see api.ts generateLeads and src/server/routes/discover.ts,
 * which reads `body.method` and rejects it with 403 if it's above what the
 * resolved plan allows). Each plan's `discoveryMode` in
 * src/config/plans.ts is that ceiling — the default method for the plan,
 * and the highest one it may select:
 *
 *   free            → live                 real scrape, results streamed
 *   starter         → instant_pool         pool first; any shortfall is
 *                                          scraped live in the background
 *   pro / premium   → instant_pool_ranked  same, ordered by Opportunity Score
 *
 * discoveryMethodForPlan() below returns that default/ceiling method —
 * used to preselect the Discover UI and to describe "your plan" in the
 * upgrade strip. isDiscoveryMethodEligible() is what actually gates
 * whether a given method can be selected/sent for a given plan.
 */
import { getPlan, isDiscoveryModeAllowed, type DiscoveryMode, type PlanId } from "../config/plans.js";
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

/**
 * Whether `method` is one `planId` may actually select/run — the same
 * ceiling check the server re-applies before honoring a chosen method.
 * Use this to decide which of DISCOVERY_METHODS are clickable vs locked.
 */
export function isDiscoveryMethodEligible(planId: string | null | undefined, method: DiscoveryMode): boolean {
  return isDiscoveryModeAllowed(planId, method);
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
