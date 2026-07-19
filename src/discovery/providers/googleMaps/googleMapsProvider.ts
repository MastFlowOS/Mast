/**
 * Google Maps DiscoveryProvider (Phase 5 Refinement 3).
 *
 * Wraps the existing runEngineQuery() / pythonBridge.ts subprocess call as a
 * concrete DiscoveryProvider implementation.  No behaviour changes \u2014 the
 * underlying Python subprocess, stdin/stdout protocol, and __done__ sentinel
 * are identical to what discoveryPlanJob.ts called directly before this
 * abstraction was introduced.  Only the call site moves: handleDiscoveryTask
 * now routes through the provider registry instead of calling runEngineQuery
 * directly.
 *
 * BROWSER REUSE \u2014 future optimization (Phase 7+):
 *   Replace this class with PooledGoogleMapsProvider when:
 *     - per-task browser startup overhead is \u226515% of mean task duration
 *       (measure first, don\u2019t build preemptively)
 *     - BoundedSubprocessPool is scoped to this class, not to batchSize
 *     - service.py supports a persistent mode (local socket / named pipe)
 *       so a single Python process can handle multiple sequential searches
 *       in the same browser context without re-launching Chromium.
 *   The DiscoveryProvider interface above is the correct abstraction layer
 *   for that change \u2014 handleDiscoveryTask requires zero modification.
 */

import { runEngineQuery } from "../../../scraperBridge/pythonBridge.js";
import type { EngineLead, EngineDoneInfo } from "../../../scraperBridge/pythonBridge.js";
import type { DiscoveryProvider, DiscoverySearchOptions } from "../../discoveryProvider.js";
import type { SearchQuery, SearchTarget } from "../../searchGenerator.js";

export class GoogleMapsProvider implements DiscoveryProvider {
  readonly id = "google_maps";
  readonly displayName = "Google Maps";

  async *search(
    query: SearchQuery,
    target: SearchTarget,
    options: DiscoverySearchOptions,
    signal?: AbortSignal,
    onDone?: (info: EngineDoneInfo) => void,
  ): AsyncGenerator<EngineLead> {
    yield* runEngineQuery(
      {
        query: query.queryString,
        city: target.city,
        country: target.countryCode,
        region: target.region,
        niche: target.niche,
        max_results: options.maxResults,
        discovery_only: options.discoveryOnly,
        require_viability: false,
        db_path: options.taskDbPath,
      },
      signal,
      onDone,
    );
  }
}
