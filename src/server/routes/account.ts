import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, PLANS } from "../../config/plans.js";

export const accountRouter = Router();

accountRouter.get("/", requireAuth, async (req, res, next) => {
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
