import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, PLANS, type PlanId } from "../../config/plans.js";
import { resolveWorkspaceContext } from "../../lib/workspaceContext.js";

function isPlanId(val: string): val is PlanId {
  return Object.prototype.hasOwnProperty.call(PLANS, val);
}

export const accountRouter = Router();

// Plain profile/usage read — generous limit, this is dashboard polling.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

accountRouter.get("/", requireAuth, readLimiter, async (req, res, next) => {
  try {
    const actorUserId = req.user!.id;
    const workspaceCtx = await resolveWorkspaceContext(actorUserId);
    const billingUserId = workspaceCtx.workspaceOwnerId;

    const [{ data: actorProfile, error: actorErr }, ownerQuery] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("full_name, email, subscription_plan, subscription_status, daily_leads_used, monthly_leads_used, pending_plan_change, bonus_credits, daily_limit_bonus")
        .eq("id", actorUserId)
        .single(),
      billingUserId !== actorUserId
        ? supabaseAdmin
            .from("profiles")
            .select("full_name, email, subscription_plan, subscription_status, daily_leads_used, monthly_leads_used, pending_plan_change, bonus_credits, daily_limit_bonus")
            .eq("id", billingUserId)
            .single()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (actorErr) throw actorErr;
    if (ownerQuery.error) throw ownerQuery.error;

    const profile = ownerQuery.data ?? actorProfile;
    const plan = getPlan(profile?.subscription_plan);
    const bonusCredits = Math.max(0, Number(profile?.bonus_credits ?? 0));
    const dailyLimitBonus = Math.max(0, Number(profile?.daily_limit_bonus ?? 0));
    const effectiveDailyLimit = plan.dailyLeadLimit + dailyLimitBonus;
    const effectiveMonthlyLimit = plan.monthlyLeadLimit + bonusCredits;
    const dailyUsed = profile?.daily_leads_used ?? 0;
    const monthlyUsed = profile?.monthly_leads_used ?? 0;

    res.json({
      user: {
        id: actorUserId,
        fullName: actorProfile?.full_name ?? "",
        email: actorProfile?.email ?? req.user!.email ?? "",
        plan: plan.id,
        subscriptionStatus: profile?.subscription_status ?? "active",
      },
      workspace: {
        ownerId: billingUserId,
        role: workspaceCtx.role,
        isTeamMember: workspaceCtx.isTeamMember,
      },
      subscription: {
        plan: plan.id,
        status: profile?.subscription_status ?? "active",
        pendingPlanChange: profile?.pending_plan_change ?? null,
      },
      credits: {
        limit: plan.creditsLimit + bonusCredits,
        used: monthlyUsed,
        remaining: Math.max(0, plan.creditsLimit - monthlyUsed) + bonusCredits,
        bonusCredits,
      },
      dailyUsage: {
        used: dailyUsed,
        limit: effectiveDailyLimit,
        remaining: Math.max(0, effectiveDailyLimit - dailyUsed),
        bonus: dailyLimitBonus,
      },
      monthlyUsage: {
        used: monthlyUsed,
        limit: effectiveMonthlyLimit,
        remaining: Math.max(0, plan.monthlyLeadLimit - monthlyUsed) + bonusCredits,
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
    const workspaceCtx = await resolveWorkspaceContext(userId);
    if (workspaceCtx.isTeamMember) {
      return res.status(403).json({
        error: "Only the workspace owner can change the subscription plan.",
        message: "Only the workspace owner can change the subscription plan.",
        code: "workspace_owner_required",
      });
    }

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
