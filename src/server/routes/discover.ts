import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, isDiscoveryModeAllowed } from "../../config/plans.js";
import { validateDiscoveryRegion } from "../../lib/geo/scope.js";
import { lookupAndDeliverFromPool, type PoolLookupResult } from "../../lib/poolLookup.js";
import { professionSlugForLabel } from "../../lib/professions.js";
import { enqueueDiscoveryPlan } from "../../discovery/planner.js";
import { terminateRequest } from "../../discovery/requestLifecycle.js";

export const discoverRouter = Router();

/**
 * Collaborators the route calls through. Production uses the real functions;
 * tests replace them with spies to PROVE which execution path a mode takes
 * (Instant never enqueues Live Discovery). Not a plug-in point for behavior.
 *
 * EXECUTION CONTRACT (do not blur):
 *  - live                 -> enqueueDiscoveryPlan (async job, 202 + planId)
 *  - instant_pool(_ranked)-> lookupAndDeliverFromPool ONLY, synchronous 200.
 *    Instant never queues poolExpand, never creates a plan, never scrapes.
 *    A shortfall is reported (completed_partial); the user may then start a
 *    SEPARATE live run via `followsJobId`.
 */
export const discoverDeps = { enqueueDiscoveryPlan, lookupAndDeliverFromPool };

// Discovery queues real background scraping work (and, on the "live" plan
// path, dispatches directly into pg-boss) — 5/min is well above what a
// legitimate user needs (this is a "kick off and check back" action, not
// something clicked repeatedly) but tight enough to stop a client from
// queuing dozens of jobs before the credit check downstream even matters.
const discoverLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

// Cancelling a job is an authenticated write but doesn't trigger new work —
// 20/min comfortably covers normal UI interaction.
const cancelLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const DiscoverRequestSchema = z.object({
  quantity: z.number().int().positive(),
  region: z.string().min(1),
  // At least one niche is required — the engine must never fall back to a
  // "General" search. z.string().min(1) alone would let whitespace or a
  // literal "General" through, so this is checked explicitly too.
  niche: z
    .string()
    .min(1)
    .refine((n) => n.trim().length > 0 && n.trim().toLowerCase() !== "general", {
      message: "At least one niche must be selected",
    }),
  channels: z.array(z.string()).default([]),
  /** Target currencies, if any — narrows which countries get searched per
   * region to ones where discovered businesses can realistically pay in
   * that currency. See src/lib/geo/regions.ts. */
  currencies: z.array(z.string()).default([]),
  /**
   * The discovery method the user picked in the Discover UI (Live
   * Scraping / Instant Pool Access / Ranked Instant Results). Optional
   * for backward compatibility — an omitted value falls back to the
   * resolved plan's default (ceiling) method below. Whatever is sent
   * here is re-validated against the resolved plan (isDiscoveryModeAllowed)
   * before it's honored — a client can never grant itself a method its
   * plan doesn't allow.
   */
  method: z.enum(["live", "instant_pool", "instant_pool_ranked"]).optional(),
  /**
   * Set ONLY by the explicit "Find remaining leads with Live Discovery"
   * action: the id of a completed_partial Instant run this live run
   * continues. Must be the caller's own job; requires method "live"; quantity
   * may not exceed that job's recorded shortfall; the same job can only be
   * continued once. It never merges the two runs — the live run is a separate
   * job with its own counters and its own credit charges.
   */
  followsJobId: z.string().uuid().optional(),
});

/**
 * POST /v1/discover
 *
 * PHASE 5 hardening, on top of Phase 4's API shape (unchanged):
 *  - Usage reset + limit check now goes through try_increment_lead_usage
 *    (p_count=0), the same atomic function every actual credit charge uses
 *    — see migrations/005_usage_hardening.sql. This replaces a raw
 *    `.select(...)` that could read stale (unreset) counters, and means
 *    the reset happens on EVERY request, not just when the frontend
 *    happens to call checkAndResetUsage.
 *  - The resolved plan can differ from what a naive read would show, if a
 *    pending downgrade just applied at this exact request's monthly
 *    boundary — limits/mode are computed AFTER resolving, never before.
 *  - Channel (email/phone/instagram/website) and regional-search
 *    restrictions are now enforced here too, not just client-side (a gap
 *    flagged, not fixed, in Phase 4).
 *  - Discovery Method is a real, user-chosen option (`body.method`), not
 *    something purely derived from the plan: each plan's `discoveryMode`
 *    is a CEILING (see config/plans.ts), and the user may pick any method
 *    at or below it. The requested method is re-validated against that
 *    ceiling here (isDiscoveryModeAllowed) — never trusted as-is. An
 *    omitted method falls back to the plan's ceiling; an ineligible one
 *    is rejected outright (403), since the UI should never have let it
 *    be selected in the first place.
 */
discoverRouter.post("/", requireAuth, discoverLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = DiscoverRequestSchema.parse(req.body);

    // Resolve current usage state atomically (reset applied if a rolling
    // window boundary has passed, including a pending plan downgrade at
    // the monthly boundary) WITHOUT charging anything (p_count: 0).
    const { data: resolved, error: resolveError } = await supabaseAdmin
      .rpc("try_increment_lead_usage", {
        p_user_id: userId,
        p_daily_limit: 0, // irrelevant for p_count=0 — never rejected
        p_monthly_limit: 0,
        p_count: 0,
      })
      .single();
    if (resolveError) throw resolveError;

    const resolvedRow = resolved as {
      subscription_plan: string;
      daily_leads_used: number;
      monthly_leads_used: number;
    };
    const plan = getPlan(resolvedRow.subscription_plan);
    const dailyUsed = resolvedRow.daily_leads_used;
    const monthlyUsed = resolvedRow.monthly_leads_used;

    // The method actually used for this request: whatever the user chose,
    // re-validated against the resolved plan — never trusted as-is —
    // falling back to the plan's default (ceiling) method when omitted.
    const mode = body.method ?? plan.discoveryMode;
    if (!isDiscoveryModeAllowed(plan.id, mode)) {
      return res.status(403).json({
        code: "method_restricted",
        message: `The '${mode}' discovery method requires a higher plan.`,
      });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();
    if (profileError) throw profileError;

    if (body.quantity > plan.maxLeadRequest) {
      return res.status(400).json({
        code: "quantity_exceeds_plan_limit",
        message: `${plan.id} plan allows at most ${plan.maxLeadRequest} opportunities per request`,
      });
    }
    if (dailyUsed >= plan.dailyLeadLimit) {
      return res.status(429).json({ code: "daily_limit_reached", message: "Daily opportunity limit reached" });
    }
    if (monthlyUsed >= plan.monthlyLeadLimit) {
      return res.status(429).json({ code: "monthly_limit_reached", message: "Monthly credit limit reached" });
    }

    for (const ch of body.channels) {
      const allowed =
        (ch === "email" && plan.channels.email) ||
        (ch === "phone" && plan.channels.phone) ||
        (ch === "instagram" && plan.channels.instagram) ||
        (ch === "website" && plan.channels.website);
      if (!allowed) {
        return res.status(403).json({ code: "channel_restricted", message: `Channel '${ch}' is restricted under your plan.` });
      }
    }
    // GEOGRAPHIC SCOPE: `region` is a list of Global | continent | country
    // tokens (see src/lib/geo/scope.ts). Unknown tokens are rejected here —
    // never silently dropped or widened — and plans without regionalSearch
    // are limited to the local (North America) region, which now includes
    // its individual countries. `region` below is the CANONICAL form of what
    // the user selected and is what every downstream consumer (scrape job,
    // discovery plan, pool lookup, pool expansion, business rows) receives.
    const geo = validateDiscoveryRegion(body.region, { regionalSearch: plan.regionalSearch });
    if (!geo.ok) {
      return res.status(geo.code === "invalid_region" ? 400 : 403).json({ code: geo.code, message: geo.message });
    }
    const region = geo.region;

    if (body.followsJobId) {
      if (mode !== "live") {
        return res.status(400).json({
          code: "follow_up_requires_live",
          message: "Only a Live Discovery run can continue a partial Instant result.",
        });
      }
      const { data: prior, error: priorError } = await (supabaseAdmin as any)
        .from("scrape_jobs")
        .select("id, user_id, mode, status, query, job_summary")
        .eq("id", body.followsJobId)
        .eq("user_id", userId)
        .maybeSingle();
      if (priorError) throw priorError;
      if (!prior) {
        return res.status(404).json({ code: "follows_job_not_found", message: "The run you are continuing was not found." });
      }
      const priorShortfall = Number(prior.job_summary?.shortfall ?? 0);
      if (!["instant_pool", "instant_pool_ranked"].includes(prior.mode) || prior.status !== "completed_partial" || priorShortfall <= 0) {
        return res.status(409).json({
          code: "follows_job_not_partial",
          message: "Only a partial Instant run with a remaining shortfall can be continued with Live Discovery.",
        });
      }
      if (body.quantity > priorShortfall) {
        return res.status(400).json({
          code: "follow_up_quantity_exceeds_shortfall",
          message: `Live Discovery can only be started for the remaining ${priorShortfall} opportunities.`,
        });
      }
      const priorQuery = (prior.query ?? {}) as { niche?: string; region?: string; channels?: string[] };
      const sameSet = (a: string[] = [], b: string[] = []) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
      if (
        String(priorQuery.niche ?? "").trim().toLowerCase() !== body.niche.trim().toLowerCase() ||
        priorQuery.region !== region ||
        !sameSet(priorQuery.channels, body.channels)
      ) {
        return res.status(400).json({
          code: "follow_up_mismatch",
          message: "A follow-up Live Discovery run must use the same niche, region and channels as the run it continues.",
        });
      }
      const { data: existingFollowUps, error: dupError } = await (supabaseAdmin as any)
        .from("scrape_jobs")
        .select("id, status")
        .eq("user_id", userId)
        .eq("query->>follows_job_id", body.followsJobId)
        .in("status", ["queued", "running", "streaming", "completed", "completed_partial"])
        .limit(1);
      if (dupError) throw dupError;
      if (Array.isArray(existingFollowUps) && existingFollowUps.length > 0) {
        return res.status(409).json({
          code: "follow_up_already_started",
          message: "Live Discovery was already started for this run.",
          jobId: existingFollowUps[0].id,
        });
      }
    }

    const focusAreaLabel = (profile?.settings as Record<string, unknown> | null)?.focusArea as string | undefined;
    const professionSlug = professionSlugForLabel(focusAreaLabel);

    const quantity = Math.min(body.quantity, plan.dailyLeadLimit - dailyUsed, plan.monthlyLeadLimit - monthlyUsed);

    const { data: job, error: jobError } = await supabaseAdmin
      .from("scrape_jobs")
      .insert({
        user_id: userId,
        mode,
        status: "queued",
        query: {
          region: region,
          niche: body.niche,
          channels: body.channels,
          currencies: body.currencies,
          profession_slug: professionSlug,
          quantity,
          ...(body.followsJobId ? { follows_job_id: body.followsJobId } : {}),
        },
      })
      .select()
      .single();
    if (jobError) throw jobError;

    if (mode === "live") {
      let planId: string;
      try {
        planId = await discoverDeps.enqueueDiscoveryPlan({
          scrapeJobId: job.id,
          userId,
          // AUDIT FIX (Phase 3B concurrency audit): this was never passed
          // before, so every downstream getPlan(request.planTierId ?? null) /
          // getPlanConcurrency() call silently fell back to the "free" tier
          // — both the priority band (materializeDiscoveryPlan) AND, after
          // this phase's dispatch fix, the per-user worker-concurrency cap
          // (dispatchQueuedDiscoveryTasks / handleDiscoveryTask) were
          // computing every user's plan as if they were on "free" (band
          // 0-9, cap 2) regardless of their actual billing tier. See
          // planner.ts's plan_tier_id row field for the other half of this
          // fix.
          //
          // NOTE: this field is named `planTierId` (never `planId`) on
          // purpose — `planId` is reserved everywhere downstream (pg-boss
          // discovery.plan payload, DiscoveryPlanPayload, DiscoveryTaskPayload,
          // discovery_tasks.plan_id) for the discovery_plans.id UUID. This
          // was the exact production incident: this field used to be named
          // `planId: plan.id` ("free"), and enqueueDiscoveryPlan's pg-boss
          // payload spread it in a way that clobbered the real UUID with the
          // string "free", so handleDiscoveryPlanJob looked up
          // discovery_plans.id = 'free', found no row, and returned early —
          // every Free discovery run queued forever with zero discovery_tasks.
          planTierId: plan.id,
          region: region,
          niche: body.niche,
          channels: body.channels,
          currencies: body.currencies,
          professionSlug,
          quantity,
          dailyLimit: plan.dailyLeadLimit,
          monthlyLimit: plan.monthlyLeadLimit,
        });
      } catch (enqueueErr) {
        // The job row exists but no plan could be queued: terminate it
        // visibly instead of leaving it "queued" forever.
        await (supabaseAdmin as any)
          .from("scrape_jobs")
          .update({
            status: "failed",
            results_count: 0,
            error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        throw enqueueErr;
      }


      return res.status(202).json({
        jobId: job.id,
        planId,
        mode,
        status: "queued",
        requested: quantity,
        requestedByUser: body.quantity,
        ...(body.followsJobId ? { followsJobId: body.followsJobId } : {}),
      });
    }

    // Instant Pool / Ranked Instant: POOL ONLY, synchronous. This branch must
    // never enqueue a plan, queue poolExpand, or otherwise start scraping — a
    // shortfall is reported to the user as a shortfall.
    let pool: PoolLookupResult;
    try {
      pool = await discoverDeps.lookupAndDeliverFromPool({
        userId,
        region: region,
        niche: body.niche,
        professionSlug,
        rank: mode === "instant_pool_ranked",
        quantity,
        scrapeJobId: job.id,
        dailyLimit: plan.dailyLeadLimit,
        monthlyLimit: plan.monthlyLeadLimit,
        channels: body.channels,
      });
    } catch (poolErr) {
      // Lookup failed before anything was delivered: never leave the job
      // sitting in "queued" forever.
      await (supabaseAdmin as any)
        .from("scrape_jobs")
        .update({
          status: "failed",
          results_count: 0,
          error: poolErr instanceof Error ? poolErr.message : String(poolErr),
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      throw poolErr;
    }

    const { delivered, shortfall, limitReached, interrupted } = pool;
    const shortfallReason = limitReached
      ? "plan_limit_reached"
      : interrupted
        ? "pool_delivery_interrupted"
        : shortfall > 0
          ? "pool_exhausted"
          : null;
    const finalStatus =
      delivered.length >= quantity ? "completed" : delivered.length === 0 && interrupted ? "failed" : "completed_partial";

    // The job row always reflects exactly what was delivered (and therefore
    // charged: one credit per saved lead — see insertLeadForUser).
    await (supabaseAdmin as any)
      .from("scrape_jobs")
      .update({
        status: finalStatus,
        results_count: delivered.length,
        completed_at: new Date().toISOString(),
        error: interrupted ? interrupted.message : null,
        job_summary: {
          requested: quantity,
          delivered: delivered.length,
          shortfall,
          // Same vocabulary as the live path's job_summary (migration 017).
          completion_reason: limitReached
            ? "limit_reached"
            : interrupted
              ? "failed"
              : shortfall > 0
                ? "exhausted"
                : "quantity_reached",
          shortfall_reason: shortfallReason,
          candidates: pool.candidates,
          skipped: pool.skipped,
          ranking: pool.ranking,
        },
      })
      .eq("id", job.id);

    if (finalStatus === "failed") {
      return res.status(500).json({
        code: "pool_delivery_failed",
        message: "The pool search failed before delivering any opportunities. No credits were used.",
        jobId: job.id,
      });
    }

    res.status(200).json({
      jobId: job.id,
      // No planId: an Instant run has no live discovery plan to show.
      mode,
      status: finalStatus,
      requested: quantity,
      requestedByUser: body.quantity,
      delivered: delivered.length,
      shortfall,
      limitReached,
      shortfallReason,
      ranking: pool.ranking,
      candidates: pool.candidates,
      skipped: pool.skipped,
      interrupted: Boolean(interrupted),
      // Offered, never started: the user must explicitly choose it, and it
      // runs as its own job under the normal plan/credit rules.
      liveFollowUp: { available: shortfall > 0 && !limitReached, remaining: shortfall },
      // Kept for response-shape backward compatibility; always false now.
      backgroundExpansionQueued: false,
      results: delivered,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/discover/:jobId/cancel
 *
 * Marks the durable plan as terminal first, so every worker polling that
 * request stops its Python process even if it is between streamed leads. Only
 * the owning user may cancel their own job, and only if the job is still
 * in a non-terminal state.
 */
discoverRouter.post("/:jobId/cancel", requireAuth, cancelLimiter, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { jobId } = req.params;

    const { data: job, error: fetchError } = await supabaseAdmin
      .from("scrape_jobs")
      .select("id, user_id, status")
      .eq("id", jobId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!job) return res.status(404).json({ code: "not_found", message: "Job not found." });
    if (job.user_id !== userId) return res.status(403).json({ code: "forbidden", message: "You do not own this job." });

    const terminalStatuses = ["completed", "completed_partial", "failed", "cancelled"];
    if (terminalStatuses.includes(job.status)) {
      return res.status(409).json({
        code: "already_terminal",
        message: `Job is already in terminal state '${job.status}' and cannot be cancelled.`,
        currentStatus: job.status,
      });
    }

    // Live discovery has a request-level plan.  Its terminal state is the
    // shared cancellation signal for workers on other processes/hosts.
    const { data: cancelledPlan, error: planError } = await (supabaseAdmin as any)
      .from("discovery_plans")
      .update({ status: "cancelled", terminal_reason: "USER_CANCELLED", completed_at: new Date().toISOString() })
      .eq("scrape_job_id", jobId)
      .in("status", ["queued", "planning", "running"])
      .select("id");
    if (planError) throw planError;

    for (const plan of (cancelledPlan ?? []) as Array<{ id: string }>) {
      // Queued pg-boss messages can still wake up, but their durable task is
      // no longer claimable and the handler's pre-flight check cannot spawn.
      await (supabaseAdmin as any)
        .from("discovery_tasks")
        .update({ status: "cancelled", termination_reason: "USER_CANCELLED", completed_at: new Date().toISOString() })
        .eq("plan_id", plan.id)
        .eq("status", "queued");
      // Same-process workers stop immediately; remote workers see the plan
      // update through their short lifecycle poll.
      terminateRequest(plan.id, "USER_CANCELLED");
    }

    const { error: updateError } = await supabaseAdmin
      .from("scrape_jobs")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", jobId)
      .not("status", "in", `(${terminalStatuses.map((s) => `"${s}"`).join(",")})`)
      .eq("user_id", userId);

    if (updateError) throw updateError;

    return res.status(200).json({ jobId, status: "cancelled" });
  } catch (err) {
    next(err);
  }
});
