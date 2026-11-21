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
  igFollowers?: string;
  igBio?: string;
  igLastPost?: string;
  websiteObservations?: string[];
  signals?: Record<string, unknown>;
}

export interface FreelancerContext {
  profession?: string;
  professionSlug?: string;
  senderName?: string;
  bookingUrl?: string;
}

export interface CustomUserPlaybook {
  name: string;
  instructions: string;
  exampleMessages?: string | null;
}

export interface WebsiteVisualCritique {
  visualSummary?: string | null;
  auditBullets?: string[];
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
    bodySnippet?: string;
  }>;
}

const PROFESSION_CREATIVE_LENSES: Record<string, string[]> = {
  graphic_design: [
    "Brand cohesion gap: their craft/product looks great, but the visual identity across their website, menus/packaging, or social graphics doesn't match that quality yet.",
    "First-impression visual hierarchy: how their hero layout, typography, or color contrast frames their brand in the first 3 seconds.",
    "Social-to-storefront visual polish: turning their best offers or signature items into thumb-stopping graphics, menus, or brand assets.",
    "Refreshing dated brand assets or promo graphics so they stand out against cookie-cutter local competitors.",
  ],
  digital_marketing: [
    "Traffic & retargeting blindspot: getting local visitors or social attention without a Meta Pixel / Google Tag or clear offer to capture and retarget them.",
    "Search & local discovery capture: turning local 'near me' searches and profile views into tracked calls, bookings, or foot traffic.",
    "Offer-led campaign hook: pitching a specific seasonal promo, local ad angle, or lead-capture funnel tailored to their signature service.",
    "Bridging organic social activity into measurable customer inquiries.",
  ],
  writing_translation: [
    "Homepage headline & positioning hook: sharpening their main hero message so first-time visitors immediately get why they're different.",
    "Service/menu copy that sells: turning flat descriptions into vivid, high-converting copy that matches their real-world personality.",
    "Email/retention storytelling: keeping past customers coming back with short, personality-driven updates or sequences.",
    "Multilingual or local-market adaptation to reach a wider neighborhood demographic.",
  ],
  video_animation: [
    "Short-form Reel/TikTok hook: turning their most visual product, service, or behind-the-scenes process into high-retention 15-30s vertical clips.",
    "Static-to-motion upgrade: noticing their site or social feed relies on static photos where a quick motion clip or video hero would grab attention instantly.",
    "Visual storytelling angle: showcasing the craft, energy, or customer reaction in a fast-paced edit built for local reach.",
    "Ad creative / motion graphics that make their flagship offer pop in local feeds.",
  ],
  music_audio: [
    "Sonic identity & audio polish: elevating their reels, ads, podcast, or in-store/promo videos with custom sound design, mixing, or original audio.",
    "Voiceover & narrative clarity: making their promo clips or explainers sound warm, broadcast-ready, and unmistakable.",
    "Custom audio hooks that keep viewers watching past the first 3 seconds on social video.",
  ],
  programming_tech: [
    "Cleaner, more modern site experience: helping their website look sharper on phones and convert visitors smoothly without friction.",
    "Interactive flow upgrade: adding 1-tap online booking, ordering, or instant quote requests directly on the page.",
    "Speed & mobile polish: tightening up the layout so local customers searching on their phone can take action in seconds.",
    "Custom automation or web integration that saves their team hours of manual back-and-forth.",
  ],
  data: [
    "Attribution & conversion visibility: knowing exactly which channel, page, or campaign actually drives paying customers instead of guessing.",
    "Customer & booking pattern insights: spotting peak demand, repeat-buyer trends, or drop-off points in their funnel.",
    "Clean, zero-fluff reporting dashboard that consolidates their sales, bookings, or marketing data.",
  ],
  business: [
    "Speed-to-lead & missed after-hours inquiries: capturing customers who reach out when the team is busy on the floor or closed.",
    "Client intake & follow-up operations: streamlining how inquiries, quotes, and repeat bookings move from first message to paid client.",
    "Operational bottleneck question: asking how they currently handle scheduling, follow-ups, or customer reactivation.",
  ],
  photography: [
    "Hero & visual appetite appeal: replacing dated, dark, or stock-looking photos with crisp original imagery of their signature work, food, team, or space.",
    "Consistent visual look across Website, Instagram, and Google listing so customers feel the quality before they walk in.",
    "Quick, zero-disruption shoot concept focused on their highest-margin products or services.",
  ],
  finance: [
    "Margin & cash-flow clarity for busy owners: keeping books, job costing, or recurring expenses clean without eating up their weekends.",
    "Profitability visibility across services/locations so they know where their best margins actually come from.",
    "Low-friction financial operations question tailored to growing independent businesses.",
  ],
  personal_growth_hobbies: [
    "Founder/team energy, leadership, or workshop collaboration tailored to their community or team culture.",
    "Partnering on a local experience, class, or customer-engagement event that brings new people through their doors.",
  ],
  end_to_end_project: [
    "Complete digital storefront & conversion upgrade: connecting brand look, site experience, and booking/inquiry capture into one cohesive flow.",
    "Fixing the gap between their real-world quality and how their online presence converts first-time visitors.",
    "High-impact before/after concept covering both visual presentation and customer conversion.",
  ],
};

export function resolveProfessionCreativeLens(
  profession?: string,
  professionSlug?: string,
): { label: string; angles: string[] } {
  if (professionSlug && PROFESSION_CREATIVE_LENSES[professionSlug]) {
    return {
      label: profession || professionSlug.replace(/_/g, " "),
      angles: PROFESSION_CREATIVE_LENSES[professionSlug],
    };
  }
  const p = (profession || "").toLowerCase();
  if (/video|animat|reel|tiktok|editor|motion|film/i.test(p)) {
    return { label: profession || "Video & Animation Specialist", angles: PROFESSION_CREATIVE_LENSES.video_animation };
  }
  if (/photo|shoot|camera/i.test(p)) {
    return { label: profession || "Photographer", angles: PROFESSION_CREATIVE_LENSES.photography };
  }
  if (/writ|copy|content|translat|blog|ghost/i.test(p)) {
    return { label: profession || "Copywriter & Content Specialist", angles: PROFESSION_CREATIVE_LENSES.writing_translation };
  }
  if (/market|seo|ads|media|growth|ppc|social/i.test(p)) {
    return { label: profession || "Digital Marketing Specialist", angles: PROFESSION_CREATIVE_LENSES.digital_marketing };
  }
  if (/design|brand|graphic|ui|ux|creative|logo/i.test(p)) {
    return { label: profession || "Design & Branding Specialist", angles: PROFESSION_CREATIVE_LENSES.graphic_design };
  }
  if (/music|audio|sound|voice|podcast/i.test(p)) {
    return { label: profession || "Audio & Sound Specialist", angles: PROFESSION_CREATIVE_LENSES.music_audio };
  }
  if (/data|analyt|bi|tracking/i.test(p)) {
    return { label: profession || "Data & Analytics Specialist", angles: PROFESSION_CREATIVE_LENSES.data };
  }
  if (/financ|account|bookkeep|cfo|tax/i.test(p)) {
    return { label: profession || "Finance & Accounting Specialist", angles: PROFESSION_CREATIVE_LENSES.finance };
  }
  if (/dev|program|tech|web|software|engineer|automat|ai/i.test(p)) {
    return { label: profession || "Web & Technical Specialist", angles: PROFESSION_CREATIVE_LENSES.programming_tech };
  }
  if (/busines|consult|operat|sales|crm/i.test(p)) {
    return { label: profession || "Business & Operations Specialist", angles: PROFESSION_CREATIVE_LENSES.business };
  }
  return {
    label: profession || "Independent Specialist",
    angles: PROFESSION_CREATIVE_LENSES.end_to_end_project,
  };
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
  userPlaybook?: CustomUserPlaybook;
  websiteVisualCritique?: WebsiteVisualCritique;
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
    userPlaybook,
    websiteVisualCritique,
  } = params;

  // Determine whether this request represents a follow-up touch
  const isFollowUp = Boolean(
    sequenceHistory?.isFollowUp ||
      (sequenceHistory?.touchCount && sequenceHistory.touchCount > 1) ||
      (template && /^(follow_up|follow_up_2day|follow_up_5day|buried_bump|reengagement|pricing_transition)$/i.test(template)) ||
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

  const professionLens = resolveProfessionCreativeLens(
    freelancer?.profession,
    freelancer?.professionSlug,
  );
  const isRegeneratingFreshTake =
    action === "generate" && Boolean(currentDraft?.body && currentDraft.body.trim().length > 15);

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
    "### 2. BUSINESS PERSONALIZATION WITH RESTRAINT (REAL HOOKS, NO DATABASE READOUTS)",
    "- BAN ROBOTIC RATING/STAT OPENERS: NEVER open with 'Hey, I saw your 4.9 rating on...', 'Saw your 4.8 stars...', or 'Congrats on X reviews'. Nobody talks like that in real life—it immediately screams automated spam.",
    "- ONLY MENTION REAL CUSTOMER-FACING BROKEN BUTTONS WHEN EXPLICITLY VERIFIED: You may ONLY mention a dead button if `leadData.websiteObservations` or `contextNotes` explicitly reports a customer action button (like 'Book Now', 'Order Online', 'Get a Quote', 'Schedule') with an empty/'#' link. NEVER invent broken buttons, and NEVER mention random nav links or unfamiliar labels.",
    "- USE REAL, NATURAL HUMAN HOOKS (IN THIS ORDER):",
    "  1. `contextNotes` (highest priority—whatever the user personally noticed).",
    "  2. `leadData.igLastPost` / `leadData.igBio`: If present, react like a real human to what they actually posted or do (e.g. 'saw your recent post about...', 'loved the look of...'). Never invent post details that aren't in `igLastPost`.",
    "  3. Verified customer-action gap from `leadData.websiteObservations` or `websiteVisualCritique`: If a high-intent customer button ('Book', 'Order', 'Schedule', 'Get a Quote') is explicitly flagged as unlinked, or if they have no online booking / outdated site layout, mention it naturally—or simply offer to make their site/brand/content look cleaner and convert better.",
    "  4. Or open with a straightforward, honest question relevant to their business.",
    "- CONNECTED PERSONALIZATION ('SO WHAT?' TEST): Every personalized detail must tie directly into why you're reaching out. Never recite CRM fields back like a spreadsheet.",
    "- PICK AT MOST 1-2 CUES: Never cram name + city + rating + niche into one opener.",
    "- TRANSLATE RAW LABELS INTO NATURAL WORDS: Never echo raw category/niche tags verbatim; talk naturally ('clinic', 'shop', 'team', 'studio', 'site').",
    "- RESPECT PERSONALIZATION TOGGLES: Never bring up location, reviews/rating, Instagram activity, niche framing, or similar-business outcomes if the corresponding `personalizationSettings` flag is false. Only mention similar-business success stories if a real outcome is explicitly supplied in `contextNotes` or `customInstructions`.",
    "",
    "### 2B. CREATIVE DIVERSITY & FREELANCER-NICHE ADAPTATION (NEVER SOUND ONE-DIMENSIONAL)",
    "- TAILOR TO THE SENDER'S EXACT CRAFT (`freelancerContext.profession` & `creativeAnglesForProfession`):",
    "  * A Video Editor / Animator pitches short-form Reel hooks, motion storytelling, or turning static visuals into high-retention clips—NOT web code.",
    "  * A Graphic / Brand Designer pitches visual identity, menu/packaging/feed cohesion, or making their brand look cleaner and sharper.",
    "  * A Photographer pitches original hero/product/food/space imagery and appetite appeal over stock or dated visuals.",
    "  * A Copywriter / Content Specialist pitches homepage messaging clarity, offer positioning, or customer retention copy.",
    "  * A Digital Marketer / Growth Specialist pitches local search capture, retargeting, or offer-driven campaigns that bring in leads.",
    "  * A Web Developer / Tech Specialist pitches making their site look cleaner/modern, mobile UX, smoother booking/ordering flow, or time-saving automations.",
    "  * A Business / Operations / Finance / Data / Audio Specialist pitches directly from their domain expertise using `freelancerContext.creativeAnglesForProfession`.",
    "- DIVERSE PERSONALIZATION ARCHETYPES (ROTATE CREATIVELY, DO NOT REPEAT ONE FORMULA):",
    "  1. Signature Offer / Craft Callout: Reference what their business actually does or specializes in and connect it to a clean creative idea.",
    "  2. 'Make It Look Better' Visual Upgrade: Checked out their site/socials—they clearly do great work in person, and you have a couple ideas to make their online look/layout match that level.",
    "  3. Smoother Customer Flow: Making it easier for a local customer checking them out on their phone to book, order, or reach out.",
    "  4. Bite-Sized Creative Concept: Pitch 1 specific, tangible micro-idea tailored to their niche (e.g. a 15s Reel concept, a cleaner homepage hero layout, a simpler booking flow, a visual refresh).",
    "  5. Social-to-Site Momentum Bridge: Connecting their Instagram presence to what happens when people check out their site.",
    "  6. Local Standout Angle: How a cleaner look or sharper content separates them from other spots in their area.",
    "  7. Sharp Operator Question: Skip the observation and ask a direct, thoughtful question about how they currently handle that part of the business.",
    "- FRESH ANGLE ON REGENERATION (`isRegeneratingFreshTake: true`): When `isRegeneratingFreshTake` is true, `currentDraft.body` shows the previous draft the user wasn't satisfied with. You MUST pick a COMPLETELY DIFFERENT personalization archetype, opening hook, and angle from `currentDraft.body`. Never reuse the same opening line or observation.",
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
    "### 5. FLEXIBLE MESSAGE SHAPES & HUMAN FOLLOW-UPS",
    "- PICK ONE NATURAL SHAPE: Observation -> Why it matters -> Low-friction question | Direct question -> Simple fix -> Soft ask.",
    "- FOLLOW-UPS (`isFollowUp: true` or follow-up `template`): Read `sequenceHistory.previousMessages` carefully so you NEVER repeat the same opener, pitch, or angle you already sent:",
    "  * `follow_up_2day` / touch 2: Keep it 35-60 words. Do NOT say 'just checking in' or 'following up'. Bring ONE new concrete detail you didn't lead with (e.g., another website observation, IG note, or a 1-sentence example of the fix) and end with an easy yes/no question.",
    "  * `follow_up_5day` / `buried_bump` / touch 3: Ultra-short (20-45 words). Casual human bump with zero guilt (e.g., 'Hey, did this get buried or just not a priority right now?').",
    "  * `reengagement` / touch 4+: Short, respectful close-the-loop note giving them a zero-pressure out ('Won't keep bugging you—if you ever want help with this down the road, just reply here.').",
    "  * `pricing_transition`: Plain-English next step or simple scope framing without sounding like a brochure; include `freelancerContext.bookingUrl` only if appropriate/warm.",
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
    "### 9B. CUSTOM USER PLAYBOOK & VERIFIED VISUAL CRITIQUE (WHEN SUPPLIED)",
    "- CUSTOM VOICE / PLAYBOOK (`userPlaybook`): When `userPlaybook` is present, prioritize its writing style, phrasing, rhythm, structure, offer, and examples so the draft genuinely sounds like THIS user talking. You MUST still obey Section 1 (never fabricate lead facts, metrics, or fake reviews) and Section 10 (strict JSON contract).",
    "- VERIFIED VISUAL WEBSITE OBSERVATIONS (`websiteVisualCritique`): When `websiteVisualCritique` is present, its `visualSummary` and `auditBullets` come from an actual inspected homepage/screenshot—you MAY reference 1 concrete observation from it naturally (e.g. layout feel, missing booking CTA, mobile friction). Never exaggerate beyond what is stated in `websiteVisualCritique`.",
    "- BOOKING LINK (`freelancerContext.bookingUrl`): Only include the user's booking link when replying to a warm/interested lead or when `customInstructions` / `userPlaybook` explicitly ask to share a scheduling link. Never shove a booking link into a cold first touch unless explicitly requested by the user's playbook.",
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
    isRegeneratingFreshTake,
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
      creativeAnglesForProfession: professionLens.angles,
      senderName: senderName || freelancer?.senderName || undefined,
      bookingUrl: freelancer?.bookingUrl || undefined,
    },
    userPlaybook: userPlaybook
      ? {
          name: userPlaybook.name,
          instructions: userPlaybook.instructions,
          exampleMessages: userPlaybook.exampleMessages || undefined,
        }
      : undefined,
    websiteVisualCritique:
      websiteVisualCritique &&
      (websiteVisualCritique.visualSummary || (websiteVisualCritique.auditBullets && websiteVisualCritique.auditBullets.length > 0))
        ? {
            visualSummary: websiteVisualCritique.visualSummary || undefined,
            auditBullets: websiteVisualCritique.auditBullets?.slice(0, 5),
          }
        : undefined,
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
      igFollowers: pInstagram ? lead.igFollowers || undefined : undefined,
      igBio: pInstagram ? lead.igBio || undefined : undefined,
      igLastPost: pInstagram ? lead.igLastPost || undefined : undefined,
      websiteObservations:
        lead.websiteObservations && lead.websiteObservations.length > 0
          ? lead.websiteObservations
          : undefined,
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
          previousMessages: sequenceHistory.previousSends.slice(0, 3).map((s) => ({
            channel: s.channel,
            subject: s.subject,
            timestamp: s.timestamp,
            bodySnippet: s.bodySnippet,
          })),
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
