import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan } from "../../config/plans.js";
import { getBoss, QUEUES } from "../../lib/queue.js";
import { lookupAndDeliverFromPool } from "../../lib/poolLookup.js";

export const discoverRouter = Router();

const DiscoverRequestSchema = z.object({
  quantity: z.number().int().positive(),
  region: z.string().min(1),
  niche: z.string().min(1),
  channels: z.array(z.string()).default([]),
});

function slugifyProfession(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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
 */
discoverRouter.post("/", requireAuth, async (req, res, next) => {
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
    if (body.region && body.region !== "North America" && !plan.regionalSearch) {
      return res.status(403).json({ code: "region_restricted", message: "Regional search is restricted under your plan." });
    }

    const focusAreaLabel = (profile?.settings as Record<string, unknown> | null)?.focusArea as string | undefined;
    const professionSlug = focusAreaLabel ? slugifyProfession(focusAreaLabel) : null;

    const quantity = Math.min(body.quantity, plan.dailyLeadLimit - dailyUsed, plan.monthlyLeadLimit - monthlyUsed);

    const { data: job, error: jobError } = await supabaseAdmin
      .from("scrape_jobs")
      .insert({
        user_id: userId,
        mode: plan.discoveryMode,
        status: "queued",
        query: { region: body.region, niche: body.niche, channels: body.channels, profession_slug: professionSlug, quantity },
      })
      .select()
      .single();
    if (jobError) throw jobError;

    if (plan.discoveryMode === "live") {
      const boss = await getBoss();
      await boss.send(QUEUES.discoverLive, {
        scrapeJobId: job.id,
        userId,
        region: body.region,
        niche: body.niche,
        channels: body.channels,
        professionSlug,
        quantity,
        dailyLimit: plan.dailyLeadLimit,
        monthlyLimit: plan.monthlyLeadLimit,
      });

      return res.status(202).json({
        jobId: job.id,
        mode: plan.discoveryMode,
        status: "queued",
        requested: quantity,
      });
    }

    // Instant Discovery (Starter/Pro/Premium): pool-first, synchronous.
    const { delivered, shortfall, limitReached } = await lookupAndDeliverFromPool({
      userId,
      region: body.region,
      niche: body.niche,
      professionSlug,
      rank: plan.discoveryMode === "instant_pool_ranked",
      quantity,
      scrapeJobId: job.id,
      dailyLimit: plan.dailyLeadLimit,
      monthlyLimit: plan.monthlyLeadLimit,
    });

    let backgroundExpansionQueued = false;

    if (shortfall > 0 && !limitReached) {
      // Leave the job "streaming" rather than "completed" — poolExpandJob
      // (with a followUp attached) is what flips it to completed once it
      // finishes delivering the rest under this same job id.
      await supabaseAdmin.from("scrape_jobs").update({ status: "streaming", results_count: delivered.length }).eq("id", job.id);

      const boss = await getBoss();
      await boss.send(QUEUES.poolExpand, {
        region: body.region,
        niche: body.niche,
        shortfall,
        followUp: {
          userId,
          professionSlug,
          rank: plan.discoveryMode === "instant_pool_ranked",
          scrapeJobId: job.id,
          dailyLimit: plan.dailyLeadLimit,
          monthlyLimit: plan.monthlyLeadLimit,
        },
      });
      backgroundExpansionQueued = true;
    } else if (shortfall > 0 && limitReached) {
      // The shortfall here is "out of credit," not "pool was thin" — no
      // point following up for THIS user, but still worth growing the pool
      // for whoever asks next. No followUp attached, so no CRM/credit
      // side effects; the job is simply done for this user.
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "completed", results_count: delivered.length, completed_at: new Date().toISOString() })
        .eq("id", job.id);

      const boss = await getBoss();
      await boss.send(QUEUES.poolExpand, { region: body.region, niche: body.niche, shortfall });
    } else {
      await supabaseAdmin
        .from("scrape_jobs")
        .update({ status: "completed", results_count: delivered.length, completed_at: new Date().toISOString() })
        .eq("id", job.id);
    }

    res.status(200).json({
      jobId: job.id,
      mode: plan.discoveryMode,
      status: shortfall > 0 && !limitReached ? "streaming" : "completed",
      requested: quantity,
      delivered: delivered.length,
      shortfall,
      limitReached,
      backgroundExpansionQueued,
      results: delivered,
    });
  } catch (err) {
    next(err);
  }
});
