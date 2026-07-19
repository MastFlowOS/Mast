/**
 * Discovery provider registry (Phase 5 Refinement 3).
 *
 * Single registration point for all DiscoveryProvider and SearchGenerator
 * implementations.  handleDiscoveryTask routes to the correct provider by
 * reading discovery_tasks.source and calling getProvider(source).
 *
 * Adding a new discovery source:
 *   1. Implement DiscoveryProvider in providers/<name>/<name>Provider.ts
 *   2. Implement SearchGenerator in providers/<name>/<name>SearchGenerator.ts
 *   3. Register both below with registerProvider() / registerGenerator()
 *   4. Add the new source id as a valid value for discovery_tasks.source if
 *      the planner needs to produce tasks for it (schema migration)
 *
 * No other files need to change \u2014 not discoveryPlanJob.ts, not queue.ts,
 * not workers/index.ts.
 */

import type { DiscoveryProvider } from "./discoveryProvider.js";
import type { SearchGenerator } from "./searchGenerator.js";
import { GoogleMapsProvider } from "./providers/googleMaps/googleMapsProvider.js";
import { GoogleMapsSearchGenerator } from "./providers/googleMaps/googleMapsSearchGenerator.js";

// ── Provider registry ─────────────────────────────────────────────────────────

const _providers = new Map<string, DiscoveryProvider>();
const _generators = new Map<string, SearchGenerator>();

export function registerProvider(provider: DiscoveryProvider): void {
  _providers.set(provider.id, provider);
}

export function registerGenerator(generator: SearchGenerator): void {
  _generators.set(generator.providerId, generator);
}

/**
 * Returns the DiscoveryProvider for the given source id.
 * Throws a clear error if the id is not registered so misconfigured tasks
 * surface immediately rather than silently falling through to Google Maps.
 */
export function getProvider(sourceId: string): DiscoveryProvider {
  const provider = _providers.get(sourceId);
  if (!provider) {
    throw new Error(
      `[providerRegistry] No DiscoveryProvider registered for source "${sourceId}". ` +
        `Registered providers: ${[..._providers.keys()].join(", ")}. ` +
        `Register the provider in src/discovery/providerRegistry.ts.`,
    );
  }
  return provider;
}

/**
 * Returns the SearchGenerator for the given source id.
 * Falls back to the Google Maps generator for legacy rows where source
 * is implicitly "google_maps" but the string is not set.
 */
export function getGenerator(sourceId: string): SearchGenerator {
  const generator = _generators.get(sourceId) ?? _generators.get("google_maps");
  if (!generator) {
    throw new Error(
      `[providerRegistry] No SearchGenerator registered for source "${sourceId}". ` +
        `Registered generators: ${[..._generators.keys()].join(", ")}.`,
    );
  }
  return generator;
}

// ── Registrations ─────────────────────────────────────────────────────────────
// Add new providers/generators here \u2014 nowhere else.

registerProvider(new GoogleMapsProvider());
registerGenerator(new GoogleMapsSearchGenerator());

// Future examples (uncomment when the provider is implemented):
// registerProvider(new YelpProvider());
// registerGenerator(new YelpSearchGenerator());
// registerProvider(new LinkedInProvider());
// registerGenerator(new LinkedInSearchGenerator());
