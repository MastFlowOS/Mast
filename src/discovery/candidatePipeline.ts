import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { validateLead, isValidPhone, isValidEmail } from "../lib/leadValidation.js";
import { evaluateLeadQuality } from "../lib/leadQualityPolicy.js";
import { evaluateEarlyChannelPrune } from "./earlyPrune.js";
import { channelsSatisfied, mergeEnrichedChannels } from "../lib/channelFilter.js";
import { deliverLead, upsertBusinessFromEngineLead, type DeliveryResult } from "../scraperBridge/deliverLead.js";
import { enqueueBusinessProcessing, ensureEnriched, ensureIntelligence, PidAdmissionUnavailableError } from "../jobs/businessProcessingJob.js";
import { recordTimeToFirstLead } from "../lib/observability.js";
import {
  publishDiscoveryLiveEvent,
  candidateDiscoveredEvent,
  candidateRejectedEvent,
  leadDeliveredEvent,
} from "./liveDiscoveryEvent.js";
import { getCandidateFunnelTracker, type ContactSource } from "./candidateFunnelTelemetry.js";
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
  signal?: AbortSignal;
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
 * Implements the authoritative sequence:
 * 1. Publish candidateDiscoveredEvent (Realtime live stream & Funnel Telemetry).
 * 2. Validate candidate (provenance, name, address, closed status).
 * 3. Evaluate lead quality (minimum rating, review thresholds).
 * 4. Evaluate early channel prune (do NOT reject if missing channel can be discovered via website).
 * 5. Persist business row (upsert).
 * 5a. Early user duplicate check: skip before expensive enrichment if already owned by this user.
 * 6. Synchronously ensure enrichment & intelligence if needed to decide requested channels.
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
  const funnel = getCandidateFunnelTracker(params.planId);

  // 1. Candidate discovery
  funnel.recordDiscovered(pid);
  deps.publishDiscoveryLiveEvent(
    candidateDiscoveredEvent(params.planId, params.effectiveScoutId, pid, params.lead.name, params.areaLabel),
  );

  // 2. Baseline Maps validation
  const validation = validateDiscoveryCandidate(params.lead);
  if (!validation.valid) {
    const reason = `validateDiscoveryCandidate:${validation.reason}`;
    funnel.recordQualityRejection(reason, pid);
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, reason, params.areaLabel, params.lead.name, "invalid_business"),
    );
    return { outcome: "rejected", reason };
  }

  // 3. Lead quality policy gate (rating / reviews)
  const quality = evaluateLeadQuality({ rating: params.lead.rating, reviews: params.lead.reviews });
  if (quality.reject) {
    funnel.recordQualityRejection(quality.reason, pid);
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, quality.reason, params.areaLabel, params.lead.name, "low_viability"),
    );
    return { outcome: "rejected", reason: quality.reason };
  }

  // 4. Early channel prune
  // If a requested channel is missing from Maps but can still be discovered from an available website,
  // do NOT reject the candidate before giving enrichment an opportunity to find it.
  const requestedChannels = params.requestedChannels;
  const earlyPrune = evaluateEarlyChannelPrune(params.lead, requestedChannels);
  if (earlyPrune.prune) {
    const cat = earlyPrune.reason.includes("website") ? "missing_website" : "missing_contact";
    funnel.recordMissingChannelRejection(earlyPrune.missing, pid);
    deps.publishDiscoveryLiveEvent(
      candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, earlyPrune.reason, params.areaLabel, params.lead.name, cat),
    );
    return { outcome: "rejected", reason: earlyPrune.reason, missingChannels: earlyPrune.missing };
  }

  // 5. Persist business row
  const businessId = await deps.upsertBusinessFromEngineLead(
    params.lead,
    params.region,
    undefined,
    params.scrapeJobId,
  );

  // 5a. Early user duplicate check: skip before expensive enrichment if already owned by this user
  if (params.userId) {
    const { data: existingUserLead } = await deps.db
      .from("leads")
      .select("id")
      .eq("user_id", params.userId)
      .eq("business_id", businessId)
      .maybeSingle();

    if (existingUserLead) {
      funnel.recordDuplicateSkipped("post_upsert_owned_lead", pid);
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
  }

  // Candidate is new for this user and eligible for enrichment
  funnel.recordEligibleForEnrichment(pid);
  await deps.enqueueBusinessProcessing(businessId, "enrich");

  let deliverable = params.lead;
  // Needs enrichment if email/instagram requested, OR if a requested channel is not yet satisfied on Maps lead and website is present
  const needsEnrichmentToDecide =
    requestedChannels.some((c) => c === "email" || c === "instagram") ||
    (!channelsSatisfied(params.lead, requestedChannels) && Boolean(params.lead.website));

  // 6. Enrich if required by requested channels
  if (needsEnrichmentToDecide) {
    const admissionDeadlineMs = 5000;
    const pollIntervalMs = 250;
    const startTime = Date.now();
    let enrichmentSucceeded = false;

    while (Date.now() - startTime < admissionDeadlineMs) {
      if (params.signal?.aborted) {
        return { outcome: "rejected", reason: "pipeline_aborted" };
      }
      try {
        await deps.ensureEnriched(businessId);
        if (requestedChannels.includes("instagram")) {
          await deps.ensureIntelligence(businessId);
        }
        enrichmentSucceeded = true;
        break;
      } catch (enrichErr) {
        const isAdmissionErr =
          enrichErr instanceof PidAdmissionUnavailableError ||
          (enrichErr instanceof Error &&
            (enrichErr.name === "PidAdmissionUnavailableError" ||
              enrichErr.message.includes("admission unavailable") ||
              enrichErr.message.includes("ADMISSION_BLOCKED"))) ||
          String(enrichErr).includes("admission unavailable");

        if (isAdmissionErr) {
          const elapsed = Date.now() - startTime;
          const remaining = admissionDeadlineMs - elapsed;
          if (remaining <= 0) break;
          await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
          continue;
        }

        console.warn(
          `[candidatePipeline] ensureEnriched/ensureIntelligence failed for businessId=${businessId}:`,
          enrichErr,
        );
        funnel.recordEnrichmentFailure("ensureEnriched_threw", pid);
        deps.publishDiscoveryLiveEvent(
          candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, "ensureEnriched_threw", params.areaLabel, params.lead.name, "enrichment_failure"),
        );
        return { outcome: "rejected", reason: "ensureEnriched_threw" };
      }
    }

    if (!enrichmentSucceeded) {
      const reason = "enrichment_failure:admission_timeout";
      console.warn(
        `[candidatePipeline] enrichment admission timed out after ${Date.now() - startTime}ms for businessId=${businessId}`,
      );
      funnel.recordEnrichmentFailure(reason, pid);
      deps.publishDiscoveryLiveEvent(
        candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, reason, params.areaLabel, params.lead.name, "enrichment_failure"),
      );
      return { outcome: "rejected", reason };
    }

    const { data: enriched } = await deps.db
      .from("businesses")
      .select("email, phone, instagram, website, field_provenance")
      .eq("id", businessId)
      .maybeSingle();

    deliverable = mergeEnrichedChannels(params.lead, enriched);
    const satisfied = channelsSatisfied(deliverable, requestedChannels);

    if (!satisfied) {
      const reason = `post_enrichment_channel_gate:requested=${JSON.stringify(requestedChannels)}`;
      const cat = reason.includes("website") ? "missing_website" : "missing_contact";
      const missingNow = requestedChannels.filter((c) => !channelsSatisfied(deliverable, [c]));
      funnel.recordMissingChannelRejection(missingNow, pid);
      deps.publishDiscoveryLiveEvent(
        candidateRejectedEvent(params.planId, params.effectiveScoutId, pid, reason, params.areaLabel, params.lead.name, cat),
      );
      return { outcome: "rejected", reason };
    }

    // Record contact extraction attribution
    const sources: ContactSource[] = [];
    if (params.lead.phone && isValidPhone(params.lead.phone)) {
      sources.push("google_maps");
    }
    if (enriched?.phone && isValidPhone(enriched.phone) && enriched.phone !== params.lead.phone) {
      sources.push("website_homepage");
    }
    if (enriched?.email && isValidEmail(enriched.email)) {
      sources.push("website_homepage");
    }
    if (sources.length === 0) {
      sources.push(params.lead.maps_link ? "google_maps" : "website_homepage");
    }
    funnel.recordContactExtracted(sources, pid);
  }

  // 7. Deliver lead (authoritative deduplication, user limits, and credit accounting)
  funnel.recordReachingDelivery(pid);
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
    funnel.recordDuplicateSkipped("authoritative_delivery_dedup", pid);
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

  funnel.recordDelivered(pid);
  deps.publishDiscoveryLiveEvent(
    leadDeliveredEvent(params.planId, params.effectiveScoutId, pid, params.lead.name, params.areaLabel),
  );

  return { outcome: "accepted", businessId, lead: deliverable };
}
