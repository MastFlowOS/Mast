import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, PLANS, type PlanId } from "../../config/plans.js";

function isPlanId(val: string): val is PlanId {
  return Object.prototype.hasOwnProperty.call(PLANS, val);
}

export const accountRouter = Router();

// Plain profile/usage read — generous limit, this is dashboard polling.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

accountRouter.get("/", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("full_name, email, subscription_plan, subscription_status, daily_leads_used, monthly_leads_used, pending_plan_change")
      .eq("id", userId)
      .single();

    if (error) throw error;

    const plan = getPlan(profile?.subscription_plan);

    res.json({
      user: {
        id: userId,
        fullName: profile?.full_name ?? "",
        email: profile?.email ?? req.user!.email ?? "",
        plan: plan.id,
        subscriptionStatus: profile?.subscription_status ?? "active",
      },
      subscription: {
        plan: plan.id,
        status: profile?.subscription_status ?? "active",
        pendingPlanChange: profile?.pending_plan_change ?? null,
      },
      credits: {
        limit: plan.creditsLimit,
        used: profile?.monthly_leads_used ?? 0,
        remaining: Math.max(0, plan.creditsLimit - (profile?.monthly_leads_used ?? 0)),
      },
      dailyUsage: {
        used: profile?.daily_leads_used ?? 0,
        limit: plan.dailyLeadLimit,
        remaining: Math.max(0, plan.dailyLeadLimit - (profile?.daily_leads_used ?? 0)),
      },
      monthlyUsage: {
        used: profile?.monthly_leads_used ?? 0,
        limit: plan.monthlyLeadLimit,
        remaining: Math.max(0, plan.monthlyLeadLimit - (profile?.monthly_leads_used ?? 0)),
      },
      limits: {
        maxLeadRequest: plan.maxLeadRequest,
        discoveryMode: plan.discoveryMode,
      },
      plans: Object.values(PLANS),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/account/subscription
 *
 * Server-authoritative subscription management endpoint.
 * In pre-launch without Creem payment gateway integration, users cannot
 * self-assign paid plans (starter, pro, premium, scale) without verified payment proof.
 */
accountRouter.post("/subscription", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    const targetPlan = typeof body.plan === "string" ? body.plan.toLowerCase().trim() : "";

    if (!targetPlan) {
      return res.status(400).json({
        error: "Target plan is required.",
        message: "Target plan is required.",
        code: "invalid_plan",
      });
    }

    if (!isPlanId(targetPlan) || !PLANS[targetPlan]) {
      return res.status(400).json({
        error: "Unknown plan tier.",
        message: "Unknown plan tier.",
        code: "unknown_plan",
      });
    }

    // In pre-launch before Creem payment integration, users cannot self-assign paid plans.
    if (targetPlan !== "free") {
      return res.status(402).json({
        error: "Payment gateway integration pending. Self-upgrading to paid plans is currently disabled.",
        message: "Payment gateway integration pending. Self-upgrading to paid plans is currently disabled.",
        code: "payment_required",
      });
    }

    // Downgrading to free is permitted.
    // Preserve product downgrade schedule:
    // If user is currently on a paid plan, retain their paid access until the billing boundary
    // by scheduling the downgrade via pending_plan_change.
    // If user is already on free, ensure pending_plan_change is cleared.
    const { data: currentProfile, error: fetchErr } = await supabaseAdmin
      .from("profiles")
      .select("subscription_plan")
      .eq("id", userId)
      .single();

    if (fetchErr) throw fetchErr;

    const currentPlan = (currentProfile?.subscription_plan || "free").toLowerCase().trim();
    const patch = currentPlan === "free"
      ? { subscription_plan: "free", pending_plan_change: null }
      : { pending_plan_change: "free" };

    const { data: updated, error } = await supabaseAdmin
      .from("profiles")
      .update(patch)
      .eq("id", userId)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      success: true,
      plan: updated?.subscription_plan ?? "free",
      pendingPlanChange: updated?.pending_plan_change ?? null,
      profile: updated,
    });
  } catch (err) {
    next(err);
  }
});

