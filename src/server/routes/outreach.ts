import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, type PlanId } from "../../config/plans.js";
import { canUseAiFeature } from "../../lib/aiAccess.js";
import {
  aiEnabled,
  AI_MODEL,
  generateJSON,
  getAiModel,
  type ModelTier,
} from "../../lib/ai.js";
import {
  buildOutreachPrompt,
  sanitizeOutreachOutput,
  type OutreachChannel,
  type OutreachAction,
  type OutreachTone,
} from "../../lib/outreachPrompt.js";

export const outreachRouter = Router();

// Per-user rate limiter for AI outreach drafting (10 calls/min per authenticated user)
export const outreachDraftLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

export function resetOutreachRateLimiter(): void {
  outreachDraftLimiter.reset();
}

const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 2000;
const MAX_CONTEXT_NOTES_LENGTH = 2000;
const MAX_SENDER_NAME_LENGTH = 100;
const MAX_SUBJECT_LENGTH = 250;
const MAX_BODY_LENGTH = 10000;
const MAX_TEMPLATE_LENGTH = 100;

const ALLOWED_CHANNELS = ["email", "instagram", "phone", "contact_form"] as const;
const ALLOWED_ACTIONS = ["generate", "rewrite", "shorten", "expand", "objections"] as const;
const ALLOWED_TONES = ["friendly", "professional", "direct", "casual", "urgent"] as const;

const RECOGNIZED_PERSONALIZATION_KEYS = [
  "businessNameAndNiche",
  "recentInstagramActivity",
  "locationAndLocalMarket",
  "businessReviewsAndReputation",
  "similarBusinessSuccessStories",
] as const;

async function resolveUserProfile(userId: string): Promise<{
  plan: PlanId;
  focusArea?: string;
  fullName?: string;
}> {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("subscription_plan, settings, full_name")
    .eq("id", userId)
    .single();
  if (error) throw error;
  const plan = getPlan(profile?.subscription_plan).id;
  const focusArea = (profile?.settings as Record<string, unknown> | null)?.focusArea as string | undefined;
  const fullName = profile?.full_name as string | undefined;
  return { plan, focusArea, fullName };
}

/**
 * GET /v1/outreach/status
 *
 * Lightweight, safe capability check exposing whether AI generation is configured
 * and the active model identifier without exposing secrets or keys.
 */
outreachRouter.get("/status", requireAuth, (_req, res) => {
  return res.json({
    aiConfigured: aiEnabled(),
    model: aiEnabled() ? AI_MODEL : null,
  });
});

/**
 * POST /v1/outreach/draft
 *
 * Authenticated AI Outreach Drafting endpoint powered by OpenRouter Free (openrouter/free).
 * Supports generating, rewriting, shortening, expanding, and handling objections.
 *
 * Gated by user plan (paid plan required).
 * Verifies lead ownership (both leadId and userId).
 */
outreachRouter.post("/draft", requireAuth, outreachDraftLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;

    if (!aiEnabled()) {
      return res.status(503).json({
        code: "ai_unavailable",
        message: "AI outreach drafting is not configured on this deployment.",
      });
    }

    const { plan, focusArea, fullName } = await resolveUserProfile(userId);
    if (!canUseAiFeature(plan, "outreachDraft")) {
      return res.status(403).json({
        code: "plan_restricted",
        message: "AI outreach drafting requires a paid plan (Starter, Pro, or Premium).",
      });
    }

    const {
      leadId: rawLeadId,
      channel,
      action = "generate",
      tone = "friendly",
      template,
      customInstructions,
      subject: clientSubject,
      body: clientBody,
      senderName,
      personalization = {},
      contextNotes,
      tier: clientTier,
    } = req.body ?? {};

    const leadId = Number(rawLeadId);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return res.status(400).json({
        code: "invalid_lead_id",
        message: "Valid numeric leadId is required.",
      });
    }

    if (!channel || !ALLOWED_CHANNELS.includes(channel as OutreachChannel)) {
      return res.status(400).json({
        code: "invalid_channel",
        message: `Channel must be one of: ${ALLOWED_CHANNELS.join(", ")}.`,
      });
    }

    if (!action || !ALLOWED_ACTIONS.includes(action as OutreachAction)) {
      return res.status(400).json({
        code: "invalid_action",
        message: `Action must be one of: ${ALLOWED_ACTIONS.join(", ")}.`,
      });
    }

    if (tone !== undefined && (!tone || !ALLOWED_TONES.includes(tone as OutreachTone))) {
      return res.status(400).json({
        code: "invalid_tone",
        message: `Tone must be one of: ${ALLOWED_TONES.join(", ")}.`,
      });
    }

    if (customInstructions !== undefined) {
      if (typeof customInstructions !== "string") {
        return res.status(400).json({
          code: "invalid_input",
          message: "customInstructions must be a string.",
        });
      }
      if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
        return res.status(400).json({
          code: "excessive_input",
          message: `customInstructions exceeds maximum length of ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters.`,
        });
      }
    }

    if (contextNotes !== undefined) {
      if (typeof contextNotes !== "string") {
        return res.status(400).json({
          code: "invalid_input",
          message: "contextNotes must be a string.",
        });
      }
      if (contextNotes.length > MAX_CONTEXT_NOTES_LENGTH) {
        return res.status(400).json({
          code: "excessive_input",
          message: `contextNotes exceeds maximum length of ${MAX_CONTEXT_NOTES_LENGTH} characters.`,
        });
      }
    }

    if (senderName !== undefined) {
      if (typeof senderName !== "string") {
        return res.status(400).json({
          code: "invalid_input",
          message: "senderName must be a string.",
        });
      }
      if (senderName.length > MAX_SENDER_NAME_LENGTH) {
        return res.status(400).json({
          code: "excessive_input",
          message: `senderName exceeds maximum length of ${MAX_SENDER_NAME_LENGTH} characters.`,
        });
      }
    }

    if (clientSubject !== undefined) {
      if (typeof clientSubject !== "string") {
        return res.status(400).json({
          code: "invalid_input",
          message: "subject must be a string.",
        });
      }
      if (clientSubject.length > MAX_SUBJECT_LENGTH) {
        return res.status(400).json({
          code: "excessive_input",
          message: `subject exceeds maximum length of ${MAX_SUBJECT_LENGTH} characters.`,
        });
      }
    }

    if (clientBody !== undefined) {
      if (typeof clientBody !== "string") {
        return res.status(400).json({
          code: "invalid_input",
          message: "body must be a string.",
        });
      }
      if (clientBody.length > MAX_BODY_LENGTH) {
        return res.status(400).json({
          code: "excessive_input",
          message: `body exceeds maximum length of ${MAX_BODY_LENGTH} characters.`,
        });
      }
    }

    if (template !== undefined) {
      if (typeof template !== "string") {
        return res.status(400).json({
          code: "invalid_input",
          message: "template must be a string.",
        });
      }
      if (template.length > MAX_TEMPLATE_LENGTH) {
        return res.status(400).json({
          code: "excessive_input",
          message: `template exceeds maximum length of ${MAX_TEMPLATE_LENGTH} characters.`,
        });
      }
    }

    if (personalization !== undefined) {
      if (
        typeof personalization !== "object" ||
        personalization === null ||
        Array.isArray(personalization)
      ) {
        return res.status(400).json({
          code: "invalid_personalization",
          message: "personalization must be an object with boolean flags.",
        });
      }
      for (const [key, val] of Object.entries(personalization)) {
        if (!RECOGNIZED_PERSONALIZATION_KEYS.includes(key as any)) {
          return res.status(400).json({
            code: "invalid_personalization",
            message: `Unrecognized personalization option: ${key}.`,
          });
        }
        if (typeof val !== "boolean") {
          return res.status(400).json({
            code: "invalid_personalization",
            message: `personalization field '${key}' must be a boolean.`,
          });
        }
      }
    }

    const existingBody = typeof clientBody === "string" ? clientBody.trim() : "";
    if (["rewrite", "shorten", "expand"].includes(action) && !existingBody) {
      return res.status(400).json({
        code: "missing_body",
        message: "Existing draft body is required to rewrite, shorten, or expand.",
      });
    }

    // Load lead from database by BOTH lead ID and authenticated user ID.
    // Never trust lead facts supplied by the client.
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select(
        `
        id,
        user_id,
        business_id,
        business_name,
        niche,
        email,
        phone,
        website,
        instagram_handle,
        location,
        status,
        priority,
        opportunity_score,
        profession_slug
      `,
      )
      .eq("id", leadId)
      .eq("user_id", userId)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) {
      return res.status(404).json({
        code: "not_found",
        message: "Lead not found or access denied.",
      });
    }

    // Load linked business details if available
    let business: Record<string, unknown> | null = null;
    if (lead.business_id) {
      const { data: biz } = await supabaseAdmin
        .from("businesses")
        .select(
          "name, category, niche, address, region, country_code, website, email, phone, instagram, reviews_count, reviews_rating, signals, website_is_weak, load_time_ms",
        )
        .eq("id", lead.business_id)
        .maybeSingle();
      business = biz;
    }

    // Load recent lead activities defensively for sequence continuity (e.g. follow-up context)
    let recentActivities: any[] = [];
    try {
      const { data: acts } = await supabaseAdmin
        .from("lead_activities")
        .select("type, channel, subject, content, metadata, timestamp")
        .eq("lead_id", leadId)
        .eq("user_id", userId)
        .order("timestamp", { ascending: false })
        .limit(5);
      if (acts && Array.isArray(acts)) {
        recentActivities = acts;
      }
    } catch {
      // Graceful degradation when lead_activities is unmocked or unavailable
    }

    const previousSends = recentActivities.filter((a) =>
      ["email_sent", "instagram_sent", "call_completed", "contact_form_sent"].includes(a.type),
    );
    const sequenceHistory = {
      isFollowUp: previousSends.length > 0 || template === "follow_up",
      touchCount: previousSends.length > 0 ? previousSends.length + 1 : 1,
      previousSends: previousSends.map((s) => ({
        channel: s.channel,
        subject: s.subject,
        timestamp: s.timestamp,
      })),
    };

    // Server-enforced model tier policy:
    // - Starter: always Fast tier. Never elevated by client request.
    // - Pro and Premium: Pro tier by default, or Fast tier if explicitly chosen.
    // Both tiers route through OpenRouter free model router (openrouter/free).
    const tier: ModelTier = plan === "starter" ? "fast" : clientTier === "fast" ? "fast" : "pro";

    // Build research-grounded prompt (zero em dashes, 5th-grade readability, dynamic CTAs, native channel fit)
    const { system: systemPrompt, user: userPayloadString } = buildOutreachPrompt({
      channel: channel as OutreachChannel,
      action: action as OutreachAction,
      tone: tone as OutreachTone,
      template,
      customInstructions,
      senderName: senderName || fullName,
      contextNotes,
      currentDraft: {
        subject: clientSubject || undefined,
        body: existingBody || undefined,
      },
      lead: {
        businessName: lead.business_name || (business?.name as string) || "the business",
        niche: lead.niche || (business?.niche as string) || undefined,
        website: lead.website || (business?.website as string) || undefined,
        instagram: lead.instagram_handle || (business?.instagram as string) || undefined,
        phone: lead.phone || (business?.phone as string) || undefined,
        email: lead.email || (business?.email as string) || undefined,
        opportunityScore: lead.opportunity_score ?? undefined,
        location: lead.location || (business?.address as string) || undefined,
        region: (business?.region as string) || undefined,
        reviewsCount: (business?.reviews_count as number) || undefined,
        reviewsRating: (business?.reviews_rating as number) || undefined,
        websiteIsWeak: (business?.website_is_weak as boolean) || undefined,
        loadTimeMs: (business?.load_time_ms as number) || undefined,
      },
      freelancer: {
        profession: focusArea || (lead.profession_slug ? lead.profession_slug.replace(/_/g, " ") : undefined),
        professionSlug: lead.profession_slug || undefined,
        senderName: senderName || fullName || undefined,
      },
      personalization,
      sequenceHistory,
    });

    const aiResult = await generateJSON<{ subject?: string | null; body?: string }>({
      system: systemPrompt,
      user: userPayloadString,
      tier,
      maxTokens: 2048,
      timeoutMs: 30000,
    });

    if (!aiResult || typeof aiResult.body !== "string" || !aiResult.body.trim()) {
      throw new Error("AI response did not contain a valid generated message body");
    }

    const { subject, body } = sanitizeOutreachOutput(
      aiResult,
      channel as OutreachChannel,
      clientSubject,
    );

    return res.json({
      subject,
      body,
      channel,
      action,
      model: getAiModel(tier),
      tier,
    });
  } catch (err) {
    next(err);
  }
});
