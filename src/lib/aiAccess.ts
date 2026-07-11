import type { PlanId } from "../config/plans.js";

/**
 * Server-side mirror of the AI-related slice of frontend
 * `src/lib/permissions.ts` PLAN_CAPABILITIES — same drift-risk disclaimer
 * as config/plans.ts already carries for the rest of the plan config.
 * These five capabilities are the only ones Phase 8 actually enforces
 * server-side; the rest (relationships, pipeline, channels, etc.) are
 * unrelated to AI Opportunity Intelligence.
 */
export type AiFeature =
  | "recommendations"
  | "pipelineCoaching"
  | "executiveBriefings"
  | "weeklyIntelligence"
  | "opportunityInsights";

const AI_FEATURE_PLANS: Record<AiFeature, PlanId> = {
  recommendations: "starter",
  pipelineCoaching: "pro",
  executiveBriefings: "premium",
  weeklyIntelligence: "premium",
  opportunityInsights: "premium",
};

const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, pro: 2, premium: 3 };

export function canUseAiFeature(plan: PlanId, feature: AiFeature): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[AI_FEATURE_PLANS[feature]];
}
