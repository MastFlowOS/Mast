import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExplanation, UNAVAILABLE_SIGNAL, readOpportunitySignal } from "@/lib/outreach/signals/opportunitySignal";
import type { OpportunityExplanation } from "@/lib/api";

function explanation(reasons: OpportunityExplanation["reasons"], score = 42): OpportunityExplanation {
  return { score, professionSlug: "graphic_design", professionMatch: "strong", reasons, summary: "dashboard prose that must never leak" };
}

test("A. highest valid component is selected", () => {
  const result = normalizeExplanation(
    explanation([
      { component: "social", label: "", detail: "", weight: 1, value: 0.3 },
      { component: "branding", label: "", detail: "", weight: 1, value: 0.9 },
    ]),
  );
  assert.equal(result.available, true);
  assert.equal(result.topComponent, "branding");
  assert.deepEqual(result.rankedComponents, ["branding", "social"]);
});

test("B. highest component suppressed -> next valid component selected", () => {
  const result = normalizeExplanation(
    explanation([
      { component: "branding", label: "", detail: "", weight: 1, value: 0.9 },
      { component: "social", label: "", detail: "", weight: 1, value: 0.3 },
    ]),
    ["branding"],
  );
  assert.equal(result.available, true);
  assert.equal(result.topComponent, "social");
});

test("C. all components suppressed -> unavailable (category fallback territory)", () => {
  const result = normalizeExplanation(
    explanation([{ component: "branding", label: "", detail: "", weight: 1, value: 0.9 }]),
    ["branding"],
  );
  assert.equal(result.available, false);
  assert.equal(result.topComponent, null);
});

test("D. no usable signal (empty reasons) -> fallback", () => {
  const result = normalizeExplanation(explanation([]));
  assert.deepEqual(result, { ...UNAVAILABLE_SIGNAL, score: 42 });
});

test("D2. null/undefined explanation -> fallback", () => {
  assert.deepEqual(normalizeExplanation(null), UNAVAILABLE_SIGNAL);
  assert.deepEqual(normalizeExplanation(undefined), UNAVAILABLE_SIGNAL);
});

test("E/G. readOpportunitySignal never throws on 404/network failure — resolves to unavailable", async () => {
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => {
    throw new Error("network failure");
  };
  try {
    const result = await readOpportunitySignal(999);
    assert.deepEqual(result, UNAVAILABLE_SIGNAL);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test("F. readOpportunitySignal on a 404-style rejection never crashes the generator", async () => {
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) });
  try {
    const result = await readOpportunitySignal(1);
    assert.equal(result.available, false);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test("H. dashboard explanation prose (summary) never appears on the normalized signal", () => {
  const result = normalizeExplanation(explanation([{ component: "branding", label: "x", detail: "y", weight: 1, value: 1 }]));
  assert.equal("summary" in result, false);
  assert.equal(JSON.stringify(result).includes("dashboard prose"), false);
});

test("unknown/invalid component values in reasons are ignored, not crashed on", () => {
  const result = normalizeExplanation(
    explanation([
      { component: "not_a_real_component" as any, label: "", detail: "", weight: 1, value: 1 },
      { component: "growth", label: "", detail: "", weight: 1, value: 0.5 },
    ]),
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.rankedComponents, ["growth"]);
});

test("duplicate components in reasons are deduplicated, keeping the strongest", () => {
  const result = normalizeExplanation(
    explanation([
      { component: "growth", label: "", detail: "", weight: 1, value: 0.9 },
      { component: "growth", label: "", detail: "", weight: 1, value: 0.2 },
    ]),
  );
  assert.deepEqual(result.rankedComponents, ["growth"]);
});
