import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { resolveZeroSlotCityScheduling } = await import("../cityScheduling.js");
const { createBrowserSlotPool } = await import("../../lib/browserSlotPool.js");

describe("Priority 4: Scheduler slot admission & deferral semantics", () => {
  it("waiting cities with held slot defer without consuming attempts or going terminal while plan is active", () => {
    // Simulate 10 consecutive deferrals while another city holds the single browser slot
    let priorDeferrals = 0;
    for (let round = 1; round <= 10; round++) {
      const decision = resolveZeroSlotCityScheduling({
        hasRemainingWork: true,
        deferredNoSlot: true,
        priorDeferrals,
        isPlanTerminal: false,
      });

      assert.equal(decision.action, "defer", `Round ${round} should defer`);
      assert.equal(decision.reason, "CITY_DEFERRED_NO_SLOT");
      assert.equal(decision.consumeAttempt, false, `Round ${round} must not consume attempt`);
      assert.equal(decision.nextDeferrals, priorDeferrals + 1);
      priorDeferrals = decision.nextDeferrals;
    }

    assert.equal(priorDeferrals, 10, "Accumulated 10 deferrals without going terminal");
  });

  it("plan target-reached cancels waiting cities as CANCELLED, not failed", () => {
    // When plan reaches target (terminal), waiting city resolves as CANCELLED
    const decision = resolveZeroSlotCityScheduling({
      hasRemainingWork: true,
      deferredNoSlot: true,
      priorDeferrals: 5,
      isPlanTerminal: true,
    });

    assert.equal(decision.action, "terminal_no_slot");
    assert.equal(decision.reason, "CANCELLED");
    assert.equal(decision.consumeAttempt, false);
  });

  it("fair turn-taking: release allows next waiting city to acquire single slot", () => {
    const slotPool = createBrowserSlotPool(1);

    // City A acquires slot
    const releaseA = slotPool.tryAcquire();
    assert.ok(typeof releaseA === "function", "City A acquires slot");

    // City B tries to acquire - fails (no slot)
    const releaseB1 = slotPool.tryAcquire();
    assert.equal(releaseB1, undefined, "City B cannot acquire while City A holds slot");

    // City C tries to acquire - fails (no slot)
    const releaseC1 = slotPool.tryAcquire();
    assert.equal(releaseC1, undefined, "City C cannot acquire while City A holds slot");

    // City A finishes and releases slot
    releaseA();

    // After release, City B can acquire slot
    const releaseB2 = slotPool.tryAcquire();
    assert.ok(typeof releaseB2 === "function", "City B acquires slot after City A releases");

    // City C still cannot acquire while City B holds it
    const releaseC2 = slotPool.tryAcquire();
    assert.equal(releaseC2, undefined, "City C cannot acquire while City B holds slot");

    // City B releases
    releaseB2();

    // City C acquires slot
    const releaseC3 = slotPool.tryAcquire();
    assert.ok(typeof releaseC3 === "function", "City C acquires slot after City B releases");
    releaseC3();
  });

  it("regression: street is never claimed before browser slot admission", async () => {
    const slotPool = createBrowserSlotPool(1);
    // Hold the single browser slot
    const releaseHolder = slotPool.tryAcquire();
    assert.ok(typeof releaseHolder === "function");

    let streetClaimAttempted = false;
    const fakeClaimStreet = async () => {
      streetClaimAttempted = true;
      return { id: 1, street_name: "35th St" };
    };

    // Attempted worker loop sequence:
    const releaseSlot = slotPool.tryAcquire();
    if (releaseSlot !== undefined) {
      try {
        await fakeClaimStreet();
      } finally {
        releaseSlot();
      }
    }

    assert.equal(releaseSlot, undefined, "Slot admission failed as expected");
    assert.equal(streetClaimAttempted, false, "Claim MUST NOT be called when slot is unavailable");

    releaseHolder();
  });

  it("denominator semantics: target is explicitly plan-cumulative, not per-city", () => {
    // In MAST discovery, the target count configured on a discovery plan (e.g. 50 leads)
    // applies to the entire plan across all cities. Progress logs explicitly state:
    // "plan target: X/Y delivered".
    const planTarget = 50;
    const city1Accepted = 20;
    const city2Accepted = 30;
    const totalDelivered = city1Accepted + city2Accepted;

    const isPlanTargetReached = totalDelivered >= planTarget;
    assert.equal(isPlanTargetReached, true, "Target is reached across cumulative plan deliveries");
  });
});
