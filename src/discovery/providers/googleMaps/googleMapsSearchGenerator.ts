/**
 * Google Maps SearchGenerator (Phase 5 Refinement 3).
 *
 * Translates a niche + city/country target into the free-text search query
 * that service.py's run_query() already understands internally.  This is the
 * same logic that previously lived inside the discoveryPlanJob.ts call to
 * runEngineQuery(), extracted into the provider abstraction so future sources
 * can produce different query shapes without touching the task-processing loop.
 *
 * splitNicheQuery() already handles comma-separated multi-niche inputs
 * (e.g. "yoga studios, pilates" \u2192 ["yoga studios","pilates"]), producing one
 * SearchQuery per niche so each gets its own Maps search run.
 */

import { splitNicheQuery } from "../../../lib/niches.js";
import type { SearchGenerator, SearchQuery, SearchTarget } from "../../searchGenerator.js";

export class GoogleMapsSearchGenerator implements SearchGenerator {
  readonly providerId = "google_maps";

  generate({ niche, city, countryCode }: SearchTarget): SearchQuery[] {
    return splitNicheQuery(niche).map((n) => ({
      queryString: `${n} ${city}`,
      providerParams: { country: countryCode },
    }));
  }
}
