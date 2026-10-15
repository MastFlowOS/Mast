import type { PlanId } from "@/config/plans";
import { canUseAiFeature } from "@/lib/aiAccess";

export type OutreachGenerationMode = "ai" | "template";

/**
 * Resolves whether outreach generation should use actual LLM generation or deterministic templates.
 *
 * Rules:
 * - If user's plan is Free -> fallback template behavior ("template")
 * - If backend AI is not configured -> fallback template behavior ("template")
 * - Only when user is on a paid plan (Starter, Pro, Premium) AND AI is configured -> actual AI generation ("ai")
 */
export function resolveOutreachGenerationMode(params: {
  plan: PlanId | string | null | undefined;
  aiConfigured: boolean | undefined | null;
}): OutreachGenerationMode {
  const { plan, aiConfigured } = params;
  if (!plan || plan === "free") {
    return "template";
  }
  const isPaidEntitled = canUseAiFeature(plan as PlanId, "outreachDraft");
  if (isPaidEntitled && aiConfigured === true) {
    return "ai";
  }
  return "template";
}
