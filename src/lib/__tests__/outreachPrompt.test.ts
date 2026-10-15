import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutreachPrompt,
  sanitizeOutreachOutput,
} from "../outreachPrompt.js";

describe("outreachPrompt - Unit Tests", () => {
  test("builds prompt with research directives and zero em dashes instruction", () => {
    const { system, user } = buildOutreachPrompt({
      channel: "email",
      action: "generate",
      tone: "friendly",
      lead: {
        businessName: "Acme Dental",
        niche: "dentist",
        location: "Seattle, WA",
        reviewsCount: 35,
        reviewsRating: 4.8,
        websiteIsWeak: true,
      },
      freelancer: {
        profession: "Web Designer",
        senderName: "Sarah Chen",
      },
    });

    assert.ok(system.includes("WITHOUT EM DASHES"));
    assert.ok(system.includes("CLARITY OVER RIGID FORMULAS"));
    assert.ok(system.includes("AVOID EMPTY MARKETING BUZZWORDS"));
    assert.ok(system.includes("SITUATIONAL CALL-TO-ACTION"));
    assert.ok(system.includes("STRICT EVIDENCE GROUNDING"));

    const payload = JSON.parse(user);
    assert.equal(payload.channel, "email");
    assert.equal(payload.action, "generate");
    assert.equal(payload.freelancerContext.profession, "Web Designer");
    assert.equal(payload.leadData.businessName, "Acme Dental");
    assert.equal(payload.leadData.reviewsCount, 35);
    assert.equal(payload.isFollowUp, false);
    assert.equal(payload.touchCount, 1);
  });

  test("handles sparse data and instructs honest exploratory posture", () => {
    const { system, user } = buildOutreachPrompt({
      channel: "email",
      action: "generate",
      lead: {
        businessName: "Boutique Books",
        niche: "bookstore",
      },
      freelancer: {
        profession: "SEO Consultant",
      },
    });

    const payload = JSON.parse(user);
    assert.equal(payload.leadData.websiteIsWeak, undefined);
    assert.equal(payload.leadData.reviewsCount, undefined);
    assert.ok(system.includes("SPARSE DATA DIRECTIVE"));
    assert.ok(system.includes("Never manufacture weaknesses"));
  });

  test("correctly recognizes follow-up touches and supplies sequence context", () => {
    const { user } = buildOutreachPrompt({
      channel: "email",
      action: "generate",
      template: "follow_up",
      lead: {
        businessName: "Summit Law",
        niche: "attorney",
      },
      sequenceHistory: {
        isFollowUp: true,
        touchCount: 2,
        previousSends: [
          {
            channel: "email",
            subject: "Quick thought on Seattle client intake",
            timestamp: "2026-10-10T12:00:00Z",
          },
        ],
      },
    });

    const payload = JSON.parse(user);
    assert.equal(payload.isFollowUp, true);
    assert.equal(payload.touchCount, 2);
    assert.equal(payload.sequenceHistory.previousTouchCount, 1);
    assert.equal(payload.sequenceHistory.lastChannelUsed, "email");
    assert.equal(payload.sequenceHistory.lastSubjectUsed, "Quick thought on Seattle client intake");
  });

  test("enforces null subject on Instagram and Phone channels in sanitizer", () => {
    const igResult = sanitizeOutreachOutput(
      { subject: "Should be removed", body: "Hey, loved your latest post on design!" },
      "instagram"
    );
    assert.equal(igResult.subject, null);
    assert.equal(igResult.body, "Hey, loved your latest post on design!");

    const phoneResult = sanitizeOutreachOutput(
      { subject: "Script header", body: "Hey Mike, quick question regarding..." },
      "phone"
    );
    assert.equal(phoneResult.subject, null);
    assert.equal(phoneResult.body, "Hey Mike, quick question regarding...");
  });

  test("sanitizer replaces any stray em dashes and en dashes with grammatical punctuation", () => {
    const result = sanitizeOutreachOutput(
      {
        subject: "Quick idea — Austin clinic",
        body: "I noticed your website — and loved your patient reviews – hope you have a great week.",
      },
      "email"
    );

    assert.equal(result.subject?.includes("—"), false);
    assert.equal(result.subject?.includes("–"), false);
    assert.equal(result.body.includes("—"), false);
    assert.equal(result.body.includes("–"), false);
    assert.equal(result.subject, "Quick idea: Austin clinic");
    assert.equal(result.body, "I noticed your website, and loved your patient reviews, hope you have a great week.");
  });
});
