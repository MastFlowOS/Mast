/**
 * Discovery subsystem \u2014 DiscoveryProvider interface (Phase 5 Refinement 3).
 *
 * A DiscoveryProvider executes a single search query against a specific data
 * source and streams back discovered leads. It is the pluggable execution
 * seam \u2014 every current and future discovery source (Google Maps, Yelp,
 * LinkedIn, ...) implements this interface, and handleDiscoveryTask routes
 * to the correct provider via the registry rather than calling runEngineQuery
 * directly.
 *
 * Current implementation: GoogleMapsProvider wraps runEngineQuery() /
 * pythonBridge.ts (the existing subprocess call), so no existing behaviour
 * changes \u2014 only the call site moves from discoveryPlanJob.ts to the provider.
 *
 * Future implementations: REST-API-backed providers use fetch() instead of
 * a subprocess. The interface is identical in both cases.
 *
 * BROWSER REUSE (future, Phase 7+):
 *   The correct seam to introduce browser reuse is here \u2014 a
 *   PooledGoogleMapsProvider would replace GoogleMapsProvider by acquiring
 *   a browser context from a shared pool rather than spawning a subprocess.
 *   Prerequisites:
 *     1. This interface is in place (done).
 *     2. BoundedSubprocessPool is scoped to the provider, not batchSize.
 *     3. service.py supports a persistent mode (socket protocol).
 *   Trigger: profiling evidence that per-task browser startup is \u226515% of
 *   mean task duration at production volumes.
 */

import type { EngineLead, EngineDoneInfo } from "../scraperBridge/pythonBridge.js";
import type { SearchQuery, SearchTarget } from "./searchGenerator.js";

export type DiscoverySearchOptions = {
  maxResults: number;
  candidateBudget: number;
  discoveryOnly: boolean;
  /** Unique per-task SQLite path so concurrent tasks don\u2019t share a dedup DB */
  taskDbPath?: string;
};

export interface DiscoveryProvider {
  /** Matches SearchGenerator.providerId and discovery_tasks.source */
  readonly id: string;
  readonly displayName: string;

  /**
   * Execute one search query and stream discovered leads.
   *
   * Callers must iterate the generator to completion or break out of it
   * (e.g. on cancellation).  Implementations should respect `signal` and
   * terminate the underlying subprocess/fetch gracefully when it fires.
   *
   * `onDone`, when provided, receives exhaustion + perf metadata once the
   * underlying source reports it (equivalent to the `__done__` sentinel in
   * the Maps subprocess protocol).
   */
  search(
    query: SearchQuery,
    target: SearchTarget,
    options: DiscoverySearchOptions,
    signal?: AbortSignal,
    onDone?: (info: EngineDoneInfo) => void,
  ): AsyncGenerator<EngineLead>;
}
