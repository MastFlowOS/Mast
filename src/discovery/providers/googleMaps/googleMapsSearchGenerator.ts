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
 *
 * PHASE 3C-4C-B \u2014 geographic rotation: when `target.area` is set (a
 * curated sub-area claimed via areaRotation.ts for a city that has one \u2014
 * see src/lib/geo/cityAreas.ts), the query is qualified as
 * "\u003cniche\u003e in \u003carea\u003e, \u003ccity\u003e" instead of "\u003cniche\u003e \u003ccity\u003e". This reuses the
 * IDENTICAL quote_plus(full_query) free-text path service.py/maps_scraper.py
 * already harden with crash-retry and interstitial handling \u2014 zero new
 * surface area in the scraper itself, matching this phase's "don't touch
 * selectors/scrolling/extraction/retry" constraint. Cities with no claimed
 * area (the majority \u2014 see cityAreas.ts) produce the exact same query
 * string as before this phase.
 */

import { splitNicheQuery } from "../../../lib/niches.js";
import type { SearchGenerator, SearchQuery, SearchTarget } from "../../searchGenerator.js";

export class GoogleMapsSearchGenerator implements SearchGenerator {
  readonly providerId = "google_maps";

  generate({ niche, city, countryCode, area }: SearchTarget): SearchQuery[] {
    const location = area ? `in ${area}, ${city}` : city;
    return splitNicheQuery(niche).map((n) => ({
      queryString: `${n} ${location}`,
      providerParams: { country: countryCode },
    }));
  }
}
