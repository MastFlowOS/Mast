import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkDomainDeliverability,
  evaluatePacingGuardrails,
  matchesSuppression,
  normalizeSuppressionValue,
  parseBookingWebhookPayload,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../deliverability.js";
import { deriveUxFindings } from "../websiteAudit.js";
import { buildOutreachPrompt, resolveProfessionCreativeLens } from "../outreachPrompt.js";
import { extractWebsiteSignalsFromHtml } from "../leadInvestigate.js";

describe("Pre-Launch Agency Suite — Core Logic", () => {
  describe("Deliverability & Safety Helpers", () => {
    it("matches email, domain (from email or website), and instagram handle suppressions", () => {
      const list = [
        { kind: "email" as const, value: "ceo@acme.com", reason: "Opted out", source: "unsubscribe" as const },
        { kind: "domain" as const, value: "blockedstudio.io", reason: "Competitor", source: "manual" as const },
        { kind: "instagram" as const, value: "coolcafe", reason: "Asked to stop", source: "manual" as const },
      ];

      assert.equal(matchesSuppression({ email: "CEO@acme.com" }, list)?.kind, "email");
      assert.equal(matchesSuppression({ email: "sales@blockedstudio.io" }, list)?.kind, "domain");
      assert.equal(matchesSuppression({ website: "https://www.blockedstudio.io/pricing" }, list)?.kind, "domain");
      assert.equal(matchesSuppression({ instagramHandle: "@CoolCafe" }, list)?.kind, "instagram");
      assert.equal(matchesSuppression({ instagramHandle: "https://instagram.com/coolcafe/" }, list)?.kind, "instagram");
      assert.equal(matchesSuppression({ email: "ok@other.com", website: "https://other.com", instagramHandle: "other" }, list), null);
    });

    it("normalizes suppression values cleanly across kinds", () => {
      assert.equal(normalizeSuppressionValue("email", "  Test@Example.COM "), "test@example.com");
      assert.equal(normalizeSuppressionValue("domain", "https://www.MySite.com/about"), "mysite.com");
      assert.equal(normalizeSuppressionValue("instagram", "https://instagram.com/@MyBrand/"), "mybrand");
    });

    it("signs and verifies HMAC-SHA256 unsubscribe tokens and rejects tampering", () => {
      const token = signUnsubscribeToken("owner-123", "Lead@Business.com");
      const verified = verifyUnsubscribeToken(token);
      assert.deepEqual(verified, { ownerId: "owner-123", email: "lead@business.com" });

      // Tamper with signature
      const tampered = `${token.slice(0, -3)}xxx`;
      assert.equal(verifyUnsubscribeToken(tampered), null);
      assert.equal(verifyUnsubscribeToken("not-a-valid-token"), null);
    });

    it("evaluates email and Instagram pacing guardrails across ok / warning / danger", () => {
      const safe = evaluatePacingGuardrails({ emailsLast24h: 10, igLast1h: 2, igLast24h: 10 });
      assert.equal(safe.email.level, "ok");
      assert.equal(safe.email.message, null);
      assert.equal(safe.instagram.level, "ok");
      assert.equal(safe.instagram.message, null);

      const warning = evaluatePacingGuardrails({ emailsLast24h: 38, igLast1h: 11, igLast24h: 20 });
      assert.equal(warning.email.level, "warning");
      assert.ok(warning.email.message);
      assert.equal(warning.instagram.level, "warning");
      assert.ok(warning.instagram.message);

      const danger = evaluatePacingGuardrails({ emailsLast24h: 65, igLast1h: 18, igLast24h: 45 });
      assert.equal(danger.email.level, "danger");
      assert.equal(danger.instagram.level, "danger");
    });

    it("checks domain deliverability (MX, SPF, DMARC, DKIM) using injected DNS resolver", async () => {
      const passReport = await checkDomainDeliverability("founder@goodagency.com", {
        resolveMx: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
        resolveTxt: async (host: string) => {
          if (host === "goodagency.com") return [["v=spf1 include:_spf.google.com ~all"]];
          if (host === "_dmarc.goodagency.com") return [["v=DMARC1; p=quarantine; rua=mailto:dmarc@goodagency.com"]];
          if (host === "google._domainkey.goodagency.com") return [["v=DKIM1; k=rsa; p=ABC123"]];
          throw new Error("ENOTFOUND");
        },
      });
      assert.equal(passReport.domain, "goodagency.com");
      assert.equal(passReport.overall, "good");
      assert.equal(passReport.mx.status, "pass");
      assert.equal(passReport.spf.status, "pass");
      assert.equal(passReport.dmarc.status, "pass");
      assert.equal(passReport.dkim.status, "pass");
      assert.equal(passReport.dkim.record, "google._domainkey.goodagency.com");

      const failReport = await checkDomainDeliverability("baddomain.com", {
        resolveMx: async () => [],
        resolveTxt: async () => {
          throw new Error("ENOTFOUND");
        },
      });
      assert.equal(failReport.overall, "at_risk");
      assert.equal(failReport.mx.status, "fail");
      assert.equal(failReport.spf.status, "fail");
      assert.equal(failReport.dmarc.status, "warn");
    });

    it("parses Calendly, Cal.com, and custom booking webhooks", () => {
      const calendly = parseBookingWebhookPayload({
        event: "invitee.created",
        payload: {
          email: "Owner@Cafe.com",
          name: "Sarah Lee",
          scheduled_event: {
            name: "15 Min Intro Call",
            start_time: "2026-06-15T15:00:00Z",
          },
        },
      });
      assert.equal(calendly.provider, "calendly");
      assert.equal(calendly.inviteeEmail, "owner@cafe.com");
      assert.equal(calendly.inviteeName, "Sarah Lee");
      assert.equal(calendly.meetingTitle, "15 Min Intro Call");

      const calcom = parseBookingWebhookPayload({
        triggerEvent: "BOOKING_CREATED",
        payload: {
          title: "Website Audit Call",
          startTime: "2026-06-16T18:00:00Z",
          attendees: [{ name: "Mike Ross", email: "mike@dentist.co" }],
        },
      });
      assert.equal(calcom.provider, "calcom");
      assert.equal(calcom.inviteeEmail, "mike@dentist.co");
      assert.equal(calcom.inviteeName, "Mike Ross");
      assert.equal(calcom.meetingTitle, "Website Audit Call");
    });
  });

  describe("Website Audit & Prompt Grounding", () => {
    it("derives concise UX findings and 3-5 audit bullets from homepage signals", () => {
      const res = deriveUxFindings({
        businessName: "Sunset Bakery",
        websiteUrl: "http://sunsetbakery.com",
        sslValid: false,
        loadTimeMs: 4800,
        websiteIsWeak: true,
        hasInstagram: false,
        snapshot: {
          checked: true,
          url: "http://sunsetbakery.com",
          finalUrl: "http://sunsetbakery.com",
          httpStatus: 200,
          https: false,
          title: "Sunset Bakery",
          metaDescription: null,
          cmsOrTech: ["WordPress"],
          bookingTools: [],
          analyticsTools: [],
          socialLinks: [],
          hasContactForm: false,
          hasMobileViewport: false,
        },
      });

      assert.ok(res.auditBullets.length >= 3 && res.auditBullets.length <= 5);
      assert.ok(res.uxFindings.some((f) => /HTTPS\/SSL/i.test(f)));
      assert.ok(res.uxFindings.some((f) => /mobile viewport/i.test(f)));
      assert.ok(res.visualSummary.includes("sunsetbakery.com"));
    });

    it("injects custom user playbook, website visual critique, and booking URL into outreach prompt", () => {
      const prompt = buildOutreachPrompt({
        channel: "email",
        action: "generate",
        tone: "friendly",
        lead: {
          businessName: "Bright Dental",
          niche: "dental",
          website: "https://brightdental.com",
        },
        freelancer: {
          name: "Beboo",
          bookingUrl: "https://cal.com/beboo/15min",
        },
        userPlaybook: {
          name: "Casual Founder Voice",
          instructions: "Keep it conversational, short, and end with a soft question.",
          exampleMessages: "Hey team, quick note after checking your site...",
        },
        websiteVisualCritique: {
          visualSummary: "Hero section feels crowded and hides the main booking CTA below the fold.",
          auditBullets: ["No online booking widget on homepage", "Crowded above-the-fold hero layout"],
        },
      });

      assert.ok(prompt.system.includes("9B. CUSTOM USER PLAYBOOK"));
      assert.ok(prompt.user.includes("Casual Founder Voice"));
      assert.ok(prompt.user.includes("Hero section feels crowded"));
      assert.ok(prompt.user.includes("https://cal.com/beboo/15min"));
    });

    it("extracts only real high-intent customer action buttons (Book/Order/Schedule/Quote) with dead # links and ignores random nav/JS links like 'Mas'", () => {
      const html = `
        <html>
          <head><title>Plaza Ray Bakery</title></head>
          <body>
            <h1>Fresh sourdough and cookies baked every morning</h1>
            <a href="#">Mas</a>
            <a href="#">Read More</a>
            <a href="#" data-bs-toggle="modal">Book Now</a>
            <a href="#">Order Cookies</a>
            <a href="">Book Catering</a>
            <footer>Copyright 2021 Plaza Ray</footer>
          </body>
        </html>
      `;
      const snap = extractWebsiteSignalsFromHtml(html, "https://plazaray.com", 200);
      assert.equal(snap.heroHeadline, "Fresh sourdough and cookies baked every morning");
      assert.equal(snap.copyrightYear, 2021);
      assert.ok(snap.brokenLinks?.some((b) => b.includes("Order Cookies")));
      assert.ok(snap.brokenLinks?.some((b) => b.includes("Book Catering")));
      assert.equal(snap.brokenLinks?.some((b) => b.includes("Mas")), false);
      assert.equal(snap.brokenLinks?.some((b) => b.includes("Read More")), false);
      assert.equal(snap.brokenLinks?.some((b) => b.includes("Book Now")), false);
    });

    it("feeds IG post, high-level website observations, and previous message bodySnippet into follow-up prompt", () => {
      const prompt = buildOutreachPrompt({
        channel: "email",
        action: "generate",
        template: "follow_up_2day",
        lead: {
          businessName: "Plaza Ray",
          igLastPost: "Posted fresh chocolate chip cookies straight out of the oven",
          websiteObservations: ['Unlinked customer action button detected on homepage: "Order Cookies" button links to "#"'],
        },
        sequenceHistory: {
          isFollowUp: true,
          touchCount: 2,
          previousSends: [
            {
              channel: "email",
              subject: "website idea",
              timestamp: "2026-11-19T10:00:00Z",
              bodySnippet: "Hey team, had a quick idea to make your site layout cleaner on mobile.",
            },
          ],
        },
      });

      assert.ok(prompt.system.includes("BAN ROBOTIC RATING/STAT OPENERS"));
      assert.ok(prompt.system.includes("ONLY MENTION REAL CUSTOMER-FACING BROKEN BUTTONS"));
      assert.ok(prompt.user.includes("chocolate chip cookies"));
      assert.ok(prompt.user.includes("Order Cookies"));
      assert.ok(prompt.user.includes("Hey team, had a quick idea to make your site layout cleaner"));
    });

    it("adapts creative personalization angles across different freelancer professions and enforces fresh-take regeneration", () => {
      const videoLens = resolveProfessionCreativeLens("Video & Animation", "video_animation");
      const designLens = resolveProfessionCreativeLens("Graphic Design", "graphic_design");
      const marketingLens = resolveProfessionCreativeLens("Digital Marketing", "digital_marketing");

      assert.ok(videoLens.angles.some((a) => /Reel|TikTok|motion/i.test(a)));
      assert.ok(designLens.angles.some((a) => /Brand cohesion|visual hierarchy/i.test(a)));
      assert.ok(marketingLens.angles.some((a) => /Meta Pixel|retargeting|local/i.test(a)));

      const regenPrompt = buildOutreachPrompt({
        channel: "email",
        action: "generate",
        lead: { businessName: "Plaza Ray" },
        freelancer: { profession: "Video & Animation", professionSlug: "video_animation" },
        currentDraft: {
          subject: "previous subject",
          body: "Hey team, saw your homepage uses static images and had a quick video idea.",
        },
      });

      const payload = JSON.parse(regenPrompt.user);
      assert.equal(payload.isRegeneratingFreshTake, true);
      assert.ok(Array.isArray(payload.freelancerContext.creativeAnglesForProfession));
      assert.ok(payload.freelancerContext.creativeAnglesForProfession.some((a: string) => /Reel|TikTok/i.test(a)));
    });
  });
});
