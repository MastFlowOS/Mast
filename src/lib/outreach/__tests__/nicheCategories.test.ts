import test from "node:test";
import assert from "node:assert/strict";
import { CATEGORY_KEYS, CATEGORY_PROFILES, getCategoryProfile } from "@/lib/outreach/niches/nicheCategories";

const VALID_COMPONENTS = ["website", "branding", "social", "growth", "newness", "tech"];

test("all 13 categories exist", () => {
  assert.equal(CATEGORY_KEYS.length, 13);
  for (const key of CATEGORY_KEYS) {
    assert.ok(CATEGORY_PROFILES[key], key);
  }
});

test("every category has all required fields", () => {
  for (const key of CATEGORY_KEYS) {
    const profile = getCategoryProfile(key);
    assert.equal(profile.categoryKey, key);
    assert.ok(profile.terminologyPreference.length > 0, key);
    assert.ok(profile.safeGeneralBusinessContext.length > 0, key);
    assert.ok(profile.genericFallbackAngle.length > 0, key);
    assert.ok(Array.isArray(profile.serviceOpportunityContext), key);
    assert.ok(profile.serviceOpportunityContext.length > 0, key);
    assert.ok("toneCaution" in profile, key);
  }
});

test("every serviceOpportunityContext component is one of the six valid components", () => {
  for (const key of CATEGORY_KEYS) {
    const profile = getCategoryProfile(key);
    for (const context of profile.serviceOpportunityContext) {
      assert.ok(VALID_COMPONENTS.includes(context.component), `${key}: ${context.component}`);
      assert.ok(context.concept.length > 0, key);
      assert.ok(context.safeWhen.length > 0, key);
    }
  }
});

test("toneCaution is only ever a valid value or null", () => {
  for (const key of CATEGORY_KEYS) {
    const profile = getCategoryProfile(key);
    assert.ok(profile.toneCaution === null || ["elevated-sensitivity", "formal-preferred"].includes(profile.toneCaution), key);
  }
});
