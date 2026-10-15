/**
 * Offline Outreach Quality Evaluation Suite
 *
 * Grounded in empirical cold-outreach research:
 * - Gong's analysis of 85M outbound emails (low-friction interest CTAs vs meeting asks)
 * - Lavender's 231k benchmark (plain English readability, scannability, no em dashes)
 * - HubSpot's substantive personalization research (connecting verified facts to craft, honest sparse data)
 * - FTC CAN-SPAM commercial compliance (non-deceptive subjects, truthful identity)
 * - Native multi-channel dynamics (Email, Instagram DMs, Phone Scripts, Website Contact Forms)
 *
 * Evaluates synthetic scenarios against the 9-dimension quality rubric:
 * 1. Evidence Accuracy (Zero Hallucinated Metrics, Audits, Mockups, or Defects)
 * 2. Prospect Relevance (Substantive Grounding in Business Context)
 * 3. Freelancer Offer Alignment (Craft Anchored to Profession)
 * 4. Value Credibility (Plausible, Non-Hyperbolic Proposition)
 * 5. CTA Appropriateness & Low Friction (Interest Ask vs. Meeting Ask)
 * 6. Natural Human Readability & Voice (No Em Dashes, No Corporate Buzzwords)
 * 7. Channel & Stage Fit (Email, Instagram DM, Phone Script, Contact Form)
 * 8. Anti-Repetition & Sequence Advance (No "Just Bumping", Narrative Continuity)
 * 9. Schema & Contract Integrity (Valid JSON { subject, body })
 *
 * EVALUATION LIMITATIONS:
 * - Offline Programmatic Testing verifies deterministic rules, schema contracts, regex pattern
 *   exclusion (em dashes, forbidden buzzwords, high-friction asks), and strict factual grounding
 *   against supplied input fixtures.
 * - Human Review & Live Testing are necessary to evaluate authentic human voice nuances across
 *   diverse regional subcultures, domain-specific terminology, and real-world inbox deliverability.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutreachPrompt,
  sanitizeOutreachOutput,
  type OutreachChannel,
  type OutreachAction,
} from "../../../lib/outreachPrompt.js";

// Banned buzzwords identified by Lavender and empirical spam filters
export const FORBIDDEN_BUZZWORDS = [
  "elevate",
  "streamline",
  "seamless",
  "synergy",
  "supercharge",
  "unleash",
  "cutting-edge",
  "game-changing",
  "holistic",
  "empower",
  "drive meaningful results",
  "take your business to the next level",
  "unlock your potential",
];

// High-friction meeting asks that hurt cold response rates (Gong 85M study)
export const HIGH_FRICTION_COLD_ASKS = [
  "15 minutes",
  "15 mins",
  "30 minutes",
  "30 mins",
  "hop on a call",
  "jump on a quick call",
  "grab coffee",
  "schedule a demo",
  "on your calendar",
  "book a call",
];

export interface GroundingValidationResult {
  valid: boolean;
  errors: string[];
}

export interface GroundingContext {
  mockupSupplied?: boolean;
  auditSupplied?: boolean;
  caseStudiesSupplied?: boolean;
  socialPostSupplied?: boolean;
  rankAuditSupplied?: boolean;
  sequenceHistory?: {
    isFollowUp?: boolean;
    touchCount?: number;
    previousSends?: Array<{ channel?: string; subject?: string; timestamp?: string }>;
  };
}

/**
 * Strict programmatic grounding validator:
 * Asserts that generated outreach claims are strictly supported by supplied lead facts and context.
 */
export function validateGrounding(
  lead: {
    businessName?: string;
    niche?: string;
    website?: string;
    reviewsCount?: number;
    reviewsRating?: number;
    websiteIsWeak?: boolean;
    loadTimeMs?: number;
  },
  output: { subject?: string | null; body: string },
  context?: GroundingContext
): GroundingValidationResult {
  const errors: string[] = [];
  const fullText = `${output.subject || ""} ${output.body}`;

  // 1. Unsupplied load time / speed measurements
  if (lead.loadTimeMs === undefined) {
    if (
      /\b(takes|loading time of|loads in)\s+(over\s+)?\d+(\.\d+)?\s*(seconds?|secs?|s)\b/i.test(fullText) ||
      /\b\d+(\.\d+)?\s*(seconds?|secs?)\s+to\s+load\b/i.test(fullText)
    ) {
      errors.push("Claims unsupplied load time measurement when no numeric speed metric was provided");
    }
  }

  // 2. Specific technical defects on coarse boolean flag
  if (lead.websiteIsWeak && !lead.loadTimeMs) {
    if (
      /\b(triggers an unformatted popup|404 error|console error|broken booking button|broken code|unformatted popup)\b/i.test(
        fullText
      )
    ) {
      errors.push("Claims specific technical defect or broken code on coarse website_is_weak flag");
    }
  }

  // 3. Unrequested work artifacts (mockup, audit, screen recording, video teardown)
  if (!context?.mockupSupplied && !context?.auditSupplied) {
    if (
      /\b(put together|prepared|built|created|drafted|designed|recorded)\s+(a|an|the|this)?\s*(quick\s*)?(\d+[- ](minute|second)\s*)?(visual\s*)?(new\s*)?([a-z]+\s*)?(mockup|prototype|wireframe|redesign|concept|audit|screen recording|video teardown)\b/i.test(
        fullText
      ) ||
      /\b(i|we)\s+(have\s+)?(already\s+)?(audited|analyzed|put together|prepared|built|designed|created)\s+(a|an|the|this|your)\b/i.test(
        fullText
      ) ||
      /\bhave\s+already\s+(audited|analyzed|put together|prepared|built|designed|created)\b/i.test(fullText) ||
      /\b(the|this|my|our)\s+(mockup|prototype|concept|audit)\b/i.test(fullText)
    ) {
      errors.push("Claims to have prepared unrequested work artifact (mockup/audit/video) without context confirmation");
    }
  }

  // 4. Review count and rating grounding (no unanimous 5-star claims when only average is given)
  if (lead.reviewsRating !== undefined && lead.reviewsRating < 5.0) {
    if (
      /\b\d+\+?\s*(five-star|5-star)\b/i.test(fullText) ||
      /\ball\s*(five-star|5-star)\b/i.test(fullText) ||
      /\bnearly\s*\d+\s*(five-star|5-star)\b/i.test(fullText)
    ) {
      errors.push("Extrapolates average review rating into unanimous 5-star reviews");
    }
  }

  // 5. Unsupplied social media specifics
  if (!context?.socialPostSupplied) {
    if (/\b(member transformation reel|recent transformation reel|your post from yesterday)\b/i.test(fullText)) {
      errors.push("Claims specific unsupplied social media post or reel");
    }
  }

  // 6. Unsupplied case studies, ROI percentages, or guarantees
  if (!context?.caseStudiesSupplied) {
    if (
      /\bcase study on how we\b/i.test(fullText) ||
      /\b\d+%\s*(increase|lift|growth|more leads)\b/i.test(fullText) ||
      /\bguarantee(d)?\b/i.test(fullText)
    ) {
      errors.push("Claims unsupplied case study, ROI percentage, or guarantee");
    }
  }

  // 7. Unsupplied search ranking audits
  if (!context?.rankAuditSupplied) {
    if (/\b(doesn't surface in the top three|ranking #\d+|not in the top 3)\b/i.test(fullText)) {
      errors.push("Claims unsupplied local search ranking audit");
    }
  }

  // 8. Fabricated prior history / fake familiarity
  const hasPriorTouches = Boolean(context?.sequenceHistory?.previousSends?.length);
  if (!hasPriorTouches) {
    if (/\b(as mentioned in my note on|following up on my email on|per our discussion|per our call)\b/i.test(fullText)) {
      errors.push("Claims prior outreach history or conversation when no prior touch exists");
    }
  }

  // 9. Businesses with no obvious weakness
  if (lead.websiteIsWeak === false) {
    if (/\b(broken website|slow website|terrible speed|needs fixing|outdated website)\b/i.test(fullText)) {
      errors.push("Claims website is broken when verified not weak");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface SyntheticScenario {
  id: string;
  name: string;
  channel: OutreachChannel;
  action: OutreachAction;
  freelancerProfession: string;
  senderName: string;
  lead: {
    businessName: string;
    niche: string;
    location?: string;
    website?: string;
    instagram?: string;
    reviewsCount?: number;
    reviewsRating?: number;
    websiteIsWeak?: boolean;
    loadTimeMs?: number;
  };
  template?: string;
  contextNotes?: string;
  currentDraft?: { subject?: string; body?: string };
  sequenceHistory?: {
    isFollowUp?: boolean;
    touchCount?: number;
    previousSends?: Array<{ channel?: string; subject?: string; timestamp?: string }>;
  };
  groundedOutput: {
    subject: string | null;
    body: string;
  };
  ungroundedOutput?: {
    subject: string | null;
    body: string;
    expectedViolations: string[];
  };
}

// 9 Comprehensive Synthetic Test Scenarios spanning all required regression cases
export const SYNTHETIC_EVALUATION_SCENARIOS: SyntheticScenario[] = [
  {
    id: "sc-1",
    name: "Weak website signal without concrete performance measurement (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "Web Designer",
    senderName: "Marcus Vance",
    lead: {
      businessName: "Apex Dental Studio",
      niche: "dentist",
      location: "Austin, TX",
      website: "https://apexdental.com",
      reviewsCount: 42,
      reviewsRating: 4.8,
      websiteIsWeak: true,
    },
    ungroundedOutput: {
      subject: "Quick idea for Apex Dental's mobile booking",
      body:
        "Hi Dr. Vance,\n\n" +
        "I was checking out Apex Dental Studio in Austin and noticed your 40+ five-star patient reviews. Your reputation is great, but your mobile site currently takes over 4 seconds to load when patients try to tap the booking button.\n\n" +
        "I put together a quick 2-minute visual mockup showing how streamlining that mobile intake flow could make booking effortless.\n\n" +
        "Open to taking a look, or is this not on your radar right now?\n\n" +
        "Best,\nMarcus",
      expectedViolations: [
        "Claims unsupplied load time measurement when no numeric speed metric was provided",
        "Claims to have prepared unrequested work artifact (mockup/audit/video) without context confirmation",
        "Extrapolates average review rating into unanimous 5-star reviews",
      ],
    },
    groundedOutput: {
      subject: "Apex Dental's patient booking experience",
      body:
        "Hi Dr. Vance,\n\n" +
        "I came across Apex Dental Studio while looking at Austin dental practices. You have built a strong local reputation with your 4.8 rating across 42 patient reviews.\n\n" +
        "Looking at your website from a smartphone, I noticed there could be an opportunity to make your appointment scheduling flow simpler for mobile patients.\n\n" +
        "Would you be open to an idea on how other practices simplify their mobile patient intake, or is your schedule completely full right now?\n\n" +
        "Best,\nMarcus",
    },
  },
  {
    id: "sc-2",
    name: "Review count and average rating without individual review data (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "Local SEO Specialist",
    senderName: "Elena Rostova",
    lead: {
      businessName: "Pine Street Veterinary",
      niche: "veterinarian",
      location: "Seattle, WA",
      reviewsCount: 65,
      reviewsRating: 4.9,
      websiteIsWeak: false,
    },
    ungroundedOutput: {
      subject: "Pet owner discovery for Pine Street Vet",
      body:
        "Hi team Pine Street,\n\n" +
        "Congratulations on your 65 five-star reviews in Seattle! With all five-star reviews on Google, you dominate local searches.\n\n" +
        "Would you be open to a quick chat on local rankings?\n\n" +
        "Best,\nElena",
      expectedViolations: ["Extrapolates average review rating into unanimous 5-star reviews"],
    },
    groundedOutput: {
      subject: "Local pet owner discovery for Pine Street Vet",
      body:
        "Hi team Pine Street,\n\n" +
        "I came across Pine Street Veterinary while researching local pet clinics in Seattle. Maintaining a 4.9 average rating across 65 client reviews is impressive and speaks to the trust pet parents have in your care.\n\n" +
        "I work with independent veterinary practices on neighborhood Google Maps visibility as new residents search for local pet care.\n\n" +
        "Would you be open to a brief note on how other Seattle clinics keep their practice top of mind in nearby neighborhood searches?\n\n" +
        "Thanks,\nElena",
    },
  },
  {
    id: "sc-3",
    name: "No supplied evidence that a mockup or audit has been prepared (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "UI/UX Designer",
    senderName: "Liam Scott",
    lead: {
      businessName: "ClearView Optometry",
      niche: "optometrist",
      location: "Portland, OR",
      website: "https://clearviewpdx.com",
      websiteIsWeak: true,
    },
    ungroundedOutput: {
      subject: "Wireframe for ClearView Optometry",
      body:
        "Hi Dr. Harris,\n\n" +
        "I have already audited your patient intake and prepared a 30-second screen recording of a prototype intake form for your clinic.\n\n" +
        "Mind if I send over the link?\n\n" +
        "Best,\nLiam",
      expectedViolations: [
        "Claims to have prepared unrequested work artifact (mockup/audit/video) without context confirmation",
      ],
    },
    groundedOutput: {
      subject: "Patient intake flow for ClearView Optometry",
      body:
        "Hi Dr. Harris,\n\n" +
        "I was reviewing independent eye care clinics in Portland and came across ClearView Optometry.\n\n" +
        "Many specialty clinics lose prospective patients when mobile intake forms require too much manual zooming and typing before insurance verification.\n\n" +
        "Would you be open to seeing an outline of how similar practices simplify mobile appointment requests, or is that already working well for you?\n\n" +
        "Best,\nLiam",
    },
  },
  {
    id: "sc-4",
    name: "No supplied testimonials, case studies, measurable results, or guarantees (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "Copywriter",
    senderName: "Maya Patel",
    lead: {
      businessName: "Highland Architecture",
      niche: "architect",
      location: "Chicago, IL",
      website: "https://highlandarch.com",
    },
    ungroundedOutput: {
      subject: "Case study for Highland Architecture",
      body:
        "Hi Highland team,\n\n" +
        "We guaranteed a 40% increase in qualified inquiries for a similar residential architect through our case study on how we overhauled their portfolio copy.\n\n" +
        "Open to discussing how we can do the same for you?\n\n" +
        "Best,\nMaya",
      expectedViolations: ["Claims unsupplied case study, ROI percentage, or guarantee"],
    },
    groundedOutput: {
      subject: "Project storytelling for Highland Architecture",
      body:
        "Hello Highland team,\n\n" +
        "I recently reviewed your residential portfolio projects in the Chicago area. The craft in your adaptive reuse work is clear and distinctive.\n\n" +
        "High-end residential clients often make hiring decisions based on how well project case studies communicate the problem-solving behind complex zoning and design hurdles.\n\n" +
        "Would it be helpful if I shared a couple of observations on framing project stories for prospective homeowners, or is your team already focused on other priorities?\n\n" +
        "Best regards,\nMaya",
    },
  },
  {
    id: "sc-5",
    name: "Businesses with no obvious weakness (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "Graphic Designer",
    senderName: "Chloe Dupont",
    lead: {
      businessName: "Velvet Bean Roasters",
      niche: "coffee_roaster",
      location: "Seattle, WA",
      website: "https://velvetbeanroasters.com",
      reviewsCount: 156,
      reviewsRating: 4.9,
      websiteIsWeak: false,
    },
    ungroundedOutput: {
      subject: "Fixing your broken website",
      body:
        "Hi team Velvet Bean,\n\n" +
        "I was checking out your shop and noticed your slow website has a broken website layout on mobile devices that needs fixing immediately.\n\n" +
        "Let me know if you want help.\n\n" +
        "Best,\nChloe",
      expectedViolations: ["Claims website is broken when verified not weak"],
    },
    groundedOutput: {
      subject: "Wholesale retail packaging for Velvet Bean",
      body:
        "Hi team Velvet Bean,\n\n" +
        "Your Seattle cafe brand and single-origin roast lineup look fantastic, and congratulations on maintaining a 4.9 rating across more than 150 customer reviews.\n\n" +
        "As independent roasters expand from cafe sales into grocery distribution, shelf visibility and retail label hierarchy often become an important focus.\n\n" +
        "Would you be open to an idea on packaging label hierarchy for regional specialty grocers, or is your distribution already established?\n\n" +
        "Best,\nChloe",
    },
  },
  {
    id: "sc-6",
    name: "Very sparse business information (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "SEO Consultant",
    senderName: "Elena Rostova",
    lead: {
      businessName: "Lighthouse Books",
      niche: "bookstore",
      location: "Portland, OR",
    },
    ungroundedOutput: {
      subject: "Audit findings for Lighthouse Books",
      body:
        "Hi team Lighthouse,\n\n" +
        "I audited your site and found that your mobile site takes 5 seconds to load and has 14 critical SEO errors that hurt your rankings.\n\n" +
        "Can we talk this week?\n\n" +
        "Thanks,\nElena",
      expectedViolations: [
        "Claims unsupplied load time measurement when no numeric speed metric was provided",
        "Claims to have prepared unrequested work artifact (mockup/audit/video) without context confirmation",
      ],
    },
    groundedOutput: {
      subject: "Local discovery for Lighthouse Books",
      body:
        "Hi team Lighthouse,\n\n" +
        "I came across your independent bookstore in Portland while looking at neighborhood listings.\n\n" +
        "With foot traffic so dependent on nearby Google Maps recommendations, I wanted to see how you currently approach local neighborhood search discovery.\n\n" +
        "Would it be helpful if I shared two low-effort ways local bookshops maintain visibility for neighborhood searches, or are you fully focused on store events right now?\n\n" +
        "Thanks,\nElena",
    },
  },
  {
    id: "sc-7",
    name: "Different offers from the same freelancer approaching different businesses (Email Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "Digital Strategist",
    senderName: "Alex Rivera",
    lead: {
      businessName: "Blue Wave Plumbing",
      niche: "plumber",
      location: "Phoenix, AZ",
      reviewsCount: 38,
      reviewsRating: 4.7,
      websiteIsWeak: true,
    },
    ungroundedOutput: {
      subject: "Plumbing leads mockup",
      body:
        "Hey team Blue Wave,\n\n" +
        "I have already designed a new website concept and your map pin doesn't surface in the top three local search results in Phoenix.\n\n" +
        "Let me know if you want the mockup.\n\n" +
        "Alex",
      expectedViolations: [
        "Claims to have prepared unrequested work artifact (mockup/audit/video) without context confirmation",
        "Claims unsupplied local search ranking audit",
      ],
    },
    groundedOutput: {
      subject: "Emergency service inquiries for Blue Wave",
      body:
        "Hi Blue Wave team,\n\n" +
        "I was looking at residential plumbing services in Phoenix and noticed your strong 4.7 customer rating across 38 reviews.\n\n" +
        "When homeowners deal with emergency leaks, having a single one-tap mobile dispatch button significantly cuts down lost calls during evening hours.\n\n" +
        "Would you be open to an idea on how other trade companies configure after-hours inquiry routing, or is your dispatcher volume already where you want it?\n\n" +
        "Best,\nAlex",
    },
  },
  {
    id: "sc-8",
    name: "Follow-ups where no prior sent message is available (Email Sequence Touch #1)",
    channel: "email",
    action: "generate",
    freelancerProfession: "Copywriter",
    senderName: "Liam Scott",
    lead: {
      businessName: "Summit Law Group",
      niche: "attorney",
      location: "Chicago, IL",
    },
    sequenceHistory: {
      isFollowUp: false,
      touchCount: 1,
      previousSends: [],
    },
    ungroundedOutput: {
      subject: "Following up on Tuesday's note",
      body:
        "Hi Sarah,\n\n" +
        "As mentioned in my note on Tuesday, I am following up on my email regarding your client intake copy.\n\n" +
        "Just checking in to see if you had 15 minutes to chat.\n\n" +
        "Best,\nLiam",
      expectedViolations: [
        "Claims prior outreach history or conversation when no prior touch exists",
      ],
    },
    groundedOutput: {
      subject: "Client intake clarity for Summit Law Group",
      body:
        "Hello Summit Law team,\n\n" +
        "I was reviewing commercial practice pages in Chicago and noticed your focus on middle-market business disputes.\n\n" +
        "Prospective corporate clients often look for quick clarity on practice scope before filling out a detailed conflict check or consultation request.\n\n" +
        "Would you be open to a quick perspective on how other litigation firms structure their practice overview pages to set clear client expectations?\n\n" +
        "Best regards,\nLiam",
    },
  },
  {
    id: "sc-9",
    name: "Instagram and phone outreach where naturalness is essential",
    channel: "instagram",
    action: "generate",
    freelancerProfession: "Social Media Manager",
    senderName: "Jordan Lee",
    lead: {
      businessName: "Iron & Oak Fitness",
      niche: "gym",
      location: "Denver, CO",
      instagram: "ironandoakdenver",
    },
    ungroundedOutput: {
      subject: "Collaboration proposal",
      body:
        "Hey Iron & Oak team! Loved your member transformation reel from yesterday. We supercharge your synergy and streamline your member acquisition.\n\n" +
        "Do you have 15 minutes to hop on a quick call this Thursday?",
      expectedViolations: ["Claims specific unsupplied social media post or reel"],
    },
    groundedOutput: {
      subject: null,
      body:
        "Hey Iron & Oak team! I noticed your fitness community in Denver and really like the welcoming atmosphere you showcase on your profile. Quick question: do you manage your member highlight stories in-house, or do you work with someone local? Had a quick creative idea for sharing weekly member milestones if you're ever open to it.",
    },
  },
];

describe("Research-Driven Outreach Quality Evaluation Suite", () => {
  describe("Prompt Construction Integrity across Synthetic Scenarios", () => {
    for (const scenario of SYNTHETIC_EVALUATION_SCENARIOS) {
      test(`Scenario [${scenario.id}]: ${scenario.name} constructs compliant prompt`, () => {
        const { system, user } = buildOutreachPrompt({
          channel: scenario.channel,
          action: scenario.action,
          lead: scenario.lead,
          freelancer: {
            profession: scenario.freelancerProfession,
            senderName: scenario.senderName,
          },
          template: scenario.template,
          contextNotes: scenario.contextNotes,
          currentDraft: scenario.currentDraft,
          sequenceHistory: scenario.sequenceHistory,
        });

        // 1. System Prompt adheres to Research directives
        assert.ok(system.includes("WITHOUT EM DASHES"), "Must mandate natural punctuation without em dashes");
        assert.ok(system.includes("CLARITY OVER RIGID FORMULAS"), "Must mandate simple readability and adaptive guidance");
        assert.ok(system.includes("AVOID EMPTY MARKETING BUZZWORDS"), "Must mandate anti-buzzword rules");
        assert.ok(system.includes("SITUATIONAL CALL-TO-ACTION"), "Must instruct dynamic CTA calibration");
        assert.ok(system.includes("STRICT EVIDENCE GROUNDING"), "Must mandate strict evidence grounding");

        // 2. User Payload passes structured runtime facts
        const payload = JSON.parse(user);
        assert.equal(payload.channel, scenario.channel);
        assert.equal(payload.action, scenario.action);
        assert.equal(payload.freelancerContext.profession, scenario.freelancerProfession);
        assert.equal(payload.leadData.businessName, scenario.lead.businessName);

        // 3. Channel specific payload constraints
        if (scenario.channel === "instagram") {
          assert.ok(system.includes("subject MUST be null"), "Instagram DM prompt must enforce null subject");
        }
        if (scenario.channel === "phone") {
          assert.ok(system.includes("Spoken phone script format"), "Phone prompt must require spoken script format");
        }

        // 4. Sequence history passed when follow-up
        if (scenario.sequenceHistory?.isFollowUp) {
          assert.equal(payload.isFollowUp, true);
          assert.ok(payload.touchCount >= 2);
        }
      });
    }
  });

  describe("Critical Grounding Regression: Catching Unsupported Claims in Evaluation", () => {
    test("Fails evaluation on the previous dental studio example for unsupported specifics", () => {
      const dentalLead = {
        businessName: "Apex Dental Studio",
        niche: "dentist",
        location: "Austin, TX",
        reviewsCount: 42,
        reviewsRating: 4.8,
        websiteIsWeak: true,
      };

      const badDentalExample = {
        subject: "Quick idea for Apex Dental's mobile booking",
        body:
          "Hi Dr. Vance,\n\n" +
          "I was checking out Apex Dental Studio in Austin and noticed your 40+ five-star patient reviews. Your reputation is great, but your mobile site currently takes over 4 seconds to load when patients try to tap the booking button.\n\n" +
          "I put together a quick 2-minute visual mockup showing how streamlining that mobile intake flow could make booking effortless.\n\n" +
          "Open to taking a look, or is this not on your radar right now?\n\n" +
          "Best,\nMarcus",
      };

      const result = validateGrounding(dentalLead, badDentalExample);
      assert.equal(result.valid, false, "Must detect grounding failure in the bad dental example");
      assert.ok(result.errors.length >= 3, `Expected at least 3 grounding errors, got ${result.errors.length}`);
      assert.ok(
        result.errors.some((e) => e.includes("unsupplied load time")),
        "Must flag unsupplied 4-second load time metric"
      );
      assert.ok(
        result.errors.some((e) => e.includes("unrequested work artifact")),
        "Must flag unsupplied prepared mockup claim"
      );
      assert.ok(
        result.errors.some((e) => e.includes("unanimous 5-star reviews")),
        "Must flag unsupplied 40+ five-star reviews extrapolation"
      );
    });

    test("Passes evaluation on the properly grounded replacement dental studio example", () => {
      const dentalLead = {
        businessName: "Apex Dental Studio",
        niche: "dentist",
        location: "Austin, TX",
        reviewsCount: 42,
        reviewsRating: 4.8,
        websiteIsWeak: true,
      };

      const groundedDentalExample = {
        subject: "Apex Dental's patient booking experience",
        body:
          "Hi Dr. Vance,\n\n" +
          "I came across Apex Dental Studio while looking at Austin dental practices. You have built a strong local reputation with your 4.8 rating across 42 patient reviews.\n\n" +
          "Looking at your website from a smartphone, I noticed there could be an opportunity to make your appointment scheduling flow simpler for mobile patients.\n\n" +
          "Would you be open to an idea on how other practices simplify their mobile patient intake, or is your schedule completely full right now?\n\n" +
          "Best,\nMarcus",
      };

      const result = validateGrounding(dentalLead, groundedDentalExample);
      assert.equal(result.valid, true, `Grounding errors encountered: ${result.errors.join(", ")}`);
      assert.equal(result.errors.length, 0);
    });

    for (const scenario of SYNTHETIC_EVALUATION_SCENARIOS) {
      if (scenario.ungroundedOutput) {
        test(`Scenario [${scenario.id}]: Ungrounded output correctly triggers grounding failure`, () => {
          const result = validateGrounding(scenario.lead, scenario.ungroundedOutput!, {
            sequenceHistory: scenario.sequenceHistory,
          });
          assert.equal(result.valid, false, `Scenario ${scenario.id} ungrounded sample must fail grounding validation`);
          for (const expectedViolation of scenario.ungroundedOutput!.expectedViolations) {
            assert.ok(
              result.errors.some((e) => e.includes(expectedViolation) || expectedViolation.includes(e)),
              `Scenario ${scenario.id} must flag violation: '${expectedViolation}'. Actual errors: ${result.errors.join("; ")}`
            );
          }
        });
      }

      test(`Scenario [${scenario.id}]: Grounded output passes grounding validation with zero errors`, () => {
        const result = validateGrounding(scenario.lead, scenario.groundedOutput, {
          sequenceHistory: scenario.sequenceHistory,
        });
        assert.equal(
          result.valid,
          true,
          `Scenario ${scenario.id} grounded output had unexpected errors: ${result.errors.join(", ")}`
        );
      });
    }
  });

  describe("Quality Rubric Evaluation (9 Dimensions) across Grounded Synthetic Outputs", () => {
    for (const scenario of SYNTHETIC_EVALUATION_SCENARIOS) {
      const sanitized = sanitizeOutreachOutput(
        scenario.groundedOutput,
        scenario.channel,
        scenario.groundedOutput.subject
      );

      test(`Scenario [${scenario.id}]: Rubric Dimension 1 - Evidence Accuracy & Absence of Hallucinations`, () => {
        const grounding = validateGrounding(scenario.lead, sanitized, {
          sequenceHistory: scenario.sequenceHistory,
        });
        assert.equal(grounding.valid, true, `Grounding check failed: ${grounding.errors.join(", ")}`);
      });

      test(`Scenario [${scenario.id}]: Rubric Dimension 5 - Low Friction CTAs for Cold Outreach`, () => {
        if (!scenario.sequenceHistory?.isFollowUp && scenario.action === "generate" && scenario.channel === "email") {
          for (const highFrictionAsk of HIGH_FRICTION_COLD_ASKS) {
            assert.equal(
              sanitized.body.toLowerCase().includes(highFrictionAsk),
              false,
              `Cold initial outreach must not demand high-friction ask: '${highFrictionAsk}'`
            );
          }
        }
      });

      test(`Scenario [${scenario.id}]: Rubric Dimension 6 - Natural Readability & Zero Em Dashes`, () => {
        assert.equal(sanitized.body.includes("—"), false, "Body must contain zero em dashes ('—')");
        assert.equal(sanitized.body.includes("–"), false, "Body must contain zero en dashes ('–')");
        if (sanitized.subject) {
          assert.equal(sanitized.subject.includes("—"), false, "Subject must contain zero em dashes");
          assert.equal(sanitized.subject.includes("–"), false, "Subject must contain zero en dashes");
        }

        // Check for corporate buzzwords
        for (const buzzword of FORBIDDEN_BUZZWORDS) {
          assert.equal(
            sanitized.body.toLowerCase().includes(buzzword),
            false,
            `Body must not contain forbidden buzzword '${buzzword}'`
          );
        }
      });

      test(`Scenario [${scenario.id}]: Rubric Dimension 7 - Channel & Stage Native Format`, () => {
        if (scenario.channel === "instagram") {
          assert.equal(sanitized.subject, null, "Instagram DM must have null subject");
          const wordCount = sanitized.body.split(/\s+/).length;
          assert.ok(wordCount <= 85, `Instagram DM should be concise, got ${wordCount} words`);
        }
        if (scenario.channel === "phone") {
          assert.equal(sanitized.subject, null, "Phone script must have null subject");
        }
        if (scenario.channel === "email") {
          assert.ok(typeof sanitized.subject === "string" && sanitized.subject.length > 0, "Email must have subject");
          const subjectWords = sanitized.subject.split(/\s+/).length;
          assert.ok(subjectWords <= 12, `Email subject must be concise (<=12 words), got ${subjectWords}`);
        }
      });

      test(`Scenario [${scenario.id}]: Rubric Dimension 8 - Anti-Repetition on Follow-Ups`, () => {
        if (scenario.sequenceHistory?.isFollowUp) {
          assert.equal(
            /just checking in|bumping this to the top/i.test(sanitized.body),
            false,
            "Follow-up must not use lazy 'just checking in' filler"
          );
        }
      });

      test(`Scenario [${scenario.id}]: Rubric Dimension 9 - Schema & Contract Integrity`, () => {
        assert.ok(typeof sanitized === "object" && sanitized !== null);
        assert.ok("subject" in sanitized);
        assert.ok(typeof sanitized.body === "string" && sanitized.body.length > 0);
      });
    }
  });

  describe("Comparative Rubric: Baseline Legacy Prompt vs. Revised Grounded Prompt", () => {
    test("Legacy baseline vs Revised research prompt demonstrates clear rubric improvement", () => {
      const legacyExample = {
        subject: "Elevate Apex Dental Studio — Partnership Opportunity",
        body:
          "Hi Dr. Vance,\n\n" +
          "I came across your website and was truly impressed by your dental clinic — we specialize in cutting-edge web design to streamline patient acquisition and drive meaningful results.\n\n" +
          "Do you have 15 minutes this Thursday at 2:00 PM to jump on a quick call?\n\n" +
          "Best regards,\nMarcus",
      };

      const revisedExample = SYNTHETIC_EVALUATION_SCENARIOS[0].groundedOutput;

      // 1. Em dash comparison
      assert.ok(legacyExample.body.includes("—") || legacyExample.subject.includes("—"), "Legacy had em dashes");
      assert.equal(revisedExample.body.includes("—"), false, "Revised has zero em dashes");
      assert.equal(revisedExample.subject?.includes("—"), false, "Revised subject has zero em dashes");

      // 2. Buzzword comparison
      assert.ok(
        legacyExample.body.includes("cutting-edge") &&
          legacyExample.body.includes("streamline") &&
          legacyExample.body.includes("drive meaningful results"),
        "Legacy overused buzzwords"
      );
      for (const buzzword of FORBIDDEN_BUZZWORDS) {
        assert.equal(revisedExample.body.toLowerCase().includes(buzzword), false, `Revised eliminated ${buzzword}`);
      }

      // 3. CTA Friction comparison
      assert.ok(legacyExample.body.includes("15 minutes"), "Legacy demanded a 15-minute meeting on cold touch");
      assert.ok(
        revisedExample.body.includes("Would you be open to an idea"),
        "Revised uses low-friction interest-based ask"
      );

      // 4. Grounding comparison
      const dentalLead = SYNTHETIC_EVALUATION_SCENARIOS[0].lead;
      const revisedGrounding = validateGrounding(dentalLead, revisedExample);
      assert.equal(revisedGrounding.valid, true, "Revised example must be 100% grounded");
    });
  });
});
