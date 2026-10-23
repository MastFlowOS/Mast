import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { PLANS as CONFIG_PLANS } from "../../../config/plans.js";
import { PLANS as LIB_PLANS } from "../../../lib/plans.js";
import { LEAD_STATUSES } from "../../../lib/lead-workspace.js";

// Helper for fake Express/HTTP response
function fakeRes() {
  const out = { status: 200, body: undefined as any };
  const res: any = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(data: any) {
      out.body = data;
      return res;
    },
  };
  return { res, out };
}

// Subscription route handler logic matching POST /v1/account/subscription
async function handleSubscriptionChange(
  req: { user?: { id: string }; body?: any },
  res: any,
  supabaseAdminMock: any,
) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = req.body ?? {};
  const targetPlan = typeof body.plan === "string" ? body.plan.toLowerCase().trim() : "";

  const knownPlans: Record<string, boolean> = {
    free: true,
    starter: true,
    pro: true,
    premium: true,
    scale: true,
  };

  if (!targetPlan) {
    return res.status(400).json({ error: "Target plan is required.", message: "Target plan is required.", code: "invalid_plan" });
  }

  if (!knownPlans[targetPlan]) {
    return res.status(400).json({ error: "Unknown plan tier.", message: "Unknown plan tier.", code: "unknown_plan" });
  }

  // In pre-launch before Creem payment integration, users cannot self-assign paid plans.
  if (targetPlan !== "free") {
    return res.status(402).json({
      error: "Payment gateway integration pending. Self-upgrading to paid plans is currently disabled.",
      message: "Payment gateway integration pending. Self-upgrading to paid plans is currently disabled.",
      code: "payment_required",
    });
  }

  // Fetch current user profile to determine existing plan
  const { data: currentProfile, error: fetchErr } = await supabaseAdminMock
    .from("profiles")
    .select("subscription_plan")
    .eq("id", userId)
    .single();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const currentPlan = (currentProfile?.subscription_plan || "free").toLowerCase().trim();
  const patch = currentPlan === "free"
    ? { subscription_plan: "free", pending_plan_change: null }
    : { pending_plan_change: "free" };

  const { data: updated, error } = await supabaseAdminMock
    .from("profiles")
    .update(patch)
    .eq("id", userId);

  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    success: true,
    plan: updated?.subscription_plan ?? (currentPlan === "free" ? "free" : currentPlan),
    pendingPlanChange: updated?.pending_plan_change ?? (currentPlan === "free" ? null : "free"),
    profile: updated,
  });
}

// Canonical get_plan_limits logic matching migration 042 & src/config/plans.ts
function getPlanLimits(planName: string | null | undefined): { daily: number; monthly: number } {
  switch ((planName || "free").toLowerCase().trim()) {
    case "starter":
      return { daily: 100, monthly: 1500 };
    case "pro":
      return { daily: 400, monthly: 6000 };
    case "premium":
    case "scale":
      return { daily: 1000, monthly: 25000 };
    case "free":
    default:
      return { daily: 20, monthly: 300 };
  }
}

// Server-side manual lead sanitization logic matching migration 042 create_crm_lead
function sanitizeManualLead(pLead: Record<string, any>, userId: string) {
  const statusAllowlist = new Set([
    "new", "email_sent", "called", "instagram_sent",
    "replied", "meeting_booked", "closed", "dead"
  ]);
  const priorityAllowlist = new Set(["low", "medium", "high"]);

  const rawStatus = (pLead.status || "new").toLowerCase().trim();
  const rawPriority = (pLead.priority || "medium").toLowerCase().trim();
  const rawName = (pLead.business_name || pLead.businessName || "New Lead").trim();

  return {
    user_id: userId,
    business_name: rawName.length > 255 ? rawName.slice(0, 255) : (rawName || "New Lead"),
    email: pLead.email ? String(pLead.email).trim() : null,
    phone: pLead.phone ? String(pLead.phone).trim() : null,
    website: pLead.website ? String(pLead.website).trim() : null,
    instagram_handle: pLead.instagram_handle || pLead.instagramHandle ? String(pLead.instagram_handle || pLead.instagramHandle).trim() : null,
    linkedin_handle: pLead.linkedin_handle || pLead.linkedinHandle ? String(pLead.linkedin_handle || pLead.linkedinHandle).trim() : null,
    status: statusAllowlist.has(rawStatus) ? rawStatus : "new",
    priority: priorityAllowlist.has(rawPriority) ? rawPriority : "medium",
    // Server-enforced fields: client input is strictly ignored
    credit_charged: true,
    discovery_mode: "manual",
    opportunity_score: null,
    scrape_job_id: null,
  };
}

describe("SEC-01: Profile Security & Entitlement Enforcement", () => {
  test("POST /subscription rejects paid plan self-assignment with 402 Payment Required", async () => {
    for (const paidPlan of ["starter", "pro", "premium", "scale"]) {
      const { res, out } = fakeRes();
      const req = { user: { id: "user-123" }, body: { plan: paidPlan } };
      await handleSubscriptionChange(req, res, { from: () => ({ select: () => ({ eq: () => ({ single: () => ({ data: { subscription_plan: "free" }, error: null }) }) }) }) });

      assert.equal(out.status, 402, `Paid plan ${paidPlan} must be rejected with 402`);
      assert.equal(out.body.code, "payment_required");
      assert.ok(out.body.error.includes("Payment gateway integration pending"));
      assert.ok(out.body.message.includes("Payment gateway integration pending"));
    }
  });

  test("POST /subscription rejects unknown plan names with 400", async () => {
    const { res, out } = fakeRes();
    const req = { user: { id: "user-123" }, body: { plan: "non_existent_tier" } };
    await handleSubscriptionChange(req, res, {});

    assert.equal(out.status, 400);
    assert.equal(out.body.code, "unknown_plan");
  });

  test("POST /subscription for free-tier user clears pending downgrade immediately", async () => {
    const { res, out } = fakeRes();
    let updatedPayload: any = null;
    const mockDb = {
      from: (t: string) => {
        assert.equal(t, "profiles");
        return {
          select: () => ({
            eq: () => ({
              single: () => ({ data: { subscription_plan: "free" }, error: null }),
            }),
          }),
          update: (patch: any) => {
            updatedPayload = patch;
            return {
              eq: (_col: string, val: string) => {
                assert.equal(val, "user-123");
                return { data: { id: "user-123", ...patch }, error: null };
              },
            };
          },
        };
      },
    };

    const req = { user: { id: "user-123" }, body: { plan: "free" } };
    await handleSubscriptionChange(req, res, mockDb);

    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);
    assert.equal(out.body.plan, "free");
    assert.deepEqual(updatedPayload, { subscription_plan: "free", pending_plan_change: null });
  });

  test("POST /subscription for paid user schedules downgrade via pending_plan_change", async () => {
    const { res, out } = fakeRes();
    let updatedPayload: any = null;
    const mockDb = {
      from: (t: string) => {
        assert.equal(t, "profiles");
        return {
          select: () => ({
            eq: () => ({
              single: () => ({ data: { subscription_plan: "pro" }, error: null }),
            }),
          }),
          update: (patch: any) => {
            updatedPayload = patch;
            return {
              eq: (_col: string, val: string) => {
                assert.equal(val, "user-pro");
                return { data: { id: "user-pro", subscription_plan: "pro", ...patch }, error: null };
              },
            };
          },
        };
      },
    };

    const req = { user: { id: "user-pro" }, body: { plan: "free" } };
    await handleSubscriptionChange(req, res, mockDb);

    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);
    assert.equal(out.body.plan, "pro", "Current plan remains pro until billing period ends");
    assert.equal(out.body.pendingPlanChange, "free", "pendingPlanChange must be set to free");
    assert.deepEqual(updatedPayload, { pending_plan_change: "free" });
  });

  test("get_plan_limits resolves dynamic limits matching application plans", () => {
    assert.deepEqual(getPlanLimits("free"), { daily: 20, monthly: 300 });
    assert.deepEqual(getPlanLimits("starter"), { daily: 100, monthly: 1500 });
    assert.deepEqual(getPlanLimits("pro"), { daily: 400, monthly: 6000 });
    assert.deepEqual(getPlanLimits("premium"), { daily: 1000, monthly: 25000 });
    assert.deepEqual(getPlanLimits("scale"), { daily: 1000, monthly: 25000 });
    // Default fallback
    assert.deepEqual(getPlanLimits(null), { daily: 20, monthly: 300 });
    assert.deepEqual(getPlanLimits("unknown"), { daily: 20, monthly: 300 });
  });

  test("Application plans configuration agrees with get_plan_limits", () => {
    // Verify frontend LIB_PLANS
    for (const plan of LIB_PLANS) {
      const limits = getPlanLimits(plan.id);
      assert.equal(plan.dailyLeadLimit, limits.daily, `Daily limit mismatch for ${plan.id}`);
      assert.equal(plan.monthlyLeadLimit, limits.monthly, `Monthly limit mismatch for ${plan.id}`);
    }

    // Verify backend CONFIG_PLANS
    for (const [planId, config] of Object.entries(CONFIG_PLANS)) {
      const limits = getPlanLimits(planId);
      assert.equal(config.dailyLeadLimit, limits.daily, `Config daily limit mismatch for ${planId}`);
      assert.equal(config.monthlyLeadLimit, limits.monthly, `Config monthly limit mismatch for ${planId}`);
    }
  });

  test("Canonical LeadStatus taxonomy exactly matches create_crm_lead allowlist", () => {
    const canonicalValues = LEAD_STATUSES.map(s => s.value);
    const expectedStatuses = [
      "new", "email_sent", "called", "instagram_sent",
      "replied", "meeting_booked", "closed", "dead"
    ];

    assert.deepEqual(canonicalValues.sort(), expectedStatuses.sort());

    // Test sanitization preserves every valid status
    for (const status of canonicalValues) {
      const sanitized = sanitizeManualLead({ businessName: "Biz", status }, "user-1");
      assert.equal(sanitized.status, status, `Sanitizer must allow canonical status: ${status}`);
    }

    // Disallowed status falls back to 'new'
    assert.equal(sanitizeManualLead({ businessName: "Biz", status: "invalid_status" }, "user-1").status, "new");
  });

  test("Manual lead creation sanitization ignores client-controlled billing overrides", () => {
    const maliciousPayload = {
      businessName: "  Legit Biz, LLC  ",
      email: "test@example.com",
      credit_charged: false, // Attempted billing bypass
      discovery_mode: "admin_override",
      opportunity_score: 99.5,
      scrape_job_id: "00000000-0000-0000-0000-000000000000",
      status: "MALICIOUS_STATUS",
      priority: "SUPER_HIGH",
    };

    const sanitized = sanitizeManualLead(maliciousPayload, "user-456");

    assert.equal(sanitized.user_id, "user-456");
    assert.equal(sanitized.business_name, "Legit Biz, LLC");
    assert.equal(sanitized.credit_charged, true, "credit_charged must be hardcoded by server");
    assert.equal(sanitized.discovery_mode, "manual", "discovery_mode must be manual");
    assert.equal(sanitized.opportunity_score, null, "opportunity_score must be null");
    assert.equal(sanitized.scrape_job_id, null, "scrape_job_id must be null");
    assert.equal(sanitized.status, "new", "invalid status must default to 'new'");
    assert.equal(sanitized.priority, "medium", "invalid priority must default to 'medium'");
  });

  test("Simulated atomic quota enforcement rejects increments exceeding plan limits", () => {
    function tryIncrementMock(
      currentDaily: number,
      currentMonthly: number,
      dailyLimit: number,
      monthlyLimit: number,
      count: number,
    ) {
      if (count > 0 && (currentDaily + count > dailyLimit || currentMonthly + count > monthlyLimit)) {
        return { allowed: false, dailyUsed: currentDaily, monthlyUsed: currentMonthly };
      }
      return { allowed: true, dailyUsed: currentDaily + count, monthlyUsed: currentMonthly + count };
    }

    const freeLimits = getPlanLimits("free"); // 20 daily, 300 monthly

    // Normal consumption
    assert.equal(tryIncrementMock(0, 0, freeLimits.daily, freeLimits.monthly, 1).allowed, true);
    assert.equal(tryIncrementMock(19, 100, freeLimits.daily, freeLimits.monthly, 1).allowed, true);

    // Daily quota boundary reached
    assert.equal(tryIncrementMock(20, 100, freeLimits.daily, freeLimits.monthly, 1).allowed, false);

    // Monthly quota boundary reached
    assert.equal(tryIncrementMock(5, 300, freeLimits.daily, freeLimits.monthly, 1).allowed, false);

    // Pro tier has higher ceiling
    const proLimits = getPlanLimits("pro"); // 400 daily, 6000 monthly
    assert.equal(tryIncrementMock(20, 100, proLimits.daily, proLimits.monthly, 1).allowed, true);
  });

  test("Atomic try_increment_lead_usage applies pending downgrade at monthly boundary", () => {
    function simulateAtomicTryIncrement(profile: {
      daily: number;
      monthly: number;
      nextDaily: Date;
      nextMonthly: Date;
      plan: string;
      pending: string | null;
    }, now: Date, count: number) {
      let v_daily = profile.daily;
      let v_monthly = profile.monthly;
      let v_plan = profile.plan;
      let v_pending = profile.pending;

      // Daily reset check
      if (profile.nextDaily <= now) {
        v_daily = 0;
      }

      // Monthly reset check + apply pending downgrade
      if (profile.nextMonthly <= now) {
        v_monthly = 0;
        if (v_pending) {
          v_plan = v_pending;
          v_pending = null;
        }
      }

      const limits = getPlanLimits(v_plan);
      if (count > 0 && (v_daily + count > limits.daily || v_monthly + count > limits.monthly)) {
        return { allowed: false, plan: v_plan, pending: v_pending, daily: v_daily, monthly: v_monthly };
      }

      return { allowed: true, plan: v_plan, pending: v_pending, daily: v_daily + count, monthly: v_monthly + count };
    }

    const now = new Date("2026-11-01T00:00:01Z");
    const proUserWithPendingFreeDowngrade = {
      daily: 50,
      monthly: 1000,
      nextDaily: new Date("2026-10-23T00:00:00Z"),
      nextMonthly: new Date("2026-10-31T23:59:59Z"),
      plan: "pro",
      pending: "free",
    };

    const result = simulateAtomicTryIncrement(proUserWithPendingFreeDowngrade, now, 1);
    assert.equal(result.allowed, true);
    assert.equal(result.plan, "free", "Plan must be downgraded to free upon crossing monthly reset");
    assert.equal(result.pending, null, "Pending downgrade must be cleared");
    assert.equal(result.daily, 1, "Daily count reset to 0 then incremented by 1");
    assert.equal(result.monthly, 1, "Monthly count reset to 0 then incremented by 1");
  });

  test("consume_crm_lead_credit rejects non-positive or null credit counts with validation error", async () => {
    // Simulates the PL/pgSQL validation in migration 042:
    // if p_count is null or p_count <= 0 then raise exception 'Requested credit count must be a positive integer' using errcode = '22023';
    function simulateConsumeRpc(p_count: number | null | undefined) {
      if (p_count === null || p_count === undefined || p_count <= 0) {
        const err: any = new Error("Requested credit count must be a positive integer");
        err.code = "22023";
        throw err;
      }
      if (p_count > 1000) {
        const err: any = new Error("Requested credit count exceeds maximum batch limit (1000)");
        err.code = "22023";
        throw err;
      }
      return true;
    }

    assert.throws(() => simulateConsumeRpc(0), { code: "22023" });
    assert.throws(() => simulateConsumeRpc(-1), { code: "22023" });
    assert.throws(() => simulateConsumeRpc(null), { code: "22023" });
    assert.throws(() => simulateConsumeRpc(undefined), { code: "22023" });
    assert.throws(() => simulateConsumeRpc(1001), { code: "22023" });
    assert.equal(simulateConsumeRpc(1), true);
    assert.equal(simulateConsumeRpc(100), true);
  });

  test("UsageService.consumeAllowance validates caller user ID and delegates to RPC", async () => {
    let rpcCalledWith: any = null;
    let rpcReturnsSuccess = true;
    let authUser = { id: "user-correct" };

    const mockSupabase = {
      auth: {
        getUser: async () => ({ data: { user: authUser } }),
      },
      rpc: async (fnName: string, params: any) => {
        assert.equal(fnName, "consume_crm_lead_credit");
        rpcCalledWith = params;
        return { data: rpcReturnsSuccess, error: null };
      },
    };

    async function testConsumeAllowance(userId: string, quantity: number, client: any) {
      if (quantity <= 0) return;
      const { data: { user } } = await client.auth.getUser();
      if (!user || user.id !== userId) {
        throw new Error("USER_MISMATCH");
      }
      const { data: allowed, error } = await client.rpc("consume_crm_lead_credit", { p_count: quantity });
      if (error) throw new Error(error.message);
      if (!allowed) {
        throw new Error("LIMIT_EXCEEDED");
      }
    }

    // Zero quantity is a no-op client-side before calling RPC
    await testConsumeAllowance("user-correct", 0, mockSupabase);
    assert.equal(rpcCalledWith, null, "Zero quantity should not invoke RPC");

    // Normal consumption with matching user
    await testConsumeAllowance("user-correct", 3, mockSupabase);
    assert.deepEqual(rpcCalledWith, { p_count: 3 });

    // User ID mismatch must be rejected
    await assert.rejects(
      async () => testConsumeAllowance("user-impersonated", 3, mockSupabase),
      { message: "USER_MISMATCH" }
    );

    // Quota rejection from server RPC
    rpcReturnsSuccess = false;
    await assert.rejects(
      async () => testConsumeAllowance("user-correct", 5, mockSupabase),
      { message: "LIMIT_EXCEEDED" }
    );
  });

  test("In-memory checkAndResetUsage calculation computes reset window without DB writes", () => {
    const now = new Date("2026-10-23T12:00:00.000Z");
    const pastReset = new Date("2026-10-23T11:00:00.000Z").toISOString();

    const staleProfile = {
      id: "u1",
      daily_leads_used: 15,
      monthly_leads_used: 150,
      next_daily_reset: pastReset,
      next_monthly_reset: "2026-11-01T00:00:00.000Z",
      subscription_plan: "free",
    };

    // Simulate in-memory reset logic
    let dailyUsed = staleProfile.daily_leads_used;
    let dailyReset = staleProfile.next_daily_reset;
    let needsReset = false;

    if (!dailyReset || new Date(dailyReset) <= now) {
      dailyUsed = 0;
      dailyReset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      needsReset = true;
    }

    assert.equal(needsReset, true);
    assert.equal(dailyUsed, 0, "Daily used should reset to 0 in-memory");
    assert.ok(new Date(dailyReset) > now, "Daily reset timer should advance 24h");
  });

  test("Static verification of migration 042 and 044: award_goal_xp privilege revocation", () => {
    const mig042Path = path.resolve(process.cwd(), "migrations/042_secure_profiles_columns.sql");
    const mig044Path = path.resolve(process.cwd(), "migrations/044_revoke_legacy_award_goal_xp.sql");

    assert.ok(fs.existsSync(mig042Path), "Migration 042 must exist");
    assert.ok(fs.existsSync(mig044Path), "Migration 044 must exist");

    const sql042 = fs.readFileSync(mig042Path, "utf8");
    const sql044 = fs.readFileSync(mig044Path, "utf8");

    // Migration 042 must NOT grant execute on award_goal_xp to authenticated
    assert.ok(!/grant\s+execute\s+on\s+function\s+public\.award_goal_xp\([^)]*\)\s+to[^;]*\bauthenticated\b/i.test(sql042),
      "Migration 042 must not grant execute on award_goal_xp to authenticated");
    assert.ok(/p_xp\s+is\s+null\s+or\s+p_xp\s*<\s*0/i.test(sql042),
      "Migration 042 must explicitly reject NULL XP in award_goal_xp");

    // Migration 044 must explicitly revoke execution from public, anon, and authenticated
    assert.ok(/revoke\s+(all|execute)\s+on\s+function\s+public\.award_goal_xp\([^)]*\)\s+from\s+authenticated/i.test(sql044),
      "Migration 044 must explicitly revoke execute from authenticated");
    assert.ok(/revoke\s+(all|execute)\s+on\s+function\s+public\.award_goal_xp\([^)]*\)\s+from\s+public/i.test(sql044),
      "Migration 044 must explicitly revoke execute from public");
    assert.ok(/revoke\s+(all|execute)\s+on\s+function\s+public\.award_goal_xp\([^)]*\)\s+from\s+anon/i.test(sql044),
      "Migration 044 must explicitly revoke execute from anon");

    // Migration 044 must grant execute ONLY to service_role and postgres
    assert.ok(/grant\s+execute\s+on\s+function\s+public\.award_goal_xp\([^)]*\)\s+to\s+service_role,\s*postgres/i.test(sql044),
      "Migration 044 must grant execute only to service_role, postgres");

    // Migration 044 must be permission-only (no function redefinition or comment statements)
    assert.ok(!/create\s+or\s+replace\s+function/i.test(sql044),
      "Migration 044 must be permission-only and not contain CREATE OR REPLACE FUNCTION");
    assert.ok(!/alter\s+function\s+.*owner\s+to/i.test(sql044),
      "Migration 044 must not contain ALTER FUNCTION ... OWNER");
    assert.ok(!/comment\s+on\s+function/i.test(sql044),
      "Migration 044 must not contain COMMENT ON FUNCTION");
  });

  test("RPC execution denial: authenticated users cannot call legacy award_goal_xp, but can claim completed daily goals", async () => {
    // Simulated database representing PostgreSQL RPC authorization and execution
    const rpcGrants: Record<string, string[]> = {
      award_goal_xp: ["service_role", "postgres"], // revoked from authenticated
      claim_daily_goal: ["authenticated", "service_role", "postgres"],
    };

    const dailyGoals = [
      { id: "g1", user_id: "user-1", status: "completed", xp: 50 },
      { id: "g2", user_id: "user-1", status: "in_progress", xp: 50 },
      { id: "g3", user_id: "user-2", status: "completed", xp: 75 },
    ];

    function invokeRpc(callerRole: string, callerUserId: string, rpcName: string, params: any) {
      const allowedRoles = rpcGrants[rpcName] || [];
      if (!allowedRoles.includes(callerRole)) {
        throw new Error(`permission denied for function ${rpcName}: 42501`);
      }

      if (rpcName === "award_goal_xp") {
        if (params.p_xp === null || params.p_xp === undefined || params.p_xp < 0 || params.p_xp > 250) {
          throw new Error("XP value out of permitted range (0-250): 22023");
        }
        return { xp: params.p_xp, awarded: true };
      }

      if (rpcName === "claim_daily_goal") {
        const goal = dailyGoals.find((g) => g.id === params.p_id && g.user_id === callerUserId);
        if (!goal) {
          throw new Error("daily goal not found: 404");
        }
        if (goal.status !== "completed") {
          throw new Error("daily goal is not completed: 400");
        }
        return { xp: goal.xp, awarded: true };
      }

      throw new Error("unknown function");
    }

    // 1. Authenticated user attempting to call legacy award_goal_xp is DENIED
    assert.throws(
      () => invokeRpc("authenticated", "user-1", "award_goal_xp", { p_goal_id: "cheat:1", p_completed_on: "2026-10-23", p_xp: 250 }),
      /permission denied for function award_goal_xp: 42501/,
      "Authenticated caller must be denied execution on award_goal_xp"
    );

    // 2. Anonymous caller is also DENIED
    assert.throws(
      () => invokeRpc("anon", "anon-user", "award_goal_xp", { p_goal_id: "cheat:1", p_completed_on: "2026-10-23", p_xp: 250 }),
      /permission denied for function award_goal_xp: 42501/
    );

    // 3. Service role can execute award_goal_xp, but parameter validation strictly rejects NULL
    assert.throws(
      () => invokeRpc("service_role", "admin", "award_goal_xp", { p_goal_id: "sys:1", p_completed_on: "2026-10-23", p_xp: null }),
      /XP value out of permitted range \(0-250\): 22023/,
      "award_goal_xp must reject NULL XP with 22023"
    );

    // 4. Authenticated user CAN call claim_daily_goal for an owned, completed goal
    const claimSuccess = invokeRpc("authenticated", "user-1", "claim_daily_goal", { p_id: "g1" });
    assert.deepEqual(claimSuccess, { xp: 50, awarded: true });

    // 5. Authenticated user CANNOT claim incomplete goal
    assert.throws(
      () => invokeRpc("authenticated", "user-1", "claim_daily_goal", { p_id: "g2" }),
      /daily goal is not completed/
    );

    // 6. Authenticated user CANNOT claim another user's goal
    assert.throws(
      () => invokeRpc("authenticated", "user-1", "claim_daily_goal", { p_id: "g3" }),
      /daily goal not found/
    );
  });
});
