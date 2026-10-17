import type { PlanId } from "../config/plans.js";

/**
 * Server-side mirror of the AI-related slice of frontend
 * `src/lib/permissions.ts` PLAN_CAPABILITIES — same drift-risk disclaimer
 * as config/plans.ts already carries for the rest of the plan config.
 * These five capabilities are the only ones Phase 8 actually enforces
 * server-side; the rest (relationships, pipeline, channels, etc.) are
 * unrelated to AI Opportunity Intelligence.
 */
/**
 * Centralized server-side entitlement mapping for AI features.
 *
 * Official plan policy:
 * - Free: Zero LLM/API model requests.
 * - Starter: Real LLM access strictly limited to outreach drafting and editing ("outreachDraft", "recommendations").
 * - Pro: Real LLM access permitted for all standard AI features ("outreachDraft", "opportunityInsights", "executiveBriefings", "pipelineCoaching", "weeklyIntelligence").
 * - Premium: Includes all Pro AI features plus Premium-specific advanced business research ("advancedResearch").
 */
export type AiFeature =
  | "recommendations"
  | "pipelineCoaching"
  | "executiveBriefings"
  | "weeklyIntelligence"
  | "opportunityInsights"
  | "outreachDraft"
  | "discoverOverview"
  | "missionCoach"
  | "advancedResearch";

const AI_FEATURE_PLANS: Record<AiFeature, PlanId> = {
  recommendations: "starter",
  outreachDraft: "starter",
  pipelineCoaching: "pro",
  executiveBriefings: "pro",
  weeklyIntelligence: "pro",
  opportunityInsights: "pro",
  discoverOverview: "pro",
  missionCoach: "pro",
  advancedResearch: "premium",
};

const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, pro: 2, premium: 3 };

export function canUseAiFeature(plan: PlanId | string | null | undefined, feature: AiFeature): boolean {
  if (!plan) return false;
  const normalized = String(plan).toLowerCase().trim() as PlanId;
  const rank = PLAN_RANK[normalized];
  if (rank === undefined) return false;
  const requiredPlan = AI_FEATURE_PLANS[feature];
  if (!requiredPlan) return false;
  return rank >= PLAN_RANK[requiredPlan];
}
