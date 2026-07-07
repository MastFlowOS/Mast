import { supabase } from "./supabase";
import { buildPermissionsManager } from "./permissions";
import type { PlanId } from "./plans";

/**
 * Local re-declaration of ApiError to avoid a circular import with api.ts.
 * Structurally identical to the class in api.ts.
 */
class ApiError extends Error {
  status: number;
  code?: string;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * UsageService
 * 
 * Centralized service to manage checking and consuming daily/monthly opportunity allowances.
 * Consumed by both the frontend UI and simulated backend operations.
 */
export class UsageService {
  /**
   * Fetches active usage counters and plan limits for the authenticated user.
   */
  static async getUsageStatus(userId: string) {
    const { data: profile, error } = await supabase!
      .from("profiles")
      .select("subscription_plan, daily_leads_used, monthly_leads_used")
      .eq("id", userId)
      .single();

    if (error) {
      throw new ApiError(500, error.message, error);
    }

    const plan = (profile?.subscription_plan || "free") as PlanId;
    const permissions = buildPermissionsManager(plan);

    const dailyLimit = permissions.limits.dailyOpportunities;
    const monthlyLimit = permissions.limits.monthlyOpportunities;

    const dailyUsed = profile?.daily_leads_used ?? 0;
    const monthlyUsed = profile?.monthly_leads_used ?? 0;

    return {
      dailyLimit,
      monthlyLimit,
      dailyUsed,
      monthlyUsed,
      dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
      monthlyRemaining: Math.max(0, monthlyLimit - monthlyUsed),
      permissions,
    };
  }

  /**
   * Checks if the requested quantity exceeds the remaining daily or monthly limits.
   * Throws an ApiError if limits are exceeded.
   */
  static async checkAllowance(userId: string, quantity: number): Promise<void> {
    const status = await this.getUsageStatus(userId);

    if (quantity > status.dailyRemaining && quantity > status.monthlyRemaining) {
      throw new ApiError(400, "LIMIT_EXCEEDED_BOTH", {
        reason: "both",
        dailyLimit: status.dailyLimit,
        dailyRemaining: status.dailyRemaining,
        monthlyLimit: status.monthlyLimit,
        monthlyRemaining: status.monthlyRemaining,
      });
    }

    if (quantity > status.dailyRemaining) {
      throw new ApiError(400, "LIMIT_EXCEEDED_DAILY", {
        reason: "daily",
        dailyLimit: status.dailyLimit,
        dailyRemaining: status.dailyRemaining,
      });
    }

    if (quantity > status.monthlyRemaining) {
      throw new ApiError(400, "LIMIT_EXCEEDED_MONTHLY", {
        reason: "monthly",
        monthlyLimit: status.monthlyLimit,
        monthlyRemaining: status.monthlyRemaining,
      });
    }
  }

  /**
   * Validates allowance and updates profile usage counts.
   */
  static async consumeAllowance(userId: string, quantity: number): Promise<void> {
    // Check allowance first (will throw if exceeded)
    await this.checkAllowance(userId, quantity);
    const status = await this.getUsageStatus(userId);

    const { error } = await supabase!
      .from("profiles")
      .update({
        daily_leads_used: status.dailyUsed + quantity,
        monthly_leads_used: status.monthlyUsed + quantity,
      })
      .eq("id", userId);

    if (error) {
      throw new ApiError(500, error.message, error);
    }
  }
}
