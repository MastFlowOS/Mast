/**
 * Deterministic outreach-content profiles for the 12 canonical professions.
 *
 * This is the ONLY registry of profession-flavored outreach copy in the
 * codebase — it is not a second profession list. The canonical list of
 * professions (`PROFESSION_SLUGS`) and their canonical display labels
 * (`FOCUS_AREA_LABELS`) stay owned by src/lib/professions.ts and are
 * imported/zipped below, never re-typed.
 *
 * `graphic_design` is the REVIEWED / APPROVED reference profile — its
 * content is encoded here verbatim from its review pass and must not be
 * altered without a new review. The remaining 11 profiles were authored
 * against that same structure and quality bar, and against the
 * per-profession safety constraints (no guarantees/ROI/compliance claims
 * for finance, no claimed diagnosis for business, no implied inadequacy
 * for personal_growth_hobbies, no asserted defect for programming_tech, no
 * claimed knowledge of the lead's actual data for data, and independent,
 * uncombined angles for end_to_end_project).
 *
 * `Record<ProfessionSlug, ProfessionProfile>` is what makes "all 12
 * professions present" a compile-time guarantee rather than something
 * checked at runtime.
 */

import { PROFESSION_SLUGS, FOCUS_AREA_LABELS, type ProfessionSlug } from "@/lib/professions";
import type { OpportunityComponent } from "@/lib/outreach/types";

// ─── Types owned by this module ─────────────────────────────────────────────
// (Not added to src/lib/outreach/types.ts — these are profession-content
// concerns, not cross-module contracts. Other modules that need them import
// from here, the same way they'd import ProfessionSlug from professions.ts.)

/**
 * One authored problem framing for a single Opportunity component, scoped
 * to this profession. `safeWhen` is authored guidance on when this framing
 * is an appropriate thing to reach for — a human-readable condition, not
 * runtime-enforced logic.
 */
export type ProfessionProblem = {
  readonly component: OpportunityComponent;
  readonly problemConcept: string;
  readonly safeWhen: string;
};

/**
 * The register a profession's CTA takes. Exactly three values — no
 * profession-local widening: `showWork` (offer to show a direction or
 * example), `lowCommitment` (offer a small, easily-declined next step),
 * `consult` (offer a short conversation).
 */
export type CtaStyle = "lowCommitment" | "consult" | "showWork";

export type VoiceFormality = "casual" | "neutral" | "formal";
export type VoiceTechnicality = "plain" | "moderate" | "technical";

/**
 * A profession's voice/tone, as a structured pair. The category layer may
 * override tone later (see compatibility/index.ts's `toneOverride`).
 */
export type ProfessionVoice = {
  readonly formality: VoiceFormality;
  readonly technicality: VoiceTechnicality;
};

export type ProfessionProfile = {
  readonly slug: ProfessionSlug;
  /** Exactly the canonical FOCUS_AREA_LABELS entry for this slug — never hand-typed, see DISPLAY_LABELS below. */
  readonly displayLabel: string;
  /**
   * How this profession describes itself in an opening line —
   * profession-generic, never lead-specific. A small set of equivalent
   * phrasing variants.
   */
  readonly selfDescription: readonly string[];
  /**
   * The problems this profession's outreach is authored to speak to.
   * Deliberately not symmetrical across professions — a profession only
   * gets entries for the components that are actually a plausible,
   * profession-relevant angle.
   */
  readonly commonProblems: readonly ProfessionProblem[];
  /**
   * Exactly one value-prop angle per component present in
   * `commonProblems` — same key set, checked at import time below.
   */
  readonly valuePropAngles: Partial<Record<OpportunityComponent, string>>;
  readonly ctaStyle: CtaStyle;
  readonly voice: ProfessionVoice;
  /** Preferred terms for this profession's own service — wording guidance, not enforced here. */
  readonly terminology: readonly string[];
  /**
   * The deterministic floor when no useful opportunity signal or category
   * angle exists. Profession-specific by design — never a
   * profession-neutral sentence.
   */
  readonly genericFallbackAngle: string;
  /** 3–5 phrasing variants for how the sender introduces themself. No lead-specific facts, no claims. */
  readonly openingVariants: readonly string[];
  /** 3–5 phrasing variants for the invitation/ask. No pricing, guarantees, metrics, or fabricated experience. */
  readonly ctaVariants: readonly string[];
};

// ─── Canonical display labels, zipped from professions.ts (never re-typed) ─

const DISPLAY_LABELS: Record<ProfessionSlug, string> = PROFESSION_SLUGS.reduce(
  (acc, slug, i) => {
    acc[slug] = FOCUS_AREA_LABELS[i];
    return acc;
  },
  {} as Record<ProfessionSlug, string>,
);

// ─── The 12 profession profiles ─────────────────────────────────────────────

const PROFESSION_OUTREACH_PROFILES: Record<ProfessionSlug, ProfessionProfile> = {
  // REVIEWED / APPROVED — do not alter without a new review pass.
  graphic_design: {
    slug: "graphic_design",
    displayLabel: DISPLAY_LABELS.graphic_design,
    selfDescription: [
      "a freelance graphic designer who helps businesses improve their visual identity",
      "an independent designer focused on helping businesses present themselves consistently",
      "a graphic designer who helps businesses bring their logo, colors, and visual materials into a cohesive look",
    ],
    commonProblems: [
      {
        component: "branding",
        problemConcept: "a business's visual identity can become inconsistent or dated across different materials over time",
        safeWhen:
          "use when the deterministic opportunity signal identifies branding as relevant, or another verified lead signal supports a branding observation; otherwise fall back to a generic angle",
      },
      {
        component: "social",
        problemConcept: "a business's social presence can lack a consistent visual style across its content",
        safeWhen:
          "use when the deterministic opportunity signal identifies social as relevant and the business has a usable social presence; otherwise omit this angle",
      },
    ],
    valuePropAngles: {
      branding:
        "graphic design can bring a business's visual materials into a more consistent system across the places people encounter it",
      social:
        "consistent templates and visual elements can make a business's social presence feel more intentional from post to post",
    },
    ctaStyle: "showWork",
    voice: {
      formality: "casual",
      technicality: "plain",
    },
    terminology: ["visual identity", "brand look", "brand assets", "look and feel", "design work", "visual consistency"],
    genericFallbackAngle:
      "graphic design can help a business make its visual materials feel more consistent wherever people encounter the brand",
    openingVariants: [
      "Hi, I'm a freelance graphic designer — I help businesses improve their visual identity.",
      "I'm an independent designer focused on helping businesses bring their visual look together.",
      "I do graphic design work around branding and visual consistency.",
    ],
    ctaVariants: [
      "Would it be useful if I shared a few quick thoughts?",
      "Happy to put together a direction or two if you're open to it.",
      "Let me know if you'd like to see how I'd approach it.",
    ],
  },

  digital_marketing: {
    slug: "digital_marketing",
    displayLabel: DISPLAY_LABELS.digital_marketing,
    selfDescription: [
      "a digital marketer who helps businesses become easier to find online",
      "an independent marketer who works with businesses on visibility and audience",
      "a marketer focused on helping businesses show up consistently across their channels",
    ],
    commonProblems: [
      {
        component: "social",
        problemConcept: "a business's social channels can be posted to sporadically rather than as part of any consistent presence",
        safeWhen:
          "use when the deterministic opportunity signal identifies social as relevant and the business has a social presence at all; otherwise omit",
      },
      {
        component: "growth",
        problemConcept: "a business can rely on word of mouth without a repeatable way of reaching new people",
        safeWhen:
          "use when the deterministic opportunity signal identifies growth as relevant; never state that the business is not growing",
      },
      {
        component: "newness",
        problemConcept: "a newer business often has no established audience yet and starts from a standing audience of zero",
        safeWhen:
          "use only when the deterministic opportunity signal identifies newness as relevant; never assert how long a business has existed",
      },
    ],
    valuePropAngles: {
      social: "marketing work can give a business's channels a steadier rhythm so its presence reads as deliberate",
      growth: "campaign and channel work can give a business a repeatable way of reaching people beyond referrals",
      newness: "early marketing work can help a newer business build an audience from the start rather than later",
    },
    ctaStyle: "lowCommitment",
    voice: { formality: "neutral", technicality: "plain" },
    terminology: ["visibility", "audience", "channels", "campaigns", "inquiries", "marketing consistency"],
    genericFallbackAngle:
      "digital marketing can help a business become easier to find and more consistent in how it shows up across its channels",
    openingVariants: [
      "Hi, I'm a digital marketer — I work with businesses on visibility and audience.",
      "I'm an independent marketer who helps businesses show up more consistently online.",
      "I do digital marketing work, mostly around audience and channel consistency.",
      "I work with businesses on the marketing side — visibility, channels, and inquiries.",
    ],
    ctaVariants: [
      "Would it be worth me sharing a couple of ideas?",
      "Happy to send over a few thoughts if that's useful.",
      "No pressure either way — let me know if you'd like me to outline something.",
      "If it's useful I can put a short note together on how I'd approach it.",
    ],
  },

  writing_translation: {
    slug: "writing_translation",
    displayLabel: DISPLAY_LABELS.writing_translation,
    selfDescription: [
      "a freelance writer who helps businesses with the copy on their website and materials",
      "an independent writer and translator who works on business messaging",
      "a writer who helps businesses say what they do more clearly",
    ],
    commonProblems: [
      {
        component: "website",
        problemConcept: "the written copy on a business's site can leave what it actually offers less clear than it could be",
        safeWhen:
          "use when the deterministic opportunity signal identifies website as relevant; never assert that specific copy is bad or wrong",
      },
      {
        component: "branding",
        problemConcept: "a business's wording can vary in voice between the places it is written",
        safeWhen: "use when the deterministic opportunity signal identifies branding as relevant; frame as consistency, not error",
      },
      {
        component: "social",
        problemConcept: "captions and short-form copy can drift in tone from how a business writes elsewhere",
        safeWhen: "use when the deterministic opportunity signal identifies social as relevant and a social presence exists",
      },
    ],
    valuePropAngles: {
      website: "copy work can make what a business offers read more clearly to someone arriving cold",
      branding: "a written voice guide can keep a business's wording consistent wherever it is read",
      social: "short-form copy work can keep captions in the same voice as everything else a business publishes",
    },
    ctaStyle: "lowCommitment",
    voice: { formality: "neutral", technicality: "plain" },
    terminology: ["copy", "messaging", "written voice", "wording", "translation", "language adaptation"],
    genericFallbackAngle:
      "writing work can help a business explain what it offers more clearly and keep its wording consistent across materials",
    openingVariants: [
      "Hi, I'm a freelance writer — I work with businesses on website and marketing copy.",
      "I'm an independent writer and translator focused on business messaging.",
      "I do copywriting work, mostly helping businesses explain what they offer clearly.",
      "I work on written copy and translation for businesses.",
    ],
    ctaVariants: [
      "Would it help if I shared a couple of thoughts on the wording?",
      "Happy to sketch out an alternative if you'd like to see one.",
      "No obligation — let me know if you'd like me to put something together.",
      "If it's useful I can send a short rewrite of one section.",
    ],
  },

  video_animation: {
    slug: "video_animation",
    displayLabel: DISPLAY_LABELS.video_animation,
    selfDescription: [
      "a freelance video editor and animator who works with businesses on short-form content",
      "an independent video and motion designer",
      "someone who makes video and animated content for businesses",
    ],
    commonProblems: [
      {
        component: "social",
        problemConcept: "a business's social content can be mostly still images where short video would carry more of the story",
        safeWhen: "use when the deterministic opportunity signal identifies social as relevant and a social presence exists",
      },
      {
        component: "website",
        problemConcept: "a site can explain a service entirely in text where a short video would do it faster",
        safeWhen: "use when the deterministic opportunity signal identifies website as relevant; never assert the site is broken",
      },
      {
        component: "newness",
        problemConcept: "a newer business often has no video assets yet to introduce itself with",
        safeWhen: "use only when the deterministic opportunity signal identifies newness as relevant",
      },
    ],
    valuePropAngles: {
      social: "short video and motion work can give a business's social content more to hold attention with",
      website: "a short explainer or motion piece can introduce a service on a site faster than text alone",
      newness: "a first set of video assets can give a newer business something to introduce itself with",
    },
    ctaStyle: "showWork",
    voice: { formality: "casual", technicality: "plain" },
    terminology: ["video", "motion", "animation", "visual storytelling", "short-form content", "edit"],
    genericFallbackAngle:
      "video and motion work can give a business content that shows what it does rather than only describing it",
    openingVariants: [
      "Hi, I'm a freelance video editor and animator — I make short-form content for businesses.",
      "I'm an independent video and motion designer working with businesses on content.",
      "I do video and animation work, mostly short pieces for businesses.",
      "I make video and motion content — that's what I do independently.",
    ],
    ctaVariants: [
      "Happy to put a short concept together if you'd like to see one.",
      "Let me know if you'd like to see how I'd approach it.",
      "Would it be useful if I sketched out a direction?",
      "I can send over a quick example of what I mean if that helps.",
    ],
  },

  music_audio: {
    slug: "music_audio",
    displayLabel: DISPLAY_LABELS.music_audio,
    selfDescription: [
      "a freelance audio engineer and composer who works with businesses on sound",
      "an independent music and audio producer",
      "someone who does music and audio work for business content",
    ],
    commonProblems: [
      {
        component: "social",
        problemConcept: "a business's video content can use generic stock audio rather than anything tied to the business itself",
        safeWhen: "use when the deterministic opportunity signal identifies social as relevant and a social presence exists",
      },
      {
        component: "branding",
        problemConcept: "a business can have a clear look without any consistent sound attached to it",
        safeWhen: "use when the deterministic opportunity signal identifies branding as relevant; frame as an addition, not a gap",
      },
    ],
    valuePropAngles: {
      social: "original or better-fitted audio can make a business's video content sound like it belongs to that business",
      branding: "a short sonic identity can give a business a sound that matches the rest of how it presents itself",
    },
    ctaStyle: "showWork",
    voice: { formality: "casual", technicality: "plain" },
    terminology: ["sound", "audio", "mix", "sonic identity", "music", "audio production"],
    genericFallbackAngle:
      "audio work can give a business's content a sound of its own rather than generic stock music",
    openingVariants: [
      "Hi, I'm a freelance audio engineer and composer — I do sound work for businesses.",
      "I'm an independent music and audio producer.",
      "I do music and audio work, mostly for business content.",
      "I work on sound and music for businesses independently.",
    ],
    ctaVariants: [
      "Happy to put together a short sample if you'd like to hear one.",
      "Let me know if you'd like to hear how I'd approach it.",
      "Would it be useful if I sent over a quick direction?",
      "I can share a short example of what I mean if that's helpful.",
    ],
  },

  programming_tech: {
    slug: "programming_tech",
    displayLabel: DISPLAY_LABELS.programming_tech,
    selfDescription: [
      "a freelance developer who builds websites and small internal tools for businesses",
      "an independent developer working on websites, booking flows, and integrations",
      "a developer who helps businesses with the technical side of their setup",
    ],
    commonProblems: [
      {
        component: "website",
        problemConcept: "a business's site may not be doing everything the business would want it to do for visitors",
        safeWhen:
          "use only when the deterministic opportunity signal identifies website as relevant; never assert a specific technical defect without a real signal",
      },
      {
        component: "tech",
        problemConcept: "routine steps like enquiries or bookings can still be handled manually where a small tool would carry them",
        safeWhen:
          "use only when the deterministic opportunity signal identifies tech as relevant; never claim to know what systems a business runs",
      },
      {
        component: "growth",
        problemConcept: "the manual parts of a setup tend to take more time as a business handles more work",
        safeWhen: "use when the deterministic opportunity signal identifies growth as relevant; frame as capacity, never as failure",
      },
    ],
    valuePropAngles: {
      website: "development work can extend what a business's site does for the people who land on it",
      tech: "small automations and integrations can take repeat steps off a business's hands",
      growth: "building out the manual parts of a setup can keep them from taking more time as volume rises",
    },
    ctaStyle: "consult",
    voice: { formality: "neutral", technicality: "moderate" },
    terminology: ["website", "automation", "integration", "booking flow", "technical setup", "build"],
    genericFallbackAngle:
      "development work can take the repetitive parts of a business's setup and turn them into something that runs on its own",
    openingVariants: [
      "Hi, I'm a freelance developer — I build websites and small tools for businesses.",
      "I'm an independent developer working on websites, booking flows, and integrations.",
      "I do development work for businesses — sites, automations, and integrations.",
      "I work with businesses on the technical side: websites and internal tooling.",
    ],
    ctaVariants: [
      "Would a short conversation about it be worth your time?",
      "Happy to talk through what that could look like if you're interested.",
      "If it's useful, I'm glad to walk through the options briefly.",
      "Let me know if a quick call makes sense.",
    ],
  },

  data: {
    slug: "data",
    displayLabel: DISPLAY_LABELS.data,
    selfDescription: [
      "a freelance data analyst who helps businesses see what their numbers are telling them",
      "an independent analyst who sets up tracking and reporting for businesses",
      "someone who works with businesses on analytics and reporting",
    ],
    commonProblems: [
      {
        component: "tech",
        problemConcept: "a business can be collecting information without it being gathered anywhere it can be read",
        safeWhen:
          "use only when the deterministic opportunity signal identifies tech as relevant; never claim to know what a business's data actually shows",
      },
      {
        component: "growth",
        problemConcept: "as more comes in, it gets harder to tell which effort is actually accounting for it",
        safeWhen:
          "use when the deterministic opportunity signal identifies growth as relevant; never assert a specific result or number",
      },
    ],
    valuePropAngles: {
      tech: "tracking and reporting work can put a business's own numbers somewhere it can read them",
      growth: "a simple dashboard can let a business see which of its efforts the results are following",
    },
    ctaStyle: "consult",
    voice: { formality: "neutral", technicality: "technical" },
    terminology: ["analytics", "tracking", "dashboard", "reporting", "metrics", "data setup"],
    genericFallbackAngle:
      "analytics work can put a business's own numbers in one place so it can read them without digging",
    openingVariants: [
      "Hi, I'm a freelance data analyst — I set up tracking and reporting for businesses.",
      "I'm an independent analyst working on analytics and dashboards.",
      "I do data work for businesses — mostly tracking, reporting, and dashboards.",
      "I help businesses get their numbers into a form they can actually read.",
    ],
    ctaVariants: [
      "Would a short conversation about it be worth your time?",
      "Happy to talk through what a setup like that involves.",
      "If it's useful, I can walk through the options briefly.",
      "Let me know if a quick call would help.",
    ],
  },

  business: {
    slug: "business",
    displayLabel: DISPLAY_LABELS.business,
    selfDescription: [
      "a freelance business consultant who works with owners on process and operations",
      "an independent consultant focused on workflow and operations",
      "someone who works with business owners on how the day-to-day runs",
    ],
    commonProblems: [
      {
        component: "growth",
        problemConcept: "the way a business runs day to day is usually built for the size it was, not the size it is becoming",
        safeWhen:
          "use when the deterministic opportunity signal identifies growth as relevant; never claim to have diagnosed a specific operational problem",
      },
      {
        component: "newness",
        problemConcept: "a newer business is usually still deciding how its processes should work rather than changing existing ones",
        safeWhen:
          "use only when the deterministic opportunity signal identifies newness as relevant; never assert how a business currently operates",
      },
    ],
    valuePropAngles: {
      growth: "operations work can look at how a business runs and where the effort is concentrated as it takes on more",
      newness: "early process work can settle how the day-to-day runs before habits harden around it",
    },
    ctaStyle: "consult",
    voice: { formality: "neutral", technicality: "moderate" },
    terminology: ["operations", "process", "workflow", "efficiency", "strategy", "day-to-day"],
    genericFallbackAngle:
      "consulting work can look at how a business's day-to-day actually runs and where its effort is going",
    openingVariants: [
      "Hi, I'm a freelance business consultant — I work with owners on process and operations.",
      "I'm an independent consultant focused on workflow and how businesses run day to day.",
      "I do operations and process work with business owners.",
      "I work with owners on the operational side of their business.",
    ],
    ctaVariants: [
      "Would a short conversation about it be worth your time?",
      "Happy to talk it through briefly if you're open to it.",
      "If it's useful, I'm glad to have a quick chat about it.",
      "Let me know if a short call would be worthwhile.",
    ],
  },

  personal_growth_hobbies: {
    slug: "personal_growth_hobbies",
    displayLabel: DISPLAY_LABELS.personal_growth_hobbies,
    selfDescription: [
      "someone who helps people turn what they teach or make into something structured for an audience",
      "a freelancer who works with people on presenting their classes, sessions, and offerings",
      "someone who helps people package what they already do into a clearer offering",
    ],
    commonProblems: [
      {
        component: "social",
        problemConcept: "sharing what you do tends to happen in bursts around whatever is going on that week",
        safeWhen:
          "use when the deterministic opportunity signal identifies social as relevant; never imply that what the person shares is inadequate",
      },
      {
        component: "website",
        problemConcept: "an offering often lives across a few different places rather than one that explains it end to end",
        safeWhen:
          "use when the deterministic opportunity signal identifies website as relevant; frame as convenience, never as a mistake",
      },
      {
        component: "newness",
        problemConcept: "a newer offering is usually still finding the shape it wants to take",
        safeWhen: "use only when the deterministic opportunity signal identifies newness as relevant",
      },
    ],
    valuePropAngles: {
      social: "a simple rhythm can make sharing what you do feel less like something to fit in around everything else",
      website: "one clear place can hold what you offer so people aren't piecing it together",
      newness: "some structure early on can help a newer offering settle into a shape that suits it",
    },
    ctaStyle: "lowCommitment",
    voice: { formality: "casual", technicality: "plain" },
    terminology: ["offering", "sessions", "classes", "structure", "presentation", "audience"],
    genericFallbackAngle:
      "some structure around how an offering is presented can make it easier for the people looking for it to find it",
    openingVariants: [
      "Hi — I help people turn what they teach or make into something more structured for an audience.",
      "I work with people on presenting their classes, sessions, and offerings.",
      "I help people package what they already do into a clearer offering.",
      "I work on the presentation side of things — structure, consistency, and reach.",
    ],
    ctaVariants: [
      "Would it be useful if I shared a couple of thoughts?",
      "Happy to send a few ideas over if you'd like them.",
      "No pressure at all — just let me know if that's interesting.",
      "If you'd like, I can put a short note together.",
    ],
  },

  photography: {
    slug: "photography",
    displayLabel: DISPLAY_LABELS.photography,
    selfDescription: [
      "a freelance photographer who shoots for businesses",
      "an independent photographer working on business and product imagery",
      "someone who takes photos for businesses — product, space, and team",
    ],
    commonProblems: [
      {
        component: "social",
        problemConcept: "a business's images can be a mix of phone shots taken at different times in different light",
        safeWhen:
          "use when the deterministic opportunity signal identifies social as relevant and a social presence exists; never call existing photos bad",
      },
      {
        component: "website",
        problemConcept: "a site can be carrying stock imagery rather than photos of the business itself",
        safeWhen: "use when the deterministic opportunity signal identifies website as relevant",
      },
      {
        component: "branding",
        problemConcept: "photography can vary in style across the places a business appears",
        safeWhen: "use when the deterministic opportunity signal identifies branding as relevant; frame as consistency",
      },
    ],
    valuePropAngles: {
      social: "a shoot can give a business a consistent set of images to draw on instead of shooting week to week",
      website: "photos of the actual business tend to read differently from stock imagery on a site",
      branding: "one shoot can give a business images that look like they belong to the same place",
    },
    ctaStyle: "showWork",
    voice: { formality: "casual", technicality: "plain" },
    terminology: ["photography", "imagery", "shoot", "visual assets", "photos", "image library"],
    genericFallbackAngle:
      "photography can give a business a consistent set of its own images to use wherever it appears",
    openingVariants: [
      "Hi, I'm a freelance photographer — I shoot for businesses.",
      "I'm an independent photographer working on business and product imagery.",
      "I do photography for businesses — product, space, and team shots.",
      "I shoot photos for businesses independently.",
    ],
    ctaVariants: [
      "Happy to share a few examples if you'd like to see them.",
      "Let me know if you'd like to see how I'd approach it.",
      "Would it be useful if I put a quick idea together?",
      "I can send over some work if that's helpful.",
    ],
  },

  finance: {
    slug: "finance",
    displayLabel: DISPLAY_LABELS.finance,
    selfDescription: [
      "a freelance bookkeeper who helps businesses keep their records organised",
      "an independent bookkeeper working with businesses on financial admin",
      "someone who helps businesses keep on top of their bookkeeping and financial processes",
    ],
    commonProblems: [
      {
        component: "growth",
        problemConcept: "bookkeeping is often set up for an earlier stage and gets handled in batches as a business takes on more",
        safeWhen:
          "use when the deterministic opportunity signal identifies growth as relevant; never state or imply any financial outcome, saving, or compliance position",
      },
      {
        component: "newness",
        problemConcept: "a newer business is usually still setting up how its records and financial admin will be kept",
        safeWhen:
          "use only when the deterministic opportunity signal identifies newness as relevant; never reference tax, compliance, or legal matters",
      },
    ],
    valuePropAngles: {
      growth: "bookkeeping support can keep records current as a business takes on more, rather than in batches",
      newness: "setting records up early can mean a newer business isn't reconstructing them later",
    },
    ctaStyle: "consult",
    voice: { formality: "formal", technicality: "moderate" },
    terminology: ["bookkeeping", "records", "financial admin", "reconciliation", "financial processes", "organisation"],
    genericFallbackAngle:
      "bookkeeping support can keep a business's records organised and current rather than handled in batches",
    openingVariants: [
      "Hello, I'm a freelance bookkeeper — I work with businesses on keeping their records organised.",
      "I'm an independent bookkeeper supporting businesses with their financial admin.",
      "I do bookkeeping work for businesses, mostly around records and process.",
      "I work with businesses on their bookkeeping and financial processes.",
    ],
    ctaVariants: [
      "Would a brief conversation about it be worthwhile?",
      "I'd be glad to talk through what that involves if you're interested.",
      "If it would be useful, I'm happy to have a short call.",
      "Please let me know if a brief chat would be of interest.",
    ],
  },

  end_to_end_project: {
    slug: "end_to_end_project",
    displayLabel: DISPLAY_LABELS.end_to_end_project,
    selfDescription: [
      "a freelancer who takes on whole projects rather than single pieces",
      "someone who handles a project end to end so it doesn't need coordinating across people",
      "an independent generalist who takes a project from start to finish",
    ],
    commonProblems: [
      {
        component: "website",
        problemConcept: "a site, its copy, and its images are often handled by different people at different times",
        safeWhen:
          "use only when the deterministic opportunity signal identifies website as relevant, and only as the single selected angle — never combined with another",
      },
      {
        component: "branding",
        problemConcept: "pieces made separately can end up not quite matching each other",
        safeWhen:
          "use only when the deterministic opportunity signal identifies branding as relevant, and only as the single selected angle",
      },
      {
        component: "growth",
        problemConcept: "coordinating several people on one project takes time the owner has to find",
        safeWhen:
          "use only when the deterministic opportunity signal identifies growth as relevant, and only as the single selected angle",
      },
    ],
    valuePropAngles: {
      website: "one person handling a build end to end means the pieces are made to fit each other",
      branding: "a single point of contact keeps the parts of a project consistent with one another",
      growth: "handing a whole project to one person takes the coordination off the owner",
    },
    ctaStyle: "consult",
    voice: { formality: "neutral", technicality: "plain" },
    terminology: ["end-to-end project", "full setup", "single point of contact", "project", "build", "coordination"],
    genericFallbackAngle:
      "taking on a project end to end means a business isn't coordinating separate people to get one thing finished",
    openingVariants: [
      "Hi, I take on whole projects rather than single pieces — start to finish.",
      "I handle projects end to end, so there's one point of contact rather than several.",
      "I'm an independent generalist who takes a project from start to finish.",
      "I work with businesses on full projects rather than individual parts.",
    ],
    ctaVariants: [
      "Would a short conversation about it be worth your time?",
      "Happy to talk through what an end-to-end approach could look like.",
      "If it's useful, I'm glad to walk through it briefly.",
      "Let me know if a quick call makes sense.",
    ],
  },
};

// ─── Validation (fails loudly at import time, same pattern as professions.ts) ─

// 1. All 12 canonical slugs present.
for (const slug of PROFESSION_SLUGS) {
  if (!PROFESSION_OUTREACH_PROFILES[slug]) {
    throw new Error(`professions/index.ts: missing outreach profile for profession "${slug}"`);
  }
}

// 2. commonProblems and valuePropAngles must reference exactly the same
//    component set, in both directions.
for (const slug of PROFESSION_SLUGS) {
  const profile = PROFESSION_OUTREACH_PROFILES[slug];
  const problemComponents = new Set(profile.commonProblems.map((p) => p.component));
  const angleComponents = new Set(Object.keys(profile.valuePropAngles) as OpportunityComponent[]);

  if (problemComponents.size !== angleComponents.size) {
    throw new Error(
      `professions/index.ts: "${slug}" has ${problemComponents.size} commonProblems component(s) but ${angleComponents.size} valuePropAngles component(s) — they must match exactly.`,
    );
  }
  for (const component of problemComponents) {
    if (!angleComponents.has(component)) {
      throw new Error(
        `professions/index.ts: "${slug}" has a commonProblems entry for "${component}" with no matching valuePropAngles entry.`,
      );
    }
  }
}

// 3. selfDescription / openingVariants / ctaVariants variant counts.
for (const slug of PROFESSION_SLUGS) {
  const profile = PROFESSION_OUTREACH_PROFILES[slug];
  if (profile.selfDescription.length < 1) {
    throw new Error(`professions/index.ts: "${slug}".selfDescription is empty.`);
  }
  for (const [field, variants] of [
    ["openingVariants", profile.openingVariants],
    ["ctaVariants", profile.ctaVariants],
  ] as const) {
    if (variants.length < 3 || variants.length > 5) {
      throw new Error(
        `professions/index.ts: "${slug}".${field} has ${variants.length} entries — must have between 3 and 5.`,
      );
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { PROFESSION_OUTREACH_PROFILES };

/**
 * Simple pure lookup. Deliberately does not accept or fall back for
 * `null`/missing profession — the pipeline's rule is "missing profession →
 * refuse generation", not "invent a 13th generic profile".
 */
export function getProfessionOutreachProfile(slug: ProfessionSlug): ProfessionProfile {
  return PROFESSION_OUTREACH_PROFILES[slug];
}
