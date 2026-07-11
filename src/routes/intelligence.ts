import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { getPlan, type PlanId } from "../config/plans.js";
import { canUseAiFeature } from "../lib/aiAccess.js";
import { aiEnabled, generateJSON, AI_MODEL } from "../lib/ai.js";
import { buildPipelineSnapshot } from "../lib/intelligenceContext.js";
import { computeOpportunityScores, type ScorableBusiness } from "../scoring/opportunityScore.js";
import { explainOpportunity } from "../scoring/explainOpportunity.js";
import { PROFESSION_SLUGS, type ProfessionSlug } from "../scoring/professionWeights.js";

export const intelligenceRouter = Router();

function slugifyProfession(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
  const slug = focusAreaLabel ? slugifyProfession(focusAreaLabel) : null;
  const professionSlug = (PROFESSION_SLUGS as readonly string[]).includes(slug ?? "") ? (slug as ProfessionSlug) : null;

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
 * GET /v1/intelligence/explain/:leadId
 *
 * Opportunity Explanations — available to every plan (not AI-gated at all;
 * it's a readout of the Opportunity Score's own components, computed the
 * same way Phase 6 already scores businesses, not a new model). Requires
 * the lead to belong to the requesting user.
 */
intelligenceRouter.get("/explain/:leadId", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const leadId = req.params.leadId;

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
      .select("website, instagram, facebook, has_photos, reviews_count, reviews_rating, is_disqualified, signals")
      .eq("id", lead.business_id)
      .single();
    if (bizError) throw bizError;

    const scores = computeOpportunityScores(business as ScorableBusiness);
    const result = scores[professionSlug];
    const explanation = explainOpportunity(business as ScorableBusiness, result, professionSlug);

    res.json(explanation);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/opportunities/:businessId
 *
 * AI Opportunity Insights (Premium): the deterministic explanation, plus a
 * short AI-written headline and a suggested opening line for outreach.
 * Cached per (business, profession) in business_opportunity_insights —
 * regenerated only if the underlying score has moved meaningfully or the
 * cache doesn't exist yet, so this never gets more expensive than the size
 * of the pool.
 */
intelligenceRouter.get("/opportunities/:businessId", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan, professionSlug } = await resolveUserPlanAndProfession(userId);

    if (!canUseAiFeature(plan, "opportunityInsights")) {
      return res.status(403).json({ code: "plan_restricted", message: "AI Opportunity Insights requires the Premium plan." });
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
      .select("name, niche, website, instagram, facebook, has_photos, reviews_count, reviews_rating, is_disqualified, signals")
      .eq("id", businessId)
      .single();
    if (bizError) throw bizError;

    const scores = computeOpportunityScores(business as ScorableBusiness);
    const result = scores[professionSlug];
    const explanation = explainOpportunity(business as ScorableBusiness, result, professionSlug);

    const { data: cached } = await supabaseAdmin
      .from("business_opportunity_insights")
      .select("headline, talking_points, opening_line, score_snapshot, generated_at")
      .eq("business_id", businessId)
      .eq("profession_slug", professionSlug)
      .maybeSingle();

    // Regenerate if there's no cache yet, or the score has drifted more
    // than 10 points since the cached copy was written (a re-verification
    // likely changed the picture materially — see Phase 7).
    const stale = !cached || Math.abs((cached.score_snapshot as number) - result.score) > 10;

    if (!stale && cached) {
      return res.json({ ...cached, explanation, cached: true });
    }

    const insight = await generateJSON<{ headline: string; talkingPoints: string[]; openingLine: string }>({
      system:
        "You are MAST's Opportunity Intelligence assistant, helping a freelancer understand why a business " +
        "was surfaced as a sales opportunity. You are given real, already-computed facts — do not invent " +
        "anything not present in the input. Respond with ONLY a JSON object: " +
        '{"headline": string (<=12 words, why this is a good opportunity), ' +
        '"talkingPoints": string[] (2-4 short, concrete, non-generic points a freelancer could raise), ' +
        '"openingLine": string (one natural first-contact message opener, no greeting/signature, <=2 sentences)}. ' +
        "Keep tone professional and specific, never salesy or exaggerated.",
      user: JSON.stringify({
        businessName: business.name,
        niche: business.niche,
        profession: professionSlug,
        opportunityScore: result.score,
        reasons: explanation.reasons,
        summary: explanation.summary,
      }),
      maxTokens: 512,
    });

    const row = {
      business_id: businessId,
      profession_slug: professionSlug,
      headline: insight.headline,
      talking_points: insight.talkingPoints,
      opening_line: insight.openingLine,
      score_snapshot: result.score,
      model: AI_MODEL,
      generated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabaseAdmin
      .from("business_opportunity_insights")
      .upsert(row, { onConflict: "business_id,profession_slug" });
    if (upsertError) throw upsertError;

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
intelligenceRouter.get("/briefing", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

    if (!canUseAiFeature(plan, "executiveBriefings")) {
      return res.status(403).json({ code: "plan_restricted", message: "AI Executive Briefings require the Premium plan." });
    }

    const periodKey = new Date().toISOString().slice(0, 10);

    const { data: cached } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "executive_briefing")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    const snapshot = await buildPipelineSnapshot(userId);

    const briefing = await generateJSON<{ summary: string; priorities: string[]; tone: "brand" | "warning" | "success" }>({
      system:
        "You are MAST's Opportunity Intelligence assistant, writing a short daily executive briefing for a " +
        "freelancer's sales pipeline. You are given real, already-computed pipeline stats — do not invent " +
        "numbers or businesses not present in the input. Respond with ONLY a JSON object: " +
        '{"summary": string (2-3 sentences, plain language, no greeting), ' +
        '"priorities": string[] (1-4 concrete next actions, most important first), ' +
        '"tone": "brand" | "warning" | "success" (warning if things are stalling/overdue, success if strong momentum, brand otherwise)}.',
      user: JSON.stringify(snapshot),
      maxTokens: 512,
    });

    const generatedAt = new Date().toISOString();
    const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
      {
        user_id: userId,
        kind: "executive_briefing",
        period_key: periodKey,
        content: briefing,
        model: AI_MODEL,
        generated_at: generatedAt,
      },
      { onConflict: "user_id,kind,period_key" },
    );
    if (upsertError) throw upsertError;

    res.json({ ...briefing, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/intelligence/weekly
 *
 * Weekly Intelligence (Premium): a reflective 7-day performance review.
 * Cached once per user per ISO week.
 */
intelligenceRouter.get("/weekly", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

    if (!canUseAiFeature(plan, "weeklyIntelligence")) {
      return res.status(403).json({ code: "plan_restricted", message: "Weekly Intelligence requires the Premium plan." });
    }

    const periodKey = isoWeekKey(new Date());

    const { data: cached } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "weekly_intelligence")
      .eq("period_key", periodKey)
      .maybeSingle();
    if (cached) return res.json({ ...(cached.content as object), generatedAt: cached.generated_at, cached: true });

    if (!aiEnabled()) {
      return res.status(503).json({ code: "ai_unavailable", message: "AI Opportunity Intelligence is not configured on this deployment." });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const snapshot = await buildPipelineSnapshot(userId, sevenDaysAgo);

    const weekly = await generateJSON<{ reflection: string; wins: string[]; focusForNextWeek: string[] }>({
      system:
        "You are MAST's Opportunity Intelligence assistant, writing a reflective weekly review of a " +
        "freelancer's last 7 days of sales activity. You are given real, already-computed stats for that " +
        "window — do not invent numbers or businesses not present in the input. Respond with ONLY a JSON " +
        'object: {"reflection": string (2-4 sentences, honest and specific, not generic praise), ' +
        '"wins": string[] (0-3 genuine positives, empty array if none), ' +
        '"focusForNextWeek": string[] (1-3 concrete goals for next week)}.',
      user: JSON.stringify(snapshot),
      maxTokens: 640,
    });

    const generatedAt = new Date().toISOString();
    const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
      {
        user_id: userId,
        kind: "weekly_intelligence",
        period_key: periodKey,
        content: weekly,
        model: AI_MODEL,
        generated_at: generatedAt,
      },
      { onConflict: "user_id,kind,period_key" },
    );
    if (upsertError) throw upsertError;

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
intelligenceRouter.get("/coaching", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { plan } = await resolveUserPlanAndProfession(userId);

    if (!canUseAiFeature(plan, "pipelineCoaching")) {
      return res.status(403).json({ code: "plan_restricted", message: "AI Pipeline Coaching requires the Pro plan." });
    }

    const periodKey = new Date().toISOString().slice(0, 10);

    const { data: cached } = await supabaseAdmin
      .from("ai_intelligence")
      .select("content, generated_at")
      .eq("user_id", userId)
      .eq("kind", "pipeline_coaching")
      .eq("period_key", periodKey)
      .maybeSingle();
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

    const coaching = await generateJSON<{ alerts: Array<{ businessName: string; message: string; suggestedAction: string }> }>({
      system:
        "You are MAST's Opportunity Intelligence assistant, coaching a freelancer on stalled deals in their " +
        "sales pipeline. You are given real, already-computed stalled-deal data — do not invent businesses " +
        'or facts not present in the input. Respond with ONLY a JSON object: {"alerts": [{"businessName": ' +
        'string, "message": string (why this deal is at risk, 1 sentence), "suggestedAction": string ' +
        "(1 concrete next step)}]} — one alert per stalled deal given, same order.",
      user: JSON.stringify({ stalledDeals: snapshot.stalledDeals }),
      maxTokens: 640,
    });

    const content = { alerts: coaching.alerts, allClear: false };
    const generatedAt = new Date().toISOString();
    const { error: upsertError } = await supabaseAdmin.from("ai_intelligence").upsert(
      { user_id: userId, kind: "pipeline_coaching", period_key: periodKey, content, model: AI_MODEL, generated_at: generatedAt },
      { onConflict: "user_id,kind,period_key" },
    );
    if (upsertError) throw upsertError;

    res.json({ ...content, generatedAt, cached: false });
  } catch (err) {
    next(err);
  }
});
