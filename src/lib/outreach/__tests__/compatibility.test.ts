import test from "node:test";
import assert from "node:assert/strict";
import { resolveCompatibility } from "@/lib/outreach/compatibility";

test("graphic_design + creative_services suppresses branding", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "creative_services", nicheValue: "graphic_design" });
  assert.ok(result.suppressedComponents.includes("branding"));
});

test("photography + creative_services (photography niche) suppresses branding and social", () => {
  const result = resolveCompatibility({ profession: "photography", category: "creative_services", nicheValue: "photography" });
  assert.ok(result.suppressedComponents.includes("branding"));
  assert.ok(result.suppressedComponents.includes("social"));
});

test("photography + creative_services (non-visual niche) suppresses only branding", () => {
  const result = resolveCompatibility({ profession: "photography", category: "creative_services", nicheValue: "music_studio" });
  assert.ok(result.suppressedComponents.includes("branding"));
  assert.equal(result.suppressedComponents.includes("social"), false);
});

test("music_audio + creative_services (music_studio niche) suppresses branding and social", () => {
  const result = resolveCompatibility({ profession: "music_audio", category: "creative_services", nicheValue: "music_studio" });
  assert.ok(result.suppressedComponents.includes("branding"));
  assert.ok(result.suppressedComponents.includes("social"));
});

test("digital_marketing + agency_tech (marketing_agency) suppresses social and growth", () => {
  const result = resolveCompatibility({ profession: "digital_marketing", category: "agency_tech", nicheValue: "marketing_agency" });
  assert.ok(result.suppressedComponents.includes("social"));
  assert.ok(result.suppressedComponents.includes("growth"));
});

test("digital_marketing + agency_tech (non-marketing niche) suppresses nothing", () => {
  const result = resolveCompatibility({ profession: "digital_marketing", category: "agency_tech", nicheValue: "saas" });
  assert.equal(result.suppressedComponents.includes("social"), false);
});

test("programming_tech + agency_tech/saas suppresses website and tech", () => {
  const result = resolveCompatibility({ profession: "programming_tech", category: "agency_tech", nicheValue: "saas" });
  assert.ok(result.suppressedComponents.includes("website"));
  assert.ok(result.suppressedComponents.includes("tech"));
});

test("programming_tech + agency_tech (non-technical niche) suppresses only tech", () => {
  const result = resolveCompatibility({ profession: "programming_tech", category: "agency_tech", nicheValue: "pr_agency" });
  assert.ok(result.suppressedComponents.includes("tech"));
  assert.equal(result.suppressedComponents.includes("website"), false);
});

test("data + agency_tech/saas suppresses tech", () => {
  const result = resolveCompatibility({ profession: "data", category: "agency_tech", nicheValue: "saas" });
  assert.ok(result.suppressedComponents.includes("tech"));
});

test("finance + financial_legal suppresses growth and newness", () => {
  const result = resolveCompatibility({ profession: "finance", category: "financial_legal", nicheValue: "accounting" });
  assert.ok(result.suppressedComponents.includes("growth"));
  assert.ok(result.suppressedComponents.includes("newness"));
});

test("healthcare category gets elevated-sensitivity tone", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "healthcare", nicheValue: "dental" });
  assert.equal(result.toneOverride, "elevated-sensitivity");
});

test("financial_legal category gets formal-preferred tone", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "financial_legal", nicheValue: "law_firm" });
  assert.equal(result.toneOverride, "formal-preferred");
});

test("nonprofit inside community_other gets formal-preferred tone", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "community_other", nicheValue: "nonprofit" });
  assert.equal(result.toneOverride, "formal-preferred");
});

test("religious_org inside community_other gets formal-preferred tone", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "community_other", nicheValue: "religious_org" });
  assert.equal(result.toneOverride, "formal-preferred");
});

test("plain community_other (e.g. 'other') gets no tone override", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "community_other", nicheValue: "other" });
  assert.equal(result.toneOverride, undefined);
});

test("veterinary terminology exception resolves to 'pet owners'", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "healthcare", nicheValue: "veterinary" });
  assert.equal(result.terminologyOverride, "pet owners");
});

test("non-veterinary healthcare terminology resolves to 'patients'", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "healthcare", nicheValue: "dental" });
  assert.equal(result.terminologyOverride, "patients");
});

test("establishedQuality is true for property, agency_tech, financial_legal", () => {
  for (const category of ["property", "agency_tech", "financial_legal"] as const) {
    const result = resolveCompatibility({ profession: "graphic_design", category, nicheValue: null });
    assert.equal(result.establishedQuality, true, category);
  }
});

test("establishedQuality is false for other categories", () => {
  const result = resolveCompatibility({ profession: "graphic_design", category: "food_beverage", nicheValue: "cafe" });
  assert.equal(result.establishedQuality, false);
});

test("resolveCompatibility is pure — identical input always produces identical output", () => {
  const input = { profession: "graphic_design", category: "creative_services", nicheValue: "graphic_design" } as const;
  const a = resolveCompatibility(input);
  const b = resolveCompatibility(input);
  assert.deepEqual(a, b);
});
