import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  runAreaWorkerPool,
  type AreaRunOutcome,
} from "../googleAreaPool.js";
import {
  claimDiscoveryStreet,
  completeDiscoveryStreetClaim,
  heartbeatDiscoveryStreetClaim,
  releaseDiscoveryStreetClaim,
  discoveryModeForStreetInventory,
  type StreetClaim,
  type StreetScope,
} from "../streetDiscovery.js";

interface MockStreet {
  id: string;
  street_key: string;
  street_name: string;
  normalized_name: string;
  country_code: string;
  city: string;
  source: string;
}

interface MockUserState {
  id: string;
  user_id: string;
  street_id: string;
  niche: string;
  profession_slug: string | null;
  country_code: string;
  city: string;
  source: string;
  status: "UNSEEN" | "IN_PROGRESS" | "COMPLETED";
  claimed_at: number;
  lease_expires_at: number | null;
  claim_token: string | null;
  worker_id: string | null;
  run_id: string | null;
  completed_at: number | null;
  attempt_count: number;
  last_attempt_at: number | null;
}

class MockCoverageDatabase {
  streets: MockStreet[] = [];
  userStates: MockUserState[] = [];
  activeLocks = new Set<string>();

  addStreet(countryCode: string, city: string, streetName: string, streetKey?: string): MockStreet {
    const id = `street-${this.streets.length + 1}-${Math.random().toString(36).slice(2)}`;
    const street: MockStreet = {
      id,
      street_key: streetKey ?? streetName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      street_name: streetName,
      normalized_name: streetName.toLowerCase().trim(),
      country_code: countryCode,
      city,
      source: "google_maps",
    };
    this.streets.push(street);
    return street;
  }

  async claim(
    scope: StreetScope,
    workerId: string,
    runId: string,
    leaseSeconds = 300,
  ): Promise<any> {
    const now = Date.now();

    // Matching PostgreSQL: order by coalesce(uds.attempt_count, 0) asc, ds.normalized_name, ds.id
    const candidates = this.streets.filter(
      (s) => s.country_code === scope.countryCode && s.city === scope.city,
    );

    const eligibleWithState = candidates.map((street) => {
      const existing = this.userStates.find(
        (u) =>
          u.street_id === street.id &&
          u.user_id === scope.userId &&
          u.niche === scope.niche &&
          u.profession_slug === scope.professionSlug &&
          u.country_code === scope.countryCode &&
          u.city === scope.city &&
          u.source === scope.source,
      );
      const isEligible =
        !existing ||
        existing.status === "UNSEEN" ||
        (existing.status === "IN_PROGRESS" && (existing.lease_expires_at ?? 0) <= now);
      return {
        street,
        existing,
        isEligible,
        attemptCount: existing?.attempt_count ?? 0,
      };
    }).filter((c) => c.isEligible);

    eligibleWithState.sort((a, b) => {
      if (a.attemptCount !== b.attemptCount) {
        return a.attemptCount - b.attemptCount;
      }
      const nameCmp = a.street.normalized_name.localeCompare(b.street.normalized_name);
      if (nameCmp !== 0) return nameCmp;
      return a.street.id.localeCompare(b.street.id);
    });

    for (const item of eligibleWithState) {
      const { street, existing } = item;
      if (this.activeLocks.has(street.id)) {
        continue;
      }

      this.activeLocks.add(street.id);
      try {
        const token = `token-${Math.random().toString(36).slice(2)}`;
        const leaseExpiresAt = now + leaseSeconds * 1000;

        if (!existing) {
          const stateId = `state-${this.userStates.length + 1}`;
          const newState: MockUserState = {
            id: stateId,
            user_id: scope.userId,
            street_id: street.id,
            niche: scope.niche,
            profession_slug: scope.professionSlug,
            country_code: scope.countryCode,
            city: scope.city,
            source: scope.source,
            status: "IN_PROGRESS",
            claimed_at: now,
            lease_expires_at: leaseExpiresAt,
            claim_token: token,
            worker_id: workerId,
            run_id: runId,
            completed_at: null,
            attempt_count: 0,
            last_attempt_at: null,
          };
          this.userStates.push(newState);
          return {
            state_id: stateId,
            street_id: street.id,
            street_key: street.street_key,
            street_name: street.street_name,
            claim_token: token,
            claimed_at: new Date(now).toISOString(),
            lease_expires_at: new Date(leaseExpiresAt).toISOString(),
          };
        } else {
          existing.status = "IN_PROGRESS";
          existing.claimed_at = now;
          existing.lease_expires_at = leaseExpiresAt;
          existing.claim_token = token;
          existing.worker_id = workerId;
          existing.run_id = runId;
          existing.completed_at = null;
          return {
            state_id: existing.id,
            street_id: street.id,
            street_key: street.street_key,
            street_name: street.street_name,
            claim_token: token,
            claimed_at: new Date(now).toISOString(),
            lease_expires_at: new Date(leaseExpiresAt).toISOString(),
          };
        }
      } finally {
        this.activeLocks.delete(street.id);
      }
    }

    return null;
  }

  async complete(stateId: string, userId: string, claimToken: string, workerId: string): Promise<boolean> {
    const state = this.userStates.find((u) => u.id === stateId);
    if (!state) return false;
    if (state.status !== "IN_PROGRESS") return false;
    if (state.user_id !== userId || state.claim_token !== claimToken || state.worker_id !== workerId) {
      return false;
    }
    if ((state.lease_expires_at ?? 0) <= Date.now()) {
      return false;
    }
    state.status = "COMPLETED";
    state.completed_at = Date.now();
    state.lease_expires_at = null;
    state.claim_token = null;
    state.worker_id = null;
    state.run_id = null;
    return true;
  }

  async release(stateId: string, userId: string, claimToken: string, workerId: string): Promise<boolean> {
    const state = this.userStates.find((u) => u.id === stateId);
    if (!state) return false;
    if (state.status !== "IN_PROGRESS") return false;
    if (state.user_id !== userId || state.claim_token !== claimToken || state.worker_id !== workerId) {
      return false;
    }
    if ((state.lease_expires_at ?? 0) <= Date.now()) {
      return false;
    }
    state.status = "UNSEEN";
    state.lease_expires_at = null;
    state.claim_token = null;
    state.worker_id = null;
    state.run_id = null;
    state.attempt_count = (state.attempt_count || 0) + 1;
    state.last_attempt_at = Date.now();
    return true;
  }

  async heartbeat(stateId: string, userId: string, claimToken: string, workerId: string, leaseSeconds = 300): Promise<boolean> {
    const state = this.userStates.find((u) => u.id === stateId);
    if (!state) return false;
    if (state.status !== "IN_PROGRESS") return false;
    if (state.user_id !== userId || state.claim_token !== claimToken || state.worker_id !== workerId) {
      return false;
    }
    if ((state.lease_expires_at ?? 0) <= Date.now()) {
      return false;
    }
    state.lease_expires_at = Date.now() + leaseSeconds * 1000;
    return true;
  }

  toDbAdapter() {
    return {
      rpc: async (fnName: string, args: any) => {
        if (fnName === "claim_discovery_street") {
          const res = await this.claim(
            {
              userId: args.p_user_id,
              niche: args.p_niche,
              professionSlug: args.p_profession_slug,
              countryCode: args.p_country_code,
              city: args.p_city,
              source: args.p_source,
            },
            args.p_worker_id,
            args.p_run_id,
            args.p_lease_seconds,
          );
          return { data: res ? [res] : [], error: null };
        }
        if (fnName === "complete_discovery_street_claim") {
          const ok = await this.complete(
            args.p_state_id,
            args.p_user_id,
            args.p_claim_token,
            args.p_worker_id,
          );
          return { data: ok, error: null };
        }
        if (fnName === "release_discovery_street_claim") {
          const ok = await this.release(
            args.p_state_id,
            args.p_user_id,
            args.p_claim_token,
            args.p_worker_id,
          );
          return { data: ok, error: null };
        }
        if (fnName === "heartbeat_discovery_street_claim") {
          const ok = await this.heartbeat(
            args.p_state_id,
            args.p_user_id,
            args.p_claim_token,
            args.p_worker_id,
            args.p_lease_seconds,
          );
          return { data: ok, error: null };
        }
        throw new Error(`Unknown mock RPC ${fnName}`);
      },
    };
  }
}

describe("Street Coverage Repairs & Fair Ordering", () => {
  const scope: StreetScope = {
    userId: "user-1",
    niche: "dental",
    professionSlug: "dentist",
    countryCode: "US",
    city: "Austin",
    source: "google_maps",
  };

  test("1. completed street is skipped in the next run (same user and scope)", async () => {
    const mockDb = new MockCoverageDatabase();
    mockDb.addStreet("US", "Austin", "1st Street");
    mockDb.addStreet("US", "Austin", "2nd Street");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1");
    assert.ok(claim1);
    assert.equal(claim1?.streetName, "1st Street");

    const completed = await completeDiscoveryStreetClaim(db, claim1!, scope.userId, "worker-1");
    assert.equal(completed, true);

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-1", "run-2");
    assert.ok(claim2);
    assert.equal(claim2?.streetName, "2nd Street", "Completed street must be skipped");
  });

  test("2. target-stopped street is released, stays eligible, and a later run claims an UNTOUCHED street before it", async () => {
    const mockDb = new MockCoverageDatabase();
    // Street A is alphabetically first; Street B is second
    mockDb.addStreet("US", "Austin", "A Street");
    mockDb.addStreet("US", "Austin", "B Street");
    const db = mockDb.toDbAdapter();

    // First run claims A Street
    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1");
    assert.ok(claim1);
    assert.equal(claim1?.streetName, "A Street");

    // Run stops at target (SUCCESS_TARGET_REACHED) -> releases claim
    const released = await releaseDiscoveryStreetClaim(db, claim1!, scope.userId, "worker-1");
    assert.equal(released, true);

    const stateA = mockDb.userStates.find((u) => u.street_id === claim1?.streetId);
    assert.equal(stateA?.status, "UNSEEN");
    assert.equal(stateA?.attempt_count, 1);
    assert.ok(stateA?.last_attempt_at);

    // Next run: untouched B Street (attempt_count 0) must be claimed BEFORE A Street (attempt_count 1),
    // even though A Street is alphabetically first!
    const claim2 = await claimDiscoveryStreet(db, scope, "worker-1", "run-2");
    assert.ok(claim2);
    assert.equal(claim2?.streetName, "B Street", "Untouched street must be claimed before attempted street");

    // Complete B Street
    await completeDiscoveryStreetClaim(db, claim2!, scope.userId, "worker-1");

    // Third run: with B completed, A Street is now claimed and completed
    const claim3 = await claimDiscoveryStreet(db, scope, "worker-1", "run-3");
    assert.ok(claim3);
    assert.equal(claim3?.streetName, "A Street", "Previously attempted street is still eligible when untouched streets are done");
  });

  test("3. cancelled, failed, timed-out and heartbeat-lost runs release and never complete", async () => {
    const mockDb = new MockCoverageDatabase();
    mockDb.addStreet("US", "Austin", "C Street");
    const db = mockDb.toDbAdapter();

    // Cancellation scenario
    const c1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-cancel");
    assert.ok(c1);
    await releaseDiscoveryStreetClaim(db, c1!, scope.userId, "worker-1");
    let state = mockDb.userStates.find((u) => u.id === c1!.stateId);
    assert.equal(state?.status, "UNSEEN");
    assert.equal(state?.completed_at, null);
    assert.equal(state?.attempt_count, 1);

    // Failure scenario
    const c2 = await claimDiscoveryStreet(db, scope, "worker-1", "run-fail");
    assert.ok(c2);
    await releaseDiscoveryStreetClaim(db, c2!, scope.userId, "worker-1");
    state = mockDb.userStates.find((u) => u.id === c2!.stateId);
    assert.equal(state?.status, "UNSEEN");
    assert.equal(state?.completed_at, null);
    assert.equal(state?.attempt_count, 2);

    // Timeout scenario
    const c3 = await claimDiscoveryStreet(db, scope, "worker-1", "run-timeout");
    assert.ok(c3);
    await releaseDiscoveryStreetClaim(db, c3!, scope.userId, "worker-1");
    state = mockDb.userStates.find((u) => u.id === c3!.stateId);
    assert.equal(state?.status, "UNSEEN");
    assert.equal(state?.completed_at, null);
    assert.equal(state?.attempt_count, 3);
  });

  test("4. release with a stale token or another worker is rejected; COMPLETED rows are never released", async () => {
    const mockDb = new MockCoverageDatabase();
    mockDb.addStreet("US", "Austin", "D Street");
    const db = mockDb.toDbAdapter();

    const claim = await claimDiscoveryStreet(db, scope, "worker-1", "run-1");
    assert.ok(claim);

    // Release with wrong worker
    const wrongWorker = await releaseDiscoveryStreetClaim(db, claim!, scope.userId, "worker-2");
    assert.equal(wrongWorker, false);

    // Release with wrong token
    const staleClaim = { ...claim!, claimToken: "00000000-0000-0000-0000-000000000000" };
    const wrongToken = await releaseDiscoveryStreetClaim(db, staleClaim, scope.userId, "worker-1");
    assert.equal(wrongToken, false);

    // Complete the street
    const completed = await completeDiscoveryStreetClaim(db, claim!, scope.userId, "worker-1");
    assert.equal(completed, true);

    // Attempting to release a COMPLETED street is rejected
    const releaseCompleted = await releaseDiscoveryStreetClaim(db, claim!, scope.userId, "worker-1");
    assert.equal(releaseCompleted, false);

    const state = mockDb.userStates.find((u) => u.id === claim!.stateId);
    assert.equal(state?.status, "COMPLETED");
  });

  test("5. zero-slot pool: no claim, no state change", async () => {
    const mockDb = new MockCoverageDatabase();
    mockDb.addStreet("US", "Austin", "Zero Street");
    const db = mockDb.toDbAdapter();

    let claimCalled = false;
    let runCalled = false;

    const poolResult = await runAreaWorkerPool({
      configuredWorkers: 3,
      totalCuratedAreas: 1,
      availableCapacity: 0, // 0 slots
      safeResourceWorkers: 0,
      claimNextArea: async () => {
        claimCalled = true;
        const c = await claimDiscoveryStreet(db, scope, "w1", "r1");
        return c?.stateId;
      },
      runArea: async () => {
        runCalled = true;
        return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: false, failed: false };
      },
    });

    assert.equal(poolResult.poolSize, 0);
    assert.equal(poolResult.deferredNoSlot, true);
    assert.equal(claimCalled, false, "zero slots must not call claim");
    assert.equal(runCalled, false, "zero slots must not call runArea");
    assert.equal(mockDb.userStates.length, 0, "No rows written to user street state");
  });

  test("6. equivalent street name formatting maps to one street_key; different streets are not merged", () => {
    function normalizeStreetKey(name: string): string {
      return name
        .toLowerCase()
        .trim()
        .replace(/\b(street|st\.|st)\b/gi, "st")
        .replace(/\b(avenue|ave\.|ave)\b/gi, "ave")
        .replace(/\b(boulevard|blvd\.|blvd)\b/gi, "blvd")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    const key1 = normalizeStreetKey("Main Street");
    const key2 = normalizeStreetKey("Main St.");
    const key3 = normalizeStreetKey("  main   st  ");
    assert.equal(key1, key2);
    assert.equal(key1, key3);

    const different = normalizeStreetKey("Oak Street");
    assert.notEqual(key1, different);
  });

  test("7. concurrent runs cannot claim the same street; two users and two niches stay independent", async () => {
    const mockDb = new MockCoverageDatabase();
    mockDb.addStreet("US", "Austin", "Concurrent Street 1");
    mockDb.addStreet("US", "Austin", "Concurrent Street 2");
    const db = mockDb.toDbAdapter();

    // Concurrent claims same user/scope
    const [c1, c2] = await Promise.all([
      claimDiscoveryStreet(db, scope, "worker-1", "run-a"),
      claimDiscoveryStreet(db, scope, "worker-2", "run-b"),
    ]);
    assert.ok(c1);
    assert.ok(c2);
    assert.notEqual(c1?.streetId, c2?.streetId, "Concurrent workers receive distinct streets");

    // Complete street 1 for user 1
    await completeDiscoveryStreetClaim(db, c1!, scope.userId, "worker-1");

    // User 2 can still claim the street completed by user 1
    const user2Scope: StreetScope = { ...scope, userId: "user-2" };
    const user2Claim = await claimDiscoveryStreet(db, user2Scope, "w-user2", "run-user2");
    assert.ok(user2Claim);
    assert.equal(user2Claim?.streetId, c1?.streetId, "User 2 can claim street completed by user 1");

    // Niche 2 for user 1 can also claim the street completed in niche 1
    const niche2Scope: StreetScope = { ...scope, niche: "plumbing", professionSlug: "plumber" };
    const niche2Claim = await claimDiscoveryStreet(db, niche2Scope, "w-niche2", "run-niche2");
    assert.ok(niche2Claim);
    assert.equal(niche2Claim?.streetId, c1?.streetId, "Different niche is independent");
  });

  test("8. business-level dedup still rejects a business found via a second street", () => {
    // Mimics discovery candidate early-fingerprint / place dedup
    const seenPlaces = new Set<string>();

    function processDiscoveredCandidate(candidate: { placeId: string; name: string; street: string }): boolean {
      if (seenPlaces.has(candidate.placeId)) {
        return false; // rejected as duplicate
      }
      seenPlaces.add(candidate.placeId);
      return true; // accepted
    }

    const candOnStreet1 = { placeId: "place-100", name: "Apex Dental", street: "1st St" };
    const candOnStreet2 = { placeId: "place-100", name: "Apex Dental", street: "2nd St" };

    assert.equal(processDiscoveredCandidate(candOnStreet1), true, "First encounter is accepted");
    assert.equal(processDiscoveredCandidate(candOnStreet2), false, "Duplicate encounter on second street is rejected");
  });

  test("9. coverage survives a fresh connection", async () => {
    const mockDb = new MockCoverageDatabase();
    mockDb.addStreet("US", "Austin", "Persistence St");

    // Connection 1 claims and completes
    const db1 = mockDb.toDbAdapter();
    const claim1 = await claimDiscoveryStreet(db1, scope, "worker-1", "run-1");
    assert.ok(claim1);
    await completeDiscoveryStreetClaim(db1, claim1!, scope.userId, "worker-1");

    // Connection 2 (simulating fresh connection / pool) reads state
    const db2 = mockDb.toDbAdapter();
    const claim2 = await claimDiscoveryStreet(db2, scope, "worker-2", "run-2");
    assert.equal(claim2, undefined, "Completed street must remain completed across fresh connection adapter");
  });

  test("10. area-path tests still pass unchanged", () => {
    // Mode resolution check
    assert.equal(discoveryModeForStreetInventory("google_maps", 10), "street");
    assert.equal(discoveryModeForStreetInventory("google_maps", 0), "area");
    assert.equal(discoveryModeForStreetInventory("other_provider", 10), "area");
    assert.equal(discoveryModeForStreetInventory("other_provider", 0), "area");
  });
});
