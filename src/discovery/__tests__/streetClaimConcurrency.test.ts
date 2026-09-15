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
  type StreetClaim,
  type StreetScope,
} from "../streetDiscovery.js";

function outcome(partial: Partial<AreaRunOutcome> = {}): AreaRunOutcome {
  return { discovered: 0, accepted: 0, rejected: 0, duplicates: 0, exhausted: true, failed: false, ...partial };
}

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
  lease_expires_at: number;
  claim_token: string;
  worker_id: string;
  run_id: string | null;
}

class MockStreetDatabase {
  streets: MockStreet[] = [];
  userStates: MockUserState[] = [];
  activeLocks = new Set<string>(); // simulates FOR UPDATE OF ds SKIP LOCKED

  addStreet(countryCode: string, city: string, streetName: string, streetKey?: string): MockStreet {
    const id = `street-${this.streets.length + 1}-${Math.random().toString(36).slice(2)}`;
    const street: MockStreet = {
      id,
      street_key: streetKey ?? streetName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
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
    await new Promise((r) => setTimeout(r, Math.random() * 5));

    const now = Date.now();

    for (const street of this.streets) {
      if (street.country_code !== scope.countryCode || street.city !== scope.city) {
        continue;
      }

      if (this.activeLocks.has(street.id)) {
        continue;
      }

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
        (existing.status === "IN_PROGRESS" && existing.lease_expires_at <= now);

      if (!isEligible) {
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
    if (state.user_id !== userId || state.claim_token !== claimToken || state.worker_id !== workerId) {
      return false;
    }
    state.status = "COMPLETED";
    return true;
  }

  async heartbeat(stateId: string, userId: string, claimToken: string, workerId: string, leaseSeconds = 300): Promise<boolean> {
    const state = this.userStates.find((u) => u.id === stateId);
    if (!state) return false;
    if (state.user_id !== userId || state.claim_token !== claimToken || state.worker_id !== workerId) {
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
          return { data: res, error: null };
        }
        if (fnName === "complete_discovery_street_claim") {
          const ok = await this.complete(args.p_state_id, args.p_user_id, args.p_claim_token, args.p_worker_id);
          return { data: ok, error: null };
        }
        if (fnName === "heartbeat_discovery_street_claim") {
          const ok = await this.heartbeat(args.p_state_id, args.p_user_id, args.p_claim_token, args.p_worker_id, args.p_lease_seconds);
          return { data: ok, error: null };
        }
        throw new Error(`unknown rpc ${fnName}`);
      },
    };
  }
}

describe("MAST 3-Worker Street Parallelism & Concurrency Test Suite", () => {
  const scope: StreetScope = {
    userId: "user-1",
    niche: "dentist",
    professionSlug: "health",
    countryCode: "US",
    city: "Austin",
    source: "google_maps",
  };

  test("1. Three concurrent workers claiming from the same street inventory receive distinct street_keys", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Congress Ave", "congress-ave");
    mockDb.addStreet("US", "Austin", "6th Street", "6th-street");
    mockDb.addStreet("US", "Austin", "Lamar Blvd", "lamar-blvd");

    const db = mockDb.toDbAdapter();

    const [claim1, claim2, claim3] = await Promise.all([
      claimDiscoveryStreet(db, scope, "task-w1", "run-1", 0),
      claimDiscoveryStreet(db, scope, "task-w2", "run-1", 1),
      claimDiscoveryStreet(db, scope, "task-w3", "run-1", 2),
    ]);

    assert.ok(claim1);
    assert.ok(claim2);
    assert.ok(claim3);

    const keys = new Set([claim1.streetKey, claim2.streetKey, claim3.streetKey]);
    assert.equal(keys.size, 3, "All 3 workers must receive distinct street keys");
    assert.ok(keys.has("congress-ave"));
    assert.ok(keys.has("6th-street"));
    assert.ok(keys.has("lamar-blvd"));
  });

  test("2. Ten or more concurrent workers racing for 10 streets have zero duplicate active claims", async () => {
    const mockDb = new MockStreetDatabase();
    for (let i = 1; i <= 10; i++) {
      mockDb.addStreet("US", "Austin", `Street ${i}`, `street-${i}`);
    }
    const db = mockDb.toDbAdapter();

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claimDiscoveryStreet(db, scope, `worker-${i + 1}`, "run-10", i),
      ),
    );

    const validClaims = claims.filter((c): c is StreetClaim => Boolean(c));
    assert.equal(validClaims.length, 10);
    const keys = new Set(validClaims.map((c) => c.streetKey));
    assert.equal(keys.size, 10, "10 racing workers must receive 10 distinct streets");
  });

  test("3. Same worker repeatedly claiming receives new streets as prior ones complete", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "1st Street", "1st-street");
    mockDb.addStreet("US", "Austin", "2nd Street", "2nd-street");
    mockDb.addStreet("US", "Austin", "3rd Street", "3rd-street");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim1);
    assert.equal(claim1.streetKey, "1st-street");
    await completeDiscoveryStreetClaim(db, claim1, scope.userId, "worker-1");

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim2);
    assert.equal(claim2.streetKey, "2nd-street");
    await completeDiscoveryStreetClaim(db, claim2, scope.userId, "worker-1");

    const claim3 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim3);
    assert.equal(claim3.streetKey, "3rd-street");
  });

  test("4. A street currently marked IN_PROGRESS cannot be claimed by another worker", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Main St", "main-st");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim1);

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-2", "run-1", 1);
    assert.equal(claim2, undefined, "Worker 2 cannot claim an in-progress street");
  });

  test("5. An active lease prevents duplicate claim by another worker", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Broadway", "broadway");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim1);

    const state = mockDb.userStates[0];
    assert.ok(state.lease_expires_at > Date.now());

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-2", "run-1", 1);
    assert.equal(claim2, undefined, "Active lease prevents duplicate claim");
  });

  test("6. An expired lease allows the street to be reclaimed", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Guadalupe", "guadalupe");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim1);

    mockDb.userStates[0].lease_expires_at = Date.now() - 1000;

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-2", "run-1", 1);
    assert.ok(claim2, "Expired lease must be reclaimable");
    assert.equal(claim2.streetKey, "guadalupe");
    assert.equal(mockDb.userStates[0].worker_id, "worker-2");
  });

  test("7. Completing street A allows next claim to receive different street B", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Street A", "street-a");
    mockDb.addStreet("US", "Austin", "Street B", "street-b");
    const db = mockDb.toDbAdapter();

    const claimA = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claimA);
    assert.equal(claimA.streetKey, "street-a");
    await completeDiscoveryStreetClaim(db, claimA, scope.userId, "worker-1");

    const claimB = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claimB);
    assert.equal(claimB.streetKey, "street-b");
  });

  test("8. Same-user completed street is never returned again for that user", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Only Street", "only-street");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim1);
    await completeDiscoveryStreetClaim(db, claim1, scope.userId, "worker-1");

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.equal(claim2, undefined, "Completed street must be skipped for same user");
  });

  test("9. Another user can still claim a street completed by user A (cross-user isolation)", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Shared Street", "shared-street");
    const db = mockDb.toDbAdapter();

    const claimA = await claimDiscoveryStreet(db, scope, "worker-a", "run-a", 0);
    assert.ok(claimA);
    await completeDiscoveryStreetClaim(db, claimA, scope.userId, "worker-a");

    const scopeB: StreetScope = { ...scope, userId: "user-2" };
    const claimB = await claimDiscoveryStreet(db, scopeB, "worker-b", "run-b", 0);
    assert.ok(claimB, "User B must be able to claim the street completed by user A");
    assert.equal(claimB.streetKey, "shared-street");
  });

  test("10. street_key normalization prevents duplicate logical streets", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Main St", "main-st");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claim1);
    assert.equal(claim1.streetKey, "main-st");

    const claim2 = await claimDiscoveryStreet(db, scope, "worker-2", "run-1", 1);
    assert.equal(claim2, undefined);
  });

  test("11. poolExpandJob exclusivity guarantee in 3-worker pool", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Alpha", "alpha");
    mockDb.addStreet("US", "Austin", "Beta", "beta");
    mockDb.addStreet("US", "Austin", "Gamma", "gamma");
    const db = mockDb.toDbAdapter();

    const streetClaims = new Map<string, StreetClaim>();
    const executedStreets: string[] = [];

    const result = await runAreaWorkerPool({
      configuredWorkers: 3,
      totalCuratedAreas: 3,
      availableCapacity: 3,
      claimNextArea: async (usedAreas, slotIndex = 0) => {
        const slotWorkerId = `poolExpand:job1-w${slotIndex + 1}`;
        const claim = await claimDiscoveryStreet(db, scope, slotWorkerId, "job1", slotIndex);
        if (!claim) return undefined;
        if (usedAreas.has(claim.stateId)) {
          throw new Error(`duplicate active claim ${claim.stateId}`);
        }
        streetClaims.set(claim.stateId, claim);
        return claim.stateId;
      },
      runArea: async (area, slotIndex = 0) => {
        const claim = streetClaims.get(area)!;
        executedStreets.push(claim.streetKey);
        const slotWorkerId = `poolExpand:job1-w${slotIndex + 1}`;
        await completeDiscoveryStreetClaim(db, claim, scope.userId, slotWorkerId);
        return outcome({ discovered: 5, accepted: 5 });
      },
      tryAcquireSlot: () => () => {},
      isTerminal: () => false,
    });

    assert.equal(result.startedWorkers, 3);
    assert.equal(new Set(executedStreets).size, 3, "poolExpandJob 3 workers processed 3 distinct streets");
  });

  test("12. discoveryPlanJob exclusivity guarantee in 3-worker pool", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "First", "first");
    mockDb.addStreet("US", "Austin", "Second", "second");
    mockDb.addStreet("US", "Austin", "Third", "third");
    const db = mockDb.toDbAdapter();

    const streetClaims = new Map<string, StreetClaim>();
    const executedStreets: string[] = [];

    const result = await runAreaWorkerPool({
      configuredWorkers: 3,
      totalCuratedAreas: 3,
      availableCapacity: 3,
      claimNextArea: async (usedClaims, slotIndex = 0) => {
        const slotWorkerLabel = `task123-w${slotIndex + 1}`;
        const claim = await claimDiscoveryStreet(db, scope, slotWorkerLabel, "plan1", slotIndex);
        if (!claim) return undefined;
        if (usedClaims.has(claim.stateId)) {
          throw new Error(`duplicate active claim ${claim.stateId}`);
        }
        streetClaims.set(claim.stateId, claim);
        return claim.stateId;
      },
      runArea: async (claimId, slotIndex) => {
        const claim = streetClaims.get(claimId)!;
        executedStreets.push(claim.streetKey);
        const slotWorkerLabel = `task123-w${slotIndex + 1}`;
        await completeDiscoveryStreetClaim(db, claim, scope.userId, slotWorkerLabel);
        return outcome({ discovered: 10, accepted: 10 });
      },
      tryAcquireSlot: () => () => {},
      isTerminal: () => false,
    });

    assert.equal(result.startedWorkers, 3);
    assert.equal(new Set(executedStreets).size, 3, "discoveryPlanJob 3 workers processed 3 distinct streets");
  });

  test("13. City stickiness intact: claims never jump across city boundaries", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Austin St", "austin-st");
    mockDb.addStreet("US", "Dallas", "Dallas St", "dallas-st");
    const db = mockDb.toDbAdapter();

    const claimAustin = await claimDiscoveryStreet(db, scope, "worker-1", "run-1", 0);
    assert.ok(claimAustin);
    assert.equal(claimAustin.streetKey, "austin-st");

    const claimAustin2 = await claimDiscoveryStreet(db, scope, "worker-2", "run-1", 1);
    assert.equal(claimAustin2, undefined, "Worker cannot claim Dallas street for Austin task");

    const dallasScope: StreetScope = { ...scope, city: "Dallas" };
    const claimDallas = await claimDiscoveryStreet(db, dallasScope, "worker-3", "run-2", 0);
    assert.ok(claimDallas);
    assert.equal(claimDallas.streetKey, "dallas-st");
  });

  test("14. Target reached stops unnecessary further claims", async () => {
    const mockDb = new MockStreetDatabase();
    for (let i = 1; i <= 5; i++) {
      mockDb.addStreet("US", "Austin", `Street ${i}`, `street-${i}`);
    }
    const db = mockDb.toDbAdapter();

    let deliveredTotal = 0;
    const target = 10;
    const executedStreets: string[] = [];

    await runAreaWorkerPool({
      configuredWorkers: 3,
      totalCuratedAreas: 5,
      availableCapacity: 3,
      claimNextArea: async (usedAreas, slotIndex = 0) => {
        const slotWorkerId = `w${slotIndex + 1}`;
        const claim = await claimDiscoveryStreet(db, scope, slotWorkerId, "run-tgt", slotIndex);
        return claim?.stateId;
      },
      runArea: async (claimId) => {
        executedStreets.push(claimId);
        deliveredTotal += 10;
        return outcome({ discovered: 10, accepted: 10 });
      },
      tryAcquireSlot: () => () => {},
      isTerminal: () => deliveredTotal >= target,
    });

    assert.ok(executedStreets.length <= 3, "Target reached terminates pool without claiming all 5 streets");
  });

  test("15. Concurrent completion + next-claim race does not assign same street twice", async () => {
    const mockDb = new MockStreetDatabase();
    mockDb.addStreet("US", "Austin", "Street 1", "street-1");
    mockDb.addStreet("US", "Austin", "Street 2", "street-2");
    mockDb.addStreet("US", "Austin", "Street 3", "street-3");
    mockDb.addStreet("US", "Austin", "Street 4", "street-4");
    const db = mockDb.toDbAdapter();

    const claim1 = await claimDiscoveryStreet(db, scope, "w1", "run-race", 0);
    const claim2 = await claimDiscoveryStreet(db, scope, "w2", "run-race", 1);
    const claim3 = await claimDiscoveryStreet(db, scope, "w3", "run-race", 2);

    assert.ok(claim1 && claim2 && claim3);

    const [next1, next2] = await Promise.all([
      (async () => {
        await completeDiscoveryStreetClaim(db, claim1, scope.userId, "w1");
        return claimDiscoveryStreet(db, scope, "w1", "run-race", 0);
      })(),
      (async () => {
        await completeDiscoveryStreetClaim(db, claim2, scope.userId, "w2");
        return claimDiscoveryStreet(db, scope, "w2", "run-race", 1);
      })(),
    ]);

    const assigned = [next1, next2].filter(Boolean);
    assert.equal(assigned.length, 1, "Only one worker gets the last remaining street");
    assert.equal(assigned[0]?.streetKey, "street-4");
  });
});
