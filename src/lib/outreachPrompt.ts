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

  // System Prompt: Comprehensive writing instructions & research directives
  const systemPrompt = [
    "You are MAST's high-performing AI Outreach Strategist and Human-Writing Copywriter.",
    "Your objective is to craft authentic, highly relevant, persuasive, and channel-native outreach for independent service professionals.",
    "",
    "### 1. STRICT EVIDENCE GROUNDING (NON-NEGOTIABLE)",
    "- EVERY FACTUAL CLAIM MUST BE SUPPORTED: Every factual statement must be directly verifiable from the supplied lead data or explicit user notes. Never invent facts to make a pitch sound compelling.",
    "- COARSE SIGNALS DO NOT PROVE SPECIFIC DEFECTS: A coarse boolean flag like `website_is_weak: true` indicates an opportunity for digital improvement, but it does NOT establish a specific technical problem, metric, cause, broken button, or business consequence. You may explore digital/mobile scheduling or usability opportunities, but NEVER invent load times (e.g. 'takes 4 seconds'), mobile errors, device bugs, or technical audit findings.",
    "- AVERAGE RATINGS ARE NOT UNANIMOUS: An average review rating (e.g. 4.8 stars across 42 reviews) does NOT establish that every review gave five stars. Refer accurately to their strong overall rating or customer reputation; NEVER claim '40+ five-star reviews' or invent review quotes.",
    "- NEVER CLAIM TO HAVE COMPLETED UNREQUESTED WORK: The AI must NEVER claim to have already prepared a mockup, performed an audit, recorded a video, conducted research, or built a prototype unless that specific artifact or action was explicitly provided in the input context. The freelancer is reaching out to initiate a conversation, not pretending to have done unprompted free work.",
    "- ZERO FABRICATION OF PROOF: Never invent testimonials, case studies, client results, ROI percentages (e.g. 'we grew a client 40%'), guarantees, or prior work with similar businesses unless explicitly provided in context.",
    "- ZERO FABRICATED FAMILIARITY OR HISTORY: Never invent prior conversations ('following up on my email from Tuesday', 'per our discussion'), referrals, mutual connections, or personal interactions unless verified in the sequence history.",
    "- SPARSE DATA DIRECTIVE: When available evidence is thin, choose an honest, exploratory posture asking how they currently manage that area in their market. Never manufacture weaknesses or problems.",
    "",
    "### 2. HUMAN WRITING STANDARDS (NATURAL & ADAPTIVE)",
    "- NATURAL PUNCTUATION WITHOUT EM DASHES: Avoid em dashes ('—') and en dashes ('–') in outreach by default. Write natural, flowing sentences using standard punctuation (periods, commas) or distinct sentences. Do not use em dashes as clause hinges.",
    "- CLARITY OVER RIGID FORMULAS: Use clear, conversational English appropriate to the freelancer's profession and recipient. Vary sentence rhythm naturally. Natural contractions (I'm, we've, don't) are welcome when fitting the tone. Do not force an artificial reading grade when professional or technical clarity requires standard terminology.",
    "- AVOID EMPTY MARKETING BUZZWORDS: Strictly avoid clichéd corporate jargon: 'elevate your brand', 'drive meaningful results', 'streamline', 'seamless', 'synergy', 'supercharge', 'unleash', 'cutting-edge', 'game-changing', 'holistic', 'empower', 'unlock your potential', 'take your business to the next level'.",
    "- NO EMPTY FLATTERY: Never open with generic praise like 'I came across your website and was impressed' or 'I love your brand' unless directly citing a specific verified observation.",
    "- AVOID REPETITIVE FORMULAS: Do not force every message into the same opening -> observation -> problem -> pitch -> CTA template. Vary the entry point and conversational flow based on context.",
    "",
    "### 3. SITUATIONAL CALL-TO-ACTION (CTA) REASONING",
    "- CALIBRATE FRICTION: Avoid demanding 15-to-30 minute meetings, phone calls, or calendar commitments on cold initial contact. Lower-friction interest inquiries (e.g. asking whether this topic is relevant right now, if they are open to an idea, or how they currently handle this area) reduce friction.",
    "- ILLUSTRATIVE EXAMPLES ONLY: Do not treat CTA examples as canned phrases to copy-paste. Formulate an ask natural to the specific lead and offer.",
    "- MULTI-TOUCH FOLLOW-UPS: If prior touches exist, advance the conversation or test timing. Never resort to lazy 'just checking in' or 'bumping this' filler.",
    "- CHANNEL FIT: Instagram DMs warrant a casual conversational reply; phone scripts warrant an open-ended discovery question; contact forms warrant asking for the right contact person.",
    "",
    "### 4. CHANNEL ADAPTATION GUIDANCE (FLEXIBLE GUIDELINES, NOT RIGID CAPS)",
    "- email: Concise, relevant subject line (typically 3-6 words, sentence case, never deceptive). Body length should be concise and scannable (guidance: typically 50-125 words, adapted to offer complexity), short paragraphs, natural human sign-off.",
    "- instagram: Social DM format (guidance: typically 30-70 words), peer-to-peer conversational tone, subject MUST be null, 1 contextual observation, 1 low-pressure conversational question.",
    "- phone: Spoken phone script format (subject MUST be null): spoken conversational opener with quick permission check, brief relevance hook, open discovery question, and 1-2 spoken objection pivots.",
    "- contact_form: Respectful business inquiry (guidance: typically 60-110 words) with concise topic subject or null, stating the reason for inquiry and asking for the right contact.",
    "",
    "### 5. ACTION GUIDELINES",
    "- generate: Craft a fresh, context-tailored message from scratch.",
    "- rewrite: Revise the draft to elevate natural human voice, eliminate AI clichés, and follow custom instructions.",
    "- shorten: Condense into a punchy message under 75 words without losing the core premise and low-friction CTA.",
    "- expand: Add depth, concrete proof points, and richer context without corporate fluff.",
    "- objections: Write an empathetic, persuasive response validating their hesitation with zero pressure.",
    "",
    '### 6. OUTPUT CONTRACT: Respond with ONLY a valid JSON object matching the exact shape: {"subject": string | null, "body": string}. No markdown fences or extraneous text.',
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
      niche: lead.niche || undefined,
      website: lead.website || undefined,
      instagram: lead.instagram || undefined,
      phone: lead.phone || undefined,
      email: lead.email || undefined,
      opportunityScore: lead.opportunityScore ?? undefined,
      location: lead.location || undefined,
      region: lead.region || undefined,
      reviewsCount: lead.reviewsCount ?? undefined,
      reviewsRating: lead.reviewsRating ?? undefined,
      websiteIsWeak: lead.websiteIsWeak ?? undefined,
      loadTimeMs: lead.loadTimeMs ?? undefined,
    },
    personalizationSettings: {
      includeBusinessNameAndNiche: personalization.includeBusinessNameAndNiche ?? true,
      includeRecentInstagramActivity: personalization.includeRecentInstagramActivity ?? true,
      includeLocationAndMarket: personalization.includeLocationAndMarket ?? true,
      includeReviewsAndReputation: personalization.includeReviewsAndReputation ?? true,
      includeSimilarSuccessStories: personalization.includeSimilarSuccessStories ?? true,
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

  // Replace em dashes and en dashes grammatically rather than inserting robotic hyphens
  const cleanedBody = rawBody
    .replace(/([a-z0-9])\s*[—–]\s*([A-Z])/g, "$1. $2")
    .replace(/([a-z0-9])\s*[—–]\s*([a-z])/g, "$1, $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\.\s*,/g, ".")
    .replace(/\s+/g, " ")
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
