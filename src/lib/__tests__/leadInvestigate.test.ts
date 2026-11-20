import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicInvestigation,
  extractWebsiteSignalsFromHtml,
  inspectWebsiteSnapshot,
  type LeadInvestigationContext,
} from "../leadInvestigate.js";

describe("leadInvestigate", () => {
  it("extracts CMS, booking tools, analytics, contact emails, and schema founder from HTML", () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Apex Dental Studio &amp; Care</title>
          <meta name="description" content="Modern family dentistry in Austin" />
          <script type="application/ld+json">{"@type":"Organization","founder":{"name":"Dr. Maya Lin"}}</script>
          <script src="https://www.googletagmanager.com/gtag/js?id=G-123"></script>
        </head>
        <body>
          <link rel="stylesheet" href="/wp-content/themes/dental/style.css" />
          <a href="https://calendly.com/apex-dental/consult">Book Now</a>
          <a href="mailto:hello@apexdental.com">Email us</a>
          <form><input type="email" name="email" /><button type="submit">Send</button></form>
        </body>
      </html>
    `;

    const snap = extractWebsiteSignalsFromHtml(html, "https://apexdental.com", 200);
    assert.equal(snap.checked, true);
    assert.equal(snap.title, "Apex Dental Studio & Care");
    assert.equal(snap.metaDescription, "Modern family dentistry in Austin");
    assert.deepEqual(snap.cmsOrTech, ["WordPress"]);
    assert.deepEqual(snap.bookingTools, ["Calendly"]);
    assert.deepEqual(snap.analyticsTools, ["Google Tag / Analytics"]);
    assert.deepEqual(snap.emailsFound, ["hello@apexdental.com"]);
    assert.deepEqual(snap.ownerHints, ["Schema founder/author: Dr. Maya Lin"]);
    assert.equal(snap.hasContactForm, true);
    assert.equal(snap.hasMobileViewport, true);
  });

  it("blocks localhost and private IPs via SSRF validation", async () => {
    const snap = await inspectWebsiteSnapshot("http://127.0.0.1:8080/admin");
    assert.equal(snap.checked, false);
    assert.ok(snap.error && /prohibited/i.test(snap.error));
  });

  it("answers WordPress and owner questions deterministically from verified context", () => {
    const ctx: LeadInvestigationContext = {
      lead: {
        id: 1,
        businessName: "Apex Dental",
        niche: "dental_clinic",
        location: "Austin, TX",
        website: "https://apexdental.com",
        email: "hello@apexdental.com",
        phone: "+15551234567",
        instagramHandle: "apexdental",
        linkedinHandle: null,
        opportunityScore: 84,
        status: "new",
        igFollowers: "1200",
        igBio: null,
        igLastPost: null,
      },
      business: {
        id: "biz-1",
        category: "Dentist",
        address: "100 Congress Ave",
        website: "https://apexdental.com",
        email: "hello@apexdental.com",
        phone: "+15551234567",
        instagram: "apexdental",
        facebook: null,
        linkedin: null,
        reviewsCount: 42,
        reviewsRating: 4.8,
        hasPhotos: true,
        websiteIsWeak: false,
        sslValid: true,
        loadTimeMs: 900,
        seo: null,
        blog: null,
        confidence: 0.9,
        lastVerifiedAt: null,
        isDisqualified: false,
        disqualifyReason: null,
        signals: {},
      },
      healthScore: { score: 82, breakdown: null },
      explanation: { score: 84, summary: "Strong fit", reasons: [] },
      recentActivitySummary: [],
      websiteSnapshot: {
        checked: true,
        url: "https://apexdental.com",
        finalUrl: "https://apexdental.com",
        statusCode: 200,
        https: true,
        title: "Apex Dental",
        metaDescription: null,
        cmsOrTech: ["WordPress"],
        bookingTools: ["Calendly"],
        analyticsTools: [],
        emailsFound: ["hello@apexdental.com"],
        socialLinks: [],
        ownerHints: ["Schema founder/author: Dr. Maya Lin"],
        hasContactForm: true,
        hasMobileViewport: true,
        error: null,
      },
    };

    const wp = buildDeterministicInvestigation("Do they use WordPress?", ctx);
    assert.match(wp.answer, /WordPress/);
    assert.equal(wp.mode, "verified_data");

    const owner = buildDeterministicInvestigation("Who is the owner?", ctx);
    assert.match(owner.answer, /Dr\. Maya Lin/);
  });
});
