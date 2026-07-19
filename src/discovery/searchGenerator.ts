/**
 * Discovery subsystem \u2014 Search Generator interface (Phase 5 Refinement 3).
 *
 * A SearchGenerator translates a niche + location target into one or more
 * provider-specific query strings. It is the seam between the planner's
 * geographic fan-out (which is source-agnostic) and a discovery provider's
 * search API/UI (which is source-specific).
 *
 * Implementing providers:
 *  \u2022 Google Maps: free-text "\u003cniche\u003e \u003ccity\u003e" (current behaviour, extracted from service.py)
 *  \u2022 Yelp (future): category-slug queries, not free-text
 *  \u2022 LinkedIn (future): structured params \u2014 company size, geo scope, industry
 *
 * Register implementations in providerRegistry.ts rather than importing them
 * directly so handleDiscoveryTask doesn't need to know the concrete class.
 */

export type SearchTarget = {
  niche: string;
  city: string;
  countryCode: string;
  region: string;
};

export type SearchQuery = {
  /**
   * The primary query string the provider's search understands.
   * For Google Maps this is "\u003cniche\u003e \u003ccity\u003e"; for future providers it may
   * be a category slug, a URL fragment, or any opaque string.
   */
  queryString: string;

  /**
   * Provider-specific supplemental params that the DiscoveryProvider
   * implementation knows how to consume.  Typed as an open record so new
   * providers can add params without touching this interface.
   * The Google Maps provider only uses `queryString` and ignores this field.
   */
  providerParams?: Record<string, unknown>;
};

export interface SearchGenerator {
  /** Must match DiscoveryProvider.id for the same source. */
  readonly providerId: string;

  /**
   * Generate one or more search queries for the given target.  Returns an
   * array so a provider can issue multiple searches per city/niche (e.g.
   * multiple category slugs, or primary + fallback queries) without the
   * planner needing to know about provider internals.
   *
   * The most common case is a single-element array.
   */
  generate(target: SearchTarget): SearchQuery[];
}
