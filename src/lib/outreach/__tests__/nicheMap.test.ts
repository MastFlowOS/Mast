import test from "node:test";
import assert from "node:assert/strict";
import { NICHES } from "@/lib/lead-workspace";
import { resolveNiche, resolveCategory, FALLBACK_CATEGORY } from "@/lib/outreach/niches/nicheMap";
import { CATEGORY_KEYS } from "@/lib/outreach/niches/nicheCategories";

test("NICHES has exactly 71 controlled entries (sanity check for coverage claims)", () => {
  assert.equal(NICHES.length, 71);
});

test("every NICHES.value resolves to exactly one valid category", () => {
  for (const niche of NICHES) {
    const resolution = resolveNiche(niche.value);
    assert.equal(resolution.matched, true, `value "${niche.value}" should match`);
    assert.equal(resolution.nicheValue, niche.value);
    assert.ok((CATEGORY_KEYS as readonly string[]).includes(resolution.category), niche.value);
  }
});

test("every NICHES.label resolves to the same category as its value", () => {
  for (const niche of NICHES) {
    const byValue = resolveNiche(niche.value);
    const byLabel = resolveNiche(niche.label);
    assert.equal(byLabel.matched, true, `label "${niche.label}" should match`);
    assert.equal(byLabel.nicheValue, niche.value);
    assert.equal(byLabel.category, byValue.category);
  }
});

test("matching is case-insensitive", () => {
  assert.equal(resolveNiche("CAFE").nicheValue, "cafe");
  assert.equal(resolveNiche("Cafe").nicheValue, "cafe");
  assert.equal(resolveNiche("CAFÉ").nicheValue, "cafe");
  assert.equal(resolveNiche("café").nicheValue, "cafe");
});

test("surrounding whitespace is ignored", () => {
  assert.equal(resolveNiche("  cafe  ").nicheValue, "cafe");
  assert.equal(resolveNiche(" Café ").nicheValue, "cafe");
});

test("explicit examples from spec", () => {
  assert.equal(resolveCategory("cafe"), "food_beverage");
  assert.equal(resolveCategory(" Café "), "food_beverage");
  assert.equal(resolveCategory("CAFÉ"), "food_beverage");
  assert.equal(resolveCategory("cafes"), "community_other");
});

test("null/undefined/empty/whitespace-only fall back, never guess", () => {
  assert.deepEqual(resolveNiche(null), { nicheValue: null, category: FALLBACK_CATEGORY, matched: false });
  assert.deepEqual(resolveNiche(undefined), { nicheValue: null, category: FALLBACK_CATEGORY, matched: false });
  assert.deepEqual(resolveNiche(""), { nicheValue: null, category: FALLBACK_CATEGORY, matched: false });
  assert.deepEqual(resolveNiche("   "), { nicheValue: null, category: FALLBACK_CATEGORY, matched: false });
});

test("unknown string falls back to community_other", () => {
  const result = resolveNiche("totally_made_up_niche_xyz");
  assert.equal(result.matched, false);
  assert.equal(result.category, "community_other");
  assert.equal(result.nicheValue, null);
});

test("near-miss does NOT fuzzy-match (cafes, coffee shops, resturant)", () => {
  assert.equal(resolveNiche("cafes").matched, false);
  assert.equal(resolveNiche("coffee shops").matched, false);
  assert.equal(resolveNiche("resturant").matched, false);
  assert.equal(resolveNiche("Cafe ").matched, true); // sanity: exact + trim still matches
});
