/**
 * src/discovery/serviceNeedGate.ts
 *
 * Deterministic, side-effect-free evaluator for the Phase 2 Service-Need Qualification Gate.
 * Distinguishes businesses with observable, verified service-need gaps from businesses
 * that merely match the broad search category, while strictly respecting:
 *
 * 1. Three-State Signal Semantics: Every signal is explicitly treated as
 *    Observed Present, Observed Absent, or Unknown/Unavailable.
 * 2. Non-Fabrication Law: Unknown or unavailable signals are NEVER converted into
 *    defects, nor used as grounds for rejection.
 * 3. Strong Assets Do Not Reject: A business with a modern website, active social media,
 *    professional photos, analytics, or booking software is NEVER rejected solely for
 *    having strong assets (outcome: UNCERTAIN).
 * 4. Explicit Incompatibility Only: Rejection occurs ONLY on verified disqualification,
 *    enterprise chain status, extreme scale (>100k followers), self-service agency
 *    conflicts, or structurally incompatible service domains.
 * 5. Unset Profession Preservation: When professionSlug is null or unset, the outcome is
 *    NOT_APPLICABLE, allowing baseline quality and channel filters to govern delivery
 *    without arbitrary rejection.
 * 6. Evidence-Based Honesty: Only signals verified to be produced by the crawler/enrichment
 *    pipeline are used for qualification. Where public web scrapers lack reliable signals
 *    (e.g. video presence, audio branding, or billing portals), the evaluator does not
 *    invent signals or substitute weak proxies; eligible candidates evaluate honestly to UNCERTAIN.
 */

import { PROFESSION_SLUGS, type ProfessionSlug } from "../lib/professions.js";
import type { EngineScoreResult, EngineLead } from "../scraperBridge/pythonBridge.js";

export type TriState<T> =
  | { state: "present"; value: T }
  | { state: "absent" }
  | { state: "unknown" };

export interface CandidateInspectionSignals {
  id?: string | null;
  name?: string | null;
  category?: string | null;
  address?: string | null;
  website?: string | null;
  website_reachable?: boolean | null;
  website_is_weak?: boolean | null;
  ssl_valid?: boolean | null;
  load_time_ms?: number | null;
  has_photos?: boolean | null;
  reviews_count?: number | null;
  reviews_rating?: number | null;
  is_disqualified?: boolean | null;
  is_chain?: boolean | null;
  seo?: {
    has_title?: boolean | null;
    has_meta_description?: boolean | null;
    title?: string | null;
    meta_description?: string | null;
  } | null;
  blog?: {
    has_blog?: boolean | null;
    recent_posts?: boolean | null;
  } | null;
  tech_stack?: {
    chat?: boolean | string | null;
    booking?: boolean | string | null;
    analytics?: boolean | Record<string, unknown> | unknown[] | null;
    detected_platform?: string | null;
    cms?: string | null;
    ecom?: string | null;
  } | null;
  growth_signals?: {
    hiring?: boolean | null;
    new_location?: boolean | null;
  } | null;
  instagram?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  ig_followers?: number | null;
  ig_last_post_days?: number | null;
  signals?: Record<string, unknown> | null;
}

export type ServiceNeedOutcome =
  | "QUALIFIED"
  | "REJECTED"
  | "UNCERTAIN"
  | "NOT_APPLICABLE";

export interface ServiceNeedGateResult {
  outcome: ServiceNeedOutcome;
  professionSlug: ProfessionSlug | null;
  reason: string;
  scoreSnapshot: number | null;
  matchedGaps: string[];
  unsuitabilityReasons: string[];
  unknownSignals: string[];
}

export interface ServiceNeedGateInput {
  candidate: CandidateInspectionSignals;
  scores?: EngineScoreResult | null;
  professionSlug?: string | null;
}

// ---------------------------------------------------------------------------
// Three-State Signal Extractors
// ---------------------------------------------------------------------------

export function inspectWebsite(candidate: CandidateInspectionSignals): TriState<string> {
  if (candidate.website === undefined) {
    return { state: "unknown" };
  }
  if (candidate.website === null || candidate.website.trim() === "") {
    return { state: "absent" };
  }
  return { state: "present", value: candidate.website.trim() };
}

export function inspectWebsiteReachable(candidate: CandidateInspectionSignals): TriState<boolean> {
  if (candidate.website_reachable === undefined || candidate.website_reachable === null) {
    return { state: "unknown" };
  }
  return candidate.website_reachable
    ? { state: "present", value: true }
    : { state: "absent" };
}

export function inspectSslValid(candidate: CandidateInspectionSignals): TriState<boolean> {
  if (candidate.ssl_valid === undefined || candidate.ssl_valid === null) {
    return { state: "unknown" };
  }
  return candidate.ssl_valid
    ? { state: "present", value: true }
    : { state: "absent" };
}

/**
 * Inspects whether an existing website is hosted on a weak/free-builder domain.
 *
 * Signal Semantics:
 * The upstream Python helper `is_weak_site(url)` returns `True` when `url` is empty or None.
 * To prevent a missing website from being double-counted or misclassified as an existing
 * weak-domain website:
 * - If no website URL is present (`website.state !== "present"`), `website_is_weak` evaluates
 *   strictly to `{ state: "unknown" }` (the missing website is captured by `website.state === "absent"`).
 * - If an existing website URL is present and `website_is_weak === true`, evaluates to
 *   `{ state: "present", value: true }`.
 * - If an existing website URL is present and `website_is_weak === false`, evaluates to
 *   `{ state: "absent" }`.
 */
export function inspectWebsiteIsWeak(candidate: CandidateInspectionSignals): TriState<boolean> {
  const website = inspectWebsite(candidate);
  if (website.state !== "present") {
    return { state: "unknown" };
  }
  if (candidate.website_is_weak === undefined || candidate.website_is_weak === null) {
    return { state: "unknown" };
  }
  return candidate.website_is_weak
    ? { state: "present", value: true }
    : { state: "absent" };
}

/**
 * Inspects Google Maps photo presence.
 *
 * Signal Semantics:
 * - `has_photos === true` confirms photo presence: `{ state: "present", value: true }`.
 * - `false`, `null`, omitted, or otherwise unverified values MUST evaluate to `{ state: "unknown" }`,
 *   because the upstream Python contract defaults `has_photos` to `False` without distinguishing
 *   an inspected zero-photo listing from a failed or skipped inspection.
 */
export function inspectHasPhotos(candidate: CandidateInspectionSignals): TriState<boolean> {
  if (candidate.has_photos === true) {
    return { state: "present", value: true };
  }
  return { state: "unknown" };
}

export function inspectSeoMetaDescription(candidate: CandidateInspectionSignals): TriState<string | boolean> {
  if (!candidate.seo) {
    return { state: "unknown" };
  }
  if (candidate.seo.has_meta_description === true || (typeof candidate.seo.meta_description === "string" && candidate.seo.meta_description.trim().length > 0)) {
    return { state: "present", value: candidate.seo.meta_description ?? true };
  }
  if (candidate.seo.has_meta_description === false) {
    return { state: "absent" };
  }
  return { state: "unknown" };
}

/**
 * Inspects analytics tooling from tech_stack.
 *
 * Signal Semantics:
 * In site_crawler.py / WebsiteWorker, detection is based on a static homepage regex scan.
 * - Positively matched analytics signatures (e.g. ga4, segment, hotjar, etc.) confirm presence:
 *   { state: "present", value: true }.
 * - Non-detection (empty array [], null, false, uninspected, or failed crawl) CANNOT establish
 *   true absence, because tracking scripts are frequently managed via Google Tag Manager,
 *   CMP cookie consent wrappers, or loaded asynchronously after hydration.
 *   Therefore, non-detection evaluates strictly to { state: "unknown" }.
 */
export function inspectAnalytics(candidate: CandidateInspectionSignals): TriState<boolean> {
  const a = candidate.tech_stack?.analytics;
  if (a === true) return { state: "present", value: true };
  if (Array.isArray(a) && a.length > 0) {
    return { state: "present", value: true };
  }
  if (typeof a === "object" && a !== null) {
    const has = (a as Record<string, unknown>).has_analytics;
    if (has === true) {
      return { state: "present", value: true };
    }
    if (Object.keys(a).length > 0 && has !== false) {
      return { state: "present", value: true };
    }
  }
  return { state: "unknown" };
}

/**
 * Inspects online booking tooling from tech_stack.
 *
 * Signal Semantics:
 * In site_crawler.py / WebsiteWorker, detection is based on a static homepage regex scan.
 * - Positively matched booking signatures (e.g. calendly, acuity, booksy, etc.) confirm presence:
 *   { state: "present", value: true }.
 * - Non-detection (null, false, empty, uninspected, or failed crawl) CANNOT establish true absence,
 *   because booking tools may be loaded dynamically, embedded in iframes, or hosted on dedicated
 *   subpages (e.g. /book or /appointments).
 *   Therefore, non-detection evaluates strictly to { state: "unknown" }.
 */
export function inspectBooking(candidate: CandidateInspectionSignals): TriState<boolean> {
  const b = candidate.tech_stack?.booking;
  if (b === true || (typeof b === "string" && b.trim().length > 0)) {
    return { state: "present", value: true };
  }
  return { state: "unknown" };
}

/**
 * Inspects chat / messaging tooling from tech_stack.
 *
 * Signal Semantics:
 * In site_crawler.py / WebsiteWorker, detection is based on a static homepage regex scan.
 * - Positively matched chat signatures (e.g. intercom, crisp, tidio, etc.) confirm presence:
 *   { state: "present", value: true }.
 * - Non-detection (null, false, empty, uninspected, or failed crawl) CANNOT establish true absence,
 *   because chat widgets are often injected dynamically by tag managers or external scripts.
 *   Therefore, non-detection evaluates strictly to { state: "unknown" }.
 */
export function inspectChat(candidate: CandidateInspectionSignals): TriState<boolean> {
  const c = candidate.tech_stack?.chat;
  if (c === true || (typeof c === "string" && c.trim().length > 0)) {
    return { state: "present", value: true };
  }
  return { state: "unknown" };
}

export function inspectGrowth(candidate: CandidateInspectionSignals): TriState<boolean> {
  const g = candidate.growth_signals ?? (candidate.signals?.growth_signals as Record<string, unknown> | undefined);
  if (!g || (g.hiring === undefined && g.new_location === undefined)) {
    return { state: "unknown" };
  }
  if (g.hiring === true || g.new_location === true) {
    return { state: "present", value: true };
  }
  if (g.hiring === false && g.new_location === false) {
    return { state: "absent" };
  }
  return { state: "unknown" };
}

/**
 * Inspects social media presence (Instagram, Facebook, LinkedIn).
 *
 * Signal Semantics:
 * - Positively detected non-empty social URLs confirm presence: `{ state: "present", value: true }`.
 * - Empty strings, nulls, omitted fields, or static homepage non-detection MUST evaluate to
 *   `{ state: "unknown" }`, because MAST does not reliably verify whether a business has social
 *   accounts outside static homepage anchor extraction.
 */
export function inspectSocialPresence(candidate: CandidateInspectionSignals): TriState<boolean> {
  const hasInsta = typeof candidate.instagram === "string" && candidate.instagram.trim().length > 0;
  const hasFb = typeof candidate.facebook === "string" && candidate.facebook.trim().length > 0;
  const hasLi = typeof candidate.linkedin === "string" && candidate.linkedin.trim().length > 0;

  if (hasInsta || hasFb || hasLi) {
    return { state: "present", value: true };
  }
  return { state: "unknown" };
}

// ---------------------------------------------------------------------------
// Incompatibility & Defensible Disqualification Matchers
// ---------------------------------------------------------------------------

function normalizeText(val?: string | null): string {
  return (val || "").toLowerCase().trim();
}

/**
 * Detects whether the candidate is an agency or direct competitor selling the
 * exact same freelance service.
 */
export function detectSelfServiceAgencyConflict(
  professionSlug: ProfessionSlug,
  name?: string | null,
  category?: string | null,
): string | null {
  const text = `${normalizeText(name)} ${normalizeText(category)}`;

  switch (professionSlug) {
    case "programming_tech":
      if (
        text.includes("software company") ||
        text.includes("software development") ||
        text.includes("web development agency") ||
        text.includes("it services agency") ||
        text.includes("app development company")
      ) {
        return "self_service_conflict:software_or_web_development_agency";
      }
      break;
    case "graphic_design":
      if (
        text.includes("graphic design studio") ||
        text.includes("branding agency") ||
        text.includes("creative agency") ||
        text.includes("logo design studio")
      ) {
        return "self_service_conflict:graphic_design_or_branding_agency";
      }
      break;
    case "digital_marketing":
      if (
        text.includes("marketing agency") ||
        text.includes("seo agency") ||
        text.includes("digital marketing firm") ||
        text.includes("advertising agency")
      ) {
        return "self_service_conflict:digital_marketing_agency";
      }
      break;
    case "writing_translation":
      if (
        text.includes("translation agency") ||
        text.includes("translation services") ||
        text.includes("publishing house") ||
        text.includes("copywriting agency")
      ) {
        return "self_service_conflict:translation_or_writing_agency";
      }
      break;
    case "video_animation":
      if (
        text.includes("video production service") ||
        text.includes("video production company") ||
        text.includes("animation studio") ||
        text.includes("film production company")
      ) {
        return "self_service_conflict:video_production_or_animation_studio";
      }
      break;
    case "music_audio":
      if (
        text.includes("recording studio") ||
        text.includes("sound design studio") ||
        text.includes("audio production company") ||
        text.includes("record label")
      ) {
        return "self_service_conflict:recording_or_audio_studio";
      }
      break;
    case "photography":
      if (
        text.includes("commercial photography studio") ||
        text.includes("photo agency") ||
        text.includes("portrait studio")
      ) {
        return "self_service_conflict:commercial_photography_studio";
      }
      break;
    case "finance":
      if (
        text.includes("cpa firm") ||
        text.includes("accounting firm") ||
        text.includes("chartered accountant") ||
        text.includes("investment bank") ||
        text.includes("wealth management")
      ) {
        return "self_service_conflict:cpa_or_accounting_firm";
      }
      break;
    case "data":
      if (
        text.includes("data science consultancy") ||
        text.includes("analytics consulting") ||
        text.includes("business intelligence consultancy")
      ) {
        return "self_service_conflict:data_science_consultancy";
      }
      break;
    case "business":
      if (
        text.includes("management consulting firm") ||
        text.includes("corporate strategy consulting")
      ) {
        return "self_service_conflict:management_consulting_firm";
      }
      break;
    case "personal_growth_hobbies":
      if (
        text.includes("accredited university") ||
        text.includes("public school district") ||
        text.includes("state college")
      ) {
        return "incompatible_organization:accredited_academic_institution";
      }
      break;
    case "end_to_end_project":
      if (
        text.includes("full-service digital agency") ||
        text.includes("digital transformation consultancy")
      ) {
        return "self_service_conflict:full_service_digital_agency";
      }
      break;
  }
  return null;
}

/**
 * Detects structural category incompatibilities where a specific freelance service
 * is fundamentally inapplicable to the business's domain.
 */
export function detectStructuralIncompatibility(
  professionSlug: ProfessionSlug,
  category?: string | null,
): string | null {
  const cat = normalizeText(category);
  if (!cat) return null;

  switch (professionSlug) {
    case "music_audio":
      if (
        cat.includes("plumbing") ||
        cat.includes("roofing") ||
        cat.includes("scrap metal") ||
        cat.includes("asphalt") ||
        cat.includes("paving") ||
        cat.includes("septic") ||
        cat.includes("demolition")
      ) {
        return "structurally_incompatible_domain:industrial_heavy_trade";
      }
      break;
    case "video_animation":
      if (
        cat.includes("scrap metal") ||
        cat.includes("commercial warehousing") ||
        cat.includes("asphalt paving")
      ) {
        return "structurally_incompatible_domain:heavy_industrial_wholesale";
      }
      break;
    case "personal_growth_hobbies":
      if (
        cat.includes("scrap metal") ||
        cat.includes("commercial warehousing") ||
        cat.includes("chemical plant")
      ) {
        return "structurally_incompatible_domain:heavy_industrial_facility";
      }
      break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Category Classification Helpers
// ---------------------------------------------------------------------------

function isVisualConsumerCategory(category?: string | null): boolean {
  const c = normalizeText(category);
  return (
    c.includes("restaurant") ||
    c.includes("cafe") ||
    c.includes("coffee") ||
    c.includes("bakery") ||
    c.includes("bar") ||
    c.includes("lounge") ||
    c.includes("hotel") ||
    c.includes("salon") ||
    c.includes("spa") ||
    c.includes("gym") ||
    c.includes("fitness") ||
    c.includes("boutique") ||
    c.includes("retail") ||
    c.includes("event venue") ||
    c.includes("nightclub")
  );
}

function isSoloPractitionerCategory(category?: string | null): boolean {
  const c = normalizeText(category);
  return (
    c.includes("coach") ||
    c.includes("trainer") ||
    c.includes("tutor") ||
    c.includes("yoga") ||
    c.includes("consultant") ||
    c.includes("therapist") ||
    c.includes("instructor")
  );
}

// ---------------------------------------------------------------------------
// Main Evaluation Function
// ---------------------------------------------------------------------------

/**
 * Pure evaluation function for the Service-Need Qualification Gate.
 * Evaluates candidate inspection signals against the user's selected profession
 * with deterministic three-state semantics.
 */
export function evaluateServiceNeedGate(input: ServiceNeedGateInput): ServiceNeedGateResult {
  const { candidate, scores, professionSlug } = input;

  // 1. Unset Profession Handling: Bypass gate cleanly
  if (professionSlug == null || professionSlug === "") {
    return {
      outcome: "NOT_APPLICABLE",
      professionSlug: null,
      reason: "profession_unset_bypassed",
      scoreSnapshot: null,
      matchedGaps: [],
      unsuitabilityReasons: [],
      unknownSignals: [],
    };
  }

  // Validate canonical slug
  const isCanonical = PROFESSION_SLUGS.includes(professionSlug as ProfessionSlug);
  if (!isCanonical) {
    return {
      outcome: "NOT_APPLICABLE",
      professionSlug: null,
      reason: `invalid_profession_slug:${professionSlug}`,
      scoreSnapshot: null,
      matchedGaps: [],
      unsuitabilityReasons: [],
      unknownSignals: [],
    };
  }

  const slug = professionSlug as ProfessionSlug;

  // Extract score snapshot if present (strictly finite numbers only)
  let scoreSnapshot: number | null = null;
  if (scores && scores.profession_scores && typeof scores.profession_scores === "object") {
    const rawScore = scores.profession_scores[slug]?.score;
    if (typeof rawScore === "number" && Number.isFinite(rawScore)) {
      scoreSnapshot = rawScore;
    }
  }

  // 2. Explicit Incompatibility & Disqualification Checks
  const unsuitabilityReasons: string[] = [];

  if (candidate.is_disqualified === true) {
    unsuitabilityReasons.push("disqualified_business");
  }

  if (candidate.is_chain === true) {
    unsuitabilityReasons.push("disqualified_enterprise_chain");
  }

  if (typeof candidate.ig_followers === "number" && candidate.ig_followers > 100_000) {
    unsuitabilityReasons.push("scale_mismatch_excessive_followers");
  }

  const agencyConflict = detectSelfServiceAgencyConflict(slug, candidate.name, candidate.category);
  if (agencyConflict) {
    unsuitabilityReasons.push(agencyConflict);
  }

  const structuralIncompatibility = detectStructuralIncompatibility(slug, candidate.category);
  if (structuralIncompatibility) {
    unsuitabilityReasons.push(structuralIncompatibility);
  }

  if (unsuitabilityReasons.length > 0) {
    return {
      outcome: "REJECTED",
      professionSlug: slug,
      reason: unsuitabilityReasons.join(";"),
      scoreSnapshot,
      matchedGaps: [],
      unsuitabilityReasons,
      unknownSignals: [],
    };
  }

  // 3. Extract Three-State Signals
  const website = inspectWebsite(candidate);
  const websiteReachable = inspectWebsiteReachable(candidate);
  const ssl = inspectSslValid(candidate);
  const weakSite = inspectWebsiteIsWeak(candidate);
  const photos = inspectHasPhotos(candidate);
  const seoMeta = inspectSeoMetaDescription(candidate);
  const analytics = inspectAnalytics(candidate);
  const booking = inspectBooking(candidate);
  const chat = inspectChat(candidate);
  const growth = inspectGrowth(candidate);
  const social = inspectSocialPresence(candidate);

  const unknownSignals: string[] = [];
  if (website.state === "unknown") unknownSignals.push("website");
  if (websiteReachable.state === "unknown") unknownSignals.push("website_reachable");
  if (ssl.state === "unknown") unknownSignals.push("ssl_valid");
  if (weakSite.state === "unknown") unknownSignals.push("website_is_weak");
  if (photos.state === "unknown") unknownSignals.push("has_photos");
  if (seoMeta.state === "unknown") unknownSignals.push("seo_meta");
  if (analytics.state === "unknown") unknownSignals.push("analytics");
  if (booking.state === "unknown") unknownSignals.push("booking");
  if (chat.state === "unknown") unknownSignals.push("chat");
  if (growth.state === "unknown") unknownSignals.push("growth_signals");
  if (social.state === "unknown") unknownSignals.push("social_presence");

  // 4. Profession-Specific Qualification Rules
  const matchedGaps: string[] = [];
  const reviewsCount = typeof candidate.reviews_count === "number" ? candidate.reviews_count : 0;

  switch (slug) {
    case "programming_tech": {
      if (website.state === "absent") {
        matchedGaps.push("confirmed_no_website");
      }
      if (weakSite.state === "present") {
        matchedGaps.push("confirmed_weak_or_free_website");
      }
      if (ssl.state === "absent") {
        matchedGaps.push("confirmed_invalid_or_missing_ssl");
      }
      break;
    }

    case "graphic_design": {
      if (weakSite.state === "present" && isVisualConsumerCategory(candidate.category)) {
        matchedGaps.push("confirmed_unbranded_free_website");
      }
      break;
    }

    case "digital_marketing": {
      // NOTE: Current scrapers produce no verified signals for ad spend, social media
      // management, or marketing agency engagements. Static non-detection of social links
      // and meta descriptions does not reliably establish absence of marketing. In accordance
      // with evidence-based honesty, eligible businesses evaluate honestly to UNCERTAIN
      // unless an explicit disqualifier matches.
      break;
    }

    case "writing_translation": {
      if (
        website.state === "present" &&
        websiteReachable.state === "present" &&
        seoMeta.state === "absent"
      ) {
        matchedGaps.push("confirmed_missing_meta_copy");
      }
      break;
    }

    case "video_animation": {
      // NOTE: Current scrapers produce no verified signals for video presence
      // or embedded video players. In accordance with evidence-based honesty,
      // this evaluator does not invent unsupported signals or substitute weak proxies.
      // Eligible businesses without explicit disqualifications evaluate to UNCERTAIN.
      break;
    }

    case "music_audio": {
      // NOTE: Current scrapers produce no verified signals for audio branding or
      // playlist integrations. Eligible businesses evaluate to UNCERTAIN.
      break;
    }

    case "data": {
      // NOTE: Current scrapers produce no verified signals for database architecture,
      // data warehousing, or reporting maturity. Static non-detection of analytics
      // does not establish absence. In accordance with evidence-based honesty,
      // eligible businesses evaluate honestly to UNCERTAIN unless an explicit disqualifier matches.
      break;
    }

    case "business": {
      // NOTE: Current scrapers produce no verified signals for internal business operations,
      // booking bottlenecks, or workflow automation. Static non-detection of booking/chat
      // does not establish absence. In accordance with evidence-based honesty,
      // eligible businesses evaluate honestly to UNCERTAIN unless an explicit disqualifier matches.
      break;
    }

    case "personal_growth_hobbies": {
      if (
        isSoloPractitionerCategory(candidate.category) &&
        weakSite.state === "present"
      ) {
        matchedGaps.push("confirmed_weak_personal_brand_website");
      }
      break;
    }

    case "photography": {
      if (weakSite.state === "present" && isVisualConsumerCategory(candidate.category)) {
        matchedGaps.push("confirmed_free_template_in_visual_category");
      }
      break;
    }

    case "finance": {
      // NOTE: Current scrapers produce no verified signals for digital billing, invoicing,
      // or accounting portals. E-commerce presence (ecom) is not equivalent to digital invoicing.
      // Eligible businesses evaluate to UNCERTAIN.
      break;
    }

    case "end_to_end_project": {
      // Foundational requirement: must have a confirmed absent or weak website.
      // A business with a healthy custom website never qualifies for an end-to-end overhaul.
      const hasFoundationalWebsiteGap = website.state === "absent" || weakSite.state === "present";

      if (hasFoundationalWebsiteGap) {
        // Additionally require at least one independently verified deficiency.
        // Unknown or unverified signals (such as non-detected social or unprobed photos)
        // never count as deficits.
        let secondaryDeficits = 0;
        if (ssl.state === "absent") secondaryDeficits += 1;

        if (reviewsCount >= 20 && secondaryDeficits >= 1) {
          const totalDeficits = 1 + secondaryDeficits;
          matchedGaps.push(`confirmed_compound_multi_pillar_deficits:${totalDeficits}_gaps`);
        }
      }
      break;
    }
  }

  // 5. Outcome Resolution
  if (matchedGaps.length > 0) {
    return {
      outcome: "QUALIFIED",
      professionSlug: slug,
      reason: `qualified_service_need:${matchedGaps.join(",")}`,
      scoreSnapshot,
      matchedGaps,
      unsuitabilityReasons: [],
      unknownSignals,
    };
  }

  // If no confirmed gap was matched, but no disqualifier occurred:
  // The business is NOT rejected. Having strong assets or missing data yields UNCERTAIN.
  const reason = unknownSignals.length > 0
    ? `insufficient_signals:${unknownSignals.slice(0, 4).join(",")}`
    : "strong_existing_assets_unproven_service_need";

  return {
    outcome: "UNCERTAIN",
    professionSlug: slug,
    reason,
    scoreSnapshot,
    matchedGaps: [],
    unsuitabilityReasons: [],
    unknownSignals,
  };
}

// ---------------------------------------------------------------------------
// Telemetry & Observation Integration
// ---------------------------------------------------------------------------

export interface ServiceNeedGateSignalStates {
  website: "present" | "absent" | "unknown";
  website_reachable: "present" | "absent" | "unknown";
  website_is_weak: "present" | "absent" | "unknown";
  ssl_valid: "present" | "absent" | "unknown";
  has_photos: "present" | "absent" | "unknown";
  social: "present" | "absent" | "unknown";
  seo_meta: "present" | "absent" | "unknown";
  analytics: "present" | "absent" | "unknown";
  booking: "present" | "absent" | "unknown";
  chat: "present" | "absent" | "unknown";
  growth: "present" | "absent" | "unknown";
}

export interface ServiceNeedGateTelemetryRecord {
  scrapeJobId: string | null;
  pipelineId: string | null;
  businessId: string | null;
  professionSlug: string | null;
  outcome: ServiceNeedOutcome;
  reason: string;
  matchedGaps: string[];
  unsuitabilityReasons: string[];
  opportunityScore: number | null;
  scoreSnapshot: number | null;
  signalStates: ServiceNeedGateSignalStates;
}

export type ServiceNeedGateTelemetrySink = (record: ServiceNeedGateTelemetryRecord) => void;

let customTelemetrySink: ServiceNeedGateTelemetrySink | null = null;

export function setServiceNeedGateTelemetrySink(sink: ServiceNeedGateTelemetrySink | null): void {
  customTelemetrySink = sink;
}

export function logServiceNeedGateTelemetry(record: ServiceNeedGateTelemetryRecord): void {
  try {
    if (customTelemetrySink) {
      customTelemetrySink(record);
    }
  } catch {
    // Sink failure must never affect live delivery
  }

  try {
    const correlationId = record.pipelineId ?? record.scrapeJobId ?? record.businessId ?? "unknown";
    console.log(`[service-need-gate][${correlationId}] SERVICE_NEED_GATE_DECISION ${JSON.stringify(record)}`);
  } catch {
    // Console log failure must never affect live delivery
  }
}

export function candidateSignalsFromEngineLead(
  lead: EngineLead,
  businessId?: string | null,
): CandidateInspectionSignals {
  const untypedLead = lead as Record<string, unknown>;
  const hasWebsiteUrl = typeof lead.website === "string" && lead.website.trim().length > 0;

  return {
    id: businessId ?? (typeof lead.id === "string" ? lead.id : null),
    name: typeof lead.name === "string" ? lead.name : null,
    category: typeof lead.category === "string" ? lead.category : null,
    address: typeof lead.address === "string" ? lead.address : null,
    website: typeof lead.website === "string" ? lead.website : (lead.website === null ? null : undefined),
    website_reachable: typeof untypedLead.website_reachable === "boolean"
      ? (untypedLead.website_reachable as boolean)
      : (untypedLead.website_reachable === null ? null : undefined),
    website_is_weak:
      hasWebsiteUrl && typeof lead.website_is_weak === "boolean"
        ? lead.website_is_weak
        : null,
    ssl_valid: typeof lead.ssl_valid === "boolean"
      ? lead.ssl_valid
      : (lead.ssl_valid === null ? null : undefined),
    load_time_ms: typeof lead.load_time_ms === "number" ? lead.load_time_ms : null,
    has_photos: typeof lead.has_photos === "boolean"
      ? lead.has_photos
      : (lead.has_photos === null ? null : undefined),
    reviews_count: typeof lead.reviews === "number" ? lead.reviews : null,
    reviews_rating: typeof lead.rating === "number" ? lead.rating : null,
    is_disqualified: typeof lead.is_disqualified === "boolean" ? lead.is_disqualified : null,
    is_chain: typeof untypedLead.is_chain === "boolean"
      ? (untypedLead.is_chain as boolean)
      : null,
    seo: lead.seo
      ? {
          has_title: typeof lead.seo.has_title === "boolean" ? lead.seo.has_title : null,
          has_meta_description: typeof lead.seo.has_meta_description === "boolean" ? lead.seo.has_meta_description : null,
          title: typeof (lead.seo as Record<string, unknown>).title === "string" ? (lead.seo as Record<string, unknown>).title as string : null,
          meta_description: typeof (lead.seo as Record<string, unknown>).meta_description === "string" ? (lead.seo as Record<string, unknown>).meta_description as string : null,
        }
      : (lead.seo === null ? null : undefined),
    blog: lead.blog
      ? {
          has_blog: typeof lead.blog.has_blog === "boolean" ? lead.blog.has_blog : null,
          recent_posts: typeof (lead.blog as Record<string, unknown>).recent_posts === "boolean" ? (lead.blog as Record<string, unknown>).recent_posts as boolean : null,
        }
      : (lead.blog === null ? null : undefined),
    tech_stack: lead.tech_stack ? (lead.tech_stack as CandidateInspectionSignals["tech_stack"]) : (lead.tech_stack === null ? null : undefined),
    growth_signals: lead.growth_signals
      ? {
          hiring: typeof lead.growth_signals.hiring === "boolean" ? lead.growth_signals.hiring : null,
          new_location: typeof lead.growth_signals.new_location === "boolean" ? lead.growth_signals.new_location : null,
        }
      : (lead.growth_signals === null ? null : undefined),
    instagram: typeof lead.instagram === "string" ? lead.instagram : (lead.instagram === null ? null : undefined),
    facebook: typeof lead.facebook === "string" ? lead.facebook : (lead.facebook === null ? null : undefined),
    linkedin: typeof lead.linkedin === "string" ? lead.linkedin : (lead.linkedin === null ? null : undefined),
    ig_followers: typeof lead.ig_followers === "number" ? lead.ig_followers : null,
    ig_last_post_days: typeof lead.ig_last_post_days === "number" ? lead.ig_last_post_days : null,
    signals: lead.signals && typeof lead.signals === "object" ? (lead.signals as Record<string, unknown>) : null,
  };
}

export function recordServiceNeedGateObservation(
  lead: EngineLead,
  ctx: {
    professionSlug?: string | null;
    discoveryMode?: string;
    scrapeJobId?: string | null;
    opportunityScore?: number | null;
  },
  businessId?: string | null,
): ServiceNeedGateResult | null {
  try {
    const candidate = candidateSignalsFromEngineLead(lead, businessId);

    let scoresInput: EngineScoreResult | null = null;
    const untypedLead = lead as Record<string, unknown>;
    if (untypedLead.scores && typeof untypedLead.scores === "object") {
      scoresInput = untypedLead.scores as EngineScoreResult;
    }

    const result = evaluateServiceNeedGate({
      candidate,
      professionSlug: ctx.professionSlug,
      scores: scoresInput,
    });

    const signalStates: ServiceNeedGateSignalStates = {
      website: inspectWebsite(candidate).state,
      website_reachable: inspectWebsiteReachable(candidate).state,
      website_is_weak: inspectWebsiteIsWeak(candidate).state,
      ssl_valid: inspectSslValid(candidate).state,
      has_photos: inspectHasPhotos(candidate).state,
      social: inspectSocialPresence(candidate).state,
      seo_meta: inspectSeoMetaDescription(candidate).state,
      analytics: inspectAnalytics(candidate).state,
      booking: inspectBooking(candidate).state,
      chat: inspectChat(candidate).state,
      growth: inspectGrowth(candidate).state,
    };

    const telemetryRecord: ServiceNeedGateTelemetryRecord = {
      scrapeJobId: ctx.scrapeJobId ?? null,
      pipelineId: (untypedLead._pipeline_id as string | undefined) ?? null,
      businessId: businessId ?? candidate.id ?? null,
      professionSlug: result.professionSlug ?? ctx.professionSlug ?? null,
      outcome: result.outcome,
      reason: result.reason,
      matchedGaps: result.matchedGaps,
      unsuitabilityReasons: result.unsuitabilityReasons,
      opportunityScore: ctx.opportunityScore ?? (typeof lead.score === "number" ? lead.score : null),
      scoreSnapshot: result.scoreSnapshot,
      signalStates,
    };

    logServiceNeedGateTelemetry(telemetryRecord);
    return result;
  } catch (err) {
    try {
      console.error(
        `[service-need-gate] Non-fatal evaluation error for candidate ${businessId ?? "unknown"}:`,
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      // Non-fatal
    }
    return null;
  }
}
