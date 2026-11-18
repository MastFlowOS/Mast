import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReplyDedupeKey,
  extractMessageIds,
  normalizeEmailAddress,
  parseInstagramNotificationEmail,
  stripQuotedReplyText,
} from "../replyParsing.js";

describe("replyParsing", () => {
  it("normalizes sender email addresses from display-name and mailto formats", () => {
    assert.equal(normalizeEmailAddress('"Jane Doe" <Jane@Bakery.COM>'), "jane@bakery.com");
    assert.equal(normalizeEmailAddress("mailto:Owner@Studio.io"), "owner@studio.io");
    assert.equal(normalizeEmailAddress("  hello@cafe.co.uk  "), "hello@cafe.co.uk");
    assert.equal(normalizeEmailAddress("not-an-email"), null);
    assert.equal(normalizeEmailAddress(""), null);
  });

  it("extracts normalized Message-IDs from In-Reply-To and References", () => {
    assert.deepEqual(
      extractMessageIds("<ABC@mail.example.com> <def@mail.example.com>"),
      ["<abc@mail.example.com>", "<def@mail.example.com>"],
    );
    assert.deepEqual(
      extractMessageIds(["<id1@a.com>", "<id1@a.com> <id2@b.com>"]),
      ["<id1@a.com>", "<id2@b.com>"],
    );
  });

  it("strips quoted reply blocks cleanly", () => {
    const raw = [
      "Yes! What are your rates for a menu redesign?",
      "",
      "On Mon, Nov 18, 2026 at 10:00 AM Beboo <beboo@mast.ai> wrote:",
      "> Hi there, I noticed your menu could use a refresh...",
    ].join("\n");

    assert.equal(
      stripQuotedReplyText(raw),
      "Yes! What are your rates for a menu redesign?",
    );
  });

  it("parses Instagram DM notification emails across common personal-account formats", () => {
    const case1 = parseInstagramNotificationEmail({
      from: "Instagram <notifications@mail.instagram.com>",
      subject: "@luna_bakery sent you a message",
      text: 'luna_bakery sent you a message: "Hey thanks for reaching out, send your portfolio!"',
    });
    assert.equal(case1.isInstagramAlert, true);
    assert.equal(case1.handle, "luna_bakery");
    assert.equal(case1.previewText, "Hey thanks for reaching out, send your portfolio!");

    const case2 = parseInstagramNotificationEmail({
      from: "no-reply@mail.instagram.com",
      subject: "New direct message from Luna Studio (@luna.studio)",
      html: '<p>Check your inbox</p><a href="https://www.instagram.com/direct/t/123">View</a>',
    });
    assert.equal(case2.isInstagramAlert, true);
    assert.equal(case2.handle, "luna.studio");

    const case3 = parseInstagramNotificationEmail({
      from: "Instagram <notifications@mail.instagram.com>",
      subject: "You have a new direct message",
      html: '<a href="https://www.instagram.com/direct/">Inbox</a> <a href="https://www.instagram.com/coffee_roasters/">Profile</a>',
    });
    assert.equal(case3.isInstagramAlert, true);
    assert.equal(case3.handle, "coffee_roasters");
  });

  it("ignores non-DM emails and non-Instagram emails", () => {
    const securityAlert = parseInstagramNotificationEmail({
      from: "security@mail.instagram.com",
      subject: "New login to Instagram from Chrome on Windows",
      text: "We noticed a new login from Chrome.",
    });
    assert.equal(securityAlert.isInstagramAlert, false);

    const regularEmail = parseInstagramNotificationEmail({
      from: "client@bakery.com",
      subject: "Re: Branding proposal",
      text: "Looks great, let's chat tomorrow.",
    });
    assert.equal(regularEmail.isInstagramAlert, false);
  });

  it("produces stable collision-resistant dedupe keys", () => {
    const k1 = buildReplyDedupeKey({
      channel: "email",
      leadId: 42,
      externalId: "<MSG-1@example.com>",
    });
    const k2 = buildReplyDedupeKey({
      channel: "email",
      leadId: 42,
      externalId: "<msg-1@example.com>",
    });
    assert.equal(k1, k2);
  });
});
