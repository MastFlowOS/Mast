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

  test("preserves paragraph breaks and includes MAST cold-email skill rules", () => {
    const { system, user } = buildOutreachPrompt({
      channel: "email",
      action: "generate",
      lengthPreference: "short",
      lead: {
        businessName: "Harbor Dental",
        niche: "dentist",
        signals: { no_online_booking: true },
      },
    });

    assert.ok(system.includes("2-4 words max, lowercase"));
    assert.ok(system.includes("CONNECTED PERSONALIZATION"));
    assert.ok(system.includes("BANNED AI TELLS"));
    const payload = JSON.parse(user);
    assert.deepEqual(payload.leadData.signals, { no_online_booking: true });
    assert.equal(payload.lengthPreference, "short");

    const sanitized = sanitizeOutreachOutput(
      {
        subject: "patient   booking",
        body: "Hi Dr. Lee,\n\nI noticed Harbor Dental handles booking by phone — is that intentional right now?\n\n\nBest,  \nSam",
      },
      "email",
    );
    assert.equal(sanitized.subject, "patient booking");
    assert.equal(sanitized.body, "Hi Dr. Lee,\n\nI noticed Harbor Dental handles booking by phone, is that intentional right now?\n\nBest,\nSam");
  });

  test("enforces business personalization restraint and filters disabled fields", () => {
    const { system, user } = buildOutreachPrompt({
      channel: "email",
      action: "generate",
      lead: {
        businessName: "Summit Dental",
        niche: "dentist",
        location: "Austin, TX",
        region: "TX",
        instagram: "summitdental",
        reviewsCount: 48,
        reviewsRating: 4.9,
      },
      personalization: {
        includeBusinessNameAndNiche: false,
        includeLocationAndMarket: false,
        includeReviewsAndReputation: false,
        includeRecentInstagramActivity: false,
        includeSimilarSuccessStories: true,
      },
    });

    assert.ok(system.includes("BUSINESS PERSONALIZATION WITH RESTRAINT"));
    assert.ok(system.includes("PICK AT MOST 1-2 CUES"));
    assert.ok(system.includes("NO DATABASE READOUTS"));

    const payload = JSON.parse(user);
    assert.equal(payload.leadData.businessName, "Summit Dental");
    assert.equal(payload.leadData.niche, undefined);
    assert.equal(payload.leadData.location, undefined);
    assert.equal(payload.leadData.region, undefined);
    assert.equal(payload.leadData.instagram, undefined);
    assert.equal(payload.leadData.reviewsCount, undefined);
    assert.equal(payload.leadData.reviewsRating, undefined);

    // Also verifies UI / API request field names (businessNameAndNiche, locationAndLocalMarket, etc.)
    const uiDisabled = buildOutreachPrompt({
      channel: "instagram",
      action: "generate",
      lead: {
        businessName: "Summit Dental",
        niche: "dentist",
        location: "Austin, TX",
        instagram: "summitdental",
        reviewsCount: 48,
        reviewsRating: 4.9,
      },
      personalization: {
        businessNameAndNiche: false,
        locationAndLocalMarket: false,
        businessReviewsAndReputation: false,
        recentInstagramActivity: false,
        similarBusinessSuccessStories: false,
      },
    });
    const uiPayload = JSON.parse(uiDisabled.user);
    assert.equal(uiPayload.leadData.niche, undefined);
    assert.equal(uiPayload.leadData.location, undefined);
    assert.equal(uiPayload.leadData.instagram, undefined);
    assert.equal(uiPayload.leadData.reviewsCount, undefined);
    assert.equal(uiPayload.personalizationSettings.includeBusinessNameAndNiche, false);
    assert.equal(uiPayload.personalizationSettings.includeLocationAndMarket, false);
    assert.equal(uiPayload.personalizationSettings.includeReviewsAndReputation, false);
    assert.equal(uiPayload.personalizationSettings.includeRecentInstagramActivity, false);
    assert.equal(uiPayload.personalizationSettings.includeSimilarSuccessStories, false);
  });
});
