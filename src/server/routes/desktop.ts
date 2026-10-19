import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { requireAuth } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { getPlan, getPlanConcurrency, type PlanId } from "../../config/plans.js";
import { env } from "../../config/env.js";
import { validateLead } from "../../lib/leadValidation.js";
import { deliverLead, type DeliveryContext, type DeliveryResult } from "../../scraperBridge/deliverLead.js";
import type { EngineLead } from "../../scraperBridge/pythonBridge.js";
import { recordTaskOutcome, completePlanIfDrained } from "../../jobs/discoveryPlanJob.js";
import { processDiscoveredCandidate, type ProcessCandidateParams, type ProcessCandidateResult } from "../../discovery/candidatePipeline.js";
import {
  publishDiscoveryLiveEvent,
  scoutStartedEvent,
  areaStartedEvent,
  areaCompletedEvent,
} from "../../discovery/liveDiscoveryEvent.js";
import { getAreasForCity } from "../../lib/geo/cityAreas.js";
import { hasCuratedAreas, claimAreaForCity, recordAreaOutcome } from "../../discovery/areaRotation.js";
import { classifyRejectionReason } from "../../discovery/liveDiscoveryState.js";

export const desktopRouter = Router();

/** Configurable lease expiration for desktop workers (default 60 seconds). */
export const DESKTOP_LEASE_TTL_MS = 60_000;

/** Rate limiters for desktop coordination endpoints */
const claimLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const heartbeatLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const ingestLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const completeLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

/**
 * Dependency collaborators container for unit testing and mocking.
 */
export const desktopDeps = {
  db: supabaseAdmin as any,
  deliverLead,
  recordTaskOutcome,
  completePlanIfDrained,
  processCandidate: (params: ProcessCandidateParams) => {
    return processDiscoveredCandidate(params, {
      db: desktopDeps.db,
      deliverLead: desktopDeps.deliverLead,
      publishDiscoveryLiveEvent: desktopDeps.publishDiscoveryLiveEvent,
    });
  },
  publishDiscoveryLiveEvent,
  claimAreaForCity,
  recordAreaOutcome,
  getAreasForCity,
};

// ── Validation Schemas ────────────────────────────────────────────────────────

const ClaimTaskSchema = z.object({
  workerId: z.string().min(1).max(128),
  preferredTaskId: z.string().uuid().optional(),
});

const HeartbeatSchema = z.object({
  leaseToken: z.string().uuid(),
  metrics: z
    .object({
      discovered: z.number().int().nonnegative().optional(),
      accepted: z.number().int().nonnegative().optional(),
      rejected: z.number().int().nonnegative().optional(),
      duplicates: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const CandidateSchema = z.object({
  pipeline_id: z.string().optional(),
  name: z.string().min(1),
  query: z.string().optional().default(""),
  city: z.string().optional().default(""),
  country: z.string().optional().default(""),
  country_code: z.string().optional(),
  niche: z.string().optional(),
  region: z.string().optional().default(""),
  address: z.string().optional().default(""),
  phone: z.string().optional().default(""),
  email: z.string().optional().default(""),
  website: z.string().optional().default(""),
  instagram: z.string().optional().default(""),
  facebook: z.string().optional().default(""),
  linkedin: z.string().optional().default(""),
  contact_form: z.string().optional().default(""),
  maps_link: z.string().optional().default(""),
  rating: z.number().nullable().optional().default(null),
  reviews: z.number().optional().default(0),
  category: z.string().optional().default(""),
  price_range: z.string().optional().default(""),
  has_photos: z.boolean().optional().default(false),
  has_popular_times: z.boolean().optional().default(false),
  owner_responds_to_reviews: z.boolean().optional().default(false),
  is_google_verified: z.boolean().optional().default(false),
  multi_location: z.boolean().optional().default(false),
  closed: z.boolean().optional().default(false),
  ig_followers: z.number().nullable().optional().default(null),
  ig_bio: z.string().optional().default(""),
  ig_activity: z.string().optional().default(""),
  ig_last_post_days: z.number().nullable().optional().default(null),
  ig_legitimacy: z.number().optional().default(0),
  tech_stack: z.record(z.unknown()).optional().default({}),
  score: z.number().optional().default(0),
  quality: z.string().optional().default(""),
  tier: z.string().optional().default(""),
  action: z.string().optional().default(""),
  fingerprints: z.array(z.string()).optional().default([]),
  is_disqualified: z.boolean().optional().default(false),
});

const IngestSchema = z.object({
  leaseToken: z.string().uuid(),
  batchId: z.string().min(1).max(128),
  candidates: z.array(CandidateSchema).max(100),
});

const CompleteSchema = z.object({
  leaseToken: z.string().uuid(),
  status: z.enum(["completed", "failed"]),
  discovered: z.number().int().nonnegative().optional().default(0),
  accepted: z.number().int().nonnegative().optional().default(0),
  rejected: z.number().int().nonnegative().optional().default(0),
  duplicates: z.number().int().nonnegative().optional().default(0),
  exhausted: z.boolean().optional().default(false),
  error: z.string().optional(),
  completionReason: z.string().optional().default("exhausted"),
  terminationReason: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTaskLeasedToOther(task: any, now: number): boolean {
  if (task.status !== "running") return false;
  if (!task.last_heartbeat_at) return false;
  const heartbeatTime = new Date(task.last_heartbeat_at).getTime();
  return now - heartbeatTime < DESKTOP_LEASE_TTL_MS;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/**
 * POST /v1/desktop/tasks/claim
 * Atomically claims an eligible desktop discovery task for the authenticated user.
 */
desktopRouter.post("/tasks/claim", requireAuth, claimLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const body = ClaimTaskSchema.parse(req.body);

    // 1. Resolve user's billing tier and concurrency cap
    const { data: profile } = await desktopDeps.db
      .from("profiles")
      .select("subscription_plan")
      .eq("id", userId)
      .maybeSingle();

    const planTierId = (profile?.subscription_plan as PlanId) ?? "free";
    const baseConcurrencyCap = getPlanConcurrency(planTierId, env.PLAN_CONCURRENCY_OVERRIDES);
    // Desktop worker runs locally on the user's desktop hardware, driving up to 3 concurrent scouts
    // (matching the 3 scouts rendered on the live discovery UI and cloud area worker pool).
    const concurrencyCap = Math.max(3, baseConcurrencyCap);

    // 2. Count active running tasks for this user
    const { data: userRunningTasks } = await desktopDeps.db
      .from("discovery_tasks")
      .select("id, last_heartbeat_at")
      .eq("user_id", userId)
      .eq("status", "running");

    const now = Date.now();
    const activeRunningCount = (userRunningTasks || []).filter((t: any) => {
      if (!t.last_heartbeat_at) return true;
      return now - new Date(t.last_heartbeat_at).getTime() < DESKTOP_LEASE_TTL_MS;
    }).length;

    if (activeRunningCount >= concurrencyCap) {
      return res.status(200).json({
        task: null,
        reason: "concurrency_limit_reached",
        concurrencyCap,
        activeRunningCount,
      });
    }

    // 3. Query candidate eligible tasks
    // Must be owned by user, execution_target = "desktop", and either queued or expired running lease
    let query = desktopDeps.db
      .from("discovery_tasks")
      .select("id, plan_id, user_id, city, niche, country_code, country_name, candidate_budget, priority, status, last_heartbeat_at, task_summary")
      .eq("user_id", userId)
      .in("status", ["queued", "running"]);

    if (body.preferredTaskId) {
      query = query.eq("id", body.preferredTaskId);
    }

    const { data: candidateTasks, error: candidateError } = await query
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(10);

    if (candidateError) throw candidateError;

    // Filter down to desktop-targeted tasks that are either queued or have an expired lease
    const eligibleTasks = (candidateTasks || []).filter((task: any) => {
      const target = task.execution_target ?? task.task_summary?.execution_target;
      if (target !== "desktop") return false;

      if (task.status === "queued") return true;
      if (task.status === "running") {
        return !isTaskLeasedToOther(task, now);
      }
      return false;
    });

    if (eligibleTasks.length === 0) {
      return res.status(200).json({ task: null });
    }

    // 4. Attempt atomic compare-and-set claim on the first available task
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now + DESKTOP_LEASE_TTL_MS);

    for (const task of eligibleTasks) {
      const currentHeartbeat = task.last_heartbeat_at;

      // Assign an active scout ID (1..3) based on currently running tasks for this plan
      const { data: runningPlanTasks } = await desktopDeps.db
        .from("discovery_tasks")
        .select("id, task_summary")
        .eq("plan_id", task.plan_id)
        .eq("status", "running");

      const usedScoutIds = new Set<number>();
      for (const t of runningPlanTasks || []) {
        if (t.id === task.id) continue;
        const sid = t.task_summary?.scout_id;
        if (typeof sid === "number") usedScoutIds.add(sid);
      }
      let assignedScoutId = 1;
      for (let i = 1; i <= 3; i++) {
        if (!usedScoutIds.has(i)) {
          assignedScoutId = i;
          break;
        }
      }

      // Curated area rotation for cities with area breakdowns
      let claimedArea: string | undefined =
        task.task_summary?.area ??
        (task.task_summary?.area_label && task.task_summary.area_label !== task.city
          ? task.task_summary.area_label
          : undefined);

      if (!claimedArea) {
        const curatedAreas = desktopDeps.getAreasForCity(task.country_code, task.city);
        if (hasCuratedAreas(curatedAreas)) {
          try {
            claimedArea = await desktopDeps.claimAreaForCity(desktopDeps.db, {
              niche: task.niche,
              countryCode: task.country_code,
              city: task.city,
              source: task.source ?? "google_maps",
              areas: curatedAreas,
            });
          } catch (err) {
            console.warn(`[desktop-coordination] claimAreaForCity failed for ${task.city}:`, err);
          }
        }
      }
      const areaLabel = claimedArea || task.city;

      const updatedSummary = {
        ...(task.task_summary || {}),
        execution_target: "desktop",
        lease_token: leaseToken,
        worker_id: body.workerId,
        lease_expires_at: leaseExpiresAt.toISOString(),
        scout_id: assignedScoutId,
        area: claimedArea || null,
        area_label: areaLabel,
      };

      let updateQuery = desktopDeps.db
        .from("discovery_tasks")
        .update({
          status: "running",
          started_at: new Date(now).toISOString(),
          last_heartbeat_at: new Date(now).toISOString(),
          task_summary: updatedSummary,
        })
        .eq("id", task.id)
        .eq("user_id", userId);

      if (task.status === "queued") {
        updateQuery = updateQuery.eq("status", "queued");
      } else {
        // Expired running lease: CAS guard on last_heartbeat_at
        updateQuery = updateQuery.eq("status", "running");
        if (currentHeartbeat) {
          updateQuery = updateQuery.eq("last_heartbeat_at", currentHeartbeat);
        } else {
          updateQuery = updateQuery.is("last_heartbeat_at", null);
        }
      }

      const { data: updated, error: updateError } = await updateQuery.select().maybeSingle();

      if (updateError) {
        console.warn(`[desktop-coordination] error claiming task ${task.id}:`, updateError);
        continue;
      }

      if (updated) {
        // Real live discovery progress events for scout startup and area exploration
        desktopDeps.publishDiscoveryLiveEvent(
          scoutStartedEvent(task.plan_id, assignedScoutId, areaLabel),
        );
        desktopDeps.publishDiscoveryLiveEvent(
          areaStartedEvent(task.plan_id, assignedScoutId, areaLabel),
        );

        // Fetch parent plan parameters to provide discovery context
        const { data: plan } = await desktopDeps.db
          .from("discovery_plans")
          .select("channels, region, profession_slug")
          .eq("id", task.plan_id)
          .maybeSingle();

        // Authoritative query string matching cloud GoogleMapsSearchGenerator:
        // "${niche} in ${area}, ${city}" or "${niche} in ${city}"
        const queryString = claimedArea
          ? `${task.niche} in ${claimedArea}, ${task.city}`
          : `${task.niche} in ${task.city}`;

        // Safe client payload containing only task execution parameters — no secrets or DB credentials
        return res.status(200).json({
          task: {
            id: task.id,
            planId: task.plan_id,
            city: task.city,
            niche: task.niche,
            countryCode: task.country_code,
            countryName: task.country_name,
            candidateBudget: task.candidate_budget,
            channels: plan?.channels ?? [],
            region: plan?.region ?? "",
            professionSlug: plan?.profession_slug ?? null,
            scoutId: assignedScoutId,
            area: claimedArea || null,
            areaLabel,
            queryString,
            query: queryString,
            leaseToken,
            leaseExpiresAt: leaseExpiresAt.toISOString(),
          },
        });
      }
    }

    return res.status(200).json({ task: null });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ code: "invalid_request", message: "Invalid request payload", errors: err.errors });
    }
    return next(err);
  }
});

/**
 * POST /v1/desktop/tasks/:taskId/heartbeat
 * Renews the short-lived lease on an actively running desktop task.
 */
desktopRouter.post("/tasks/:taskId/heartbeat", requireAuth, heartbeatLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const taskId = req.params.taskId;
    const body = HeartbeatSchema.parse(req.body);

    const { data: task, error } = await desktopDeps.db
      .from("discovery_tasks")
      .select("id, user_id, plan_id, status, last_heartbeat_at, task_summary")
      .eq("id", taskId)
      .maybeSingle();

    if (error) throw error;
    if (!task) {
      return res.status(404).json({ code: "task_not_found", message: "Task not found" });
    }

    if (task.user_id !== userId) {
      return res.status(403).json({ code: "forbidden", message: "Access denied to task" });
    }

    // Verify lease token matches
    if (task.task_summary?.lease_token !== body.leaseToken) {
      return res.status(409).json({ code: "lease_invalid", message: "Lease token is invalid or has been superseded" });
    }

    // Check if task is already terminal
    if (task.status !== "running") {
      return res.status(200).json({ renewed: false, terminal: true, status: task.status });
    }

    // Check parent plan status
    const { data: plan } = await desktopDeps.db
      .from("discovery_plans")
      .select("status, delivered_count, requested_count")
      .eq("id", task.plan_id)
      .maybeSingle();

    if (plan?.status === "cancelled") {
      return res.status(200).json({ renewed: false, aborted: true, reason: "cancelled" });
    }
    if (plan && plan.delivered_count >= plan.requested_count) {
      return res.status(200).json({ renewed: false, aborted: true, reason: "plan_target_reached" });
    }

    const now = Date.now();
    const leaseExpiresAt = new Date(now + DESKTOP_LEASE_TTL_MS);

    const updatedSummary = {
      ...(task.task_summary || {}),
      lease_expires_at: leaseExpiresAt.toISOString(),
      ...(body.metrics ? { live_metrics: body.metrics } : {}),
    };

    await desktopDeps.db
      .from("discovery_tasks")
      .update({
        last_heartbeat_at: new Date(now).toISOString(),
        task_summary: updatedSummary,
      })
      .eq("id", taskId);

    return res.status(200).json({
      renewed: true,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ code: "invalid_request", message: "Invalid request payload", errors: err.errors });
    }
    return next(err);
  }
});

/**
 * POST /v1/desktop/tasks/:taskId/ingest
 * Ingests a batch of discovered candidates through the validated, deduplicated cloud pipeline.
 */
desktopRouter.post("/tasks/:taskId/ingest", requireAuth, ingestLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const taskId = req.params.taskId;
    const body = IngestSchema.parse(req.body);

    const { data: task, error: taskError } = await desktopDeps.db
      .from("discovery_tasks")
      .select("id, user_id, plan_id, city, niche, status, discovered_count, accepted_count, rejected_count, task_summary")
      .eq("id", taskId)
      .maybeSingle();

    if (taskError) throw taskError;
    if (!task) {
      return res.status(404).json({ code: "task_not_found", message: "Task not found" });
    }

    if (task.user_id !== userId) {
      return res.status(403).json({ code: "forbidden", message: "Access denied to task" });
    }

    if (task.task_summary?.lease_token !== body.leaseToken) {
      return res.status(409).json({ code: "lease_invalid", message: "Lease token is invalid or has been superseded" });
    }

    if (task.status !== "running") {
      return res.status(400).json({ code: "task_not_running", message: "Task is not currently running" });
    }

    // Idempotency check: has this batchId already been processed for this task?
    const processedBatches = (task.task_summary?.processed_batches || {}) as Record<string, any>;
    if (processedBatches[body.batchId]) {
      return res.status(200).json(processedBatches[body.batchId]);
    }

    // Fetch parent plan
    const { data: plan, error: planError } = await desktopDeps.db
      .from("discovery_plans")
      .select("id, scrape_job_id, status, requested_count, delivered_count, channels, region, profession_slug")
      .eq("id", task.plan_id)
      .maybeSingle();

    if (planError) throw planError;
    if (!plan) {
      return res.status(404).json({ code: "plan_not_found", message: "Parent discovery plan not found" });
    }

    if (plan.status === "cancelled" || plan.delivered_count >= plan.requested_count) {
      const responsePayload = {
        batchId: body.batchId,
        accepted: 0,
        rejected: 0,
        duplicates: 0,
        limitReached: false,
        planTargetReached: true,
        planDelivered: plan.delivered_count,
        planRequested: plan.requested_count,
      };
      return res.status(200).json(responsePayload);
    }

    // Resolve plan tier limits
    const { data: profile } = await desktopDeps.db
      .from("profiles")
      .select("subscription_plan")
      .eq("id", userId)
      .maybeSingle();

    const planConfig = getPlan((profile?.subscription_plan as PlanId) ?? "free");

    let accepted = 0;
    let duplicates = 0;
    let rejected = 0;
    let limitReached = false;
    const rejectionReasons: Record<string, number> = {};

    const scoutId = task.task_summary?.scout_id ?? 1;
    const areaLabel = task.task_summary?.area_label ?? task.city;

    for (const rawCandidate of body.candidates) {
      // Validate candidate shape & fields
      const candidate: EngineLead = {
        name: rawCandidate.name,
        address: rawCandidate.address,
        city: rawCandidate.city || task.city,
        country: rawCandidate.country,
        country_code: rawCandidate.country_code,
        query: rawCandidate.query || task.niche,
        niche: rawCandidate.niche || task.niche,
        region: rawCandidate.region || plan.region,
        phone: rawCandidate.phone,
        email: rawCandidate.email,
        website: rawCandidate.website,
        instagram: rawCandidate.instagram,
        facebook: rawCandidate.facebook,
        linkedin: rawCandidate.linkedin,
        contact_form: rawCandidate.contact_form,
        maps_link: rawCandidate.maps_link,
        rating: rawCandidate.rating,
        reviews: rawCandidate.reviews,
        category: rawCandidate.category,
        price_range: rawCandidate.price_range,
        has_photos: rawCandidate.has_photos,
        has_popular_times: rawCandidate.has_popular_times,
        owner_responds_to_reviews: rawCandidate.owner_responds_to_reviews,
        is_google_verified: rawCandidate.is_google_verified,
        multi_location: rawCandidate.multi_location,
        closed: rawCandidate.closed,
        ig_followers: rawCandidate.ig_followers ?? null,
        ig_bio: rawCandidate.ig_bio ?? "",
        ig_activity: rawCandidate.ig_activity ?? "",
        ig_last_post_days: rawCandidate.ig_last_post_days ?? null,
        ig_legitimacy: rawCandidate.ig_legitimacy ?? 0,
        tech_stack: rawCandidate.tech_stack ?? {},
        score: rawCandidate.score ?? 0,
        quality: rawCandidate.quality ?? "",
        tier: rawCandidate.tier ?? "",
        action: rawCandidate.action ?? "",
        fingerprints: rawCandidate.fingerprints ?? [],
        is_disqualified: rawCandidate.is_disqualified ?? false,
      };

      // Canonical processing: validation, quality gate, early prune, business upsert,
      // enrichment gating, authoritative deliverLead (dedup & credit charging), and live events.
      const result = await desktopDeps.processCandidate({
        lead: candidate,
        planId: plan.id,
        effectiveScoutId: scoutId,
        areaLabel,
        pipelineId: rawCandidate.pipeline_id,
        requestedChannels: plan.channels ?? [],
        userId,
        professionSlug: plan.profession_slug,
        region: plan.region,
        scrapeJobId: plan.scrape_job_id,
        dailyLimit: planConfig.dailyLeadLimit,
        monthlyLimit: planConfig.monthlyLeadLimit,
        startedAt: task.started_at ? Date.parse(task.started_at) : undefined,
      });

      if (result.outcome === "accepted") {
        accepted++;
      } else if (result.outcome === "duplicate") {
        duplicates++;
        rejectionReasons.duplicate = (rejectionReasons.duplicate || 0) + 1;
      } else if (result.outcome === "rejected") {
        rejected++;
        const cat = classifyRejectionReason(result.reason);
        rejectionReasons[cat] = (rejectionReasons[cat] || 0) + 1;
      } else if (result.outcome === "limit_reached") {
        limitReached = true;
        break;
      }
    }

    // Refresh plan to check whether plan reached target or was cancelled
    const { data: currentPlan } = await desktopDeps.db
      .from("discovery_plans")
      .select("status, delivered_count, requested_count")
      .eq("id", task.plan_id)
      .maybeSingle();

    const planTargetReached = Boolean(
      currentPlan && (currentPlan.status === "cancelled" || currentPlan.delivered_count >= currentPlan.requested_count),
    );

    const batchResult = {
      batchId: body.batchId,
      accepted,
      rejected,
      duplicates,
      discovered: body.candidates.length,
      limitReached,
      planTargetReached,
      planDelivered: currentPlan?.delivered_count ?? (plan.delivered_count + accepted),
      planRequested: currentPlan?.requested_count ?? plan.requested_count,
      rejectionReasons,
    };

    // Atomically record counts and idempotent batch record
    const updatedSummary = {
      ...(task.task_summary || {}),
      processed_batches: {
        ...processedBatches,
        [body.batchId]: batchResult,
      },
    };

    await desktopDeps.db
      .from("discovery_tasks")
      .update({
        discovered_count: (task.discovered_count || 0) + body.candidates.length,
        accepted_count: (task.accepted_count || 0) + accepted,
        rejected_count: (task.rejected_count || 0) + rejected,
        last_heartbeat_at: new Date().toISOString(),
        task_summary: updatedSummary,
      })
      .eq("id", taskId);

    return res.status(200).json(batchResult);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ code: "invalid_request", message: "Invalid request payload", errors: err.errors });
    }
    return next(err);
  }
});

/**
 * POST /v1/desktop/tasks/:taskId/complete
 * Records task completion and triggers downstream plan draining logic.
 */
desktopRouter.post("/tasks/:taskId/complete", requireAuth, completeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const taskId = req.params.taskId;
    const body = CompleteSchema.parse(req.body);

    const { data: task, error } = await desktopDeps.db
      .from("discovery_tasks")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();

    if (error) throw error;
    if (!task) {
      return res.status(404).json({ code: "task_not_found", message: "Task not found" });
    }

    if (task.user_id !== userId) {
      return res.status(403).json({ code: "forbidden", message: "Access denied to task" });
    }

    if (task.task_summary?.lease_token !== body.leaseToken) {
      return res.status(409).json({ code: "lease_invalid", message: "Lease token is invalid or has been superseded" });
    }

    const startedAt = task.started_at ? Date.parse(task.started_at) : Date.now();

    // Record outcome for claimed curated area if one was assigned
    const claimedArea = task.task_summary?.area;
    if (claimedArea) {
      try {
        await desktopDeps.recordAreaOutcome(desktopDeps.db, {
          niche: task.niche,
          countryCode: task.country_code,
          city: task.city,
          area: claimedArea,
          source: task.source ?? "google_maps",
          discovered: body.discovered,
          accepted: body.accepted,
        });
      } catch (areaErr) {
        console.warn(`[desktop-coordination] recordAreaOutcome failed for ${task.id}:`, areaErr);
      }
    }

    // Publish area completion live event for the live discovery UI
    const scoutId = task.task_summary?.scout_id ?? 1;
    const areaLabel = task.task_summary?.area_label ?? task.city;
    desktopDeps.publishDiscoveryLiveEvent(
      areaCompletedEvent(task.plan_id, scoutId, areaLabel, {
        discovered: body.discovered,
        accepted: body.accepted,
        rejected: body.rejected,
        duplicates: body.duplicates,
        exhausted: body.exhausted,
        failed: body.status === "failed",
        error: body.error,
      }),
    );

    const outcome = {
      discovered: body.discovered,
      accepted: body.accepted,
      rejected: body.rejected,
      duplicates: body.duplicates,
      exhausted: body.exhausted,
      status: body.status,
      error: body.error,
      startedAt,
      completionReason: body.completionReason,
      terminationReason: body.terminationReason,
    };

    await desktopDeps.recordTaskOutcome(task, outcome);
    await desktopDeps.completePlanIfDrained(task.plan_id);

    return res.status(200).json({
      success: true,
      taskId: task.id,
      status: body.status,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ code: "invalid_request", message: "Invalid request payload", errors: err.errors });
    }
    return next(err);
  }
});
