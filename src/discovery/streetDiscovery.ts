/**
 * Per-user street discovery adapters.
 *
 * The database RPCs are deliberately the only authority for coverage and
 * leases. This module does not preload street state or attempt a local
 * select/update claim sequence.
 */

export const STREET_CLAIM_LEASE_SECONDS = 300;

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
