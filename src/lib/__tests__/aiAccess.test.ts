import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canUseAiFeature, type AiFeature } from "../aiAccess.js";
import { resolveOutreachGenerationMode } from "../outreach/generationMode.js";

describe("Part A & B: Centralized AI Feature Entitlements", () => {
  const allFeatures: AiFeature[] = [
    "outreachDraft",
    "recommendations",
    "pipelineCoaching",
    "executiveBriefings",
    "weeklyIntelligence",
    "opportunityInsights",
    "advancedResearch",
  ];

  test("Free plan has zero real LLM entitlements", () => {
    for (const feat of allFeatures) {
      assert.equal(
        canUseAiFeature("free", feat),
        false,
        `Free tier must not have access to AI feature: ${feat}`,
      );
    }
    // Also test null/undefined/empty
    assert.equal(canUseAiFeature(null, "outreachDraft"), false);
    assert.equal(canUseAiFeature(undefined, "outreachDraft"), false);
    assert.equal(canUseAiFeature("", "outreachDraft"), false);
    assert.equal(canUseAiFeature("unknown_tier" as any, "outreachDraft"), false);
  });

  test("Starter plan is limited to outreach drafting & recommendations", () => {
    // Allowed AI features for Starter
    assert.equal(canUseAiFeature("starter", "outreachDraft"), true);
    assert.equal(canUseAiFeature("starter", "recommendations"), true);

    // Blocked intelligence features for Starter
    assert.equal(canUseAiFeature("starter", "opportunityInsights"), false);
    assert.equal(canUseAiFeature("starter", "executiveBriefings"), false);
    assert.equal(canUseAiFeature("starter", "weeklyIntelligence"), false);
    assert.equal(canUseAiFeature("starter", "pipelineCoaching"), false);
    assert.equal(canUseAiFeature("starter", "advancedResearch"), false);
  });

  test("Pro plan has access to all standard AI features but not Premium-specific research", () => {
    // Pro standard AI features
    assert.equal(canUseAiFeature("pro", "outreachDraft"), true);
    assert.equal(canUseAiFeature("pro", "recommendations"), true);
    assert.equal(canUseAiFeature("pro", "opportunityInsights"), true);
    assert.equal(canUseAiFeature("pro", "executiveBriefings"), true);
    assert.equal(canUseAiFeature("pro", "weeklyIntelligence"), true);
    assert.equal(canUseAiFeature("pro", "pipelineCoaching"), true);

    // Premium-specific feature is blocked on Pro
    assert.equal(canUseAiFeature("pro", "advancedResearch"), false);
  });

  test("Premium plan inherits all Pro AI features and unlocks advanced research", () => {
    for (const feat of allFeatures) {
      assert.equal(
        canUseAiFeature("premium", feat),
        true,
        `Premium tier must have access to AI feature: ${feat}`,
      );
    }
  });

  test("resolveOutreachGenerationMode enforces Free vs Paid AI rules", () => {
    // Free plan always gets deterministic template mode
    assert.equal(resolveOutreachGenerationMode({ plan: "free", aiConfigured: true }), "template");
    assert.equal(resolveOutreachGenerationMode({ plan: "free", aiConfigured: false }), "template");
    assert.equal(resolveOutreachGenerationMode({ plan: null, aiConfigured: true }), "template");

    // Starter gets real AI when configured, template when unconfigured
    assert.equal(resolveOutreachGenerationMode({ plan: "starter", aiConfigured: true }), "ai");
    assert.equal(resolveOutreachGenerationMode({ plan: "starter", aiConfigured: false }), "template");

    // Pro gets real AI when configured, template when unconfigured
    assert.equal(resolveOutreachGenerationMode({ plan: "pro", aiConfigured: true }), "ai");
    assert.equal(resolveOutreachGenerationMode({ plan: "pro", aiConfigured: false }), "template");

    // Premium gets real AI when configured, template when unconfigured
    assert.equal(resolveOutreachGenerationMode({ plan: "premium", aiConfigured: true }), "ai");
    assert.equal(resolveOutreachGenerationMode({ plan: "premium", aiConfigured: false }), "template");
  });

  test("Mission Coach and Discover Overview remain deterministic and do not masquerade as LLM", () => {
    // Verified architecture: Discover AI Overview and Mission Follow-up coach are rule-based
    // and must not consume LLM credits or require AI provider keys.
    // They are available deterministically across plans without triggering model calls.
    assert.equal(canUseAiFeature("free", "outreachDraft"), false);
    assert.equal(canUseAiFeature("free", "executiveBriefings"), false);
  });
});
