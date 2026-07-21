/**
 * Sprint 3: in-process request coalescing for expensive, cacheable work
 * (specifically: Anthropic-backed generation in server/routes/intelligence.ts).
 *
 * Problem: each AI route does cache-check -> miss -> generate -> upsert.
 * If two requests for the same cache key land while the cache is still
 * empty (double-click, multiple tabs, client retry), both miss the cache
 * and both call the Anthropic API independently, then race to upsert.
 *
 * Fix: callers wrap the "generate + upsert" step in singleFlight(key, fn).
 * The first caller for a given key actually runs fn(); any caller that
 * arrives while that promise is still pending gets the *same* promise
 * instead of starting a new generation. Once it settles (success or
 * failure), the key is cleared so the next cache-miss can generate again.
 *
 * Deliberately minimal: single process, single Map, no TTL, no cross-process
 * coordination. This does not replace the DB cache (business_opportunity_insights,
 * ai_intelligence) — it only prevents redundant concurrent generations before
 * that cache is written. A multi-instance deployment would still allow one
 * in-flight generation per instance; that's an acceptable, explicitly
 * out-of-scope tradeoff for this sprint (no Redis / no new infra).
 */

const inFlight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}
