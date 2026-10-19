import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { validateLead } from "../lib/leadValidation.js";
import { evaluateLeadQuality } from "../lib/leadQualityPolicy.js";
import { evaluateEarlyChannelPrune } from "./earlyPrune.js";
import { channelsSatisfied, mergeEnrichedChannels } from "../lib/channelFilter.js";
import { deliverLead, upsertBusinessFromEngineLead, type DeliveryResult } from "../scraperBridge/deliverLead.js";
import { enqueueBusinessProcessing, ensureEnriched, ensureIntelligence } from "../jobs/businessProcessingJob.js";
import { recordTimeToFirstLead } from "../lib/observability.js";
import {
  publishDiscoveryLiveEvent,
  candidateDiscoveredEvent,
  candidateRejectedEvent,
  leadDeliveredEvent,
} from "./liveDiscoveryEvent.js";
import type { EngineLead } from "../scraperBridge/pythonBridge.js";

/**
 * Dependency container for test seam mocking.
 */
export const candidatePipelineDeps = {
  db: supabaseAdmin as any,
  upsertBusinessFromEngineLead,
  enqueueBusinessProcessing,
  ensureEnriched,
  ensureIntelligence,
  deliverLead,
  recordTimeToFirstLead,
  publishDiscoveryLiveEvent,
};

/**
 * Baseline gate used before a lead is visible.
 * It intentionally relies only on independently observed Maps data:
 * identity, location, and a usable Maps contact/presence field.
 * Rich fields are validated later by dedicated jobs.
 */
export function validateDiscoveryCandidate(lead: EngineLead): { valid: true } | { valid: false; reason: string } {
  if (!lead.name?.trim()) return { valid: false, reason: "missing_name" };
  if (!lead.address?.trim()) return { valid: false, reason: "missing_address" };
  if (!lead.maps_link?.includes("google.")) return { valid: false, reason: "missing_maps_provenance" };
  if (lead.closed || lead.is_disqualified) return { valid: false, reason: "disqualified" };
  return validateLead(lead);
}

export interface ProcessCandidateParams {
  lead: EngineLead;
  planId: string;
  effectiveScoutId: number;
  areaLabel?: string;
  pipelineId?: string;
  requestedChannels: string[];
  userId: string;
  professionSlug?: string | null;
  region: string;
  scrapeJobId: string;
  dailyLimit?: number;
  monthlyLimit?: number;
  startedAt?: number;
}

export type ProcessCandidateResult =
  | { outcome: "accepted"; businessId: string; lead: EngineLead }
  | { outcome: "rejected"; reason: string; missingChannels?: string[] }
  | { outcome: "duplicate"; businessId: string }
  | { outcome: "limit_reached" };

/**
 * Canonical candidate processing pipeline shared between Cloud Workers
 * (discoveryPlanJob.ts) and Local Desktop Workers (desktop.ts).
 *
 * Implements the exact authoritative sequence:
 * 1. Publish candidateDiscoveredEvent (Realtime live stream).
 * 2. Validate candidate (provenance, name, address, closed status).
 * 3. Evaluate lead quality (minimum rating, review thresholds).
 * 4. Evaluate early channel prune (website / phone gating).
 * 5. Persist business row (upsert) and enqueue background enrichment.
 * 6. Synchronously ensure enrichment & intelligence if email/instagram requested.
 * 7. Post-enrichment channel satisfaction check & merge.
 * 8. Authoritative deliverLead (deduplication, limits, credit accounting).
 * 9. Publish live events (candidateRejectedEvent or leadDeliveredEvent).
 */
export async function processDiscoveredCandidate(
  params: ProcessCandidateParams,
  customDeps?: Partial<typeof candidatePipelineDeps>,
): Promise<ProcessCandidateResult> {
  const deps = { ...candidatePipelineDeps, ...customDeps };
  const pid = params.pipelineId ?? params.lead._pipeline_id ?? `lead:${Date.now()}`;

  // 1. Emit live discovery event for candidate discovery
  deps.publishDiscoveryLiveEvent(
    candidateDiscoveredEvent(params.planId, params.effectiveScoutId, pid, params.lead.name, params.areaLabel),
  );

  // 2. Baseline Maps validation
  const validation = validateDiscoveryCandidate(params.lead);
  if (!validation.valid) {
    const reason = `validateDiscoveryCandidate:${validation.reason}`;
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, reason, params.areaLabel, params.lead.name, "invalid_business"),
    );
    return { outcome: "rejected", reason };
  }

  // 3. Lead quality policy gate (rating / reviews)
  const quality = evaluateLeadQuality({ rating: params.lead.rating, reviews: params.lead.reviews });
  if (quality.reject) {
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, quality.reason, params.areaLabel, params.lead.name, "low_viability"),
    );
    return { outcome: "rejected", reason: quality.reason };
  }

  // 4. Early channel prune
  const requestedChannels = params.requestedChannels;
  const earlyPrune = evaluateEarlyChannelPrune(params.lead, requestedChannels);
  if (earlyPrune.prune) {
    const cat = earlyPrune.reason.includes("website") ? "missing_website" : "missing_contact";
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, earlyPrune.reason, params.areaLabel, params.lead.name, cat),
    );
    return { outcome: "rejected", reason: earlyPrune.reason, missingChannels: earlyPrune.missing };
  }

  // 5. Persist business row & enqueue async enrichment
  const businessId = await deps.upsertBusinessFromEngineLead(
    params.lead,
    params.region,
    undefined,
    params.scrapeJobId,
  );
  await deps.enqueueBusinessProcessing(businessId, "enrich");

  let deliverable = params.lead;
  const needsEnrichmentToDecide = requestedChannels.some((c) => c === "email" || c === "instagram");

  // 6. Enrich if required by requested channels
  if (needsEnrichmentToDecide) {
    try {
      await deps.ensureEnriched(businessId);
      if (requestedChannels.includes("instagram")) {
        await deps.ensureIntelligence(businessId);
      }
    } catch (enrichErr) {
      console.warn(
        `[candidatePipeline] ensureEnriched/ensureIntelligence failed for businessId=${businessId}:`,
        enrichErr,
      );
      deps.publishDiscoveryLiveEvent(
        candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, "ensureEnriched_threw", params.areaLabel, params.lead.name, "enrichment_failure"),
      );
      return { outcome: "rejected", reason: "ensureEnriched_threw" };
    }

    const { data: enriched } = await deps.db
      .from("businesses")
      .select("email, phone, instagram, website")
      .eq("id", businessId)
      .maybeSingle();

    const satisfied = Boolean(enriched) && channelsSatisfied(enriched, requestedChannels);
    if (!satisfied) {
      const reason = `post_enrichment_channel_gate:requested=${JSON.stringify(requestedChannels)}`;
      const cat = reason.includes("website") ? "missing_website" : "missing_contact";
      deps.publishDiscoveryLiveEvent(
        candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, reason, params.areaLabel, params.lead.name, cat),
      );
      return { outcome: "rejected", reason };
    }
    deliverable = mergeEnrichedChannels(params.lead, enriched);
  }

  // 7. Deliver lead (authoritative deduplication, user limits, and credit accounting)
  const delivery: DeliveryResult = await deps.deliverLead(
    deliverable,
    {
      userId: params.userId,
      professionSlug: params.professionSlug ?? null,
      discoveryMode: "live",
      scrapeJobId: params.scrapeJobId,
      dailyLimit: params.dailyLimit ?? 0,
      monthlyLimit: params.monthlyLimit ?? 0,
      discoveryPlanId: params.planId,
    },
    params.region,
    businessId,
  );

  if (delivery.limitReached) {
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, "plan_limit_reached", params.areaLabel, params.lead.name),
    );
    return { outcome: "limit_reached" };
  }

  if (!delivery.wasNewForUser) {
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(
        params.planId,
        params.effectiveScoutId,
        pid,
        "duplicate_already_owned_by_user",
        params.areaLabel,
        params.lead.name,
        "duplicate",
      ),
    );
    return { outcome: "duplicate", businessId };
  }

  // 8. Lead accepted and delivered
  if (params.startedAt) {
    const elapsedMs = Date.now() - params.startedAt;
    deps.recordTimeToFirstLead(params.planId, elapsedMs);
  }

  deps.publishDiscoveryLiveEvent(
    leadDeliveredEvent(params.planId, params.effectiveScoutId, pid, params.lead.name, params.areaLabel),
  );

  return { outcome: "accepted", businessId, lead: deliverable };
}
