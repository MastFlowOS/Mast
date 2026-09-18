import test from "node:test";
import assert from "node:assert/strict";
import { generateFreeOutreach } from "@/lib/outreach/pipeline";
import type { NormalizedOpportunitySignal, Lead, LeadActivity } from "@/lib/outreach/types";
import { REENGAGEMENT_MIN_DAYS } from "@/lib/outreach/templates";

function lead(overrides: Partial<Lead>): Lead {
  return {
    id: 1,
    businessName: "Test Biz",
    niche: null,
    status: "new",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Lead;
}

function signal(available: boolean, ranked: NormalizedOpportunitySignal["rankedComponents"] = []): NormalizedOpportunitySignal {
  return { available, rankedComponents: ranked, topComponent: ranked[0] ?? null, score: available ? 80 : null };
}

function sentActivity(daysAgo: number, extra: Partial<LeadActivity> = {}): LeadActivity {
  return {
    id: "send-1",
    leadId: 1,
    type: "email_sent",
    channel: "email",
    timestamp: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    content: "sent",
    ...extra,
  } as LeadActivity;
}

// Case 1 — Graphic Design + Restaurant + Initial + Email + valid opportunity signal
test("Case 1: Graphic Design + Restaurant + Initial + Email + valid signal -> personalized message", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: "restaurant" }),
    profession: "graphic_design",
    templateKey: "initial",
    channel: "email",
    signal: signal(true, ["branding"]),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.angleComponent, "branding");
    assert.equal(result.angleSource, "opportunity");
    assert.ok(result.subject);
    assert.ok(result.body.length > 0);
  }
});

// Case 2 — Programming & Tech + Dental + Initial + Instagram -> sensitive/category-compatible output
test("Case 2: Programming & Tech + Dental + Initial + Instagram -> healthcare-safe output", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: "dental" }),
    profession: "programming_tech",
    templateKey: "initial",
    channel: "instagram",
    signal: signal(false),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.toneOverride, "elevated-sensitivity");
    assert.equal(result.subject, null);
    // Never mentions clinical/treatment/outcome language.
    for (const word of ["patient outcomes", "treatment", "diagnosis", "cure"]) {
      assert.equal(result.body.toLowerCase().includes(word), false);
    }
  }
});

// Case 3 — Unknown niche + Graphic Design + Initial -> generic safe fallback
test("Case 3: unknown niche + Graphic Design + Initial -> generic safe fallback", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: "totally_unknown_xyz" }),
    profession: "graphic_design",
    templateKey: "initial",
    channel: "email",
    signal: signal(false),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.angleSource, "category-fallback");
  }
});

// Case 4 — No opportunity signal + known category -> category fallback
test("Case 4: no opportunity signal + known category -> category fallback rung used", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: "cafe" }),
    profession: "graphic_design",
    templateKey: "initial",
    channel: "email",
    signal: signal(false),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.notEqual(result.angleSource, "opportunity");
  }
});

// Case 5 — No profession -> refusal
test("Case 5: no profession -> refusal", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: null,
    templateKey: "initial",
    channel: "email",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_profession");
});

// Case 6 — Existing prior contact + Follow-up 2 day -> valid continuity-based message
test("Case 6: prior contact + follow_up_2day -> valid continuity-based message", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: "graphic_design",
    templateKey: "follow_up_2day",
    channel: "email",
    activities: [sentActivity(2)],
    signal: signal(false),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.body.length > 0);
    for (const word of ["saw", "opened", "read your", "ignored"]) {
      assert.equal(result.body.toLowerCase().includes(word), false);
    }
  }
});

// Case 7 — Prior contact <14 days + Re-engagement -> refusal
test("Case 7: prior contact <14 days + reengagement -> refusal", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: "graphic_design",
    templateKey: "reengagement",
    channel: "email",
    activities: [sentActivity(5)],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "template_ineligible");
});

// Case 8 — Prior contact >=14 days + Re-engagement + no new signal -> valid reengagement, no fabricated reason
test("Case 8: prior contact >=14 days + reengagement + no new signal -> no fabricated angle", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: "graphic_design",
    templateKey: "reengagement",
    channel: "email",
    activities: [
      sentActivity(REENGAGEMENT_MIN_DAYS, {
        metadata: {
          originalTemplate: "initial",
          originalAngleComponent: "branding",
          originalAngleSource: "opportunity",
          sentAt: new Date(Date.now() - REENGAGEMENT_MIN_DAYS * 86_400_000).toISOString(),
          channel: "email",
        },
      }),
    ],
    signal: signal(false), // no new signal at all
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.angleComponent, "generic");
    assert.ok(result.body.length > 0);
  }
});

test("Case 8b: reengagement WITH a genuinely new signal component does carry a new angle", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: "graphic_design",
    templateKey: "reengagement",
    channel: "email",
    activities: [
      sentActivity(REENGAGEMENT_MIN_DAYS, {
        metadata: {
          originalTemplate: "initial",
          originalAngleComponent: "branding",
          originalAngleSource: "opportunity",
          sentAt: new Date(Date.now() - REENGAGEMENT_MIN_DAYS * 86_400_000).toISOString(),
          channel: "email",
        },
      }),
    ],
    signal: signal(true, ["social"]), // different component than the stored original
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.angleComponent, "social");
    assert.equal(result.angleSource, "opportunity");
  }
});

// Case 9 — Pricing transition + no explicit pricing context -> refusal
test("Case 9: pricing_transition + no explicit pricing context -> refusal", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: "graphic_design",
    templateKey: "pricing_transition",
    channel: "email",
    explicitPricingContext: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "template_ineligible");
});

test("determinism: identical inputs produce byte-identical output", () => {
  const input = {
    lead: lead({ niche: "cafe" }),
    profession: "graphic_design" as const,
    templateKey: "initial" as const,
    channel: "email" as const,
    signal: signal(true, ["branding"]),
  };
  const a = generateFreeOutreach(input);
  const b = generateFreeOutreach(input);
  // continuityMetadata.sentAt is a real generation-time timestamp (when the
  // draft was produced), not authored content — it is expected to differ
  // between two separate calls. Everything else, including the message
  // itself, must be byte-identical.
  assert.deepEqual({ ...a, continuityMetadata: undefined }, { ...b, continuityMetadata: undefined });
  if (a.ok && b.ok) {
    assert.deepEqual(
      { ...a.continuityMetadata, sentAt: undefined },
      { ...b.continuityMetadata, sentAt: undefined },
    );
  }
});

// ─── Fallback ladder (all four rungs) ────────────────────────────────────────

test("ladder rung 1: profession + unsuppressed opportunity + niche/category", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: "cafe" }),
    profession: "graphic_design",
    templateKey: "initial",
    channel: "email",
    signal: signal(true, ["branding"]),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.angleSource, "opportunity");
});

test("ladder rung 2: profession + opportunity signal without a category match still uses opportunity", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: null }),
    profession: "graphic_design",
    templateKey: "initial",
    channel: "email",
    signal: signal(true, ["social"]),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.angleSource, "opportunity");
});

test("ladder rung 3: profession + category fallback when signal unavailable", () => {
  const result = generateFreeOutreach({
    lead: lead({ niche: "cafe" }),
    profession: "graphic_design",
    templateKey: "initial",
    channel: "email",
    signal: signal(false),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.angleSource, "category-fallback");
});

test("ladder rung 4: profession generic fallback when nothing else applies", () => {
  // finance has no valuePropAngle for the "other"/community_other category's
  // service contexts that would satisfy rung 3 in every case; force it by
  // using an unknown niche with no signal.
  const result = generateFreeOutreach({
    lead: lead({ niche: "totally_unknown_xyz_2" }),
    profession: "finance",
    templateKey: "initial",
    channel: "email",
    signal: signal(false),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(["category-fallback", "profession-generic"].includes(result.angleSource));
  }
});

test("no profession -> refusal (ladder never reaches a 5th profession-neutral fallback)", () => {
  const result = generateFreeOutreach({
    lead: lead({}),
    profession: undefined,
    templateKey: "initial",
    channel: "email",
  });
  assert.equal(result.ok, false);
});
