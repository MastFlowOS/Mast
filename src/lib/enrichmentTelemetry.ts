/**
 * PHASE 29 — Truthful Enrichment Telemetry Correctness.
 *
 * Provides accurate, live measurement for:
 *   - website_active: number of jobs currently executing Website/Contact work.
 *   - contact_active: tracks the same underlying active enrichment execution
 *     (since Website + Contact execute in the same enrichment subprocess).
 *   - instagram_active: number of business-score / Instagram jobs currently executing.
 *   - enrichment_queue_depth: pg-boss queue depth for businessEnrich queue.
 *   - intelligence_queue_depth: pg-boss queue depth for businessScore queue.
 *
 * Lifecycle and Safety Guarantees:
 *   - Active counters increment exactly when actual enrichment/scoring work starts.
 *   - Active counters decrement exactly when work finishes, fails, times out, or cancels.
 *   - Decrement is strictly wrapped in try/finally blocks.
 *   - Counters are clamped to 0 to prevent underflow (never negative).
 *   - Queue depth queries pg-boss's getQueueSize().
 *   - Confirmed empty queue returns 0.
 *   - Queue depth measurement failures return "unavailable" (never false 0).
 */

export type EnrichmentTelemetrySnapshot = {
  website_active: number;
  contact_active: number;
  instagram_active: number;
  enrichment_active_total: number;
  intelligence_active_total: number;
};

export type QueueDepthMeasurement = number | "unavailable";

// In-process live execution counters
let websiteContactActive = 0;
let instagramActive = 0;

/** Increments active website/contact enrichment count. */
export function incrementActiveEnrichment(): void {
  websiteContactActive += 1;
}

/** Decrements active website/contact enrichment count with underflow protection. */
export function decrementActiveEnrichment(): void {
  websiteContactActive = Math.max(0, websiteContactActive - 1);
}

/** Increments active instagram/score intelligence count. */
export function incrementActiveIntelligence(): void {
  instagramActive += 1;
}

/** Decrements active instagram/score intelligence count with underflow protection. */
export function decrementActiveIntelligence(): void {
  instagramActive = Math.max(0, instagramActive - 1);
}

/**
 * Executes an enrichment task with guaranteed active count increment on start
 * and decrement on completion, error, timeout, or cancellation.
 */
export async function trackActiveEnrichment<T>(fn: () => Promise<T>): Promise<T> {
  incrementActiveEnrichment();
  try {
    return await fn();
  } finally {
    decrementActiveEnrichment();
  }
}

/**
 * Executes an intelligence task with guaranteed active count increment on start
 * and decrement on completion, error, timeout, or cancellation.
 */
export async function trackActiveIntelligence<T>(fn: () => Promise<T>): Promise<T> {
  incrementActiveIntelligence();
  try {
    return await fn();
  } finally {
    decrementActiveIntelligence();
  }
}

/** Returns the current in-process enrichment telemetry snapshot. */
export function getEnrichmentTelemetrySnapshot(): EnrichmentTelemetrySnapshot {
  return {
    website_active: websiteContactActive,
    contact_active: websiteContactActive,
    instagram_active: instagramActive,
    enrichment_active_total: websiteContactActive,
    intelligence_active_total: instagramActive,
  };
}

/**
 * Measures the queue depth for a given pg-boss queue name using pg-boss's getQueueSize().
 *
 * Emits 0 when the queue is confirmed empty.
 * Emits "unavailable" when measurement cannot be performed or throws, avoiding false zeros.
 */
export async function getEnrichmentQueueDepth(
  boss: { getQueueSize?: (name: string) => Promise<number> } | null | undefined,
  queueName: string,
): Promise<QueueDepthMeasurement> {
  if (!boss || typeof boss.getQueueSize !== "function") {
    return "unavailable";
  }
  try {
    const size = await boss.getQueueSize(queueName);
    if (typeof size === "number" && !Number.isNaN(size)) {
      return size;
    }
    return "unavailable";
  } catch (err) {
    console.warn(`[enrichment-telemetry] getQueueSize failed for queue "${queueName}" (non-fatal):`, err);
    return "unavailable";
  }
}

/**
 * Formats the enrichment telemetry log line for the 30-second heartbeat.
 */
export function formatEnrichmentTelemetryLog(
  snapshot: EnrichmentTelemetrySnapshot,
  queueDepths: { enrichment_queue_depth: QueueDepthMeasurement; intelligence_queue_depth: QueueDepthMeasurement },
): string {
  return (
    `[worker][enrichment-telemetry] website_active=${snapshot.website_active} ` +
    `contact_active=${snapshot.contact_active} instagram_active=${snapshot.instagram_active} ` +
    `enrichment_queue_depth=${queueDepths.enrichment_queue_depth} ` +
    `intelligence_queue_depth=${queueDepths.intelligence_queue_depth} ` +
    `enrichment_active_total=${snapshot.enrichment_active_total} ` +
    `intelligence_active_total=${snapshot.intelligence_active_total}`
  );
}

/** Reset helper for test isolation. */
export function resetEnrichmentTelemetry(): void {
  websiteContactActive = 0;
  instagramActive = 0;
  resetPhase0SubprocessMetrics();
}

// ---------------------------------------------------------------------------
// Phase 0 — Subprocess execution timing & non-production score-parity counters
// ---------------------------------------------------------------------------

export type SubprocessStageKind = "website_enrich" | "instagram_enrich" | "opportunity_score";

export type Phase0SubprocessMetrics = {
  website_enrich_count: number;
  website_enrich_total_ms: number;
  instagram_enrich_count: number;
  instagram_enrich_total_ms: number;
  opportunity_score_count: number;
  opportunity_score_total_ms: number;
  score_parity_checks_total: number;
  score_parity_matched: number;
  score_parity_diverged: number;
  score_parity_divergences: Array<{
    businessId: string;
    professionSlug: string;
    enrichScore: number;
    scoreSubprocessScore: number;
  }>;
};

const phase0Metrics: Phase0SubprocessMetrics = {
  website_enrich_count: 0,
  website_enrich_total_ms: 0,
  instagram_enrich_count: 0,
  instagram_enrich_total_ms: 0,
  opportunity_score_count: 0,
  opportunity_score_total_ms: 0,
  score_parity_checks_total: 0,
  score_parity_matched: 0,
  score_parity_diverged: 0,
  score_parity_divergences: [],
};

/** Records a single subprocess execution count and duration (ms). */
export function recordSubprocessExecution(kind: SubprocessStageKind, durationMs: number): void {
  const safeMs = Math.max(0, Math.round(durationMs));
  if (kind === "website_enrich") {
    phase0Metrics.website_enrich_count += 1;
    phase0Metrics.website_enrich_total_ms += safeMs;
  } else if (kind === "instagram_enrich") {
    phase0Metrics.instagram_enrich_count += 1;
    phase0Metrics.instagram_enrich_total_ms += safeMs;
  } else if (kind === "opportunity_score") {
    phase0Metrics.opportunity_score_count += 1;
    phase0Metrics.opportunity_score_total_ms += safeMs;
  }
}

/**
 * Records a non-production/test-mode score parity comparison between the
 * `service.py enrich` (`ScoringWorker`) profession_scores list and the
 * `service.py score` (`score_business_v2`) profession_scores map.
 * Never mutates persisted scores or qualification behavior.
 */
export function recordScoreParityCheck(
  businessId: string,
  enrichProfessionScores: unknown,
  scoreSubprocessProfessionScores: Record<string, { score: number }> | undefined,
): { matched: boolean; divergedSlugs: string[] } {
  if (!enrichProfessionScores || typeof enrichProfessionScores !== "object" || !scoreSubprocessProfessionScores) {
    return { matched: false, divergedSlugs: [] };
  }

  const normalizedEntries: Array<{ slug: string; enrichScore: number }> = [];
  if (Array.isArray(enrichProfessionScores)) {
    for (const item of enrichProfessionScores) {
      if (!item || typeof item !== "object") continue;
      const slug = (item as Record<string, unknown>).profession_slug;
      const rawScore =
        (item as Record<string, unknown>).score ??
        (item as Record<string, unknown>).opportunity_score;
      if (typeof slug === "string" && typeof rawScore === "number") {
        normalizedEntries.push({ slug, enrichScore: rawScore });
      }
    }
  } else {
    for (const [slug, val] of Object.entries(enrichProfessionScores as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const rawScore =
        (val as Record<string, unknown>).score ??
        (val as Record<string, unknown>).opportunity_score;
      if (typeof rawScore === "number") {
        normalizedEntries.push({ slug, enrichScore: rawScore });
      }
    }
  }

  if (normalizedEntries.length === 0) {
    return { matched: false, divergedSlugs: [] };
  }

  phase0Metrics.score_parity_checks_total += 1;
  const divergedSlugs: string[] = [];

  for (const { slug, enrichScore } of normalizedEntries) {
    const subEntry = scoreSubprocessProfessionScores[slug];
    const subScore = subEntry?.score;
    if (typeof subScore !== "number" || Math.abs(enrichScore - subScore) > 1e-6) {
      divergedSlugs.push(slug);
      if (phase0Metrics.score_parity_divergences.length < 100) {
        phase0Metrics.score_parity_divergences.push({
          businessId,
          professionSlug: slug,
          enrichScore,
          scoreSubprocessScore: typeof subScore === "number" ? subScore : NaN,
        });
      }
    }
  }

  if (divergedSlugs.length === 0) {
    phase0Metrics.score_parity_matched += 1;
    return { matched: true, divergedSlugs: [] };
  }

  phase0Metrics.score_parity_diverged += 1;
  return { matched: false, divergedSlugs };
}

/** Returns a defensive copy of the Phase 0 subprocess & parity metrics. */
export function getPhase0SubprocessMetrics(): Phase0SubprocessMetrics {
  return {
    ...phase0Metrics,
    score_parity_divergences: [...phase0Metrics.score_parity_divergences],
  };
}

/** Resets Phase 0 subprocess & parity metrics (called by resetEnrichmentTelemetry). */
export function resetPhase0SubprocessMetrics(): void {
  phase0Metrics.website_enrich_count = 0;
  phase0Metrics.website_enrich_total_ms = 0;
  phase0Metrics.instagram_enrich_count = 0;
  phase0Metrics.instagram_enrich_total_ms = 0;
  phase0Metrics.opportunity_score_count = 0;
  phase0Metrics.opportunity_score_total_ms = 0;
  phase0Metrics.score_parity_checks_total = 0;
  phase0Metrics.score_parity_matched = 0;
  phase0Metrics.score_parity_diverged = 0;
  phase0Metrics.score_parity_divergences = [];
}
