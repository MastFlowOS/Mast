import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashString, pickVariant, variationKey } from "@/lib/outreach/templates/variation";

test("same leadId + template + slot always selects the same variant", () => {
  const variants = ["a", "b", "c", "d", "e"];
  const first = pickVariant(variants, 42, "initial", "opening");
  for (let i = 0; i < 20; i += 1) {
    assert.equal(pickVariant(variants, 42, "initial", "opening"), first);
  }
});

test("different lead IDs deterministically select (possibly different) variants, never random", () => {
  const variants = ["a", "b", "c", "d", "e"];
  const results = new Map<number, string | null>();
  for (let leadId = 1; leadId <= 50; leadId += 1) {
    const picked = pickVariant(variants, leadId, "initial", "cta");
    results.set(leadId, picked);
  }
  // Determinism: re-running produces identical map.
  for (let leadId = 1; leadId <= 50; leadId += 1) {
    assert.equal(pickVariant(variants, leadId, "initial", "cta"), results.get(leadId));
  }
  // Sanity: with 50 leads and 5 variants, more than one distinct variant should appear.
  assert.ok(new Set(results.values()).size > 1);
});

test("different slot types can select different variants for the same lead/template", () => {
  const variants = ["a", "b", "c", "d", "e", "f", "g"];
  const opening = pickVariant(variants, 7, "initial", "opening");
  const cta = pickVariant(variants, 7, "initial", "cta");
  // Not asserting they always differ (hash collision is possible), just that both are stable individually.
  assert.equal(pickVariant(variants, 7, "initial", "opening"), opening);
  assert.equal(pickVariant(variants, 7, "initial", "cta"), cta);
});

test("empty variant list returns null rather than throwing", () => {
  assert.equal(pickVariant([], 1, "initial", "opening"), null);
});

test("hashString and pickVariant use no Math.random or Date.now (source inspection)", () => {
  // Strip comments first — the module's own doc-comment explicitly *names*
  // Math.random()/Date.now() to say they are NOT used, which would
  // otherwise false-positive a naive substring check.
  const path = fileURLToPath(new URL("../templates/variation.ts", import.meta.url));
  const source = readFileSync(path, "utf-8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(code.includes("Math.random"), false);
  assert.equal(code.includes("Date.now"), false);
});

test("hashString is a pure deterministic function", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
});

test("variationKey composes leadId/templateKey/slotType predictably", () => {
  assert.equal(variationKey(1, "initial", "opening"), "1|initial|opening");
  assert.equal(variationKey("lead-2", "follow_up_2day", "cta"), "lead-2|follow_up_2day|cta");
});
