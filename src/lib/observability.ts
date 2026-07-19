/**
 * Phase 7 — Lead Engine Observability helpers.
 *
 * ALL functions in this module are fire-and-forget and best-effort.
 * They are wrapped in try/catch so that any failure while recording
 * observability data NEVER impacts discovery, enrichment, intelligence,
 * or job completion.  Callers must not await these if timing is critical.
 *
 * Design decisions:
 *  • Uses `supabaseAdmin` (service-role) so RLS never blocks metric writes.
 *  • Metric rows are upserted / atomically incremented so concurrent
 *    task workers can update the same plan's row without races.
 *  • The `lead_engine_job_metrics` row is keyed on `discovery_plan_id`,
 *    which is a 1-to-1 mapping with `discovery_plans.id`.
 *  • For the Free-tier `discover.live` flow (which has no discovery_plan),
 *    pass `null` for `planId` — the functions will be no-ops.
 */

import { supabaseAdmin } from "./supabaseAdmin.js";

const db = supabaseAdmin as any;

// ---------------------------------------------------------------------------
// Job-level lifecycle
// ---------------------------------------------------------------------------

/** Called when a discovery plan starts execution. Initializes the metrics row. */
export function initJobMetrics(opts: {
  planId: string;
  scrapeJobId: string;
  userId: string;
  requestedCount: number;
}): void {
  // Fire-and-forget — do not await.
  (async () => {
    try {
      await db.from("lead_engine_job_metrics").upsert(
        {
          id: opts.planId,
          scrape_job_id: opts.scrapeJobId,
          user_id: opts.userId,
          requested_count: opts.requestedCount,
          delivered_count: 0,
          completion_status: "running",
          started_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    } catch (err) {
      console.warn("[observability] initJobMetrics failed (non-fatal):", err);
    }
  })();
}

/** Called when a discovery plan finishes. Finalizes the metrics row. */
export function finalizeJobMetrics(opts: {
  planId: string;
  deliveredCount: number;
  completionStatus: "completed" | "completed_partial" | "failed" | "cancelled";
}): void {
  (async () => {
    try {
      const now = new Date().toISOString();
      // Read started_at to compute runtime — do a lightweight select first.
      const { data } = await db
        .from("lead_engine_job_metrics")
        .select("started_at")
        .eq("id", opts.planId)
        .maybeSingle();

      const runtimeMs = data?.started_at
        ? Date.now() - Date.parse(data.started_at)
        : null;

      await db.from("lead_engine_job_metrics").update({
        delivered_count: opts.deliveredCount,
        completion_status: opts.completionStatus,
        completed_at: now,
        runtime_ms: runtimeMs,
      }).eq("id", opts.planId);
    } catch (err) {
      console.warn("[observability] finalizeJobMetrics failed (non-fatal):", err);
    }
  })();
}

/** Records the time-to-first-lead once (idempotent — COALESCE guard in DB). */
export function recordTimeToFirstLead(planId: string, elapsedMs: number): void {
  (async () => {
    try {
      // Use a raw RPC update so COALESCE is atomic.  Falls back gracefully
      // if the row doesn't exist (e.g. plan created before this migration).
      await db.rpc("record_time_to_first_lead" as any, {
        p_plan_id: planId,
        p_elapsed_ms: Math.round(elapsedMs),
      } as any);
    } catch {
      // The RPC may not exist on older deployments — silently skip.
    }
  })();
}

// ---------------------------------------------------------------------------
// Discovery stage increments
// ---------------------------------------------------------------------------

/** Increments discovery counters for a completed discovery task. */
export function incrementDiscoveryMetrics(
  planId: string | null | undefined,
  delta: {
    businessesDiscovered?: number;
    mapsScrollRounds?: number;
    duplicateCount?: number;
    searchExhaustionReason?: string;
  },
): void {
  if (!planId) return;
  (async () => {
    try {
      await db.rpc("increment_job_discovery_metrics" as any, {
        p_plan_id: planId,
        p_businesses_discovered: delta.businessesDiscovered ?? 0,
        p_maps_scroll_rounds: delta.mapsScrollRounds ?? 0,
        p_duplicate_count: delta.duplicateCount ?? 0,
        p_search_exhaustion_reason: delta.searchExhaustionReason ?? null,
      } as any);
    } catch {
      // Silently skip if function doesn't exist yet.
    }
  })();
}

// ---------------------------------------------------------------------------
// Enrichment stage increments
// ---------------------------------------------------------------------------

/** Increments enrichment stage metrics atomically. */
export function incrementEnrichmentMetrics(
  planId: string | null | undefined,
  delta: {
    websiteSuccess?: number;
    websiteFailure?: number;
    crawlTimeMs?: number;
    emailSuccess?: number;
    phoneSuccess?: number;
  },
): void {
  if (!planId) return;
  (async () => {
    try {
      await db.rpc("increment_job_enrichment_metrics" as any, {
        p_plan_id: planId,
        p_website_success: delta.websiteSuccess ?? 0,
        p_website_failure: delta.websiteFailure ?? 0,
        p_crawl_time_ms: delta.crawlTimeMs ?? 0,
        p_email_success: delta.emailSuccess ?? 0,
        p_phone_success: delta.phoneSuccess ?? 0,
      } as any);
    } catch {
      // Silently skip.
    }
  })();
}

// ---------------------------------------------------------------------------
// Intelligence stage increments
// ---------------------------------------------------------------------------

/** Increments intelligence stage metrics atomically. */
export function incrementIntelligenceMetrics(
  planId: string | null | undefined,
  delta: {
    instagramSuccess?: number;
    instagramFailure?: number;
    instagramLookupTimeMs?: number;
    aiInsightTimeMs?: number;
    aiInsightGenerated?: number;
  },
): void {
  if (!planId) return;
  (async () => {
    try {
      await db.rpc("increment_job_intelligence_metrics" as any, {
        p_plan_id: planId,
        p_instagram_success: delta.instagramSuccess ?? 0,
        p_instagram_failure: delta.instagramFailure ?? 0,
        p_instagram_lookup_time_ms: delta.instagramLookupTimeMs ?? 0,
        p_ai_insight_time_ms: delta.aiInsightTimeMs ?? 0,
        p_ai_insight_generated: delta.aiInsightGenerated ?? 0,
      } as any);
    } catch {
      // Silently skip.
    }
  })();
}

// ---------------------------------------------------------------------------
// Failure tracking
// ---------------------------------------------------------------------------

/** Increments failure counters. All fields are optional; unset fields default to 0. */
export function incrementFailureMetrics(
  planId: string | null | undefined,
  delta: {
    browserCrashes?: number;
    navigationTimeouts?: number;
    unreachableWebsites?: number;
    instagramUnavailables?: number;
    validationFailures?: number;
    userCancellations?: number;
  },
): void {
  if (!planId) return;
  (async () => {
    try {
      await db.rpc("increment_job_failure_metrics" as any, {
        p_plan_id: planId,
        p_browser_crashes: delta.browserCrashes ?? 0,
        p_navigation_timeouts: delta.navigationTimeouts ?? 0,
        p_unreachable_websites: delta.unreachableWebsites ?? 0,
        p_instagram_unavailables: delta.instagramUnavailables ?? 0,
        p_validation_failures: delta.validationFailures ?? 0,
        p_user_cancellations: delta.userCancellations ?? 0,
      } as any);
    } catch {
      // Silently skip.
    }
  })();
}

// ---------------------------------------------------------------------------
// System snapshot (called on a recurring schedule)
// ---------------------------------------------------------------------------

/**
 * Captures a system-wide time-series snapshot and perserts it into
 * `lead_engine_snapshots`.  Called every minute by the worker scheduler.
 * Failures are non-fatal.
 */
export async function captureSystemSnapshot(workerMetrics: WorkerMetricsCounters): Promise<void> {
  try {
    // Query active + idle workers from worker_instances.
    const { data: workers } = await db
      .from("worker_instances")
      .select(
        "effective_concurrency, active_tasks, browser_launches, active_browsers, active_contexts, active_pages, browser_crashes, python_subprocess_restarts, free_memory_mb, cpu_count",
      )
      .gte("last_heartbeat_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

    const activeWorkers = workers?.filter((w: any) => (w.active_tasks ?? 0) > 0).length ?? 0;
    const idleWorkers = (workers?.length ?? 0) - activeWorkers;

    const totalFreeMem = workers?.reduce((sum: number, w: any) => sum + (w.free_memory_mb ?? 0), 0) ?? 0;
    const avgFreeMem = workers?.length ? Math.round(totalFreeMem / workers.length) : 0;
    const totalCpu = workers?.reduce((sum: number, w: any) => sum + (w.cpu_count ?? 0), 0) ?? 0;

    const totalBrowserLaunches = workers?.reduce((sum: number, w: any) => sum + (w.browser_launches ?? 0), 0) ?? 0;
    const totalActiveBrowsers = workers?.reduce((sum: number, w: any) => sum + (w.active_browsers ?? 0), 0) ?? 0;
    const totalActiveContexts = workers?.reduce((sum: number, w: any) => sum + (w.active_contexts ?? 0), 0) ?? 0;
    const totalActivePages = workers?.reduce((sum: number, w: any) => sum + (w.active_pages ?? 0), 0) ?? 0;
    const totalCrashes = workers?.reduce((sum: number, w: any) => sum + (w.browser_crashes ?? 0), 0) ?? 0;
    const totalSubprocessRestarts = workers?.reduce((sum: number, w: any) => sum + (w.python_subprocess_restarts ?? 0), 0) ?? 0;

    await db.from("lead_engine_snapshots").insert({
      active_workers: activeWorkers,
      idle_workers: idleWorkers,
      browser_launches: totalBrowserLaunches,
      active_browsers: totalActiveBrowsers,
      active_contexts: totalActiveContexts,
      active_pages: totalActivePages,
      browser_crashes: totalCrashes,
      python_subprocess_restarts: totalSubprocessRestarts,
      total_free_memory_mb: totalFreeMem,
      avg_free_memory_mb: avgFreeMem,
      total_cpu_count: totalCpu,
    });
  } catch (err) {
    console.warn("[observability] captureSystemSnapshot failed (non-fatal):", err);
  }
}

// ---------------------------------------------------------------------------
// In-process worker metrics (counters maintained in-memory by the bridge)
// ---------------------------------------------------------------------------

export type WorkerMetricsCounters = {
  browserLaunches: number;
  activeBrowsers: number;
  browserCrashes: number;
  subprocessRestarts: number;
};

/** Global singleton for this worker process's in-memory metrics. */
export const workerMetrics: WorkerMetricsCounters = {
  browserLaunches: 0,
  activeBrowsers: 0,
  browserCrashes: 0,
  subprocessRestarts: 0,
};
