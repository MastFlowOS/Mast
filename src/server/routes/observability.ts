/**
 * Phase 7 — Observability API endpoint.
 *
 * GET /v1/observability/stats?range_hours=24
 *
 * Secured:
 *  1. Requires a valid Supabase bearer token (requireAuth).
 *  2. Requires `profiles.internal_role IN ('engineer', 'admin')`.
 *
 * Returns a JSON payload produced by the `get_lead_engine_stats` Postgres
 * Security Definer function, which has access to pg-boss internal tables
 * without exposing the pgboss schema to the API layer directly.
 */

import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

export const observabilityRouter = Router();

// Internal engineer/admin dashboard reads — generous limit.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

const db = supabaseAdmin as any;

/**
 * Internal role guard middleware.
 * Verifies the authenticated user has internal_role = 'engineer' or 'admin'.
 * Returns 403 Forbidden immediately for all other users.
 */
async function requireEngineer(req: any, res: any, next: any) {
  try {
    const { data: profile, error } = await db
      .from("profiles")
      .select("internal_role")
      .eq("id", req.user!.id)
      .maybeSingle();

    if (error) {
      console.error("[observability] role check failed:", error.message);
      return res.status(500).json({ code: "internal_error", message: "Failed to verify role" });
    }

    if (!profile || !["engineer", "admin"].includes(profile.internal_role ?? "")) {
      return res.status(403).json({
        code: "forbidden",
        message: "This endpoint requires an engineering role (profiles.internal_role).",
      });
    }

    return next();
  } catch (err) {
    console.error("[observability] requireEngineer threw:", err);
    return res.status(500).json({ code: "internal_error", message: "Role verification error" });
  }
}

/**
 * GET /v1/observability/stats
 *
 * Query params:
 *  - `range_hours` (optional, default 24): Historical window for analytics.
 */
observabilityRouter.get("/stats", requireAuth, readLimiter, requireEngineer, async (req, res, next) => {
  try {
    const rangeHours = Math.max(1, Math.min(720, parseInt(String(req.query.range_hours ?? "24"), 10) || 24));

    const { data, error } = await db.rpc("get_lead_engine_stats", {
      p_range_hours: rangeHours,
    });

    if (error) {
      console.error("[observability] get_lead_engine_stats RPC failed:", error.message);
      return res.status(500).json({ code: "rpc_error", message: error.message });
    }

    return res.json(data ?? {});
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /v1/observability/history
 *
 * Returns historical job metrics (completed runs) for graphing.
 * Query params:
 *  - `range_hours` (optional, default 24)
 *  - `limit` (optional, default 100)
 */
observabilityRouter.get("/history", requireAuth, readLimiter, requireEngineer, async (req, res, next) => {
  try {
    const rangeHours = Math.max(1, Math.min(720, parseInt(String(req.query.range_hours ?? "24"), 10) || 24));
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? "100"), 10) || 100));

    const since = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();

    const { data, error } = await db
      .from("lead_engine_job_metrics")
      .select("*")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[observability] history query failed:", error.message);
      return res.status(500).json({ code: "query_error", message: error.message });
    }

    return res.json(data ?? []);
  } catch (err) {
    return next(err);
  }
});
