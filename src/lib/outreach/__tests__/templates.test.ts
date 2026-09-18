import test from "node:test";
import assert from "node:assert/strict";
import { isTemplateEligible, FREE_TEMPLATE_KEYS, isFreeTemplateKey, REENGAGEMENT_MIN_DAYS } from "@/lib/outreach/templates";
import type { EligibilityContext } from "@/lib/outreach/templates";

const lead = { id: 1, businessName: "Test", niche: null, status: "new", createdAt: "", updatedAt: "" } as any;

const NO_CONTACT: EligibilityContext = { lastSendAt: null, continuity: null, explicitPricingContext: false };

function contactDaysAgo(days: number): EligibilityContext {
  const date = new Date(Date.now() - days * 86_400_000).toISOString();
  return { lastSendAt: date, continuity: null, explicitPricingContext: false };
}

test("objection_handling is NOT part of the Free template registry", () => {
  assert.equal(isFreeTemplateKey("objection_handling"), false);
  assert.equal((FREE_TEMPLATE_KEYS as readonly string[]).includes("objection_handling"), false);
});

test("all 6 free templates are registered", () => {
  assert.deepEqual(
    [...FREE_TEMPLATE_KEYS].sort(),
    ["buried_bump", "follow_up_2day", "follow_up_5day", "initial", "pricing_transition", "reengagement"].sort(),
  );
});

test("INITIAL: always eligible, no prior contact needed", () => {
  assert.equal(isTemplateEligible("initial", lead, NO_CONTACT), true);
});

test("FOLLOW_UP_2DAY: refuses with no genuine prior contact", () => {
  const result = isTemplateEligible("follow_up_2day", lead, NO_CONTACT);
  assert.notEqual(result, true);
});

test("FOLLOW_UP_2DAY: accepts genuine prior contact", () => {
  const result = isTemplateEligible("follow_up_2day", lead, contactDaysAgo(2));
  assert.equal(result, true);
});

test("FOLLOW_UP_5DAY: requires prior contact", () => {
  assert.notEqual(isTemplateEligible("follow_up_5day", lead, NO_CONTACT), true);
  assert.equal(isTemplateEligible("follow_up_5day", lead, contactDaysAgo(5)), true);
});

test("BURIED_BUMP: requires prior contact", () => {
  assert.notEqual(isTemplateEligible("buried_bump", lead, NO_CONTACT), true);
  assert.equal(isTemplateEligible("buried_bump", lead, contactDaysAgo(1)), true);
});

test("REENGAGEMENT: refuses without prior contact", () => {
  assert.notEqual(isTemplateEligible("reengagement", lead, NO_CONTACT), true);
});

test("REENGAGEMENT: refuses below 14 days", () => {
  assert.notEqual(isTemplateEligible("reengagement", lead, contactDaysAgo(13)), true);
});

test("REENGAGEMENT: succeeds at exactly 14 days", () => {
  assert.equal(isTemplateEligible("reengagement", lead, contactDaysAgo(REENGAGEMENT_MIN_DAYS)), true);
});

test("REENGAGEMENT: succeeds after 14 days", () => {
  assert.equal(isTemplateEligible("reengagement", lead, contactDaysAgo(30)), true);
});

test("PRICING_TRANSITION: unavailable without explicit pricing context", () => {
  const result = isTemplateEligible("pricing_transition", lead, NO_CONTACT);
  assert.notEqual(result, true);
});

test("PRICING_TRANSITION: remains unavailable with ordinary lead data / prior contact but no explicit context", () => {
  const result = isTemplateEligible("pricing_transition", lead, contactDaysAgo(3));
  assert.notEqual(result, true);
});

test("PRICING_TRANSITION: eligible only when explicitPricingContext is true", () => {
  const context: EligibilityContext = { lastSendAt: null, continuity: null, explicitPricingContext: true };
  assert.equal(isTemplateEligible("pricing_transition", lead, context), true);
});
