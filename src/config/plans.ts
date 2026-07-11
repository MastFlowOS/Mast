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
  },
};

export function getPlan(planId: string | null | undefined): PlanConfig {
  return PLANS[(planId as PlanId) ?? "free"] ?? PLANS.free;
}
