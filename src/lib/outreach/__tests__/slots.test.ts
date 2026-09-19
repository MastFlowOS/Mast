import test from "node:test";
import assert from "node:assert/strict";
import { PROFESSION_SLUGS } from "@/lib/professions";
import { getProfessionOutreachProfile } from "@/lib/outreach/professions";
import { CATEGORY_KEYS, getCategoryProfile } from "@/lib/outreach/niches/nicheCategories";
import { resolveAngle, resolveSlots, toSafeLeadFacts } from "@/lib/outreach/templates/slots";
import type { NormalizedOpportunitySignal } from "@/lib/outreach/types";

const LEAD = toSafeLeadFacts({
  id: 1,
  businessName: "Test Biz",
  niche: null,
  status: "new",
  createdAt: "",
  updatedAt: "",
} as any);

function baseInput(overrides: Partial<Parameters<typeof resolveAngle>[0]> = {}) {
  return {
    lead: LEAD,
    templateKey: "initial" as const,
    profession: getProfessionOutreachProfile("graphic_design"),
    category: getCategoryProfile("food_beverage"),
    signal: { available: false, rankedComponents: [], topComponent: null, score: null } as NormalizedOpportunitySignal,
    establishedQuality: false,
    continuity: null,
    senderName: null,
    ...overrides,
  };
}

test("opportunity-sourced angle: value is null (never a duplicate of text)", () => {
  const profession = getProfessionOutreachProfile("graphic_design");
  const input = baseInput({
    profession,
    signal: { available: true, rankedComponents: ["branding"], topComponent: "branding", score: 80 },
  });
  const angle = resolveAngle(input);
  assert.equal(angle.source, "opportunity");
  assert.equal(angle.value, null);
  assert.notEqual(angle.text, angle.value);
});

test("category-fallback angle: value is null (never a duplicate of text)", () => {
  const profession = getProfessionOutreachProfile("graphic_design");
  const category = getCategoryProfile("food_beverage");
  const input = baseInput({ profession, category, signal: { available: false, rankedComponents: [], topComponent: null, score: null } });
  const angle = resolveAngle(input);
  assert.equal(angle.source, "category-fallback");
  assert.equal(angle.value, null);
});

test("profession-generic angle: value is null, as before", () => {
  const profession = getProfessionOutreachProfile("finance");
  const category = getCategoryProfile("community_other");
  const input = baseInput({
    profession,
    category,
    signal: { available: false, rankedComponents: [], topComponent: null, score: null },
  });
  const angle = resolveAngle(input);
  if (angle.source === "profession-generic") {
    assert.equal(angle.value, null);
  }
});

test("across every profession x component (opportunity-sourced), angle.value is never equal to angle.text", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profession = getProfessionOutreachProfile(slug);
    for (const problem of profession.commonProblems) {
      const input = baseInput({
        profession,
        signal: { available: true, rankedComponents: [problem.component], topComponent: problem.component, score: 50 },
      });
      const angle = resolveAngle(input);
      assert.notEqual(angle.value, angle.text, `${slug}/${problem.component}`);
      assert.equal(angle.value, null, `${slug}/${problem.component} should omit value, not duplicate it`);
    }
  }
});

test("across every profession x category (fallback rung), angle.value is never equal to angle.text", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profession = getProfessionOutreachProfile(slug);
    for (const categoryKey of CATEGORY_KEYS) {
      const category = getCategoryProfile(categoryKey);
      const input = baseInput({
        profession,
        category,
        signal: { available: false, rankedComponents: [], topComponent: null, score: null },
      });
      const angle = resolveAngle(input);
      assert.notEqual(angle.value && angle.text === angle.value, true, `${slug}/${categoryKey}`);
    }
  }
});

test("resolveSlots: the 'value' slot is correctly omitted from SlotContent, never duplicating 'angle'", () => {
  const profession = getProfessionOutreachProfile("graphic_design");
  const input = baseInput({
    profession,
    signal: { available: true, rankedComponents: ["branding"], topComponent: "branding", score: 80 },
  });
  const angle = resolveAngle(input);
  const content = resolveSlots(input, ["opening", "observation", "angle", "value", "cta", "signoff"], angle);

  assert.ok(content.angle, "angle slot should be populated");
  assert.equal(content.value, undefined, "value slot should be omitted, not set to a duplicate of angle");
});

test("resolveSlots: observation and angle remain distinct authored sentences", () => {
  const profession = getProfessionOutreachProfile("graphic_design");
  const input = baseInput({
    profession,
    signal: { available: true, rankedComponents: ["branding"], topComponent: "branding", score: 80 },
  });
  const angle = resolveAngle(input);
  const content = resolveSlots(input, ["opening", "observation", "angle", "value", "cta", "signoff"], angle);
  assert.notEqual(content.observation, content.angle);
});
