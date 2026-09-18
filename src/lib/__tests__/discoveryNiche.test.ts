/**
 * Pure-helper tests for discovery niche attribution (src/lib/niches.ts).
 *
 * The bug these guard: discovered leads landed in the CRM with a blank niche
 * because the engine's result dicts carry no `niche` and nothing downstream
 * re-attached the niche the user had requested.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  attributeDiscoveryNiche,
  normalizeDiscoveryNiche,
  resolveLeadNiche,
  singleDiscoveryNiche,
  splitNicheQuery,
} from "../niches.js";

describe("normalizeDiscoveryNiche", () => {
  test("trims but otherwise preserves the exact string (no lower-casing, no slug)", () => {
    assert.equal(normalizeDiscoveryNiche("  Coffee Shops "), "Coffee Shops");
    assert.equal(normalizeDiscoveryNiche("Bar & Lounge"), "Bar & Lounge");
  });
  test("blank / missing / non-string input is null", () => {
    for (const v of ["", "   ", null, undefined, 0, {}]) assert.equal(normalizeDiscoveryNiche(v), null);
  });
});

describe("singleDiscoveryNiche", () => {
  test("A. one niche is returned as-is", () => {
    assert.equal(singleDiscoveryNiche("Coffee Shops"), "Coffee Shops");
  });
  test("a still-joined multi-niche string is null — never the first niche", () => {
    assert.equal(singleDiscoveryNiche("Coffee Shops, Barbers, Gyms"), null);
  });
  test("blank is null", () => {
    assert.equal(singleDiscoveryNiche(""), null);
    assert.equal(singleDiscoveryNiche(undefined), null);
  });
});

describe("attributeDiscoveryNiche", () => {
  test("A. stamps the requested niche onto a lead that has none, without mutating the input", () => {
    const engineLead = { name: "Blue Door", category: "Coffee shop" } as { name: string; category: string; niche?: string };
    const stamped = attributeDiscoveryNiche(engineLead, "Coffee Shops");
    assert.equal(stamped.niche, "Coffee Shops");
    assert.equal(stamped.name, "Blue Door");
    assert.equal(stamped.category, "Coffee shop", "Google's own category is left alone");
    assert.equal("niche" in engineLead, false, "input object must not be mutated");
  });
  test("the request wins over whatever the engine emitted", () => {
    assert.equal(attributeDiscoveryNiche({ niche: "test" }, "Barbers").niche, "Barbers");
  });
  test("D. no requested niche -> lead returned untouched, nothing fabricated", () => {
    const lead: { name: string; niche?: string } = { name: "x" };
    for (const requested of [undefined, null, "", "   "]) {
      const out = attributeDiscoveryNiche(lead, requested);
      assert.equal(out, lead);
      assert.equal(out.niche, undefined);
    }
  });
  test("C. a joined multi-niche request never leaks its first entry", () => {
    const lead: { niche?: string } = {};
    assert.equal(attributeDiscoveryNiche(lead, "Coffee Shops, Barbers, Gyms").niche, undefined);
  });
});

describe("resolveLeadNiche", () => {
  test("discovery niche outranks the business tag, including a different one", () => {
    assert.equal(resolveLeadNiche("Barbers", "Coffee Shops"), "Barbers");
    assert.equal(resolveLeadNiche("Barbers", null), "Barbers");
  });
  test("falls back to the business tag, then null", () => {
    assert.equal(resolveLeadNiche(null, "Coffee Shops"), "Coffee Shops");
    assert.equal(resolveLeadNiche(undefined, "  "), null);
    assert.equal(resolveLeadNiche(undefined, undefined), null);
  });
});

describe("splitNicheQuery (unchanged contract the attribution relies on)", () => {
  test("request order is preserved and case-insensitive duplicates collapse to the first spelling", () => {
    assert.deepEqual(splitNicheQuery("Coffee Shops, Barbers, coffee shops, Gyms"), ["Coffee Shops", "Barbers", "Gyms"]);
  });
});
