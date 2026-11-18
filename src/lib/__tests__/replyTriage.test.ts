import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectDeterministicNonReply, triageClientReply } from "../replyTriage.js";

describe("replyTriage", () => {
  it("deterministically filters out RFC Auto-Submitted and bounce emails", () => {
    const ooo = detectDeterministicNonReply({
      from: "client@bakery.com",
      subject: "Re: Logo refresh",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    assert.equal(ooo.isNonReply, true);
    assert.equal(ooo.reason, "ooo");

    const bounce = detectDeterministicNonReply({
      from: "MAILER-DAEMON@mx.google.com",
      subject: "Delivery Status Notification (Failure)",
    });
    assert.equal(bounce.isNonReply, true);
    assert.equal(bounce.reason, "bounce");

    const real = detectDeterministicNonReply({
      from: "owner@bakery.com",
      subject: "Re: Quick question",
      text: "Sure, how much do you charge?",
      headers: { "Auto-Submitted": "no" },
    });
    assert.equal(real.isNonReply, false);
  });

  it("uses AI triage when enabled and extracts intent, summary, and suggested reply", async () => {
    const res = await triageClientReply(
      {
        channel: "email",
        businessName: "Luna Bakery",
        from: "luna@bakery.com",
        subject: "Re: Menu redesign",
        text: "Hey! How much would a full menu + Instagram kit cost?",
      },
      {
        aiEnabled: () => true,
        getAiModel: () => "openrouter/free",
        generateJSON: async () => ({
          isHumanReply: true,
          intent: "pricing",
          summary: "Asked about pricing for menu and Instagram kit.",
          suggestedReply: "Thanks for getting back to me! Our menu + social kit starts at $450.",
        }) as any,
      },
    );

    assert.equal(res.isHumanReply, true);
    assert.equal(res.intent, "pricing");
    assert.equal(res.usedAi, true);
    assert.match(res.summary, /pricing/i);
    assert.ok(res.suggestedReply);
  });

  it("falls back gracefully as a human reply if AI throws", async () => {
    const res = await triageClientReply(
      {
        channel: "instagram",
        businessName: "Luna Bakery",
        text: "Sounds interesting, send me your work!",
      },
      {
        aiEnabled: () => true,
        getAiModel: () => "openrouter/free",
        generateJSON: async () => {
          throw new Error("Upstream 503");
        },
      },
    );

    assert.equal(res.isHumanReply, true);
    assert.equal(res.intent, "other");
    assert.equal(res.usedAi, false);
    assert.equal(res.summary, "Sounds interesting, send me your work!");
  });
});
