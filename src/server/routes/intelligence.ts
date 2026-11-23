import { createHash } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, type PlanId } from "../../config/plans.js";
import { canUseAiFeature } from "../../lib/aiAccess.js";
import {
  aiEnabled,
  generateJSON,
  AI_MODEL,
  getAiModel,
  logAiMetric,
} from "../../lib/ai.js";
import { singleFlight } from "../../lib/singleFlight.js";
import { buildPipelineSnapshot } from "../../lib/intelligenceContext.js";
import { runEngineScore } from "../../scraperBridge/pythonBridge.js";
import { type ProfessionSlug } from "../../scoring/professionWeights.js";
import { professionSlugForLabel } from "../../lib/professions.js";
import { resolveWorkspaceContext } from "../../lib/workspaceContext.js";
import {
  buildDeterministicInvestigation,
  inspectWebsiteSnapshot,
  type InvestigateLeadResult,
  type LeadInvestigationContext,
} from "../../lib/leadInvestigate.js";
import {
  collectWebsiteAuditInputs,
  type WebsiteAuditResult,
} from "../../lib/websiteAudit.js";
import {
  computeBusinessActivity,
  fetchLiveInstagramActivity,
  formatDaysAgoLabel,
  type LiveInstagramCheckResult,
} from "../../lib/businessActivity.js";

export const intelligenceRouter = Router();

// explain/trust and cached reads are local reads with no external AI calls — generous limit.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

// aiGenerationLimiter bounds how fast a client can trigger cache-miss AI generations.
// Raised to 20/min to safely support multiple dashboard widget loads without false 429s.
// Checked strictly on cache miss, never on cache hit.
export const aiGenerationLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

export function checkAiGenerationRateLimit(req: any, res: any): boolean {
  let allowed = false;
  aiGenerationLimiter(req, res, () => {
    allowed = true;
  });
  return allowed;
}

export function resetIntelligenceRateLimiters(): void {
  readLimiter.reset();
  aiGenerationLimiter.reset();
}

// ─── AI response contract enforcement ──────────────────────────────────────
// generateJSON() only guarantees the model's reply parses as JSON — it does
// NOT guarantee the shape matches the TypeScript generic it was called with
// (see lib/ai.ts's own doc comment: "callers own their own schema/
// validation"). A model that omits a field (e.g. returns {summary, tone}
// with no "priorities") produces a value that is valid JSON but `undefined`
// at that key. Every one of these responses is cached verbatim and served
// to the frontend, which reads them assuming the full contract holds (e.g.
// `aiBriefing.priorities.length` in FocusDashboard.tsx) — so an under-shaped
// model reply becomes a hard crash on the dashboard. Normalizing here, at
// the point where untrusted model output enters the system, is the actual
// fix: it guarantees the contract these routes have always promised,
// instead of pushing defensive optional-chaining out to every consumer.
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

async function resolveUserPlanAndProfession(userId: string): Promise<{
  plan: PlanId;
  professionSlug: ProfessionSlug | null;
  workspaceOwnerId: string;
}> {
  const ctx = await resolveWorkspaceContext(userId);
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("subscription_plan, settings")
    .eq("id", ctx.workspaceOwnerId)
    .single();
  if (error) throw error;

  const plan = getPlan(profile?.subscription_plan).id;
  const focusAreaLabel = (profile?.settings as Record<string, unknown> | null)?.focusArea as string | undefined;
  const professionSlug = professionSlugForLabel(focusAreaLabel);

  return { plan, professionSlug, workspaceOwnerId: ctx.workspaceOwnerId };
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * GET /v1/intelligence/status
 *
 * Safe capability check exposing whether AI generation is configured
 * and the active model identifier without exposing secrets or keys.
 */
intelligenceRouter.get("/status", requireAuth, (_req, res) => {
  return res.json({
    aiConfigured: aiEnabled(),
    model: aiEnabled() ? AI_MODEL : null,
  });
});

/**
 * GET /v1/intelligence/explain/:leadId
 *
 * Opportunity Explanations — available to every plan (not AI-gated at all;
 * it's a readout of the Opportunity Score's own components, computed the
 * same way Phase 6 already scores businesses, not a new model). Requires
 * the lead to belong to the requesting user.
 */
intelligenceRouter.get("/explain/:leadId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { workspaceOwnerId: userId, professionSlug: profileProfession } = await resolveUserPlanAndProfession(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ code: "invalid_lead_id", message: "leadId must be numeric." });
    }

    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("id, business_id, profession_slug, opportunity_score")
      .eq("id", leadId)
      .eq("user_id", userId)
      .single();
    if (leadError) throw leadError;
    if (!lead?.business_id) {
      return res.status(404).json({ code: "not_found", message: "Lead has no linked business to explain (pre-Opportunity-Engine lead)." });
    }

    const professionSlug = (lead.profession_slug as ProfessionSlug | null) ?? profileProfession;
    if (!professionSlug) {
      return res.status(400).json({ code: "no_profession", message: "Set a profession in onboarding/settings to see opportunity explanations." });
    }

    const { data: business, error: bizError } = await supabaseAdmin
      .from("businesses")
      .select("id, website, instagram, facebook, linkedin, has_photos, reviews_count, reviews_rating, is_disqualified, website_is_weak, ssl_valid, load_time_ms, seo, blog, signals")
      .eq("id", lead.business_id)
      .single();
    if (bizError) throw bizError;

    // Engine 2.0 owns all scoring and explanation logic.
    const engineResult = await runEngineScore({
      ...business,
      id: lead.business_id,
      ...(business.signals != null && typeof business.signals === "object" ? business.signals as Record<string, unknown> : {}),
    });

    const ps = engineResult.profession_scores?.[professionSlug];
    const explanation = {
      score: ps?.score ?? 0,
      summary: ps?.summary ?? "",
      reasons: ps?.reasons ?? [],
      breakdown: ps?.breakdown ?? engineResult.universal_breakdown ?? {},
    };

    res.json(explanation);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/trust/:leadId
 *
 * Priority 2/3/7 readout: per-field source attribution/confidence
 * (`field_provenance`) plus the separate Business Health Score. This is
 * what lets the frontend show "Website — Verified, Confidence 100%,
 * Source: Google Business" per field, and "Business Health: 82/100" as its
 * own independent number — never blended into the Opportunity Score (see
 * businessHealth.ts's doc comment for why the two are kept apart).
 *
 * Also passes through `is_disqualified` / `disqualify_reason` from the
 * business row as-is (disqualification transparency) — this is a straight
 * read of the existing qualification verdict, not a new computation.
 */
intelligenceRouter.get("/trust/:leadId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { workspaceOwnerId: userId } = await resolveWorkspaceContext(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ code: "invalid_lead_id", message: "leadId must be numeric." });
    }

    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("id, business_id")
      .eq("id", leadId)
      .eq("user_id", userId)
      .single();
    if (leadError) throw leadError;
    if (!lead?.business_id) {
      return res.status(404).json({ code: "not_found", message: "Lead has no linked business to explain (pre-Opportunity-Engine lead)." });
    }

    const { data: business, error: bizError } = await supabaseAdmin
      .from("businesses")
      .select("confidence, field_provenance, emails, phones, linkedin, last_verified_at, last_verification_kind, is_disqualified, disqualify_reason")
      .eq("id", lead.business_id)
      .single();
    if (bizError) throw bizError;

    const { data: health } = await supabaseAdmin
      .from("business_health_scores")
      .select("health_score, breakdown, computed_at")
      .eq("business_id", lead.business_id)
      .maybeSingle();

    res.json({
      overallConfidence: business.confidence,
      lastVerifiedAt: business.last_verified_at,
      lastVerificationKind: business.last_verification_kind,
      fieldTrust: business.field_provenance ?? {},
      contacts: {
        emails: business.emails ?? [],
        phones: business.phones ?? [],
        linkedin: business.linkedin ?? null,
      },
      businessHealth: health
        ? { score: health.health_score, breakdown: health.breakdown, computedAt: health.computed_at }
        : null,
      // Disqualification transparency: straight passthrough of the existing
      // qualification/scoring verdict already stored on the business row —
      // no new computation, no invented reason text.
      isDisqualified: Boolean(business.is_disqualified),
      disqualifyReason: business.disqualify_reason ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * AI Opportunity Insights (Premium): the deterministic explanation, plus a
 * short AI-written headline and a suggested opening line for outreach.
 * Cached per (business, profession) in business_opportunity_insights —
 * regenerated only if the underlying score has moved meaningfully or the
 * cache doesn't exist yet, so this never gets more expensive than the size
 * of the pool.
 */
intelligenceRouter.get("/opportunities/:businessId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, professionSlug, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);

    if (!canUseAiFeature(plan, "opportunityInsights")) {
      return res.status(403).json({ code: "plan_restricted", message: "AI Opportunity Insights requires a Pro or Premium plan." });
    }
    if (!professionSlug) {
      return res.status(400).json({ code: "no_profession", message: "Set a profession in onboarding/settings first." });
    }
    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    const businessId = req.params.businessId;

    // Authoritative ownership check: the calling user must own a lead linked to this business
    const { data: userLead, error: leadCheckErr } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("business_id", businessId)
      .limit(1)
      .maybeSingle();

    if (leadCheckErr) throw leadCheckErr;
    if (!userLead) {
      return res.status(404).json({ code: "not_found", message: "Business not found or access denied." });
    }
    const { data: business, error: bizError } = await supabaseAdmin
      .from("businesses")
      .select("id, name, niche, website, instagram, facebook, linkedin, has_photos, reviews_count, reviews_rating, is_disqualified, website_is_weak, ssl_valid, load_time_ms, seo, blog, signals")
      .eq("id", businessId)
      .single();
    if (bizError) throw bizError;

    // Engine 2.0 owns all scoring and explanation logic.
    const engineResult = await runEngineScore({
      ...business,
      id: businessId,
      ...(business.signals != null && typeof business.signals === "object" ? business.signals as Record<string, unknown> : {}),
    });

    const ps = engineResult.profession_scores?.[professionSlug];
    const result = { score: ps?.score ?? 0, breakdown: ps?.breakdown ?? engineResult.universal_breakdown ?? {} };
    const explanation = {
      score: result.score,
      summary: ps?.summary ?? "",
      reasons: ps?.reasons ?? [],
      breakdown: result.breakdown,
    };

    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("business_opportunity_insights")
      .select("headline, talking_points, opening_line, score_snapshot, generated_at")
      .eq("business_id", businessId)
      .eq("profession_slug", professionSlug)
      .maybeSingle();
    if (cacheError) console.error("[intelligence] business_opportunity_insights read failed", cacheError);

    // Regenerate if there's no cache yet, or the score has drifted more
    // than 10 points since the cached copy was written (a re-verification
    // likely changed the picture materially — see Phase 7).
    const stale = !cached || Math.abs((cached.score_snapshot as number) - result.score) > 10;

    if (!stale && cached) {
      logAiMetric({
        correlationId: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        feature: "opportunity_insight",
        model: getAiModel("pro"),
        cacheHit: true,
        contextPrepMs: Date.now() - routeStart,
        modelDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - routeStart,
        retryCount: 0,
        retryReasons: [],
        outcome: "success",
      });
      return res.json({ ...cached, explanation, cached: true });
    }

    if (!checkAiGenerationRateLimit(req, res)) {
      return;
    }

    // Sprint 3: coalesce concurrent cache-miss generations for the same
    // (business, profession) — see lib/singleFlight.ts.
    const row = await singleFlight(`opportunities:${businessId}:${professionSlug}`, async () => {
      const insight = await generateJSON<{ headline: string; talkingPoints: string[]; openingLine: string }>({
        system:
          "You are MAST's Opportunity Intelligence assistant, helping a freelancer understand why a business " +
          "was surfaced as a sales opportunity. You are given real, already-computed facts. Do not invent " +
          "anything not present in the input. Never use em dashes ('—' or '–'). Avoid generic marketing buzzwords ('elevate', 'streamline', 'synergy'). " +
          "Respond with ONLY a JSON object: " +
          '{"headline": string (<=12 words, why this is a good opportunity, no em dashes), ' +
          '"talkingPoints": string[] (2-4 short, concrete, non-generic points grounded in verified data, no em dashes), ' +
          '"openingLine": string (one natural first-contact opener, no em dashes, no greeting/signature, <=2 sentences)}. ' +
          "Keep tone professional, natural, and specific, never salesy or exaggerated.",
        user: JSON.stringify({
          businessName: business.name,
          niche: business.niche,
          profession: professionSlug,
          opportunityScore: result.score,
          reasons: explanation.reasons,
          summary: explanation.summary,
        }),
        feature: "opportunity_insight",
        contextPrepMs: Date.now() - routeStart,
        maxTokens: 1024,
        timeoutMs: 28000,
        tier: "pro",
      });

      const nextRow = {
        business_id: businessId,
        profession_slug: professionSlug,
        headline: asString(insight.headline, business.name ? `A fresh opportunity: ${business.name}` : "A fresh opportunity").replace(/[—–]/g, " - "),
        talking_points: asStringArray(insight.talkingPoints).map((tp) => tp.replace(/[—–]/g, " - ")),
        opening_line: asString(insight.openingLine, "Hi, I came across your business and had a few specific ideas that could help.").replace(/[—–]/g, " - "),
        score_snapshot: result.score,
        model: getAiModel("pro"),
        generated_at: new Date().toISOString(),
      };

      const { error: upsertError } = await supabaseAdmin
        .from("business_opportunity_insights")
        .upsert(nextRow, { onConflict: "business_id,profession_slug" });
      if (upsertError) throw upsertError;

      return nextRow;
    });

    res.json({
      headline: row.headline,
      talking_points: row.talking_points,
      opening_line: row.opening_line,
      score_snapshot: row.score_snapshot,
      generated_at: row.generated_at,
      explanation,
      cached: false,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/briefing
 *
 * AI Executive Briefing (Premium). Cached once per user per UTC day —
 * "Today's Briefing" reads as a considered snapshot taken at the start of
 * the day, not something that reshuffles on every dashboard visit.
 */
intelligenceRouter.get("/briefing", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);

    if (!canUseAiFeature(plan, "executiveBriefings")) {
      return res.status(403).json({ code: "plan_restricted", message: "AI Executive Briefings require a Pro or Premium plan." });
    }

    const periodKey = new Date().toISOString().slice(0, 10);

    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "executive_briefing")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cacheError) console.error("[intelligence] ai_intelligence (executive_briefing) read failed", cacheError);
    if (cached) {
      logAiMetric({
        correlationId: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        feature: "executive_briefing",
        model: getAiModel("pro"),
        cacheHit: true,
        contextPrepMs: Date.now() - routeStart,
        modelDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - routeStart,
        retryCount: 0,
        retryReasons: [],
        outcome: "success",
      });
      return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });
    }

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    if (!checkAiGenerationRateLimit(req, res)) {
      return;
    }

    const snapshot = await buildPipelineSnapshot(userId);

    // Sprint 3: coalesce concurrent cache-miss generations for the same
    // (user, day) — see lib/singleFlight.ts.
    const { briefing, generatedAt } = await singleFlight(`briefing:${userId}:${periodKey}`, async () => {
      const nextBriefing = await generateJSON<{ summary: string; priorities: string[]; tone: "brand" | "warning" | "success" }>({
        system:
          "You are MAST's Opportunity Intelligence assistant, writing a short daily executive briefing for a " +
          "freelancer's sales pipeline. You are given real, already-computed pipeline stats — do not invent " +
          "numbers or businesses not present in the input. Respond with ONLY a JSON object: " +
          '{"summary": string (2-3 sentences, plain language, no greeting), ' +
          '"priorities": string[] (1-4 concrete next actions, most important first), ' +
          '"tone": "brand" | "warning" | "success" (warning if things are stalling/overdue, success if strong momentum, brand otherwise)}.',
        user: JSON.stringify(snapshot),
        feature: "executive_briefing",
        contextPrepMs: Date.now() - routeStart,
        maxTokens: 1024,
        timeoutMs: 28000,
        tier: "pro",
      });

      nextBriefing.summary = asString(nextBriefing.summary, "Here's where your pipeline stands today.");
      nextBriefing.priorities = asStringArray(nextBriefing.priorities);
      nextBriefing.tone = asEnum(nextBriefing.tone, ["brand", "warning", "success"] as const, "brand");

      const nextGeneratedAt = new Date().toISOString();
      const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
        {
          user_id: userId,
          kind: "executive_briefing",
          period_key: periodKey,
          content: nextBriefing,
          model: getAiModel("pro"),
          generated_at: nextGeneratedAt,
        },
        { onConflict: "user_id,kind,period_key" },
      );
      if (upsertError) console.error("[intelligence] ai_intelligence (executive_briefing) upsert failed", upsertError);

      return { briefing: nextBriefing, generatedAt: nextGeneratedAt };
    });

    res.json({ ...briefing, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/weekly
 *
 * Weekly Intelligence (Pro+): a reflective 7-day performance review.
 * Cached once per user per ISO week.
 */
intelligenceRouter.get("/weekly", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);

    if (!canUseAiFeature(plan, "weeklyIntelligence")) {
      return res.status(403).json({ code: "plan_restricted", message: "Weekly Intelligence requires a Pro or Premium plan." });
    }

    const periodKey = isoWeekKey(new Date());

    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "weekly_intelligence")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cacheError) console.error("[intelligence] ai_intelligence (weekly_intelligence) read failed", cacheError);
    if (cached) {
      logAiMetric({
        correlationId: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        feature: "weekly_intelligence",
        model: getAiModel("pro"),
        cacheHit: true,
        contextPrepMs: Date.now() - routeStart,
        modelDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - routeStart,
        retryCount: 0,
        retryReasons: [],
        outcome: "success",
      });
      return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });
    }

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    if (!checkAiGenerationRateLimit(req, res)) {
      return;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const snapshot = await buildPipelineSnapshot(userId, sevenDaysAgo);

    // Sprint 3: coalesce concurrent cache-miss generations for the same
    // (user, week) — see lib/singleFlight.ts.
    const { weekly, generatedAt } = await singleFlight(`weekly:${userId}:${periodKey}`, async () => {
      const nextWeekly = await generateJSON<{ reflection: string; wins: string[]; focusForNextWeek: string[] }>({
        system:
          "You are MAST's Opportunity Intelligence assistant, writing a reflective weekly review of a " +
          "freelancer's last 7 days of sales activity. You are given real, already-computed stats for that " +
          "window — do not invent numbers or businesses not present in the input. Respond with ONLY a JSON " +
          'object: {"reflection": string (2-4 sentences, honest and specific, not generic praise), ' +
          '"wins": string[] (0-3 genuine positives, empty array if none), ' +
          '"focusForNextWeek": string[] (1-3 concrete goals for next week)}.',
        user: JSON.stringify(snapshot),
        feature: "weekly_intelligence",
        contextPrepMs: Date.now() - routeStart,
        maxTokens: 1024,
        timeoutMs: 28000,
        tier: "pro",
      });

      nextWeekly.reflection = asString(nextWeekly.reflection, "Here's a look back at your last 7 days.");
      nextWeekly.wins = asStringArray(nextWeekly.wins);
      nextWeekly.focusForNextWeek = asStringArray(nextWeekly.focusForNextWeek);

      const nextGeneratedAt = new Date().toISOString();
      const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
        {
          user_id: userId,
          kind: "weekly_intelligence",
          period_key: periodKey,
          content: nextWeekly,
          model: getAiModel("pro"),
          generated_at: nextGeneratedAt,
        },
        { onConflict: "user_id,kind,period_key" },
      );
      if (upsertError) console.error("[intelligence] ai_intelligence (weekly_intelligence) upsert failed", upsertError);

      return { weekly: nextWeekly, generatedAt: nextGeneratedAt };
    });

    res.json({ ...weekly, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/coaching
 *
 * AI Pipeline Coaching (Pro+): alerts on stalled deals and suggested next
 * moves. Cached once per user per UTC day, same rationale as /briefing.
 */
intelligenceRouter.get("/coaching", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);

    if (!canUseAiFeature(plan, "pipelineCoaching")) {
      return res.status(403).json({ code: "plan_restricted", message: "AI Pipeline Coaching requires a Pro or Premium plan." });
    }

    const periodKey = new Date().toISOString().slice(0, 10);

    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "pipeline_coaching")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cacheError) console.error("[intelligence] ai_intelligence (pipeline_coaching) read failed", cacheError);
    if (cached) {
      logAiMetric({
        correlationId: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        feature: "pipeline_coaching",
        model: getAiModel("pro"),
        cacheHit: true,
        contextPrepMs: Date.now() - routeStart,
        modelDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - routeStart,
        retryCount: 0,
        retryReasons: [],
        outcome: "success",
      });
      return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });
    }

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    if (!checkAiGenerationRateLimit(req, res)) {
      return;
    }

    const snapshot = await buildPipelineSnapshot(userId);

    if (snapshot.stalledDeals.length === 0) {
      const content = { alerts: [], allClear: true };
      const generatedAt = new Date().toISOString();
      await supabaseAdmin.from("ai_intelligence").upsert(
        { user_id: userId, kind: "pipeline_coaching", period_key: periodKey, content, model: "none", generated_at: generatedAt },
        { onConflict: "user_id,kind,period_key" },
      );
      return res.json({ ...content, generatedAt, cached: false });
    }

    // Sprint 3: coalesce concurrent cache-miss generations for the same
    // (user, day) — see lib/singleFlight.ts.
    const { content, generatedAt } = await singleFlight(`coaching:${userId}:${periodKey}`, async () => {
      const coaching = await generateJSON<{ alerts: Array<{ businessName: string; message: string; suggestedAction: string }> }>({
        system:
          "You are MAST's Opportunity Intelligence assistant, coaching a freelancer on stalled deals in their " +
          "sales pipeline. You are given real, already-computed stalled-deal data — do not invent businesses " +
          'or facts not present in the input. Respond with ONLY a JSON object: {"alerts": [{"businessName": ' +
          'string, "message": string (why this deal is at risk, 1 sentence), "suggestedAction": string ' +
          "(1 concrete next step)}]} — one alert per stalled deal given, same order.",
        user: JSON.stringify({ stalledDeals: snapshot.stalledDeals }),
        feature: "pipeline_coaching",
        contextPrepMs: Date.now() - routeStart,
        maxTokens: 1024,
        timeoutMs: 28000,
        tier: "pro",
      });

      const alerts = (Array.isArray(coaching.alerts) ? coaching.alerts : [])
        .filter((alert): alert is { businessName: string; message: string; suggestedAction: string } => !!alert)
        .map((alert) => ({
          businessName: asString(alert.businessName, "A business in your pipeline"),
          message: asString(alert.message, "This deal has been stalled and may need a follow-up."),
          suggestedAction: asString(alert.suggestedAction, "Send a follow-up message."),
        }));

      const nextContent = { alerts, allClear: alerts.length === 0 };
      const nextGeneratedAt = new Date().toISOString();
      const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
        { user_id: userId, kind: "pipeline_coaching", period_key: periodKey, content: nextContent, model: getAiModel("pro"), generated_at: nextGeneratedAt },
        { onConflict: "user_id,kind,period_key" },
      );
      if (upsertError) console.error("[intelligence] ai_intelligence (pipeline_coaching) upsert failed", upsertError);

      return { content: nextContent, generatedAt: nextGeneratedAt };
    });

    res.json({ ...content, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/discover-overview
 *
 * Genuine Discover AI Overview (Pro/Premium).
 * Analyzes the user's actual saved leads and discovery results,
 * highlighting patterns, promising opportunities, and practical next steps.
 * Cached per material state of the user's discovery results.
 */
intelligenceRouter.get("/discover-overview", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);

    if (!canUseAiFeature(plan, "discoverOverview")) {
      return res.status(403).json({ code: "plan_restricted", message: "Discover AI Overview requires a Pro or Premium plan." });
    }

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    const { data: leadsData, error: leadsError } = await supabaseAdmin
      .from("leads")
      .select("id, business_name, niche, location, status, priority, opportunity_score, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (leadsError) throw leadsError;

    const leads = leadsData ?? [];

    if (leads.length === 0) {
      return res.json({
        label: "Discovery Overview",
        headline: "No leads discovered yet",
        body: "Run your first discovery search to surface opportunities and receive AI insights.",
        confidence: "Recommended",
        tone: "brand",
        patterns: [],
        promisingOpportunities: [],
        nextSteps: ["Run a search in Discover to find local business opportunities."],
        action: { label: "Start Discovery", href: "#niche-select" },
        generatedAt: new Date().toISOString(),
        cached: false,
      });
    }

    const totalLeads = leads.length;
    let newCount = 0;
    let contactedCount = 0;
    let repliedCount = 0;
    const nicheCounts: Record<string, number> = {};
    const regionCounts: Record<string, number> = {};

    for (const l of leads) {
      const st = (l.status ?? "new").toLowerCase();
      if (st === "new") newCount++;
      else if (st === "replied" || st === "interested" || st === "meeting_booked" || st === "closed") repliedCount++;
      else contactedCount++;

      if (l.niche) nicheCounts[l.niche] = (nicheCounts[l.niche] ?? 0) + 1;
      if (l.location) regionCounts[l.location] = (regionCounts[l.location] ?? 0) + 1;
    }

    const topNiches = Object.entries(nicheCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, c]) => `${n} (${c})`);
    const topRegions = Object.entries(regionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, c]) => `${r} (${c})`);

    const topOpportunities = [...leads]
      .filter((l) => l.opportunity_score != null)
      .sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0))
      .slice(0, 5)
      .map((l) => ({
        businessName: l.business_name,
        niche: l.niche ?? "General",
        score: l.opportunity_score,
        status: l.status,
      }));

    const boundedPayload = {
      totalLeads,
      breakdown: { new: newCount, contacted: contactedCount, repliedOrAdvanced: repliedCount },
      topNiches,
      topRegions,
      topOpportunities,
    };
    const contextFingerprint = createHash("sha256")
      .update(JSON.stringify(boundedPayload))
      .digest("hex")
      .slice(0, 16);
    const today = new Date().toISOString().slice(0, 10);
    const periodKey = `${today}:${contextFingerprint}`;

    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "discover_overview")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cacheError) console.error("[intelligence] ai_intelligence (discover_overview) read failed", cacheError);
    if (cached) {
      logAiMetric({
        correlationId: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        feature: "discover_overview",
        model: getAiModel("pro"),
        cacheHit: true,
        contextPrepMs: Date.now() - routeStart,
        modelDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - routeStart,
        retryCount: 0,
        retryReasons: [],
        outcome: "success",
      });
      return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });
    }

    if (!checkAiGenerationRateLimit(req, res)) {
      return;
    }

    const { overview, generatedAt } = await singleFlight(`discover_overview:${userId}:${periodKey}`, async () => {

      let nextOverview: any;
      const generateOptions = {
        system:
          "You are MAST's Opportunity Intelligence assistant, generating an executive overview of a freelancer's " +
          "discovered leads and opportunities. You are provided with real, already-aggregated lead statistics and top " +
          "opportunity scores. Do NOT invent businesses, market trends, conversion rates, or facts not present in the input. " +
          "Never use em dashes ('—' or '–'). Avoid generic buzzwords ('elevate', 'streamline', 'synergy'). " +
          "Respond with ONLY a raw JSON object without preamble, conversational intro, or markdown fences outside the JSON: " +
          '{"label": string (<=3 words, e.g. "High Potential" or "Key Patterns"), ' +
          '"headline": string (1 concise sentence summarizing what the current discovery results suggest), ' +
          '"body": string (2-3 sentences explaining notable patterns, promising angles, and immediate next steps), ' +
          '"confidence": "High Confidence" | "Recommended" | "Worth Testing" | "Watch Closely", ' +
          '"tone": "brand" | "warning" | "success" | "neutral", ' +
          '"patterns": string[] (1-3 observed patterns from the niches and scores), ' +
          '"promisingOpportunities": string[] (1-3 specific business names or high-score segments highlighted), ' +
          '"nextSteps": string[] (1-3 practical next actions grounded in the data), ' +
          '"action": {"label": string, "href": string} (optional action link, default label "View Saved Leads", href "#leads-table")}',
        user: JSON.stringify(boundedPayload),
        feature: "discover_overview" as const,
        contextPrepMs: Date.now() - routeStart,
        maxTokens: 1200,
        timeoutMs: 28000,
        tier: "pro" as const,
      };

      try {
        nextOverview = await generateJSON<any>(generateOptions);
      } catch (firstErr) {
        console.warn("[intelligence] discover-overview first attempt failed, retrying once with boosted token budget", firstErr);
        const retryOptions = {
          ...generateOptions,
          maxTokens: Math.min(4000, (generateOptions.maxTokens ?? 1200) * 2),
        };
        nextOverview = await generateJSON<any>(retryOptions);
      }

      nextOverview.label = asString(nextOverview.label, "AI Overview").replace(/[—–]/g, " - ");
      nextOverview.headline = asString(nextOverview.headline, "Here is an executive overview of your discovered opportunities.").replace(/[—–]/g, " - ");
      nextOverview.body = asString(nextOverview.body, "Review your top leads and begin outreach with verified high-opportunity prospects.").replace(/[—–]/g, " - ");
      nextOverview.confidence = asEnum(nextOverview.confidence, ["High Confidence", "Recommended", "Worth Testing", "Watch Closely"] as const, "Recommended");
      nextOverview.tone = asEnum(nextOverview.tone, ["brand", "warning", "success", "neutral"] as const, "brand");
      nextOverview.patterns = asStringArray(nextOverview.patterns).map((s) => s.replace(/[—–]/g, " - "));
      nextOverview.promisingOpportunities = asStringArray(nextOverview.promisingOpportunities).map((s) => s.replace(/[—–]/g, " - "));
      nextOverview.nextSteps = asStringArray(nextOverview.nextSteps).map((s) => s.replace(/[—–]/g, " - "));
      if (nextOverview.action && typeof nextOverview.action === "object") {
        nextOverview.action = {
          label: asString((nextOverview.action as any).label, "View Leads"),
          href: asString((nextOverview.action as any).href, "#leads-table"),
        };
      }

      const nextGeneratedAt = new Date().toISOString();
      const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
        {
          user_id: userId,
          kind: "discover_overview",
          period_key: periodKey,
          content: nextOverview,
          model: getAiModel("pro"),
          generated_at: nextGeneratedAt,
        },
        { onConflict: "user_id,kind,period_key" },
      );
      if (upsertError) console.error("[intelligence] ai_intelligence (discover_overview) upsert failed", upsertError);

      return { overview: nextOverview, generatedAt: nextGeneratedAt };
    });

    res.json({ ...overview, generatedAt, cached: false });
  } catch (err) {
    // Phase 7: On provider failure / abort, return cached or degraded response instead of 500
    try {
      console.warn("[intelligence] discover-overview generation failed, falling back to cached/degraded response", err);
      const userId = req.user?.id;
      if (userId) {
        const { data: cached } = await supabaseAdmin
          .from("ai_intelligence")
          .select("content, generated_at")
          .eq("user_id", userId)
          .eq("kind", "discover_overview")
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cached?.content) {
          return res.json({
            ...(cached.content as object),
            generatedAt: cached.generated_at,
            cached: true,
            degraded: true,
            fallbackReason: "provider_failure",
          });
        }
      }

      const degradedOverview = {
        label: "Discovery Overview",
        headline: "Here is an executive overview of your discovered opportunities.",
        body: "Review your top leads and begin outreach with verified high-opportunity prospects.",
        confidence: "Recommended",
        tone: "neutral",
        patterns: ["Pipeline active"],
        promisingOpportunities: [],
        nextSteps: ["Review discovered leads in your pipeline", "Initiate outreach to verified contacts"],
        action: { label: "View Leads", href: "#leads-table" },
        generatedAt: new Date().toISOString(),
        cached: false,
        degraded: true,
        fallbackReason: "provider_failure",
      };
      return res.json(degradedOverview);
    } catch (fallbackErr) {
      console.error("[intelligence] discover-overview fallback failed", fallbackErr);
      next(err);
    }
  }
});

/**
 * GET /v1/intelligence/mission-coach
 *
 * Genuine Mission AI Coach (Pro/Premium).
 * Analyzes the user's active mission queue, follow-up progress, and lead priorities
 * to recommend a concrete, grounded next action with supporting rationale.
 * Cached per material state of the user's mission follow-ups.
 */
intelligenceRouter.get("/mission-coach", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);

    if (!canUseAiFeature(plan, "missionCoach")) {
      return res.status(403).json({ code: "plan_restricted", message: "Mission AI Coach requires a Pro or Premium plan." });
    }

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    const [{ data: rawFollowups, error: followupsError }, { data: rawLeads, error: leadsError }] = await Promise.all([
      supabaseAdmin
        .from("lead_followups")
        .select("id, lead_id, channel, due_at, status, notes, step_number, sequence_name, completed_at, updated_at")
        .eq("user_id", userId),
      supabaseAdmin
        .from("leads")
        .select("id, business_name, niche, status, priority, opportunity_score, last_contacted_at, follow_up_at, updated_at")
        .eq("user_id", userId),
    ]);
    if (followupsError) console.warn("[intelligence] lead_followups read error", followupsError.message);
    if (leadsError) throw leadsError;

    const leads = rawLeads ?? [];
    const leadsById = new Map<number, (typeof leads)[0]>(leads.map((l) => [l.id, l]));

    // If followups table is empty, fall back to checking if leads have follow_up_at
    const followups = (rawFollowups && rawFollowups.length > 0)
      ? rawFollowups
      : leads.filter((l) => Boolean(l.follow_up_at)).map((l) => ({
          id: l.id,
          lead_id: l.id,
          channel: "email",
          due_at: l.follow_up_at!,
          status: "pending",
          notes: null,
          step_number: null,
          sequence_name: null,
          completed_at: null,
          updated_at: l.updated_at,
        }));

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    const todayEndMs = todayStartMs + 86_400_000;

    const activeFollowups = followups.filter((f) => f.status !== "completed");
    const completedToday = followups.filter((f) => {
      if (f.status !== "completed") return false;
      const compTime = new Date(f.completed_at ?? f.updated_at).getTime();
      return compTime >= todayStartMs && compTime < todayEndMs;
    });

    let overdueCount = 0;
    let dueTodayCount = 0;
    let upcomingCount = 0;

    for (const f of activeFollowups) {
      const dueTime = new Date(f.due_at).getTime();
      if (dueTime < todayStartMs) overdueCount++;
      else if (dueTime < todayEndMs) dueTodayCount++;
      else upcomingCount++;
    }

    if (activeFollowups.length === 0 && completedToday.length === 0 && leads.length === 0) {
      return res.json({
        briefing: "Nothing due today. Your pipeline is on schedule.",
        recommendedLeadId: null,
        recommendedAction: "Schedule follow-ups from your leads to build your next mission.",
        rationale: "No pending or overdue follow-up actions found.",
        reasons: ["Pipeline is up to date"],
        cached: false,
        generatedAt: new Date().toISOString(),
      });
    }

    // Sort active follow-ups to find the top priority candidates
    const scoredFollowups = activeFollowups.map((f) => {
      const lead = leadsById.get(f.lead_id);
      const dueTime = new Date(f.due_at).getTime();
      const isOverdue = dueTime < todayStartMs;
      const isToday = dueTime >= todayStartMs && dueTime < todayEndMs;
      const daysOverdue = isOverdue ? Math.max(1, Math.round((todayStartMs - dueTime) / 86_400_000)) : 0;
      const daysSinceContact = lead?.last_contacted_at
        ? Math.max(0, Math.floor((Date.now() - new Date(lead.last_contacted_at).getTime()) / 86_400_000))
        : null;

      let urgencyScore = (lead?.opportunity_score ?? 50) * 0.4;
      if (isOverdue) urgencyScore += 40 + daysOverdue * 5;
      else if (isToday) urgencyScore += 25;
      if (lead?.priority === "high") urgencyScore += 20;
      if (lead?.status === "meeting_booked") urgencyScore += 30;
      else if (lead?.status === "replied") urgencyScore += 25;

      return {
        followupId: f.id,
        leadId: f.lead_id,
        businessName: lead?.business_name ?? "Unknown Prospect",
        niche: lead?.niche ?? "General",
        channel: f.channel,
        status: f.status,
        dueAt: f.due_at,
        dueState: isOverdue ? "overdue" : isToday ? "today" : "upcoming",
        daysOverdue,
        daysSinceContact,
        opportunityScore: lead?.opportunity_score ?? null,
        priority: lead?.priority ?? "normal",
        notes: f.notes,
        urgencyScore,
      };
    }).sort((a, b) => b.urgencyScore - a.urgencyScore);

    const topPriorityCandidates = scoredFollowups.slice(0, 5).map(({ urgencyScore, ...item }) => item);

    const boundedPayload = {
      queueSummary: {
        overdue: overdueCount,
        dueToday: dueTodayCount,
        upcoming: upcomingCount,
        completedToday: completedToday.length,
        completedIds: completedToday.map((f) => String(f.id)).sort(),
        totalLeads: leads.length,
      },
      topPriorityCandidates,
    };
    const contextFingerprint = createHash("sha256")
      .update(JSON.stringify(boundedPayload))
      .digest("hex")
      .slice(0, 16);
    const today = new Date().toISOString().slice(0, 10);
    const periodKey = `${today}:${contextFingerprint}`;

    const { data: cached, error: cacheError } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "mission_coach")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cacheError) console.error("[intelligence] ai_intelligence (mission_coach) read failed", cacheError);
    if (cached) {
      logAiMetric({
        correlationId: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        feature: "mission_coach",
        model: getAiModel("pro"),
        cacheHit: true,
        contextPrepMs: Date.now() - routeStart,
        modelDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: Date.now() - routeStart,
        retryCount: 0,
        retryReasons: [],
        outcome: "success",
      });
      return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });
    }

    if (!checkAiGenerationRateLimit(req, res)) {
      return;
    }

    const { coaching, generatedAt } = await singleFlight(`mission_coach:${userId}:${periodKey}`, async () => {

      const nextCoaching = await generateJSON<{
        briefing: string;
        recommendedLeadId: number | null;
        recommendedAction: string;
        rationale: string;
        reasons: string[];
      }>({
        system:
          "You are MAST's Opportunity Intelligence assistant acting as the Mission Coach for a freelancer. " +
          "You are given real mission progress, follow-up counts, and top lead facts. Do NOT invent contacts, messages, " +
          "replies, dates, or tasks not present in the input. Never use em dashes ('—' or '–'). Avoid generic motivational cliches. " +
          "Keep advice practical, concise, and grounded in the data. " +
          "Respond with ONLY a raw JSON object without preamble, conversational intro, or markdown fences outside the JSON: " +
          '{"briefing": string (1-2 sentences summarizing today\'s executive mission priority based on overdue/due counts), ' +
          '"recommendedLeadId": number | null (the id of the lead to act on first, from the provided items, or null if none), ' +
          '"recommendedAction": string (1 concrete next step for the recommended lead, <=15 words), ' +
          '"rationale": string (1-2 sentences explaining why this action makes sense right now), ' +
          '"reasons": string[] (1-3 short bullet reasons grounded in stage, timing, or score)}.',
        user: JSON.stringify(boundedPayload),
        feature: "mission_coach",
        contextPrepMs: Date.now() - routeStart,
        maxTokens: 1024,
        timeoutMs: 28000,
        tier: "pro",
      });

      nextCoaching.briefing = asString(nextCoaching.briefing, "Here is your mission priority for today.").replace(/[—–]/g, " - ");
      nextCoaching.recommendedAction = asString(nextCoaching.recommendedAction, "Review your pending follow-ups.").replace(/[—–]/g, " - ");
      nextCoaching.rationale = asString(nextCoaching.rationale, "Focus on overdue and warm conversations first.").replace(/[—–]/g, " - ");
      nextCoaching.reasons = asStringArray(nextCoaching.reasons).map((s) => s.replace(/[—–]/g, " - "));
      if (typeof nextCoaching.recommendedLeadId !== "number") {
        nextCoaching.recommendedLeadId = topPriorityCandidates[0]?.leadId ?? null;
      }

      const nextGeneratedAt = new Date().toISOString();
      const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
        {
          user_id: userId,
          kind: "mission_coach",
          period_key: periodKey,
          content: nextCoaching,
          model: getAiModel("pro"),
          generated_at: nextGeneratedAt,
        },
        { onConflict: "user_id,kind,period_key" },
      );
      if (upsertError) console.error("[intelligence] ai_intelligence (mission_coach) upsert failed", upsertError);

      return { coaching: nextCoaching, generatedAt: nextGeneratedAt };
    });

    res.json({ ...coaching, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});

export const investigateDeps = {
  inspectWebsite: inspectWebsiteSnapshot,
};

const MAX_INVESTIGATE_QUESTION_LENGTH = 500;

/**
 * POST /v1/intelligence/investigate/:leadId
 *
 * Answers a specific pre-outreach research question about a lead using:
 *   1. Verified lead + business + health + activity data in Postgres
 *   2. A fast, SSRF-safe live homepage signal check (CMS/tech, booking tools,
 *      SSL/meta, contact/owner clues) when a website is present
 *   3. Optional AI synthesis (Premium `advancedResearch`) strictly grounded
 *      in the collected facts, with deterministic fallback for all plans
 */
intelligenceRouter.post("/investigate/:leadId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const routeStart = Date.now();
    const { plan, professionSlug: profileProfession, workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return res.status(400).json({ code: "invalid_lead_id", message: "leadId must be numeric." });
    }

    const rawQuestion = req.body?.question;
    if (typeof rawQuestion !== "string" || !rawQuestion.trim()) {
      return res.status(400).json({ code: "invalid_question", message: "A non-empty research question is required." });
    }
    const question = rawQuestion.trim().slice(0, MAX_INVESTIGATE_QUESTION_LENGTH);

    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select(
        "id, business_id, profession_slug, opportunity_score, business_name, niche, location, website, email, phone, instagram_handle, linkedin_handle, status, ig_followers, ig_bio, ig_last_post",
      )
      .eq("id", leadId)
      .eq("user_id", userId)
      .maybeSingle();

    if (leadError) throw leadError;
    if (!lead) {
      return res.status(404).json({ code: "not_found", message: "Lead not found or access denied." });
    }

    const professionSlug = (lead.profession_slug as ProfessionSlug | null) ?? profileProfession;

    let business: Record<string, any> | null = null;
    let healthScore: { score: number; breakdown: Record<string, unknown> | null } | null = null;
    let explanation: LeadInvestigationContext["explanation"] = null;

    if (lead.business_id) {
      const [{ data: bizRow }, { data: healthRow }] = await Promise.all([
        supabaseAdmin
          .from("businesses")
          .select(
            "id, category, address, website, email, phone, instagram, facebook, linkedin, reviews_count, reviews_rating, has_photos, website_is_weak, ssl_valid, load_time_ms, seo, blog, confidence, last_verified_at, is_disqualified, disqualify_reason, signals",
          )
          .eq("id", lead.business_id)
          .maybeSingle(),
        supabaseAdmin
          .from("business_health_scores")
          .select("health_score, breakdown")
          .eq("business_id", lead.business_id)
          .maybeSingle(),
      ]);
      business = bizRow ?? null;
      if (healthRow) {
        healthScore = {
          score: Number(healthRow.health_score ?? 0),
          breakdown: (healthRow.breakdown as Record<string, unknown> | null) ?? null,
        };
      }

      if (business && professionSlug) {
        try {
          const engineResult = await runEngineScore({
            ...business,
            id: lead.business_id,
            ...(business.signals != null && typeof business.signals === "object"
              ? (business.signals as Record<string, unknown>)
              : {}),
          });
          const ps = engineResult.profession_scores?.[professionSlug];
          explanation = {
            score: ps?.score ?? 0,
            summary: ps?.summary ?? "",
            reasons: (ps?.reasons ?? []) as any[],
          };
        } catch {
          // Non-fatal: proceed without engine breakdown
        }
      }
    }

    const { data: activityRows } = await supabaseAdmin
      .from("lead_activities")
      .select("type, channel, content, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(5);

    const recentActivitySummary = Array.isArray(activityRows)
      ? activityRows
          .map((a: any) => `${a.type}${a.channel ? ` (${a.channel})` : ""}: ${String(a.content ?? "").slice(0, 140)}`)
          .filter(Boolean)
      : [];

    const websiteToCheck = (lead.website as string | null) || (business?.website as string | null) || null;
    const websiteSnapshot = await investigateDeps.inspectWebsite(websiteToCheck);

    const context: LeadInvestigationContext = {
      lead: {
        id: Number(lead.id),
        businessName: String(lead.business_name ?? "Unknown Business"),
        niche: lead.niche ?? null,
        location: lead.location ?? null,
        website: lead.website ?? null,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        instagramHandle: lead.instagram_handle ?? null,
        linkedinHandle: lead.linkedin_handle ?? null,
        opportunityScore: lead.opportunity_score ?? null,
        status: String(lead.status ?? "new"),
        igFollowers: lead.ig_followers ?? null,
        igBio: lead.ig_bio ?? null,
        igLastPost: lead.ig_last_post ?? null,
      },
      business: business
        ? {
            id: String(business.id),
            category: business.category ?? null,
            address: business.address ?? null,
            website: business.website ?? null,
            email: business.email ?? null,
            phone: business.phone ?? null,
            instagram: business.instagram ?? null,
            facebook: business.facebook ?? null,
            linkedin: business.linkedin ?? null,
            reviewsCount: business.reviews_count ?? null,
            reviewsRating: business.reviews_rating ?? null,
            hasPhotos: business.has_photos ?? null,
            websiteIsWeak: business.website_is_weak ?? null,
            sslValid: business.ssl_valid ?? null,
            loadTimeMs: business.load_time_ms ?? null,
            seo: business.seo ?? null,
            blog: business.blog ?? null,
            confidence: business.confidence ?? null,
            lastVerifiedAt: business.last_verified_at ?? null,
            isDisqualified: Boolean(business.is_disqualified),
            disqualifyReason: business.disqualify_reason ?? null,
            signals: (business.signals as Record<string, unknown>) ?? {},
          }
        : null,
      healthScore,
      explanation,
      recentActivitySummary,
      websiteSnapshot,
    };

    const deterministic = buildDeterministicInvestigation(question, context);

    if (aiEnabled() && canUseAiFeature(plan, "advancedResearch")) {
      if (!checkAiGenerationRateLimit(req, res)) {
        return;
      }
      try {
        const aiResult = await generateJSON<{
          answer: string;
          confidence: "high" | "medium" | "low";
          evidence: string[];
          gaps: string[];
        }>({
          system:
            "You are MAST's Pre-Outreach Research Analyst. Answer the user's specific question about a business " +
            "using ONLY the verified database telemetry and live homepage snapshot provided in the JSON input. " +
            "Never invent owner names, revenue figures, broken links, or tools that are not explicitly present in the input. " +
            "If the answer is not verifiable from the supplied facts, state clearly what is known and what remains unverified. " +
            "Never use em dashes ('—' or '–'). " +
            "Respond with ONLY a raw JSON object: " +
            '{"answer": string (2-4 clear sentences directly answering the question), ' +
            '"confidence": "high" | "medium" | "low", ' +
            '"evidence": string[] (2-6 short factual bullets from the input), ' +
            '"gaps": string[] (0-3 short notes on missing/unverified details)}.',
          user: JSON.stringify({ question, context }),
          feature: "advanced_research",
          contextPrepMs: Date.now() - routeStart,
          maxTokens: 700,
          timeoutMs: 20_000,
          tier: "pro",
        });

        const cleanAnswer = asString(aiResult.answer, deterministic.answer).replace(/[—–]/g, " - ");
        const cleanEvidence = asStringArray(aiResult.evidence).map((s) => s.replace(/[—–]/g, " - "));
        const cleanGaps = asStringArray(aiResult.gaps).map((s) => s.replace(/[—–]/g, " - "));

        const responsePayload: InvestigateLeadResult = {
          question,
          answer: cleanAnswer,
          mode: "ai",
          confidence: asEnum(aiResult.confidence, ["high", "medium", "low"] as const, deterministic.confidence),
          evidence: cleanEvidence.length > 0 ? cleanEvidence : deterministic.evidence,
          gaps: cleanGaps.length > 0 ? cleanGaps : deterministic.gaps,
          websiteSnapshot,
          checkedAt: new Date().toISOString(),
        };
        return res.json(responsePayload);
      } catch (aiErr) {
        console.warn("[intelligence] investigate AI synthesis failed, returning deterministic result:", aiErr);
      }
    }

    return res.json(deterministic);
  } catch (err) {
    next(err);
  }
});

export const auditDeps = {
  collectWebsiteAuditInputs,
};

/**
 * GET /v1/intelligence/audit/:leadId
 *
 * Returns the cached website screenshot + bullet-point mini audit for a lead,
 * or { audit: null } if no audit has been generated yet.
 */
intelligenceRouter.get("/audit/:leadId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ error: "Invalid leadId" });
    }

    const { data, error } = await (supabaseAdmin as any)
      .from("lead_website_audits")
      .select("website_url, screenshot_data_url, visual_summary, audit_bullets, ux_findings, mode, updated_at")
      .eq("user_id", userId)
      .eq("lead_id", leadId)
      .maybeSingle();

    if (error || !data) {
      return res.json({ audit: null });
    }

    const audit: WebsiteAuditResult = {
      websiteUrl: data.website_url ?? null,
      screenshotDataUrl: data.screenshot_data_url ?? null,
      screenshotAvailable: Boolean(data.screenshot_data_url),
      visualSummary: typeof data.visual_summary === "string" ? data.visual_summary : "",
      auditBullets: Array.isArray(data.audit_bullets) ? data.audit_bullets : [],
      uxFindings: Array.isArray(data.ux_findings) ? data.ux_findings : [],
      mode: asEnum(data.mode, ["ai_vision", "ai_text", "verified_data"] as const, "verified_data"),
      checkedAt: data.updated_at || new Date().toISOString(),
      cached: true,
    };
    return res.json({ audit });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/intelligence/audit/:leadId
 *
 * Captures a homepage screenshot (when headless Chrome/Edge is available),
 * inspects verified homepage UX/tech signals, and generates a 3-5 bullet
 * Mini Audit + visual critique summary. Paid plans with AI (starter/pro/premium)
 * refine the visual summary & bullets with AI (vision when screenshot exists,
 * with automatic text-only fallback); free plans receive verified-data bullets.
 */
intelligenceRouter.post("/audit/:leadId", requireAuth, async (req, res, next) => {
  const routeStart = Date.now();
  try {
    const { workspaceOwnerId: userId, plan } = await resolveUserPlanAndProfession(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ error: "Invalid leadId" });
    }

    const skipScreenshot = req.body?.skipScreenshot === true;

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("id, business_name, website, instagram_handle, business_id")
      .eq("id", leadId)
      .eq("user_id", userId)
      .single();

    if (leadErr || !lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    let business: Record<string, any> | null = null;
    if (lead.business_id) {
      const { data: biz } = await supabaseAdmin
        .from("businesses")
        .select("website, ssl_valid, load_time_ms, website_is_weak, reviews_count, reviews_rating, instagram")
        .eq("id", lead.business_id)
        .maybeSingle();
      business = biz ?? null;
    }

    const websiteUrl = (lead.website as string | null) || (business?.website as string | null) || null;
    const collected = await auditDeps.collectWebsiteAuditInputs({
      businessName: String(lead.business_name ?? "Business"),
      websiteUrl,
      sslValid: business?.ssl_valid ?? null,
      loadTimeMs: business?.load_time_ms ?? null,
      websiteIsWeak: business?.website_is_weak ?? null,
      reviewsCount: business?.reviews_count ?? null,
      reviewsRating: business?.reviews_rating ?? null,
      hasInstagram: Boolean(lead.instagram_handle || business?.instagram),
      skipScreenshot,
    });

    let visualSummary = collected.deterministic.visualSummary;
    let auditBullets = collected.deterministic.auditBullets;
    let mode: WebsiteAuditResult["mode"] = "verified_data";

    if (aiEnabled() && canUseAiFeature(plan, "outreachDraft")) {
      if (!checkAiGenerationRateLimit(req, res)) {
        return;
      }

      const systemPrompt =
        "You are MAST's Website & Conversion Reviewer. Given a business's verified homepage telemetry " +
        "(and optionally a homepage screenshot), write a concise plain-English visual critique and 3 to 5 " +
        "punchy bullet points a freelancer or agency can share directly with the business owner.\n" +
        "Rules:\n" +
        "- ONLY state issues you can directly verify from the screenshot or supplied telemetry. Never invent broken links, traffic numbers, or fake metrics.\n" +
        "- Keep each bullet under 22 words, practical, and respectful (no harsh insults, no agency jargon).\n" +
        "- Make visualSummary 1-2 short sentences describing what stands out visually or structurally so AI outreach can mention it naturally.\n" +
        "- Never use em dashes ('—' or '–').\n" +
        'Respond with ONLY a raw JSON object: {"visualSummary": string, "auditBullets": string[]}.';

      const userPayload = JSON.stringify({
        businessName: lead.business_name,
        websiteUrl,
        snapshot: collected.snapshot,
        verifiedFindings: collected.deterministic.uxFindings,
        fallbackBullets: collected.deterministic.auditBullets,
      });

      const applyAiAudit = (raw: { visualSummary?: unknown; auditBullets?: unknown }, usedVision: boolean) => {
        const cleanSummary = asString(raw?.visualSummary, "").replace(/[—–]/g, " - ").trim();
        const cleanBullets = asStringArray(raw?.auditBullets)
          .map((b) => b.replace(/[—–]/g, " - ").trim())
          .filter(Boolean)
          .slice(0, 5);
        if (cleanSummary) visualSummary = cleanSummary;
        if (cleanBullets.length >= 2) auditBullets = cleanBullets;
        mode = usedVision ? "ai_vision" : "ai_text";
      };

      if (collected.screenshotDataUrl) {
        try {
          const visionResult = await generateJSON<{ visualSummary: string; auditBullets: string[] }>({
            system: systemPrompt,
            user: userPayload,
            imageDataUrl: collected.screenshotDataUrl,
            feature: "website_audit",
            contextPrepMs: Date.now() - routeStart,
            maxTokens: 600,
            timeoutMs: 22_000,
            tier: "fast",
          });
          applyAiAudit(visionResult, true);
        } catch (visionErr) {
          console.warn("[intelligence] website audit vision failed, retrying text-only:", visionErr);
        }
      }

      if (mode === "verified_data") {
        try {
          const textResult = await generateJSON<{ visualSummary: string; auditBullets: string[] }>({
            system: systemPrompt,
            user: userPayload,
            feature: "website_audit",
            contextPrepMs: Date.now() - routeStart,
            maxTokens: 550,
            timeoutMs: 18_000,
            tier: "fast",
          });
          applyAiAudit(textResult, false);
        } catch (textErr) {
          console.warn("[intelligence] website audit text AI failed, returning verified_data:", textErr);
        }
      }
    }

    const nowIso = new Date().toISOString();
    try {
      await (supabaseAdmin as any).from("lead_website_audits").upsert(
        {
          user_id: userId,
          lead_id: leadId,
          website_url: websiteUrl,
          screenshot_data_url: collected.screenshotDataUrl,
          visual_summary: visualSummary,
          audit_bullets: auditBullets,
          ux_findings: collected.deterministic.uxFindings,
          mode,
          checked_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "lead_id" },
      );
    } catch (persistErr) {
      console.warn("[intelligence] website audit cache save skipped:", persistErr);
    }

    const result: WebsiteAuditResult = {
      websiteUrl,
      screenshotDataUrl: collected.screenshotDataUrl,
      screenshotAvailable: Boolean(collected.screenshotDataUrl),
      visualSummary,
      auditBullets,
      uxFindings: collected.deterministic.uxFindings,
      mode,
      checkedAt: nowIso,
      cached: false,
    };

    return res.json({ audit: result });
  } catch (err) {
    next(err);
  }
});

// ── Business Activity & Live Instagram Check ─────────────────────────────────
// In-memory 30-minute cache for live IG checks per lead so switching back and
// forth doesn't hammer Instagram's public endpoint.
const LIVE_IG_CACHE_TTL_MS = 30 * 60 * 1000;
const liveIgCache = new Map<string, { expiresAt: number; result: LiveInstagramCheckResult }>();

async function loadLeadAndBusinessForActivity(userId: string, leadId: number) {
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select(
      "id, business_id, email, phone, website, instagram_handle, linkedin_handle, ig_followers, ig_last_post, ig_bio",
    )
    .eq("id", leadId)
    .eq("user_id", userId)
    .single();

  if (leadErr || !lead) return null;

  let business: Record<string, any> | null = null;
  if (lead.business_id) {
    const { data: biz } = await supabaseAdmin
      .from("businesses")
      .select(
        "id, email, phone, website, instagram, facebook, linkedin, reviews_count, reviews_rating, website_is_weak, blog, signals",
      )
      .eq("id", lead.business_id)
      .maybeSingle();
    business = biz ?? null;
  }

  return { lead, business };
}

function buildActivityFromRecords(
  lead: Record<string, any>,
  business: Record<string, any> | null,
  liveIg: LiveInstagramCheckResult | null,
) {
  const signals =
    business?.signals && typeof business.signals === "object"
      ? (business.signals as Record<string, any>)
      : {};
  const blogObj =
    business?.blog && typeof business.blog === "object"
      ? (business.blog as Record<string, any>)
      : null;

  return computeBusinessActivity({
    email: lead.email ?? business?.email ?? null,
    phone: lead.phone ?? business?.phone ?? null,
    website: lead.website ?? business?.website ?? null,
    instagramHandle: lead.instagram_handle ?? business?.instagram ?? null,
    igFollowers: lead.ig_followers ?? signals.ig_followers ?? null,
    igLastPost: lead.ig_last_post ?? null,
    igLastPostDays:
      typeof signals.ig_last_post_days === "number" ? signals.ig_last_post_days : null,
    liveIg,
    facebook: business?.facebook ?? null,
    linkedin: lead.linkedin_handle ?? business?.linkedin ?? null,
    reviewsCount:
      typeof business?.reviews_count === "number" ? business.reviews_count : null,
    reviewsRating:
      typeof business?.reviews_rating === "number" ? business.reviews_rating : null,
    websiteIsWeak:
      typeof business?.website_is_weak === "boolean" ? business.website_is_weak : null,
    hasBlog: Boolean(blogObj?.has_blog),
  });
}

/**
 * GET /v1/intelligence/activity/:leadId
 *
 * Computes the Business Activity report ("Most Active On" recommended channel +
 * Instagram last-post & story activity status) from verified lead/business data
 * and any recent live IG check cached for this lead.
 */
intelligenceRouter.get("/activity/:leadId", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ error: "Invalid leadId" });
    }

    const loaded = await loadLeadAndBusinessForActivity(userId, leadId);
    if (!loaded) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const cacheKey = `${userId}:${leadId}`;
    const cached = liveIgCache.get(cacheKey);
    const liveIg = cached && cached.expiresAt > Date.now() ? cached.result : null;

    const activity = buildActivityFromRecords(loaded.lead, loaded.business, liveIg);
    return res.json({ activity });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/intelligence/activity/:leadId/check-ig
 *
 * Runs a live public Instagram check for the lead's IG handle to verify
 * when they last posted, follower/post counts, and active story metadata
 * (when exposed by Instagram). Persists fresh last-post & follower info back
 * to the lead so future views and AI Writer use it automatically.
 */
intelligenceRouter.post("/activity/:leadId/check-ig", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { workspaceOwnerId: userId } = await resolveUserPlanAndProfession(req.user!.id);
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ error: "Invalid leadId" });
    }

    const loaded = await loadLeadAndBusinessForActivity(userId, leadId);
    if (!loaded) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const igHandle = (loaded.lead.instagram_handle || loaded.business?.instagram || "").trim();
    if (!igHandle) {
      const activity = buildActivityFromRecords(loaded.lead, loaded.business, null);
      return res.json({ activity });
    }

    const liveIg = await fetchLiveInstagramActivity(igHandle);
    const cacheKey = `${userId}:${leadId}`;
    liveIgCache.set(cacheKey, {
      expiresAt: Date.now() + LIVE_IG_CACHE_TTL_MS,
      result: liveIg,
    });

    // Persist verified live fields back to the lead so AI outreach & future loads benefit
    if (liveIg.ok) {
      const leadPatch: { ig_last_post?: string; ig_followers?: string; ig_bio?: string } = {};
      if (liveIg.lastPostDaysAgo !== null) {
        leadPatch.ig_last_post = formatDaysAgoLabel(liveIg.lastPostDaysAgo) ?? `${liveIg.lastPostDaysAgo}d ago`;
      }
      if (liveIg.followersCount !== null) {
        leadPatch.ig_followers = String(liveIg.followersCount);
      }
      if (liveIg.bio && !loaded.lead.ig_bio) {
        leadPatch.ig_bio = liveIg.bio;
      }
      if (Object.keys(leadPatch).length > 0) {
        try {
          await supabaseAdmin
            .from("leads")
            .update(leadPatch)
            .eq("id", leadId)
            .eq("user_id", userId);
        } catch (persistErr) {
          console.warn("[intelligence] live IG lead update skipped:", persistErr);
        }
      }
    }

    const activity = buildActivityFromRecords(loaded.lead, loaded.business, liveIg);
    return res.json({ activity });
  } catch (err) {
    next(err);
  }
});
