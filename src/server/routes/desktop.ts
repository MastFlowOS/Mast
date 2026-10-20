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
import { sanitizeWorkerError } from "../../lib/safeRequestLog.js";

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
  preferredPlanId: z.string().uuid().optional(),
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

/**
 * Normalizes multi-identifier keys across Maps URLs/place IDs, website domains,
 * phone numbers, email, social handles, and engine fingerprints for intra-batch deduplication.
 */
// ── Intra-Batch Deduplication & Normalization ─────────────────────────────────

const PLATFORM_DOMAINS = new Set([
  "linktr.ee",
  "linktree.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "toasttab.com",
  "booksy.com",
  "square.site",
  "squareup.com",
  "calendly.com",
  "yelp.com",
  "tripadvisor.com",
  "foursquare.com",
  "opentable.com",
  "resy.com",
  "vagaro.com",
  "mindbodyonline.com",
  "glofox.com",
  "ubereats.com",
  "doordash.com",
  "grubhub.com",
  "justeat.com",
  "deliveroo.com",
  "fresha.com",
  "styleseat.com",
  "wixsite.com",
  "wix.com",
  "wordpress.com",
  "blogspot.com",
  "myshopify.com",
  "carrd.co",
  "bitly.com",
  "sites.google.com",
  "business.site",
]);

const TOLL_FREE_AREA_CODES = new Set(["800", "888", "877", "866", "855", "844", "833"]);

export function extractPlaceId(raw: any): string | null {
  if (Array.isArray(raw?.fingerprints)) {
    const fp = raw.fingerprints.find((f: any) => typeof f === "string" && f.trim().toLowerCase().startsWith("place:"));
    if (fp) return fp.trim().toLowerCase();
  }
  if (typeof raw?.maps_link === "string" && raw.maps_link.trim()) {
    const rawLink = raw.maps_link.trim();
    const chijMatch = rawLink.match(/(ChIJ[\w\-]+)/i);
    if (chijMatch) return `place:${chijMatch[1].toLowerCase()}`;
    const hexMatch = rawLink.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    if (hexMatch) return `place:${hexMatch[1].toLowerCase()}`;
  }
  return null;
}

export function normalizeMapsUrl(rawLink?: string | null): string | null {
  if (!rawLink || typeof rawLink !== "string") return null;
  const trimmed = rawLink.trim();
  if (!trimmed || trimmed.includes("/maps/search/")) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanPath = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "").toLowerCase();
    return cleanPath;
  } catch {
    const stripped = trimmed.split("?")[0].replace(/\/+$/, "").toLowerCase();
    return stripped || null;
  }
}

export function getCustomDomain(url?: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    let u = url.trim().toLowerCase();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      u = `https://${u}`;
    }
    const host = new URL(u).hostname.replace(/^www\./, "");
    if (!host || !host.includes(".")) return null;
    for (const plat of PLATFORM_DOMAINS) {
      if (host === plat || host.endsWith(`.${plat}`)) {
        return null;
      }
    }
    return host;
  } catch {
    return null;
  }
}

export function getCanonicalPlatformUrl(url?: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    let u = url.trim().toLowerCase();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      u = `https://${u}`;
    }
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, "");
    for (const plat of PLATFORM_DOMAINS) {
      if (host === plat || host.endsWith(`.${plat}`)) {
        const cleanPath = parsed.pathname.replace(/\/+$/, "");
        if (cleanPath && cleanPath !== "/") {
          return `${host}${cleanPath}`;
        }
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeFullPhone(rawPhone?: string | null, countryCode?: string | null): string | null {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  const s = rawPhone.trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;

  if (s.startsWith("+")) {
    return `+${digits}`;
  }
  if (s.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }

  const cc = (countryCode || "").toUpperCase();
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    if (cc === "GB" || cc === "UK") {
      return `+44${digits}`;
    }
    return `+1${digits}`;
  }
  if (cc === "GB" || cc === "UK") {
    if (digits.length === 11 && digits.startsWith("0")) {
      return `+44${digits.slice(1)}`;
    }
    return `+44${digits}`;
  }

  return `+${digits}`;
}

export function isTollFree(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    const area = digits.slice(1, 4);
    return TOLL_FREE_AREA_CODES.has(area);
  }
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    return TOLL_FREE_AREA_CODES.has(area);
  }
  return false;
}

export function normalizeBusinessName(name?: string | null): string {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function namesAreSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) && b.length / a.length >= 0.5) return true;
  if (b.includes(a) && a.length / b.length >= 0.5) return true;

  const tokensA = a.split(/\s+/).filter((t) => t.length > 2);
  const tokensB = b.split(/\s+/).filter((t) => t.length > 2);
  if (tokensA.length > 0 && tokensB.length > 0) {
    const common = tokensA.filter((t) => tokensB.includes(t));
    if (common.length >= 2 || common.length / Math.min(tokensA.length, tokensB.length) >= 0.5) {
      return true;
    }
  }
  return false;
}

export function isDuplicateCandidateInBatch(candidate: any, seenCandidates: any[]): boolean {
  const candPlaceId = extractPlaceId(candidate);
  const candMapsUrl = normalizeMapsUrl(candidate.maps_link);
  const candCustomDomain = getCustomDomain(candidate.website);
  const candPlatformUrl = getCanonicalPlatformUrl(candidate.website);
  const candPhone = normalizeFullPhone(candidate.phone, candidate.country_code);
  const candName = normalizeBusinessName(candidate.name);
  const candCity = (candidate.city || "").trim().toLowerCase();
  const candAddress = (candidate.address || "").trim().toLowerCase();
  const candEmail = (candidate.email || "").trim().toLowerCase();
  const candIg = (candidate.instagram || "").trim().toLowerCase().replace(/^@/, "");

  for (const seen of seenCandidates) {
    const seenPlaceId = extractPlaceId(seen);

    // 1. Authoritative Place ID Isolation
    // If BOTH candidates have an authoritative Google Place ID:
    if (candPlaceId && seenPlaceId) {
      if (candPlaceId === seenPlaceId) {
        return true; // Exactly identical Google Maps listing -> DUPLICATE
      }
      // Separate Place IDs -> DISTINCT physical locations (franchise branches, etc.)!
      // Never discard as duplicate based on shared domain, phone, or IG.
      continue;
    }

    // 2. Canonical Maps URL Match (e.g. identical URL when Place ID was not formatted as ChIJ/0x)
    const seenMapsUrl = normalizeMapsUrl(seen.maps_link);
    if (candMapsUrl && seenMapsUrl && candMapsUrl === seenMapsUrl) {
      return true;
    }

    // 3. For candidates without authoritative Place IDs, use compound matching
    const seenCustomDomain = getCustomDomain(seen.website);
    const seenPlatformUrl = getCanonicalPlatformUrl(seen.website);
    const seenPhone = normalizeFullPhone(seen.phone, seen.country_code);
    const seenName = normalizeBusinessName(seen.name);
    const seenCity = (seen.city || "").trim().toLowerCase();
    const seenAddress = (seen.address || "").trim().toLowerCase();
    const seenEmail = (seen.email || "").trim().toLowerCase();
    const seenIg = (seen.instagram || "").trim().toLowerCase().replace(/^@/, "");

    const sameName = namesAreSimilar(candName, seenName);
    const sameCity = Boolean(candCity && seenCity && candCity === seenCity);
    const sameAddress = Boolean(candAddress && seenAddress && candAddress === seenAddress);
    const samePhone = Boolean(candPhone && seenPhone && candPhone === seenPhone && !isTollFree(candPhone));

    // Compound Rule A: Shared custom domain (must corroborate with phone, matching name, or location)
    if (candCustomDomain && seenCustomDomain && candCustomDomain === seenCustomDomain) {
      if (samePhone || (sameName && (sameCity || sameAddress || !candCity || !seenCity))) {
        return true;
      }
    }

    // Compound Rule B: Matching platform profile URL (e.g. linktr.ee/marios)
    if (candPlatformUrl && seenPlatformUrl && candPlatformUrl === seenPlatformUrl) {
      if (sameName || samePhone || sameCity) {
        return true;
      }
    }

    // Compound Rule C: Non-toll-free full phone match
    if (samePhone) {
      if (sameName || sameCity || sameAddress) {
        return true;
      }
    }

    // Compound Rule D: Valid email match + name or location
    if (candEmail && seenEmail && candEmail === seenEmail && candEmail.includes("@")) {
      if (sameName || samePhone || sameCity) {
        return true;
      }
    }

    // Compound Rule E: Valid Instagram handle match + name
    if (candIg && seenIg && candIg === seenIg && !["p", "reel", "reels", "stories", "explore"].includes(candIg)) {
      if (sameName || samePhone) {
        return true;
      }
    }
  }

  return false;
}

export function extractCandidateDedupKeys(raw: any): string[] {
  const keys: string[] = [];

  // 1. Engine precomputed strong fingerprints
  if (Array.isArray(raw.fingerprints)) {
    for (const fp of raw.fingerprints) {
      if (typeof fp === "string" && fp.trim()) {
        const trimmed = fp.trim().toLowerCase();
        if (
          trimmed.startsWith("place:") ||
          trimmed.startsWith("map:") ||
          trimmed.startsWith("web:") ||
          trimmed.startsWith("tel:") ||
          trimmed.startsWith("email:") ||
          trimmed.startsWith("ig:")
        ) {
          keys.push(trimmed);
        }
      }
    }
  }

  // 2. Maps link & Place ID normalization
  const placeId = extractPlaceId(raw);
  if (placeId) {
    keys.push(placeId);
  }
  const cleanMap = normalizeMapsUrl(raw.maps_link);
  if (cleanMap) {
    keys.push(`map:${cleanMap}`);
  }

  // 3. Website normalization (excludes platform domains like linktr.ee)
  const customDom = getCustomDomain(raw.website);
  if (customDom) {
    keys.push(`web:${customDom}`);
  }
  const platformUrl = getCanonicalPlatformUrl(raw.website);
  if (platformUrl) {
    keys.push(`web_path:${platformUrl}`);
  }

  // 4. Phone normalization: E.164 full number and 10-digit backward-compat for NANP
  const normPhone = normalizeFullPhone(raw.phone, raw.country_code);
  if (normPhone) {
    keys.push(`tel:${normPhone}`);
    if (normPhone.startsWith("+1") && normPhone.length === 12) {
      keys.push(`tel:${normPhone.slice(2)}`);
    }
  }

  // 5. Email normalization
  if (typeof raw.email === "string" && raw.email.trim()) {
    const email = raw.email.trim().toLowerCase();
    if (email.includes("@")) {
      keys.push(`email:${email}`);
    }
  }

  // 6. Instagram normalization
  if (typeof raw.instagram === "string" && raw.instagram.trim()) {
    let ig = raw.instagram.trim().toLowerCase().replace(/^@/, "");
    const match = ig.match(/instagram\.com\/([^/?#]+)/);
    if (match) ig = match[1];
    ig = ig.replace(/\/+$/, "");
    if (ig && !["p", "reel", "reels", "stories", "explore"].includes(ig)) {
      keys.push(`ig:${ig}`);
    }
  }

  return Array.from(new Set(keys));
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

    // 3. Query candidate eligible tasks strictly for active, non-terminal discovery plans
    let planQuery = desktopDeps.db
      .from("discovery_plans")
      .select("id, status, requested_count, delivered_count, created_at")
      .eq("user_id", userId)
      .in("status", ["queued", "planning", "running"])
      .order("created_at", { ascending: false });

    if (body.preferredPlanId) {
      planQuery = planQuery.eq("id", body.preferredPlanId);
    }

    const { data: userActivePlans, error: activePlansErr } = await planQuery;
    if (activePlansErr) throw activePlansErr;

    // Filter down to plans that are not already satisfied
    const eligiblePlans = (userActivePlans || []).filter(
      (p: any) => (p.delivered_count ?? 0) < (p.requested_count ?? 0),
    );

    if (eligiblePlans.length === 0) {
      return res.status(200).json({ task: null, reason: "no_active_plans" });
    }

    const eligiblePlanIds = eligiblePlans.map((p: any) => p.id);

    let query = desktopDeps.db
      .from("discovery_tasks")
      .select("id, plan_id, user_id, city, niche, country_code, country_name, candidate_budget, priority, status, last_heartbeat_at, task_summary, created_at")
      .eq("user_id", userId)
      .in("plan_id", eligiblePlanIds)
      .in("status", ["queued", "running"]);

    if (body.preferredTaskId) {
      query = query.eq("id", body.preferredTaskId);
    }

    const { data: candidateTasks, error: candidateError } = await query
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(20);

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

    // Sort eligible tasks so the newest active plan's tasks are claimed first,
    // and within each plan by priority descending then created_at ascending (Scout 1 -> 2 -> 3)
    const primaryPlanId = body.preferredPlanId && eligiblePlanIds.includes(body.preferredPlanId)
      ? body.preferredPlanId
      : eligiblePlanIds[0];

    eligibleTasks.sort((a: any, b: any) => {
      if (a.plan_id === primaryPlanId && b.plan_id !== primaryPlanId) return -1;
      if (b.plan_id === primaryPlanId && a.plan_id !== primaryPlanId) return 1;
      const planIndexA = eligiblePlanIds.indexOf(a.plan_id);
      const planIndexB = eligiblePlanIds.indexOf(b.plan_id);
      if (planIndexA !== planIndexB) return planIndexA - planIndexB;
      if ((b.priority ?? 0) !== (a.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });

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

    // Process candidates with intra-batch dedup and bounded concurrency
    const scoutId = task.task_summary?.scout_id ?? 1;
    const areaLabel = task.task_summary?.area_label ?? task.city;

    function buildCandidate(rawCandidate: any): EngineLead {
      return {
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
    }

    const seenBatchCandidates: any[] = [];
    const candidatesToProcess: Array<{ raw: any; candidate: EngineLead; isDuplicateInBatch: boolean }> = [];

    for (const rawCandidate of body.candidates) {
      const isDup = isDuplicateCandidateInBatch(rawCandidate, seenBatchCandidates);
      if (!isDup) {
        seenBatchCandidates.push(rawCandidate);
      }
      candidatesToProcess.push({
        raw: rawCandidate,
        candidate: buildCandidate(rawCandidate),
        isDuplicateInBatch: isDup,
      });
    }

    // Preserve safe parallelism for light DB operations (website, phone), while bounding
    // concurrency to 1 when enrichment subprocesses (email, instagram) are needed.
    const needsEnrichment = (plan.channels ?? []).some((c: string) => c === "email" || c === "instagram");
    const BATCH_CONCURRENCY = needsEnrichment ? 1 : 3;
    let nextCandidateIndex = 0;

    const candidateWorker = async () => {
      while (nextCandidateIndex < candidatesToProcess.length) {
        if (limitReached) break;
        const itemIndex = nextCandidateIndex++;
        const item = candidatesToProcess[itemIndex];

        if (item.isDuplicateInBatch) {
          duplicates++;
          rejectionReasons.duplicate = (rejectionReasons.duplicate || 0) + 1;
          continue;
        }

        const result = await desktopDeps.processCandidate({
          lead: item.candidate,
          planId: plan.id,
          effectiveScoutId: scoutId,
          areaLabel,
          pipelineId: item.raw.pipeline_id,
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
    };

    const workerCount = Math.min(BATCH_CONCURRENCY, candidatesToProcess.length);
    const workerPromises = Array.from({ length: workerCount }, () => candidateWorker());
    await Promise.all(workerPromises);

    // Refresh plan to check whether plan reached target or was cancelled
    const { data: currentPlan } = await desktopDeps.db
      .from("discovery_plans")
      .select("status, delivered_count, requested_count")
      .eq("id", task.plan_id)
      .maybeSingle();

    const planTargetReached = Boolean(
      currentPlan && (currentPlan.status === "cancelled" || currentPlan.delivered_count >= currentPlan.requested_count),
    );

    if (planTargetReached) {
      await desktopDeps.db
        .from("discovery_tasks")
        .update({
          status: "cancelled",
          termination_reason: "PLAN_TARGET_REACHED",
          completed_at: new Date().toISOString(),
        })
        .eq("plan_id", task.plan_id)
        .in("status", ["queued"]);
    }

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

    const sanitizedError = sanitizeWorkerError(body.error);

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
        error: sanitizedError,
      }),
    );

    const outcome = {
      discovered: body.discovered,
      accepted: body.accepted,
      rejected: body.rejected,
      duplicates: body.duplicates,
      exhausted: body.exhausted,
      status: body.status,
      error: sanitizedError,
      startedAt,
      completionReason: body.completionReason,
      terminationReason: body.terminationReason,
    };

    await desktopDeps.recordTaskOutcome(task, outcome);
    if (body.terminationReason === "PLAN_TARGET_REACHED" || body.completionReason === "target_reached") {
      await desktopDeps.db
        .from("discovery_tasks")
        .update({
          status: "cancelled",
          termination_reason: "PLAN_TARGET_REACHED",
          completed_at: new Date().toISOString(),
        })
        .eq("plan_id", task.plan_id)
        .in("status", ["queued"]);
    }
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
