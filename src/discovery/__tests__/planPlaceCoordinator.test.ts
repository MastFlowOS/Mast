import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PlanPlaceCoordinator,
  type TimeProvider,
  type ReadonlyClaim,
  MIN_LEASE_DURATION_MS,
  MAX_LEASE_DURATION_MS,
  validateLeaseDuration,
} from "../planPlaceCoordinator.js";

class FakeTimeProvider implements TimeProvider {
  private currentTime = 10_000;
  private nextTimerId = 1;
  private timers = new Map<number, { callback: () => void; triggerTime: number }>();

  public now(): number {
    return this.currentTime;
  }

  public setTimeout(callback: () => void, ms: number): any {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, triggerTime: this.currentTime + ms });
    return id;
  }

  public clearTimeout(handle: any): void {
    this.timers.delete(Number(handle));
  }

  public advanceTime(ms: number): void {
    this.currentTime += ms;
    const ready: (() => void)[] = [];
    for (const [id, timer] of Array.from(this.timers.entries())) {
      if (this.currentTime >= timer.triggerTime) {
        this.timers.delete(id);
        ready.push(timer.callback);
      }
    }
    for (const cb of ready) {
      cb();
    }
  }

  public get pendingTimersCount(): number {
    return this.timers.size;
  }
}

const VERIFIED_CHID_1 = "ChIJtQHuj3_ND4gRCGB5fYGOs4k"; // 0x880fcd7f8fee01b5:0x89b38e817d796008
const VERIFIED_CHID_2 = "ChIJHXydMNIlDogRFs3i2VJvfQs"; // 0x880e25d2309d7c1d:0xb7d6f52d9e2cd16
const VERIFIED_HEX_1 = "0x880fcd7f8fee01b5:0x89b38e817d796008";
const VERIFIED_HEX_2 = "0x880e25d2309d7c1d:0xb7d6f52d9e2cd16";

describe("PlanPlaceCoordinator (Gate 2)", () => {
  describe("1. Initial Known Place IDs & Validation", () => {
    it("canonicalizes valid initial Place IDs and prevents scouts from claiming them", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        initialKnownPlaceIds: [VERIFIED_CHID_1, VERIFIED_HEX_2],
        timeProvider: clock,
      });

      assert.equal(coordinator.getKnownPlaceIdsCount(), 2);

      // Attempting to claim known place 1 via ChIJ fails
      const claim1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim1.success, false);
      assert.equal(claim1.status, "ALREADY_KNOWN");
      if (!claim1.success) {
        assert.equal(claim1.canonicalPlaceId, VERIFIED_HEX_1);
      }

      // Attempting to claim known place 2 via Hex fails
      const claim2 = coordinator.tryClaim("scout-2", "req-2", VERIFIED_HEX_2);
      assert.equal(claim2.success, false);
      assert.equal(claim2.status, "ALREADY_KNOWN");
    });

    it("safely ignores missing IDs in initialKnownPlaceIds without creating valid claims", () => {
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        initialKnownPlaceIds: [null, undefined, "", "   \t\n  "],
      });
      assert.equal(coordinator.getKnownPlaceIdsCount(), 0);
    });

    it("fails closed on construction if any initial known Place ID is malformed", () => {
      assert.throws(
        () => {
          new PlanPlaceCoordinator({
            planId: "plan-1",
            initialKnownPlaceIds: ["not_a_place_id"],
          });
        },
        /malformed initial known Place ID/
      );

      assert.throws(
        () => {
          new PlanPlaceCoordinator({
            planId: "plan-1",
            initialKnownPlaceIds: [12345 as any],
          });
        },
        /malformed initial known Place ID/
      );
    });

    it("rejects tryClaim with missing or malformed Place IDs", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1" });

      const resMissing = coordinator.tryClaim("scout-1", "req-1", null);
      assert.equal(resMissing.success, false);
      assert.equal(resMissing.status, "MISSING_PLACE_ID");

      const resMalformed = coordinator.tryClaim("scout-1", "req-1", "invalid_id");
      assert.equal(resMalformed.success, false);
      assert.equal(resMalformed.status, "MALFORMED_PLACE_ID");
    });
  });

  describe("2. Lease Duration Validation", () => {
    it("validates helper function bounds correctly", () => {
      assert.equal(validateLeaseDuration(30_000, "test").valid, true);
      assert.equal(validateLeaseDuration(1_000, "test").valid, true);
      assert.equal(validateLeaseDuration(300_000, "test").valid, true);

      assert.equal(validateLeaseDuration(0, "test").valid, false);
      assert.equal(validateLeaseDuration(-100, "test").valid, false);
      assert.equal(validateLeaseDuration(999, "test").valid, false);
      assert.equal(validateLeaseDuration(300_001, "test").valid, false);
      assert.equal(validateLeaseDuration(NaN, "test").valid, false);
      assert.equal(validateLeaseDuration(Infinity, "test").valid, false);
      assert.equal(validateLeaseDuration("30000", "test").valid, false);
    });

    it("rejects invalid defaultLeaseDurationMs in constructor", () => {
      assert.throws(() => {
        new PlanPlaceCoordinator({ planId: "p1", defaultLeaseDurationMs: 0 });
      }, /must be between/);

      assert.throws(() => {
        new PlanPlaceCoordinator({ planId: "p1", defaultLeaseDurationMs: -5000 });
      }, /must be between/);

      assert.throws(() => {
        new PlanPlaceCoordinator({ planId: "p1", defaultLeaseDurationMs: 500_000 });
      }, /must be between/);

      assert.throws(() => {
        new PlanPlaceCoordinator({ planId: "p1", defaultLeaseDurationMs: NaN });
      }, /must be a finite number/);
    });

    it("rejects invalid custom leaseDurationMs in tryClaim", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "p1" });

      const resZero = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1, 0);
      assert.equal(resZero.success, false);
      assert.equal(resZero.status, "INVALID_LEASE_DURATION");

      const resNegative = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1, -1000);
      assert.equal(resNegative.success, false);
      assert.equal(resNegative.status, "INVALID_LEASE_DURATION");

      const resExcessive = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1, 1_000_000);
      assert.equal(resExcessive.success, false);
      assert.equal(resExcessive.status, "INVALID_LEASE_DURATION");
    });

    it("rejects invalid extensionMs in renewClaim", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "p1" });
      const claim = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim.success, true);
      if (!claim.success) return;

      const renewZero = coordinator.renewClaim("scout-1", "req-1", claim.claimToken, 0);
      assert.equal(renewZero.success, false);
      assert.equal(renewZero.status, "INVALID_LEASE_DURATION");

      const renewExcessive = coordinator.renewClaim("scout-1", "req-1", claim.claimToken, 400_000);
      assert.equal(renewExcessive.success, false);
      assert.equal(renewExcessive.status, "INVALID_LEASE_DURATION");
    });
  });

  describe("3. Two Scouts Competing for Same ID & Concurrency", () => {
    it("grants claim to first scout and rejects competing scout with ALREADY_CLAIMED", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim1.success, true);
      assert.equal(claim1.status, "CLAIM_ACQUIRED");
      if (claim1.success) {
        assert.equal(claim1.canonicalPlaceId, VERIFIED_HEX_1);
        assert.equal(claim1.claim.phase, "PRE_CLICK");
      }

      // Scout 2 attempts to claim the same Place ID via Hex representation
      const claim2 = coordinator.tryClaim("scout-2", "req-2", VERIFIED_HEX_1);
      assert.equal(claim2.success, false);
      assert.equal(claim2.status, "ALREADY_CLAIMED");
      if (!claim2.success) {
        assert.equal(claim2.owningScoutId, "scout-1");
      }
    });

    it("handles concurrent sequential claim attempts atomically within the event loop", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const results = [
        coordinator.tryClaim("scout-A", "req-A", VERIFIED_CHID_1),
        coordinator.tryClaim("scout-B", "req-B", VERIFIED_CHID_1),
        coordinator.tryClaim("scout-C", "req-C", VERIFIED_CHID_1),
      ];

      const acquired = results.filter((r) => r.success);
      const rejected = results.filter((r) => !r.success);

      assert.equal(acquired.length, 1);
      assert.equal(rejected.length, 2);
      assert.equal(acquired[0].status, "CLAIM_ACQUIRED");
      assert.equal(rejected[0].status, "ALREADY_CLAIMED");
      assert.equal(rejected[1].status, "ALREADY_CLAIMED");
    });

    it("rejects duplicate claim attempt by the same scout on same Place ID", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim1.success, true);

      const claimAgain = coordinator.tryClaim("scout-1", "req-2", VERIFIED_CHID_1);
      assert.equal(claimAgain.success, false);
      assert.equal(claimAgain.status, "ALREADY_CLAIMED_BY_SELF");
    });
  });

  describe("4. Claim Ownership & Token Validation", () => {
    it("validates active claim with matching scout, request, and token", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      const valOk = coordinator.validateActiveClaim("scout-1", "req-1", claimRes.claimToken, VERIFIED_HEX_1);
      assert.equal(valOk.valid, true);
      assert.equal(valOk.status, "VALID");

      // Wrong scout
      const valWrongScout = coordinator.validateActiveClaim("scout-2", "req-1", claimRes.claimToken);
      assert.equal(valWrongScout.valid, false);
      assert.equal(valWrongScout.status, "WRONG_SCOUT");

      // Wrong request
      const valWrongReq = coordinator.validateActiveClaim("scout-1", "req-wrong", claimRes.claimToken);
      assert.equal(valWrongReq.valid, false);
      assert.equal(valWrongReq.status, "WRONG_REQUEST");

      // Wrong Place ID
      const valWrongPid = coordinator.validateActiveClaim("scout-1", "req-1", claimRes.claimToken, VERIFIED_HEX_2);
      assert.equal(valWrongPid.valid, false);
      assert.equal(valWrongPid.status, "PLACE_ID_MISMATCH");

      // Unknown token
      const valWrongToken = coordinator.validateActiveClaim("scout-1", "req-1", "non-existent-token");
      assert.equal(valWrongToken.valid, false);
      assert.equal(valWrongToken.status, "CLAIM_NOT_FOUND");
    });
  });

  describe("5. Claim Renewal & Expiry Rejection", () => {
    it("renews an active claim before expiration and advances expiresAt", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 20_000,
        timeProvider: clock,
      });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      assert.equal(claimRes.expiresAt, 30_000); // 10,000 + 20,000

      // Advance clock by 10s (within lease)
      clock.advanceTime(10_000);

      // Renew with 25s extension
      const renewRes = coordinator.renewClaim("scout-1", "req-1", claimRes.claimToken, 25_000);
      assert.equal(renewRes.success, true);
      assert.equal(renewRes.status, "RENEWED");
      if (renewRes.success) {
        assert.equal(renewRes.newExpiresAt, 45_000); // 20,000 (current) + 25,000
      }
    });

    it("rejects renewal if lease has already expired", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 15_000,
        timeProvider: clock,
      });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      // Advance clock past expiration
      clock.advanceTime(16_000);

      const renewRes = coordinator.renewClaim("scout-1", "req-1", claimRes.claimToken);
      assert.equal(renewRes.success, false);
      assert.equal(renewRes.status, "CLAIM_FENCED");
    });
  });

  describe("6. PRE_CLICK Voluntary Release vs CLICK_STARTED Release Rejection", () => {
    it("allows voluntary release in PRE_CLICK phase, freeing the Place ID for others", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim1.success, true);
      if (!claim1.success) return;

      const relRes = coordinator.releaseClaim("scout-1", "req-1", claim1.claimToken);
      assert.equal(relRes.success, true);
      assert.equal(relRes.status, "RELEASED");

      // Place ID can now be claimed by scout-2
      const claim2 = coordinator.tryClaim("scout-2", "req-2", VERIFIED_CHID_1);
      assert.equal(claim2.success, true);
      assert.equal(claim2.status, "CLAIM_ACQUIRED");
    });

    it("rejects voluntary release once CLICK_STARTED phase is entered", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim1.success, true);
      if (!claim1.success) return;

      // Transition to CLICK_STARTED
      const clickRes = coordinator.notifyClickStarted("scout-1", "req-1", claim1.claimToken);
      assert.equal(clickRes.success, true);
      assert.equal(clickRes.status, "CLICK_STARTED");

      // Attempt voluntary release
      const relRes = coordinator.releaseClaim("scout-1", "req-1", claim1.claimToken);
      assert.equal(relRes.success, false);
      assert.equal(relRes.status, "CANNOT_RELEASE_CLICK_STARTED");

      // Competing scout cannot claim it
      const claim2 = coordinator.tryClaim("scout-2", "req-2", VERIFIED_CHID_1);
      assert.equal(claim2.success, false);
      assert.equal(claim2.status, "ALREADY_CLAIMED");
    });
  });

  describe("7. Strict Claim Lifecycle: completeClaim Enforcement", () => {
    it("rejects completeClaim in PRE_CLICK phase with CLICK_NOT_STARTED", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim.success, true);
      if (!claim.success) return;

      assert.equal(claim.claim.phase, "PRE_CLICK");

      // Attempt completion before click started
      const compRes = coordinator.completeClaim("scout-1", "req-1", claim.claimToken);
      assert.equal(compRes.success, false);
      assert.equal(compRes.status, "CLICK_NOT_STARTED");
    });

    it("completes claim successfully once in CLICK_STARTED phase", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim.success, true);
      if (!claim.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", claim.claimToken);

      const compRes = coordinator.completeClaim("scout-1", "req-1", claim.claimToken);
      assert.equal(compRes.success, true);
      assert.equal(compRes.status, "COMPLETED");
    });

    it("repeated completion calls remain idempotent", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const claim = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim.success, true);
      if (!claim.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", claim.claimToken);

      const comp1 = coordinator.completeClaim("scout-1", "req-1", claim.claimToken);
      assert.equal(comp1.success, true);
      assert.equal(comp1.status, "COMPLETED");

      const comp2 = coordinator.completeClaim("scout-1", "req-1", claim.claimToken);
      assert.equal(comp2.success, true);
      assert.equal(comp2.status, "ALREADY_COMPLETED");
    });

    it("rejects delayed completion message for an expired/fenced claim", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 10_000,
        timeProvider: clock,
      });

      const c1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(c1.success, true);
      if (!c1.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", c1.claimToken);

      clock.advanceTime(11_000); // Expired

      const compRes = coordinator.completeClaim("scout-1", "req-1", c1.claimToken);
      assert.equal(compRes.success, false);
      assert.equal(compRes.status, "CLAIM_FENCED");
    });
  });

  describe("8. Expiration, Fencing, and Exactly-Once Notification", () => {
    it("fences expired claim, triggers notification exactly once, and prevents other scouts from claiming", () => {
      const clock = new FakeTimeProvider();
      const expiredNotified: ReadonlyClaim[] = [];

      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 10_000,
        timeProvider: clock,
        onClaimExpired: (claim) => {
          expiredNotified.push(claim);
        },
      });

      const claim1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(claim1.success, true);
      if (!claim1.success) return;

      assert.equal(expiredNotified.length, 0);

      // Advance clock past expiration
      clock.advanceTime(10_001);

      // Notification fired exactly once
      assert.equal(expiredNotified.length, 1);
      assert.equal(expiredNotified[0].canonicalPlaceId, VERIFIED_HEX_1);
      assert.equal(expiredNotified[0].fenced, true);

      // Subsequent time advance does NOT re-notify
      clock.advanceTime(5_000);
      assert.equal(expiredNotified.length, 1);

      // Synchronous validation confirms claim is fenced
      const val = coordinator.validateActiveClaim("scout-1", "req-1", claim1.claimToken);
      assert.equal(val.valid, false);
      assert.equal(val.status, "CLAIM_FENCED");

      // Competing scout cannot claim it because it is FENCED
      const compClaim = coordinator.tryClaim("scout-2", "req-2", VERIFIED_CHID_1);
      assert.equal(compClaim.success, false);
      assert.equal(compClaim.status, "FENCED");
      if (!compClaim.success) {
        assert.equal(compClaim.owningScoutId, "scout-1");
      }
    });
  });

  describe("9. Post-Termination Release Privileged Contract (releaseAllForScout)", () => {
    it("rejects empty or missing scoutId or reason parameter", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "p1" });

      assert.throws(() => {
        coordinator.releaseAllForScout("", "valid reason");
      }, /valid non-empty scoutId/);

      assert.throws(() => {
        coordinator.releaseAllForScout("scout-1", "");
      }, /valid non-empty reason string/);
    });

    it("releases fenced and CLICK_STARTED claims only when confirmed process termination is invoked", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 10_000,
        timeProvider: clock,
      });

      // Scout 1 claims two places: place 1 in CLICK_STARTED, place 2 in PRE_CLICK
      const c1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      const c2 = coordinator.tryClaim("scout-1", "req-2", VERIFIED_CHID_2);
      assert.equal(c1.success, true);
      assert.equal(c2.success, true);
      if (!c1.success || !c2.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", c1.claimToken);

      // Advance clock to expire place 2
      clock.advanceTime(12_000);

      // Competing scout cannot claim either
      assert.equal(coordinator.tryClaim("scout-2", "req-comp-1", VERIFIED_CHID_1).status, "FENCED");
      assert.equal(coordinator.tryClaim("scout-2", "req-comp-2", VERIFIED_CHID_2).status, "FENCED");

      // Process manager confirms scout-1 process terminated
      const termRelease = coordinator.releaseAllForScout("scout-1", "PROCESS_CONFIRMED_TERMINATED");
      assert.equal(termRelease.success, true);
      assert.equal(termRelease.releasedCount, 2);
      assert.ok(termRelease.releasedPlaceIds.includes(VERIFIED_HEX_1));
      assert.ok(termRelease.releasedPlaceIds.includes(VERIFIED_HEX_2));

      // Now competing scout can claim them
      const comp1After = coordinator.tryClaim("scout-2", "req-comp-1", VERIFIED_CHID_1);
      assert.equal(comp1After.success, true);
      assert.equal(comp1After.status, "CLAIM_ACQUIRED");
    });

    it("does not release completed claims during process termination release", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const c1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(c1.success, true);
      if (!c1.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", c1.claimToken);
      coordinator.completeClaim("scout-1", "req-1", c1.claimToken);

      const termRelease = coordinator.releaseAllForScout("scout-1", "PROCESS_CONFIRMED_TERMINATED");
      assert.equal(termRelease.releasedCount, 0);

      // Completed claim remains completed and permanently blocked
      const compClaim = coordinator.tryClaim("scout-2", "req-comp", VERIFIED_CHID_1);
      assert.equal(compClaim.success, false);
      assert.equal(compClaim.status, "ALREADY_COMPLETED");
    });
  });

  describe("10. Stale / Fabricated / Wrong-Owner Rejection", () => {
    it("rejects completion with wrong scout, request, or unknown token", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });

      const c1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(c1.success, true);
      if (!c1.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", c1.claimToken);

      assert.equal(coordinator.completeClaim("scout-2", "req-1", c1.claimToken).status, "WRONG_SCOUT");
      assert.equal(coordinator.completeClaim("scout-1", "req-wrong", c1.claimToken).status, "WRONG_REQUEST");
      assert.equal(coordinator.completeClaim("scout-1", "req-1", "fake-token").status, "CLAIM_NOT_FOUND");
    });
  });

  describe("11. Diagnostics & Counts Accuracy", () => {
    it("accurately distinguishes active, fenced, and completed claim counts", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "p1",
        defaultLeaseDurationMs: 10_000,
        timeProvider: clock,
      });

      assert.equal(coordinator.getActiveClaimsCount(), 0);
      assert.equal(coordinator.getFencedClaimsCount(), 0);
      assert.equal(coordinator.getTotalTrackedClaimsCount(), 0);

      // Claim 1: stays active
      const c1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      // Claim 2: will be completed
      const c2 = coordinator.tryClaim("scout-1", "req-2", VERIFIED_CHID_2);
      assert.equal(c1.success && c2.success, true);
      if (!c1.success || !c2.success) return;

      coordinator.notifyClickStarted("scout-1", "req-2", c2.claimToken);
      coordinator.completeClaim("scout-1", "req-2", c2.claimToken);

      assert.equal(coordinator.getActiveClaimsCount(), 1); // c1 only
      assert.equal(coordinator.getCompletedPlaceIdsCount(), 1); // c2
      assert.equal(coordinator.getTotalTrackedClaimsCount(), 2); // c1 + c2

      // Advance clock past lease duration of c1 -> c1 becomes fenced
      clock.advanceTime(11_000);

      assert.equal(coordinator.getActiveClaimsCount(), 0); // none active
      assert.equal(coordinator.getFencedClaimsCount(), 1); // c1 fenced
      assert.equal(coordinator.getCompletedPlaceIdsCount(), 1); // c2 completed
      assert.equal(coordinator.getTotalTrackedClaimsCount(), 2); // still tracked
    });
  });

  describe("12. Timer Generation & Renewal Behavior", () => {
    it("ensures timer callbacks from previous lease generations do not expire renewed claims", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 10_000,
        timeProvider: clock,
      });

      const c1 = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID_1);
      assert.equal(c1.success, true);
      if (!c1.success) return;

      // Advance by 8s, then renew with 10s more
      clock.advanceTime(8_000);
      const renew = coordinator.renewClaim("scout-1", "req-1", c1.claimToken, 10_000);
      assert.equal(renew.success, true);

      // Advance by 3s (total 11s from original claim start, which would have triggered old timer)
      clock.advanceTime(3_000);

      // Claim must STILL be valid because it was renewed to expire at t = 18_000 + 10_000 = 28_000
      const check = coordinator.validateActiveClaim("scout-1", "req-1", c1.claimToken);
      assert.equal(check.valid, true);
      assert.equal(check.status, "VALID");
    });
  });
});
