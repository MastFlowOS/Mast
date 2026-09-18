/**
 * CRM niche display + filter (src/lib/lead-workspace.ts).
 *
 * Filter options are NICHES slugs ("coffee_shop"); discovered leads store the
 * exact discovery string ("Coffee Shop"); manual leads store the slug. The
 * filter must match all of them without rewriting the stored value.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EMPTY_NICHE_LABEL,
  NICHES,
  leadMatchesNicheFilter,
  leadNicheDisplay,
  leadNicheLabel,
  nicheMatchKey,
} from "../lead-workspace.js";

describe("K. CRM niche display", () => {
  test('a stored discovery niche renders exactly as stored ("Coffee Shops")', () => {
    assert.equal(leadNicheDisplay("Coffee Shops"), "Coffee Shops");
    assert.equal(leadNicheLabel("Coffee Shops"), "Coffee Shops");
  });
  test("blank / whitespace-only / null / undefined render the placeholder", () => {
    for (const v of ["", " ", "\t\n", null, undefined]) {
      assert.equal(leadNicheDisplay(v), "—");
      assert.equal(leadNicheLabel(v), null);
    }
    assert.equal(EMPTY_NICHE_LABEL, "—");
  });
  test("a controlled-list slug (manual/imported leads) still renders its label", () => {
    assert.equal(leadNicheDisplay("coffee_shop"), "Coffee Shop");
    assert.equal(leadNicheDisplay("bar_lounge"), "Bar & Lounge");
  });
  test("an arbitrary stored value is not remapped to another category", () => {
    assert.equal(leadNicheDisplay("Accounting Firm"), "Accounting Firm");
  });
});

describe("nicheMatchKey", () => {
  test("is case-, whitespace-, punctuation- and diacritic-safe", () => {
    assert.equal(nicheMatchKey("coffee_shop"), "coffee shop");
    assert.equal(nicheMatchKey("  COFFEE   Shop "), "coffee shop");
    assert.equal(nicheMatchKey("Café"), "cafe");
    assert.equal(nicheMatchKey("Bar & Lounge"), "bar and lounge");
    assert.equal(nicheMatchKey(null), "");
    assert.equal(nicheMatchKey("   "), "");
  });
  test("no two NICHES options share a slug/label key (a filter can never match a sibling option)", () => {
    const owner = new Map<string, string>();
    for (const n of NICHES) {
      for (const key of new Set([nicheMatchKey(n.value), nicheMatchKey(n.label)])) {
        const prev = owner.get(key);
        assert.ok(prev === undefined || prev === n.value, `key "${key}" claimed by both ${prev} and ${n.value}`);
        owner.set(key, n.value);
      }
    }
  });
});

describe("L. CRM niche filter", () => {
  test('coffee_shop matches a discovered lead stored as "Coffee Shop"', () => {
    assert.equal(leadMatchesNicheFilter("Coffee Shop", ["coffee_shop"]), true);
  });
  test("…and case/whitespace variants, and the manual-lead slug form", () => {
    for (const stored of ["coffee shop", "  COFFEE SHOP ", "Coffee  Shop", "coffee_shop"]) {
      assert.equal(leadMatchesNicheFilter(stored, ["coffee_shop"]), true, stored);
    }
  });
  test("does not match a different niche", () => {
    assert.equal(leadMatchesNicheFilter("Bakery", ["coffee_shop"]), false);
    assert.equal(leadMatchesNicheFilter("Barbers", ["barbershop"]), false);
  });
  test("multiple selected options are OR'd", () => {
    assert.equal(leadMatchesNicheFilter("Bakery", ["coffee_shop", "bakery"]), true);
  });
  test("existing values keep working: every NICHES option matches both its slug and its label", () => {
    for (const n of NICHES) {
      assert.equal(leadMatchesNicheFilter(n.value, [n.value]), true, `${n.value} (slug)`);
      assert.equal(leadMatchesNicheFilter(n.label, [n.value]), true, `${n.label} (label)`);
    }
  });
  test('"Café" label and slug forms, and "&" spelled out, still match', () => {
    assert.equal(leadMatchesNicheFilter("Cafe", ["cafe"]), true);
    assert.equal(leadMatchesNicheFilter("Café", ["cafe"]), true);
    assert.equal(leadMatchesNicheFilter("Bar and Lounge", ["bar_lounge"]), true);
    assert.equal(leadMatchesNicheFilter("E-commerce", ["ecommerce"]), true);
  });
  test("no selection = no filtering (blank-niche leads stay visible); with a selection, blank never matches", () => {
    assert.equal(leadMatchesNicheFilter(null, []), true);
    assert.equal(leadMatchesNicheFilter("", ["coffee_shop"]), false);
    assert.equal(leadMatchesNicheFilter(undefined, ["coffee_shop"]), false);
  });
  test("an unknown filter value falls back to matching by its own key", () => {
    assert.equal(leadMatchesNicheFilter("Accounting Firm", ["accounting_firm"]), true);
  });
});

describe("the CRM page actually uses the helpers", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../routes/dashboard.relationships.tsx"),
    "utf8",
  );
  test("filter goes through leadMatchesNicheFilter, not a raw includes() on the slug list", () => {
    assert.ok(src.includes("leadMatchesNicheFilter(lead.niche, nicheFilters)"));
    assert.equal(/nicheFilters\.includes\(lead\.niche\)/.test(src), false);
  });
  test('cell renders leadNicheDisplay(), not `nicheLabel ?? "—"` (which let "" through)', () => {
    assert.ok(src.includes("leadNicheDisplay(lead.niche)"));
    assert.equal(src.includes('nicheLabel ?? "—"'), false);
  });
});
