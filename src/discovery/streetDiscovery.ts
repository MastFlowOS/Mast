/**
 * Per-user street discovery adapters.
 *
 * The database RPCs are deliberately the only authority for coverage and
 * leases. This module does not preload street state or attempt a local
 * select/update claim sequence.
 */

import { runEngineStreetInventory, type EngineStreetInventoryResult } from "../scraperBridge/pythonBridge.js";

export const STREET_CLAIM_LEASE_SECONDS = 300;

/**
 * CRITMODE — street-inventory hang investigation (requirement 8: "the
 * Node caller must not wait forever for the Python subprocess"). Before
 * this fix, `ensureStreetInventory()` called `buildFn(params)` with NO
 * signal at all — unlike every other subprocess-bridge call site in this
 * codebase (see `businessProcessingJob.ts`'s `ENRICH_SELF_CLAIM_TIMEOUT_MS`
 * / `timeoutController` pattern, which this mirrors), so a stuck
 * `service.py street_inventory` child process could hold this `await`
 * open indefinitely — `runEngineStreetInventory()`'s own `await new
 * Promise((resolve) => child.on("close", resolve))` has no timeout of
 * its own; it only reacts to an externally supplied AbortSignal.
 *
 * Sized generously above the Python-side worst case: boundary resolution
 * (instant) + Overpass fetch (60s soft timeout + 30s hard-deadline buffer,
 * see overpass_source.py) + DB upsert (a handful of batches at up to 30s
 * soft timeout + 15s hard-deadline buffer each, see repository.py). 3
 * minutes covers a large city's worth of batches with real headroom
 * without masking a genuine hang for many minutes.
 */
export const STREET_INVENTORY_BUILD_TIMEOUT_MS = 180_000;

/** The hybrid-mode decision is deliberately tiny and independently testable. */
export function discoveryModeForStreetInventory(source: string, inventoryCount: number): "street" | "area" {
  return source === "google_maps" && inventoryCount > 0 ? "street" : "area";
}

export type StreetClaim = {
  stateId: string;
  streetId: string;
  streetKey: string;
  streetName: string;
  claimToken: string;
  claimedAt: string;
  leaseExpiresAt: string;
};

export type StreetScope = {
  userId: string;
  niche: string;
  professionSlug: string | null;
  countryCode: string;
  city: string;
  source: string;
};

/**
 * A count-only inventory probe. It is intentionally separate from claiming:
 * a city with no inventory must take the established area path unchanged.
 */
export async function streetInventoryCount(db: any, countryCode: string, city: string): Promise<number> {
  const { count, error } = await db
    .from("discovery_streets")
    .select("id", { count: "exact", head: true })
    .eq("country_code", countryCode)
    .eq("city", city);
  if (error) throw error;
  return count ?? 0;
}

/**
 * CRITMODE Phase 4 — PART A: the smallest safe way to give
 * `street_inventory/build.py`'s real OSM/Overpass builder a production
 * caller, for one (country, city) at a time.
 *
 * Idempotent by construction:
 *   - If `discovery_streets` already has rows for this exact
 *     (country_code, city), the build is skipped entirely — this function
 *     NEVER re-fetches or re-upserts inventory that already exists (the
 *     "must not recreate/delete existing valid inventory unnecessarily"
 *     requirement). The underlying builder is itself upsert-on-`street_key`
 *     (see repository.py), so even a forced re-run would be safe, but the
 *     count-first check avoids the network/CPU cost of a redundant
 *     Overpass fetch for a city this process has already warmed.
 *   - A per-process in-flight map collapses concurrent callers for the
 *     SAME (country_code, city) — e.g. two area workers racing into the
 *     same city in the same poolExpandJob run — into exactly one
 *     subprocess spawn, not one per caller.
 *
 * Never throws: a transport failure, an unresolved OSM area, or any other
 * builder-reported problem becomes an explicit `mode: "area"` outcome with
 * `fallbackReason` set, per the "must not silently fall back to area mode"
 * requirement — the caller is expected to log `fallbackReason`, not
 * swallow it.
 */
export type StreetInventoryOutcome =
  | { mode: "street"; count: number }
  | { mode: "area"; count: number; fallbackReason: string };

const inFlightInventoryBuilds = new Map<string, Promise<EngineStreetInventoryResult | undefined>>();

export async function ensureStreetInventory(
  db: any,
  countryCode: string,
  city: string,
  opts?: { countryName?: string; region?: string },
  // Test-only injection point (mirrors build.py's own `repository`
  // constructor-injection convention for the same reason): defaults to the
  // real subprocess bridge for both production call sites, which never
  // pass this argument.
  buildFn: typeof runEngineStreetInventory = runEngineStreetInventory,
): Promise<StreetInventoryOutcome> {
  const existing = await streetInventoryCount(db, countryCode, city);
  if (existing > 0) {
    return { mode: "street", count: existing };
  }

  const key = `${countryCode}:${city}`;
  console.info(`[street-inventory] check country=${countryCode} city=${city} existing=0 — starting build`);

  let buildPromise = inFlightInventoryBuilds.get(key);
  if (!buildPromise) {
    // CRITMODE — street-inventory hang investigation: bound the
    // subprocess call with a real wall-clock timeout (see
    // STREET_INVENTORY_BUILD_TIMEOUT_MS above for sizing/rationale).
    // Without this, a stuck `service.py street_inventory` child holds
    // this promise open indefinitely, and every future caller for this
    // (country, city) piles onto the same never-settling in-flight
    // promise via the map below.
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(
      () => timeoutController.abort(),
      STREET_INVENTORY_BUILD_TIMEOUT_MS,
    );
    const buildStartedAt = Date.now();
    buildPromise = buildFn(
      {
        country_code: countryCode,
        city,
        country_name: opts?.countryName,
        region: opts?.region,
      },
      timeoutController.signal,
    )
      .catch((err) => {
        const timedOut = timeoutController.signal.aborted;
        const elapsedMs = Date.now() - buildStartedAt;
        if (timedOut) {
          console.warn(
            `[street-inventory] build TIMED OUT country=${countryCode} city=${city} after ${elapsedMs}ms ` +
              `(limit=${STREET_INVENTORY_BUILD_TIMEOUT_MS}ms) — Python subprocess killed, never returned a result`,
          );
        } else {
          console.warn(
            `[street-inventory] build errored country=${countryCode} city=${city} after ${elapsedMs}ms`,
            err,
          );
        }
        return undefined;
      })
      .finally(() => clearTimeout(timeoutHandle));
    inFlightInventoryBuilds.set(key, buildPromise);
    // Removed once settled (success, unavailable, or error) so a later,
    // independent call for the same city — e.g. after a transient Overpass
    // outage — gets its own fresh attempt instead of being permanently
    // pinned to this run's outcome.
    void buildPromise.finally(() => inFlightInventoryBuilds.delete(key));
  }

  const result = await buildPromise;

  if (!result) {
    return { mode: "area", count: 0, fallbackReason: "build_error" };
  }
  if (result.status === "unavailable") {
    console.info(`[street-inventory] result country=${countryCode} city=${city} status=unavailable reason=${result.reason}`);
    return { mode: "area", count: 0, fallbackReason: `unavailable:${result.reason}` };
  }

  console.info(
    `[street-inventory] result country=${countryCode} city=${city} status=ok fetched=${result.fetched} upserted=${result.upserted}`,
  );
  const count = await streetInventoryCount(db, countryCode, city);
  if (count === 0) {
    // The builder reported success but the city's real OSM inventory was
    // empty (e.g. zero named highways for that boundary) — a genuine,
    // observable "no usable inventory", not a bug in this function.
    return { mode: "area", count: 0, fallbackReason: "empty_after_build" };
  }
  return { mode: "street", count };
}

export type StreetInitResult = {
  stateId: string;
};

/**
 * Thin wrapper for `initialize_user_discovery_street_state` — the fourth
 * RPC migration 029 already deploys, exposed here the exact same way
 * claimDiscoveryStreet/heartbeatDiscoveryStreetClaim/
 * completeDiscoveryStreetClaim already are. Not part of the hot claim path
 * (claim_discovery_street already lazily materialises a row on first
 * claim — see that RPC's own comment) — this exists so a caller that wants
 * an explicit, pre-claim UNSEEN row (e.g. the validation harness's Step 2,
 * or a future pre-seeding job) doesn't have to hand-roll the RPC call.
 */
export async function initializeUserDiscoveryStreetState(
  db: any,
  scope: StreetScope,
  streetId: string,
): Promise<StreetInitResult> {
  const { data, error } = await db.rpc("initialize_user_discovery_street_state", {
    p_user_id: scope.userId,
    p_street_id: streetId,
    p_niche: scope.niche,
    p_profession_slug: scope.professionSlug,
    p_country_code: scope.countryCode,
    p_city: scope.city,
    p_source: scope.source,
  });
  if (error) throw error;
  return { stateId: data as string };
}

export async function claimDiscoveryStreet(
  db: any,
  scope: StreetScope,
  workerId: string,
  runId: string,
): Promise<StreetClaim | undefined> {
  const { data, error } = await db.rpc("claim_discovery_street", {
    p_user_id: scope.userId,
    p_niche: scope.niche,
    p_profession_slug: scope.professionSlug,
    p_country_code: scope.countryCode,
    p_city: scope.city,
    p_source: scope.source,
    p_worker_id: workerId,
    p_run_id: runId,
    p_lease_seconds: STREET_CLAIM_LEASE_SECONDS,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return undefined;
  return {
    stateId: row.state_id,
    streetId: row.street_id,
    streetKey: row.street_key,
    streetName: row.street_name,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function completeDiscoveryStreetClaim(
  db: any,
  claim: StreetClaim,
  userId: string,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("complete_discovery_street_claim", {
    p_state_id: claim.stateId,
    p_user_id: userId,
    p_claim_token: claim.claimToken,
    p_worker_id: workerId,
  });
  if (error) throw error;
  return data === true;
}

export async function heartbeatDiscoveryStreetClaim(
  db: any,
  claim: StreetClaim,
  userId: string,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await db.rpc("heartbeat_discovery_street_claim", {
    p_state_id: claim.stateId,
    p_user_id: userId,
    p_claim_token: claim.claimToken,
    p_worker_id: workerId,
    p_lease_seconds: STREET_CLAIM_LEASE_SECONDS,
  });
  if (error) throw error;
  return data === true;
}
