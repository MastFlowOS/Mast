import { createHash } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, type PlanId } from "../../config/plans.js";
import { canUseAiFeature } from "../../lib/aiAccess.js";
import { aiEnabled, generateJSON, AI_MODEL, getAiModel } from "../../lib/ai.js";
import { singleFlight } from "../../lib/singleFlight.js";
import { buildPipelineSnapshot } from "../../lib/intelligenceContext.js";
import { runEngineScore } from "../../scraperBridge/pythonBridge.js";
import { type ProfessionSlug } from "../../scoring/professionWeights.js";
import { professionSlugForLabel } from "../../lib/professions.js";

export const intelligenceRouter = Router();

// explain/trust are local reads (already-computed scores, or a straight
// Supabase select) with no external calls — generous limit.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

// opportunities/briefing/weekly/coaching call out to an external AI
// provider on a cache miss — daily/weekly caching keeps steady-state cost
// low, but the limiter still bounds how fast a client can force
// cache-miss generations. 5/min matches the cost profile of discovery.
const aiGenerationLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

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

async function resolveUserPlanAndProfession(userId: string): Promise<{ plan: PlanId; professionSlug: ProfessionSlug | null }> {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("subscription_plan, settings")
    .eq("id", userId)
    .single();
  if (error) throw error;

  const plan = getPlan(profile?.subscription_plan).id;
  const focusAreaLabel = (profile?.settings as Record<string, unknown> | null)?.focusArea as string | undefined;
  const professionSlug = professionSlugForLabel(focusAreaLabel);

  return { plan, professionSlug };
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
    const userId = req.user!.id;
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

    const professionSlug = (lead.profession_slug as ProfessionSlug | null) ?? (await resolveUserPlanAndProfession(userId)).professionSlug;
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
    const userId = req.user!.id;
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
intelligenceRouter.get("/opportunities/:businessId", requireAuth, aiGenerationLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan, professionSlug } = await resolveUserPlanAndProfession(userId);

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
      return res.json({ ...cached, explanation, cached: true });
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
        maxTokens: 512,
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
intelligenceRouter.get("/briefing", requireAuth, aiGenerationLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

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
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
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
        maxTokens: 512,
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
      if (upsertError) throw upsertError;

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
intelligenceRouter.get("/weekly", requireAuth, aiGenerationLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

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
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
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
        maxTokens: 640,
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
      if (upsertError) throw upsertError;

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
intelligenceRouter.get("/coaching", requireAuth, aiGenerationLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

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
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
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
        maxTokens: 640,
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
      if (upsertError) throw upsertError;

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
intelligenceRouter.get("/discover-overview", requireAuth, aiGenerationLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

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
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

    const { overview, generatedAt } = await singleFlight(`discover_overview:${userId}:${periodKey}`, async () => {

      const nextOverview = await generateJSON<{
        label: string;
        headline: string;
        body: string;
        confidence: "High Confidence" | "Recommended" | "Worth Testing" | "Watch Closely";
        tone: "brand" | "warning" | "success" | "neutral";
        patterns: string[];
        promisingOpportunities: string[];
        nextSteps: string[];
        action?: { label: string; href: string };
      }>({
        system:
          "You are MAST's Opportunity Intelligence assistant, generating an executive overview of a freelancer's " +
          "discovered leads and opportunities. You are provided with real, already-aggregated lead statistics and top " +
          "opportunity scores. Do NOT invent businesses, market trends, conversion rates, or facts not present in the input. " +
          "Never use em dashes ('—' or '–'). Avoid generic buzzwords ('elevate', 'streamline', 'synergy'). " +
          "Respond with ONLY a JSON object: " +
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
        maxTokens: 512,
        tier: "pro",
      });

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
      if (upsertError) throw upsertError;

      return { overview: nextOverview, generatedAt: nextGeneratedAt };
    });

    res.json({ ...overview, generatedAt, cached: false });
  } catch (err) {
    next(err);
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
intelligenceRouter.get("/mission-coach", requireAuth, aiGenerationLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

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
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

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
          "Respond with ONLY a JSON object: " +
          '{"briefing": string (1-2 sentences summarizing today\'s executive mission priority based on overdue/due counts), ' +
          '"recommendedLeadId": number | null (the id of the lead to act on first, from the provided items, or null if none), ' +
          '"recommendedAction": string (1 concrete next step for the recommended lead, <=15 words), ' +
          '"rationale": string (1-2 sentences explaining why this action makes sense right now), ' +
          '"reasons": string[] (1-3 short bullet reasons grounded in stage, timing, or score)}.',
        user: JSON.stringify(boundedPayload),
        maxTokens: 512,
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
      if (upsertError) throw upsertError;

      return { coaching: nextCoaching, generatedAt: nextGeneratedAt };
    });

    res.json({ ...coaching, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});
