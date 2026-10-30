/**
 * src/discovery/candidateFunnelTelemetry.ts
 *
 * Candidate Funnel Telemetry for MAST Live Discovery.
 *
 * Tracks every candidate through the 9-stage qualification and delivery funnel:
 * 1. Maps businesses discovered
 * 2. Already-owned user duplicates skipped
 * 3. New candidates eligible for enrichment
 * 4. Contacts successfully extracted (with source attribution)
 * 5. Contact enrichment failures
 * 6. Candidates rejected for missing required channels
 * 7. Candidates rejected for quality/relevance
 * 8. Candidates reaching delivery
 * 9. Successfully delivered leads
 *
 * Contact source attribution:
 * - google_maps: Provided directly by Google Maps listing
 * - website_homepage: Extracted from website homepage HTML
 * - contact_subpage: Extracted from /contact or /about subpage
 * - jsonld: Extracted from JSON-LD structured business data
 * - contact_intel: Extracted from existing contact intelligence / anchors
 *
 * Non-Functional Guarantees:
 * - No PII logging: Never logs names, phone numbers, emails, raw HTML, or credentials.
 * - Non-fatal: Logging failures must never interrupt discovery.
 * - Separation: Cumulative retries are tracked separately from unique candidates.
 */

export type ContactSource =
  | "google_maps"
  | "website_homepage"
  | "contact_subpage"
  | "jsonld"
  | "contact_intel";

export type DuplicateSkipStage =
  | "pre_click_place_id"
  | "post_upsert_owned_lead"
  | "authoritative_delivery_dedup";

export interface CandidateFunnelCounts {
  mapsDiscovered: number;
  userDuplicatesSkipped: number;
  newCandidatesEligible: number;
  contactsExtracted: number;
  enrichmentFailures: number;
  rejectedMissingChannels: number;
  rejectedQualityRelevance: number;
  candidatesReachingDelivery: number;
  deliveredLeads: number;
  retriesTotal: number;
}

export interface CandidateFunnelBreakdowns {
  duplicatesByStage: Record<DuplicateSkipStage | string, number>;
  contactsBySource: Record<ContactSource, number>;
  enrichmentFailuresByReason: Record<string, number>;
  missingChannels: Record<string, number>;
  qualityRejectionsByReason: Record<string, number>;
}

export interface CandidateFunnelSnapshot {
  planId: string;
  uniqueCandidateCount: number;
  counts: CandidateFunnelCounts;
  breakdowns: CandidateFunnelBreakdowns;
}

class PlanFunnelTracker {
  private readonly planId: string;
  private readonly seenPipelines = new Set<string>();
  private retries = 0;

  private readonly counts: CandidateFunnelCounts = {
    mapsDiscovered: 0,
    userDuplicatesSkipped: 0,
    newCandidatesEligible: 0,
    contactsExtracted: 0,
    enrichmentFailures: 0,
    rejectedMissingChannels: 0,
    rejectedQualityRelevance: 0,
    candidatesReachingDelivery: 0,
    deliveredLeads: 0,
    retriesTotal: 0,
  };

  private readonly breakdowns: CandidateFunnelBreakdowns = {
    duplicatesByStage: {},
    contactsBySource: {
      google_maps: 0,
      website_homepage: 0,
      contact_subpage: 0,
      jsonld: 0,
      contact_intel: 0,
    },
    enrichmentFailuresByReason: {},
    missingChannels: {},
    qualityRejectionsByReason: {},
  };

  constructor(planId: string) {
    this.planId = planId;
  }

  private registerCandidate(pipelineId?: string): boolean {
    if (!pipelineId) return true;
    if (this.seenPipelines.has(pipelineId)) {
      this.retries++;
      this.counts.retriesTotal = this.retries;
      return false; // Already seen candidate (retry / re-observation)
    }
    this.seenPipelines.add(pipelineId);
    return true;
  }

  recordDiscovered(pipelineId?: string): void {
    const isNew = this.registerCandidate(pipelineId);
    if (isNew) {
      this.counts.mapsDiscovered++;
      this.safeLog("maps_discovered", { pipelineId });
    }
  }

  recordDuplicateSkipped(stage: DuplicateSkipStage | string, pipelineId?: string): void {
    this.counts.userDuplicatesSkipped++;
    this.breakdowns.duplicatesByStage[stage] = (this.breakdowns.duplicatesByStage[stage] ?? 0) + 1;
    this.safeLog("duplicate_skipped", { stage, pipelineId });
  }

  recordEligibleForEnrichment(pipelineId?: string): void {
    this.counts.newCandidatesEligible++;
    this.safeLog("eligible_for_enrichment", { pipelineId });
  }

  recordContactExtracted(sources: ContactSource[], pipelineId?: string): void {
    this.counts.contactsExtracted++;
    for (const src of sources) {
      if (src in this.breakdowns.contactsBySource) {
        this.breakdowns.contactsBySource[src]++;
      } else {
        this.breakdowns.contactsBySource[src] = 1;
      }
    }
    this.safeLog("contacts_extracted", { sources, pipelineId });
  }

  recordEnrichmentFailure(reason: string, pipelineId?: string): void {
    this.counts.enrichmentFailures++;
    const safeReason = reason.replace(/[:=].*$/, "");
    this.breakdowns.enrichmentFailuresByReason[safeReason] =
      (this.breakdowns.enrichmentFailuresByReason[safeReason] ?? 0) + 1;
    this.safeLog("enrichment_failure", { reason: safeReason, pipelineId });
  }

  recordMissingChannelRejection(missingChannels: string[], pipelineId?: string): void {
    this.counts.rejectedMissingChannels++;
    for (const ch of missingChannels) {
      this.breakdowns.missingChannels[ch] = (this.breakdowns.missingChannels[ch] ?? 0) + 1;
    }
    this.safeLog("rejected_missing_channels", { missingChannels, pipelineId });
  }

  recordQualityRejection(reason: string, pipelineId?: string): void {
    this.counts.rejectedQualityRelevance++;
    const safeReason = reason.replace(/[:=].*$/, "");
    this.breakdowns.qualityRejectionsByReason[safeReason] =
      (this.breakdowns.qualityRejectionsByReason[safeReason] ?? 0) + 1;
    this.safeLog("rejected_quality_relevance", { reason: safeReason, pipelineId });
  }

  recordReachingDelivery(pipelineId?: string): void {
    this.counts.candidatesReachingDelivery++;
    this.safeLog("reaching_delivery", { pipelineId });
  }

  recordDelivered(pipelineId?: string): void {
    this.counts.deliveredLeads++;
    this.safeLog("delivered", { pipelineId });
  }

  getSnapshot(): CandidateFunnelSnapshot {
    return {
      planId: this.planId,
      uniqueCandidateCount: this.seenPipelines.size,
      counts: { ...this.counts },
      breakdowns: {
        duplicatesByStage: { ...this.breakdowns.duplicatesByStage },
        contactsBySource: { ...this.breakdowns.contactsBySource },
        enrichmentFailuresByReason: { ...this.breakdowns.enrichmentFailuresByReason },
        missingChannels: { ...this.breakdowns.missingChannels },
        qualityRejectionsByReason: { ...this.breakdowns.qualityRejectionsByReason },
      },
    };
  }

  private safeLog(stage: string, detail: Record<string, unknown>): void {
    try {
      const correlation = detail.pipelineId ? ` pid=${detail.pipelineId}` : "";
      const extra = Object.entries(detail)
        .filter(([k]) => k !== "pipelineId")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      console.log(`[candidate-funnel][plan=${this.planId}] stage=${stage}${correlation} ${extra}`.trim());
    } catch {
      // Logging failures must never interrupt discovery
    }
  }
}

const activeTrackers = new Map<string, PlanFunnelTracker>();

export function getCandidateFunnelTracker(planId: string): PlanFunnelTracker {
  let tracker = activeTrackers.get(planId);
  if (!tracker) {
    tracker = new PlanFunnelTracker(planId);
    activeTrackers.set(planId, tracker);
  }
  return tracker;
}

export function clearCandidateFunnelTracker(planId: string): void {
  activeTrackers.delete(planId);
}
