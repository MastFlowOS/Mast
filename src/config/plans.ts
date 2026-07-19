/**
 * Server-side mirror of frontend `src/lib/plans.ts` AND the plan-gated
 * parts of `src/lib/permissions.ts`.
 *
 * The frontend's copies are what render pricing/UI and drive client-side
 * fast-fail checks; THIS copy is what's actually enforced — a user's plan
 * is looked up here before every credit check, discovery mode decision,
 * channel/region gate, and pool-ranking decision. All three must stay in
 * sync manually until this becomes a shared package (flagged since Phase 1,
 * still not done — noted again here since Phase 5 made the gap concrete:
 * channel/region gating existed ONLY client-side through Phase 4).
 *
 * Phase 5 additions (Refinements 1 & 2):
 *  - `workerConcurrency` — max browser-backed tasks in `running` state per
 *    user at once.  Primary fairness enforcement for the discovery and
 *    enrichment worker pools.  Runtime override via PLAN_CONCURRENCY_OVERRIDES.
 *  - `priorityBand` — `{ base, ceiling }` integers defining the pg-boss
 *    priority band for this tier.  Tasks are scheduled inside [base, ceiling];
 *    a priority-aging job raises stale tasks toward the ceiling to prevent
 *    within-tier starvation without crossing into a higher tier's band.
 */

export type PlanId = "free" | "starter" | "pro" | "premium";

/**
 * Discovery behavior per the product philosophy doc:
 *  - free    -> always Live Discovery (real scrape, streamed results, never
 *               touches the Global Lead Pool)
 *  - starter -> Instant Discovery (pool-first, background-expand on miss)
 *  - pro     -> same as starter, but results are ranked by Opportunity Score
 *               before being returned
 *  - premium -> same as pro, plus AI Opportunity Intelligence downstream
 */
export type DiscoveryMode = "live" | "instant_pool" | "instant_pool_ranked";

export type PlanConfig = {
  id: PlanId;
  creditsLimit: number;
  maxLeadRequest: number;
  dailyLeadLimit: number;
  monthlyLeadLimit: number;
  discoveryMode: DiscoveryMode;
  aiAccess: "none" | "limited" | "standard" | "full";
  /** Mirrors permissions.ts PLAN_CAPABILITIES' channel-related FeatureIds. */
  channels: {
    email: boolean;
    phone: boolean;
    instagram: boolean;
    website: boolean;
  };
  /** Mirrors permissions.ts "regionalSearch" — false means localSearch only. */
  regionalSearch: boolean;

  /**
   * Maximum number of browser-backed tasks (discovery.task, enrich.website,
   * enrich.instagram) that can be in `running` state simultaneously for a
   * single user on this plan.  This is the primary fairness enforcement
   * mechanism — a plan can never hold more browser slots than this value,
   * regardless of how many tasks it has queued.  Override at runtime via
   * the PLAN_CONCURRENCY_OVERRIDES env var (JSON blob) so ops can tune
   * under load without a deploy.  Use getPlanConcurrency() to resolve
   * the effective value (env override takes precedence over this field).
   */
  workerConcurrency: number;

  /**
   * pg-boss priority band for this tier.  `base` is the minimum priority
   * a newly-dispatched task receives; `ceiling` is the maximum that the
   * priority-aging job can raise a stale task to.  The intra-plan
   * yield-based rank (computed in planner.ts) is scaled to fit within
   * [base, ceiling] so cross-plan and cross-tier ordering compose
   * correctly without collision.
   */
  priorityBand: { base: number; ceiling: number };
};

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    creditsLimit: 300,
    maxLeadRequest: 20,
    dailyLeadLimit: 20,
    monthlyLeadLimit: 300,
    discoveryMode: "live",
    aiAccess: "limited",
    channels: { email: true, phone: true, instagram: false, website: false },
    regionalSearch: false,
    workerConcurrency: 2,
    priorityBand: { base: 0, ceiling: 9 },
  },
  starter: {
    id: "starter",
    creditsLimit: 1500,
    maxLeadRequest: 100,
    dailyLeadLimit: 100,
    monthlyLeadLimit: 1500,
    discoveryMode: "instant_pool",
    aiAccess: "limited",
    channels: { email: true, phone: true, instagram: true, website: false },
    regionalSearch: true,
    workerConcurrency: 4,
    priorityBand: { base: 10, ceiling: 19 },
  },
  pro: {
    id: "pro",
    creditsLimit: 6000,
    maxLeadRequest: 400,
    dailyLeadLimit: 400,
    monthlyLeadLimit: 6000,
    discoveryMode: "instant_pool_ranked",
    aiAccess: "standard",
    channels: { email: true, phone: true, instagram: true, website: true },
    regionalSearch: true,
    workerConcurrency: 8,
    priorityBand: { base: 20, ceiling: 29 },
  },
  premium: {
    id: "premium",
    creditsLimit: 25000,
    maxLeadRequest: 1000,
    dailyLeadLimit: 1000,
    monthlyLeadLimit: 25000,
    discoveryMode: "instant_pool_ranked",
    aiAccess: "full",
    channels: { email: true, phone: true, instagram: true, website: true },
    regionalSearch: true,
    workerConcurrency: 16,
    priorityBand: { base: 30, ceiling: 39 },
  },
};

export function getPlan(planId: string | null | undefined): PlanConfig {
  return PLANS[(planId as PlanId) ?? "free"] ?? PLANS.free;
}

/**
 * Returns the effective worker concurrency cap for a plan, respecting the
 * PLAN_CONCURRENCY_OVERRIDES env var.  Import from here instead of reading
 * plan.workerConcurrency directly so that the runtime override is always
 * applied without callers having to know the resolution order.
 *
 * PLAN_CONCURRENCY_OVERRIDES is parsed and cached by env.ts at startup.
 * A bad JSON value or unknown plan key causes a startup validation failure,
 * not a silent runtime error.
 */
export function getPlanConcurrency(planId: PlanId, overrides: Partial<Record<PlanId, number>> = {}): number {
  return overrides[planId] ?? getPlan(planId).workerConcurrency;
}
