/**
 * Research-Driven AI Outreach Prompt Architecture & Context Assembly
 *
 * Grounded in empirical findings from:
 * 1. Gong's analysis of 85 million outbound sales emails (low-friction interest CTAs >2x vs meeting asks)
 * 2. Lavender's 231k email benchmark and buzzword guide (5th-grade readability, 50-100 words, zero em dashes)
 * 3. HubSpot's substantive personalization research (verified observations connected to craft, honest sparse-data handling)
 * 4. FTC commercial communication compliance (non-deceptive, transparent sender)
 * 5. Native multi-channel dynamics (Email, Instagram DM, Phone Scripts, Website Contact Forms)
 */

export const ALLOWED_CHANNELS = ["email", "instagram", "phone", "contact_form"] as const;
export type OutreachChannel = (typeof ALLOWED_CHANNELS)[number];

export const ALLOWED_ACTIONS = ["generate", "rewrite", "shorten", "expand", "objections"] as const;
export type OutreachAction = (typeof ALLOWED_ACTIONS)[number];

export const ALLOWED_TONES = ["friendly", "professional", "direct", "casual", "urgent"] as const;
export type OutreachTone = (typeof ALLOWED_TONES)[number];

export type OutreachLengthPreference = "short" | "standard" | "detailed";

export interface LeadOutreachData {
  businessName: string;
  niche?: string;
  website?: string;
  instagram?: string;
  phone?: string;
  email?: string;
  opportunityScore?: number;
  location?: string;
  region?: string;
  reviewsCount?: number;
  reviewsRating?: number;
  websiteIsWeak?: boolean;
  loadTimeMs?: number;
  signals?: Record<string, unknown>;
}

export interface FreelancerContext {
  profession?: string;
  professionSlug?: string;
  senderName?: string;
}

export interface PersonalizationSettings {
  businessNameAndNiche?: boolean;
  recentInstagramActivity?: boolean;
  locationAndLocalMarket?: boolean;
  businessReviewsAndReputation?: boolean;
  similarBusinessSuccessStories?: boolean;
  includeBusinessNameAndNiche?: boolean;
  includeRecentInstagramActivity?: boolean;
  includeLocationAndMarket?: boolean;
  includeReviewsAndReputation?: boolean;
  includeSimilarSuccessStories?: boolean;
}

export interface SequenceHistory {
  isFollowUp?: boolean;
  touchCount?: number;
  previousSends?: Array<{
    channel?: string;
    subject?: string;
    timestamp?: string;
    angle?: string;
  }>;
}

export interface BuildOutreachPromptParams {
  channel: OutreachChannel;
  action: OutreachAction;
  tone?: OutreachTone;
  template?: string;
  lengthPreference?: OutreachLengthPreference;
  customInstructions?: string;
  senderName?: string;
  contextNotes?: string;
  currentDraft?: {
    subject?: string;
    body?: string;
  };
  lead: LeadOutreachData;
  freelancer?: FreelancerContext;
  personalization?: PersonalizationSettings;
  sequenceHistory?: SequenceHistory;
}

/**
 * Builds system and user prompts grounded in empirical research.
 */
export function buildOutreachPrompt(params: BuildOutreachPromptParams): {
  system: string;
  user: string;
} {
  const {
    channel,
    action,
    tone = "friendly",
    template,
    lengthPreference,
    customInstructions,
    senderName,
    contextNotes,
    currentDraft,
    lead,
    freelancer,
    personalization = {},
    sequenceHistory,
  } = params;

  // Determine whether this request represents a follow-up touch
  const isFollowUp = Boolean(
    sequenceHistory?.isFollowUp ||
      (sequenceHistory?.touchCount && sequenceHistory.touchCount > 1) ||
      template === "follow_up" ||
      (contextNotes && /follow[- ]?up/i.test(contextNotes))
  );

  const pBusinessNameAndNiche =
    personalization.includeBusinessNameAndNiche ?? personalization.businessNameAndNiche ?? true;
  const pInstagram =
    personalization.includeRecentInstagramActivity ?? personalization.recentInstagramActivity ?? true;
  const pLocation =
    personalization.includeLocationAndMarket ?? personalization.locationAndLocalMarket ?? true;
  const pReviews =
    personalization.includeReviewsAndReputation ?? personalization.businessReviewsAndReputation ?? true;
  const pSimilarStories =
    personalization.includeSimilarSuccessStories ?? personalization.similarBusinessSuccessStories ?? true;

  // System Prompt: MAST-adapted cold outbound skill & strict evidence grounding
  const systemPrompt = [
    "You are MAST's AI Outreach Copywriter helping independent freelancers and specialists write cold messages to local and SMB business owners.",
    "Write like a sharp, observant peer reaching out 1-to-1—never like a marketer, agency blast, or AI template.",
    "",
    "### 1. STRICT EVIDENCE GROUNDING (NON-NEGOTIABLE)",
    "- EVERY FACTUAL CLAIM MUST BE SUPPORTED: Every factual claim must come directly from `leadData`, `freelancerContext`, `customInstructions`, or `contextNotes`. Never invent facts, metrics, or stories to make a pitch sound stronger.",
    "- COARSE SIGNALS DO NOT PROVE SPECIFIC DEFECTS: Flags like `websiteIsWeak: true` only indicate a general opportunity for improvement. Never invent load times (e.g. 'takes 4 seconds'), broken buttons, mobile bugs, SEO scores, or technical audits unless those exact numbers/facts appear in `leadData.signals` or `loadTimeMs`.",
    "- AVERAGE RATINGS ARE NOT UNANIMOUS: An average rating (e.g. 4.8 stars across 42 reviews) means strong overall reputation, NEVER '40+ five-star reviews' and never invented review quotes.",
    "- NEVER CLAIM UNREQUESTED FREE WORK: Never say you already built a mockup, recorded a Loom/video, ran an audit, or drafted designs unless `contextNotes` or `customInstructions` explicitly say so.",
    "- ZERO FABRICATED PROOF OR HISTORY: Never invent case studies, client results, ROI percentages ('we grew a clinic 40%'), prior calls/emails ('following up on my email from Tuesday'), or mutual connections unless present in `sequenceHistory` or user notes.",
    "- SPARSE DATA DIRECTIVE: When `leadData` is thin, drop fake personalization and use an honest, industry-relevant question asking how they currently handle that area. Never manufacture weaknesses or problems.",
    "",
    "### 2. BUSINESS PERSONALIZATION WITH RESTRAINT (MENU, NOT CHECKLIST)",
    "- PICK AT MOST 1-2 CUES: The enabled flags in `personalizationSettings` and fields in `leadData` are a menu of options, NOT a checklist to cram into every draft. Using all of them (name + city + rating + review count + niche) in one opener sounds robotic and creepy.",
    "- NO DATABASE READOUTS OR MAIL-MERGE PHRASING: Never recite CRM fields back like a scraped spreadsheet (bad: 'I saw Acme Dental Studio, a dentist in Austin, TX, has a 4.8 rating across 42 reviews'). Reference details lightly the way a real person talks (e.g. 'saw your reviews in Austin', 'looks like the clinic stays busy', or skip stats altogether).",
    "- TRANSLATE RAW LABELS INTO NATURAL WORDS: Never echo raw category/niche tags verbatim; talk naturally ('clinic', 'shop', 'team', 'studio', 'site').",
    "- CONNECTED PERSONALIZATION ('SO WHAT?' TEST): Every personalized detail must tie directly into why you're reaching out. If removing the opening line leaves the rest of the pitch unchanged, cut the fluff line or bridge it naturally into the problem/question.",
    "- RESPECT PERSONALIZATION TOGGLES: Never bring up location, reviews/rating, Instagram activity, niche framing, or similar-business outcomes if the corresponding `personalizationSettings` flag is false. Only mention similar-business success stories if a real outcome is explicitly supplied in `contextNotes` or `customInstructions`.",
    "",
    "### 3. PEER VOICE & OUTBOUND CRAFT (CLARITY OVER RIGID FORMULAS)",
    "- WRITE LIKE A PEER, NOT A VENDOR: Sound like one thoughtful person texting or emailing another business owner. Use natural contractions (I'm, don't, you've). Lead with THEIR world (you/your), not I/we or a stiff 'My name is X and I do Y' opener.",
    "- EVERY SENTENCE MUST EARN ITS PLACE: Ruthlessly short. If a sentence does not move the reader toward replying, cut it. No throat-clearing, no recap padding.",
    "- PRIORITIZE `contextNotes` WHEN PRESENT: Specific notes supplied by the user in `contextNotes` are highest-signal context—use them naturally ahead of generic profile fields.",
    "- NATURAL FORMATTING WITHOUT EM DASHES: Zero em dashes ('—') and zero en dashes ('–') in subject or body. Use periods, commas, and clean short paragraphs separated by blank lines (except casual short DMs).",
    "",
    "### 4. BANNED AI TELLS & CLICHÉS (AVOID EMPTY MARKETING BUZZWORDS)",
    "- NEVER USE AI TELLS: No contrast reveals ('It's not about X, it's about Y'), no 'no X, no Y, no Z' triplets, no self-answered questions ('The result? More bookings.'), no colon reveals, no restating comma-clauses.",
    "- NEVER USE STOCK OPENERS OR JARGON: Strictly avoid 'I hope this email finds you well', 'My name is ... and I work at ...', 'I came across your website/profile and was impressed', 'Here's the thing', 'I'll be honest', 'Quick question' as an opener, 'Say goodbye to', 'Unlock', 'Take your business to the next level', 'elevate', 'streamline', 'seamless', 'synergy', 'leverage', 'supercharge', 'unleash', 'cutting-edge', 'game-changing', 'holistic', 'empower', 'circle back', 'best-in-class', 'drive meaningful results'.",
    "- NO LAZY FOLLOW-UP FILLER: Never write 'Just checking in', 'Bumping this to the top', 'Following up on my previous message', 'Did you see my last email?', or guilt-tripping phrases like 'I never heard back'.",
    "",
    "### 5. FLEXIBLE MESSAGE SHAPES & FOLLOW-UPS",
    "- PICK ONE NATURAL SHAPE (DO NOT FORCE ONE TEMPLATE): Observation -> Angle -> Ask | Targeted Question -> Value -> Ask | Situation -> Typical Bottleneck -> Question. Only cite proof/examples if supplied in user context.",
    "- STANDALONE FOLLOW-UPS (`isFollowUp: true`): Assume they missed earlier touches. Never repeat or summarize your last email. Bring one fresh angle, one grounded detail, or a low-pressure close-the-loop note (for touch 3+, allow an easy out with zero pressure).",
    "",
    "### 6. SUBJECT LINES (LOWERCASE, SHORT, INTERNAL-LOOKING)",
    "- email / contact_form subjects: 2-4 words max, lowercase, plain, boring/internal-looking like a colleague wrote it (e.g. 'patient booking flow', 'website question', 'local search').",
    "- NEVER use product pitches, urgency, exclamation marks, emojis, recipient's first name, or deceptive 'Re:' / 'Fwd:' prefixes.",
    "",
    "### 7. SITUATIONAL CALL-TO-ACTION (CTA) REASONING",
    "- ONE LOW-FRICTION ASK PER MESSAGE: End with a single easy-to-answer interest question (e.g. 'Worth exploring?', 'Open to a quick idea on this?', 'How are you handling that right now?'). Never ask for a 15- or 30-minute call, Zoom link, or calendar slot on cold initial contact.",
    "",
    "### 8. CHANNEL ADAPTATION GUIDANCE",
    "- email: Plain-text, mobile-scannable short paragraphs (`\\n\\n` between opener, core point, ask, and short sign-off). Target 45-90 words (`lengthPreference: 'short'` -> 35-65 words; `'detailed'` -> 90-130 words).",
    "- instagram: Peer-to-peer DM feel (20-55 words, 1-2 short lines), casual & direct, ZERO email greetings/sign-offs ('Dear', 'Best regards'), `subject MUST be null`, one grounded detail or honest question.",
    "- phone: Spoken phone script format (`subject MUST be null`): casual opener + quick permission check, 1-sentence reason for calling tied to their business, 1 open discovery question, and 2 short spoken responses for common brush-offs.",
    "- contact_form: Direct business inquiry (45-85 words), 2-4 word lowercase subject, clear ask to connect or route to the right person.",
    "",
    "### 9. ACTION GUIDELINES",
    "- generate: Craft a fresh, grounded outreach draft.",
    "- rewrite: Strip AI tells, fluff, and marketing tone while keeping verified facts and honoring `customInstructions`.",
    "- shorten: Cut to <= 65 words without losing the core relevance and single soft CTA.",
    "- expand: Add helpful context or clearer reasoning using only grounded facts (no fluff).",
    "- objections: Acknowledge their hesitation genuinely with zero pressure and keep the door open.",
    "",
    '### 10. OUTPUT CONTRACT: Respond with ONLY a valid JSON object matching the exact shape: {"subject": string | null, "body": string}. Use `\\n\\n` inside `body` for clean paragraph breaks where appropriate. No markdown code fences or extra keys.',
  ].join("\n");

  // User Prompt Payload: Structured runtime context
  const userPayload = {
    action,
    channel,
    tone,
    template: template || undefined,
    lengthPreference: lengthPreference || undefined,
    isFollowUp,
    touchCount: sequenceHistory?.touchCount ?? (isFollowUp ? 2 : 1),
    customInstructions: customInstructions || undefined,
    senderName: senderName || freelancer?.senderName || undefined,
    contextNotes: contextNotes || undefined,
    currentDraft: {
      subject: currentDraft?.subject || undefined,
      body: currentDraft?.body || undefined,
    },
    freelancerContext: {
      profession: freelancer?.profession || "Independent Specialist",
      professionSlug: freelancer?.professionSlug || undefined,
      senderName: senderName || freelancer?.senderName || undefined,
    },
    leadData: {
      businessName: lead.businessName || "the business",
      niche: pBusinessNameAndNiche ? lead.niche || undefined : undefined,
      website: lead.website || undefined,
      instagram: pInstagram ? lead.instagram || undefined : undefined,
      phone: lead.phone || undefined,
      email: lead.email || undefined,
      opportunityScore: lead.opportunityScore ?? undefined,
      location: pLocation ? lead.location || undefined : undefined,
      region: pLocation ? lead.region || undefined : undefined,
      reviewsCount: pReviews ? lead.reviewsCount ?? undefined : undefined,
      reviewsRating: pReviews ? lead.reviewsRating ?? undefined : undefined,
      websiteIsWeak: lead.websiteIsWeak ?? undefined,
      loadTimeMs: lead.loadTimeMs ?? undefined,
      signals: lead.signals ?? undefined,
    },
    personalizationSettings: {
      includeBusinessNameAndNiche: pBusinessNameAndNiche,
      includeRecentInstagramActivity: pInstagram,
      includeLocationAndMarket: pLocation,
      includeReviewsAndReputation: pReviews,
      includeSimilarSuccessStories: pSimilarStories,
    },
    sequenceHistory: sequenceHistory?.previousSends?.length
      ? {
          previousTouchCount: sequenceHistory.previousSends.length,
          lastChannelUsed: sequenceHistory.previousSends[0]?.channel,
          lastSubjectUsed: sequenceHistory.previousSends[0]?.subject,
          lastSentAt: sequenceHistory.previousSends[0]?.timestamp,
        }
      : undefined,
  };

  return {
    system: systemPrompt,
    user: JSON.stringify(userPayload),
  };
}

/**
 * Normalizes and sanitizes generated outreach output:
 * - Enforces null subject for Instagram and Phone channels
 * - Eliminates stray em dashes ('—') and en dashes ('–') naturally and grammatically
 * - Trims whitespace
 */
export function sanitizeOutreachOutput(
  raw: { subject?: string | null; body?: string },
  channel: OutreachChannel,
  fallbackSubject?: string | null
): { subject: string | null; body: string } {
  const rawBody = typeof raw.body === "string" ? raw.body : "";

  // Replace em dashes and en dashes grammatically while preserving intentional paragraph breaks
  const cleanedBody = rawBody
    .replace(/\r\n/g, "\n")
    .replace(/([a-z0-9])\s*[—–]\s*([A-Z])/g, "$1. $2")
    .replace(/([a-z0-9])\s*[—–]\s*([a-z])/g, "$1, $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\.\s*,/g, ".")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let cleanedSubject: string | null = null;
  if (channel !== "instagram" && channel !== "phone") {
    const rawSub = typeof raw.subject === "string" && raw.subject.trim() ? raw.subject : fallbackSubject;
    if (typeof rawSub === "string" && rawSub.trim()) {
      cleanedSubject = rawSub
        .replace(/\s*[—–]\s*/g, ": ")
        .replace(/:\s*:/g, ":")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  return {
    subject: cleanedSubject,
    body: cleanedBody,
  };
}
