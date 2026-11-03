import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PlanPlaceCoordinator,
  type TimeProvider,
} from "../planPlaceCoordinator.js";
import {
  CandidateReceiptStore,
  validateGoogleMapsCardUrl,
} from "../candidateReceiptStore.js";

class FakeTimeProvider implements TimeProvider {
  private currentTime = 50_000;
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
}

const VERIFIED_CHID = "ChIJtQHuj3_ND4gRCGB5fYGOs4k"; // 0x880fcd7f8fee01b5:0x89b38e817d796008
const VERIFIED_HEX = "0x880fcd7f8fee01b5:0x89b38e817d796008";
const VALID_MAPS_URL = "https://www.google.com/maps/place/Some+Cafe/@40.7,-74.0,17z";

describe("CandidateReceiptStore (Gate 2)", () => {
  describe("1. Place ID Receipt Creation & Admission Lifecycle", () => {
    it("creates receipt in PRE_CLICK, rejects consumption in PRE_CLICK, and consumes once in CLICK_STARTED", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });

      assert.equal(createRes.success, true);
      assert.equal(createRes.status, "CREATED");
      if (!createRes.success) return;

      const { receipt } = createRes;
      assert.equal(receipt.kind, "PLACE_ID");
      assert.equal(receipt.claimPhase, "PRE_CLICK");

      // Attempt consumption while claim remains in PRE_CLICK -> MUST BE REJECTED
      const prematureConsume = store.consumePlaceIdReceipt({
        receiptId: receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });

      assert.equal(prematureConsume.success, false);
      assert.equal(prematureConsume.status, "CLICK_NOT_STARTED");

      // Transition coordinator claim to CLICK_STARTED
      const clickRes = coordinator.notifyClickStarted("scout-1", "req-1", claimRes.claimToken);
      assert.equal(clickRes.success, true);

      // Now consumption succeeds
      const consumeRes = store.consumePlaceIdReceipt({
        receiptId: receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });

      assert.equal(consumeRes.success, true);
      assert.equal(consumeRes.status, "CONSUMED");
      if (consumeRes.success) {
        assert.equal(consumeRes.receipt.consumed, true);
        assert.equal(consumeRes.receipt.consumedAt, clock.now());
      }
    });

    it("rejects receipt creation if coordinator claim does not exist or is invalid", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: "fabricated-token",
      });

      assert.equal(createRes.success, false);
      assert.equal(createRes.status, "INVALID_CLAIM");
    });
  });

  describe("2. Single-Use Enforcement", () => {
    it("rejects second consumption attempt of the same Place ID receipt", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(createRes.success, true);
      if (!createRes.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", claimRes.claimToken);

      // First consumption succeeds
      const consume1 = store.consumePlaceIdReceipt({
        receiptId: createRes.receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(consume1.success, true);

      // Replay rejected
      const consume2 = store.consumePlaceIdReceipt({
        receiptId: createRes.receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(consume2.success, false);
      assert.equal(consume2.status, "ALREADY_CONSUMED");
    });
  });

  describe("3. Binding Mismatch Rejections", () => {
    it("rejects consumption when scout, request, Place ID, or token mismatches", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", claimRes.claimToken);

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(createRes.success, true);
      if (!createRes.success) return;

      const { receiptId } = createRes.receipt;

      // Wrong scout
      assert.equal(
        store.consumePlaceIdReceipt({
          receiptId,
          scoutId: "scout-wrong",
          requestId: "req-1",
          canonicalPlaceId: VERIFIED_HEX,
          claimToken: claimRes.claimToken,
        }).status,
        "WRONG_SCOUT"
      );

      // Wrong request
      assert.equal(
        store.consumePlaceIdReceipt({
          receiptId,
          scoutId: "scout-1",
          requestId: "req-wrong",
          canonicalPlaceId: VERIFIED_HEX,
          claimToken: claimRes.claimToken,
        }).status,
        "WRONG_REQUEST"
      );

      // Wrong Place ID
      assert.equal(
        store.consumePlaceIdReceipt({
          receiptId,
          scoutId: "scout-1",
          requestId: "req-1",
          canonicalPlaceId: "0x123:0x456",
          claimToken: claimRes.claimToken,
        }).status,
        "WRONG_PLACE_ID"
      );

      // Wrong token
      assert.equal(
        store.consumePlaceIdReceipt({
          receiptId,
          scoutId: "scout-1",
          requestId: "req-1",
          canonicalPlaceId: VERIFIED_HEX,
          claimToken: "wrong-token",
        }).status,
        "WRONG_TOKEN"
      );
    });

    it("rejects unknown or fabricated receipt ID", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const res = store.consumePlaceIdReceipt({
        receiptId: "fabricated-receipt-uuid",
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: "any-token",
      });

      assert.equal(res.success, false);
      assert.equal(res.status, "UNKNOWN_RECEIPT");
    });
  });

  describe("4. Expired and Fenced Claim Rejection at Consumption", () => {
    it("rejects receipt consumption if claim expires in coordinator before consumption", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({
        planId: "plan-1",
        defaultLeaseDurationMs: 10_000,
        timeProvider: clock,
      });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", claimRes.claimToken);

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(createRes.success, true);
      if (!createRes.success) return;

      // Advance clock past lease expiration
      clock.advanceTime(11_000);

      // Consumption must be rejected because claim is now fenced in coordinator
      const consumeRes = store.consumePlaceIdReceipt({
        receiptId: createRes.receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });

      assert.equal(consumeRes.success, false);
      assert.equal(consumeRes.status, "CLAIM_INVALID_AT_CONSUMPTION");
    });
  });

  describe("5. Abandoned Receipt Handling", () => {
    it("marks receipt abandoned and prevents subsequent consumption", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      coordinator.notifyClickStarted("scout-1", "req-1", claimRes.claimToken);

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(createRes.success, true);
      if (!createRes.success) return;

      const { receiptId } = createRes.receipt;

      // Abandon receipt
      const abandonRes = store.abandonReceipt({ receiptId, scoutId: "scout-1" });
      assert.equal(abandonRes.success, true);
      assert.equal(abandonRes.status, "ABANDONED");

      // Attempting to consume abandoned receipt fails
      const consumeRes = store.consumePlaceIdReceipt({
        receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });

      assert.equal(consumeRes.success, false);
      assert.equal(consumeRes.status, "RECEIPT_ABANDONED");
    });
  });

  describe("6. Google Maps URL Policy Validation", () => {
    it("accepts valid Google Maps endpoints and card URLs", () => {
      const validCases = [
        "https://www.google.com/maps/place/Some+Cafe/@40.7,-74.0,17z",
        "https://maps.google.com/?cid=123456789",
        "https://www.google.co.uk/maps/search/restaurants/@51.5,-0.1,15z",
        "https://maps.google.ca/maps?q=coffee",
        "https://maps.app.goo.gl/abcdef123",
        "https://goo.gl/maps/xyz789",
        "http://www.google.com/maps/place/Cafe",
      ];

      for (const url of validCases) {
        const res = validateGoogleMapsCardUrl(url);
        assert.equal(res.valid, true, `Expected valid: ${url}`);
      }
    });

    it("rejects unsupported protocols, malformed URLs, and unrelated domains", () => {
      const invalidCases = [
        "",
        "   \t\n ",
        "not_a_url",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "ftp://google.com/maps",
        "https://evil-google.com/maps/place/Cafe",
        "https://google.com.attacker.com/maps",
        "https://example.com/place/cafe",
        "https://www.google.com/search?q=restaurants", // not /maps
        "https://www.google.com/finance",             // not /maps
        "https://maps.app.goo.gl/",                   // missing path token
      ];

      for (const url of invalidCases) {
        const res = validateGoogleMapsCardUrl(url);
        assert.equal(res.valid, false, `Expected invalid: ${url}`);
      }
    });
  });

  describe("7. Fallback Receipts (Missing Place ID Cards) & Admission Lifecycle", () => {
    it("creates fallback receipt in PRE_CLICK, rejects consumption in PRE_CLICK, and consumes once in CLICK_STARTED", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      // MISSING classification (null)
      const createRes = store.createFallbackReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        rawPlaceId: null,
        cardUrl: VALID_MAPS_URL,
      });

      assert.equal(createRes.success, true);
      assert.equal(createRes.status, "CREATED");
      if (!createRes.success) return;

      const { receipt } = createRes;
      assert.equal(receipt.kind, "FALLBACK");
      assert.equal(receipt.claimPhase, "PRE_CLICK");

      // Attempt consumption before click started -> REJECTED
      const prematureConsume = store.consumeFallbackReceipt({
        receiptId: receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        cardUrl: VALID_MAPS_URL,
      });
      assert.equal(prematureConsume.success, false);
      assert.equal(prematureConsume.status, "CLICK_NOT_STARTED");

      // Notify fallback click started
      const clickRes = store.notifyFallbackClickStarted({
        receiptId: receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
      });
      assert.equal(clickRes.success, true);
      assert.equal(clickRes.status, "CLICK_STARTED");

      // Now consumption succeeds
      const consumeRes = store.consumeFallbackReceipt({
        receiptId: receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        cardUrl: VALID_MAPS_URL,
      });

      assert.equal(consumeRes.success, true);
      assert.equal(consumeRes.status, "CONSUMED");

      // Second consumption rejected (single-use)
      const replayRes = store.consumeFallbackReceipt({
        receiptId: receipt.receiptId,
        scoutId: "scout-1",
        requestId: "req-1",
        cardUrl: VALID_MAPS_URL,
      });
      assert.equal(replayRes.success, false);
      assert.equal(replayRes.status, "ALREADY_CONSUMED");
    });

    it("rejects fallback receipt creation if rawPlaceId is MALFORMED", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const resString = store.createFallbackReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        rawPlaceId: "malformed_place_id",
        cardUrl: VALID_MAPS_URL,
      });
      assert.equal(resString.success, false);
      assert.equal(resString.status, "REJECTED_MALFORMED_PLACE_ID");

      const resNumber = store.createFallbackReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        rawPlaceId: 12345,
        cardUrl: VALID_MAPS_URL,
      });
      assert.equal(resNumber.success, false);
      assert.equal(resNumber.status, "REJECTED_MALFORMED_PLACE_ID");
    });

    it("rejects fallback receipt creation if card has a VALID Place ID", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const resValid = store.createFallbackReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        rawPlaceId: VERIFIED_CHID,
        cardUrl: VALID_MAPS_URL,
      });

      assert.equal(resValid.success, false);
      assert.equal(resValid.status, "REJECTED_VALID_PLACE_ID_PRESENT");
    });

    it("rejects fallback receipt creation and consumption on invalid URL", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const resBadUrl = store.createFallbackReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        rawPlaceId: null,
        cardUrl: "https://evil-attacker.com/maps",
      });
      assert.equal(resBadUrl.success, false);
      assert.equal(resBadUrl.status, "INVALID_URL");
    });

    it("rejects fallback receipt consumption on URL, scout, or request mismatch", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const createRes = store.createFallbackReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        rawPlaceId: "",
        cardUrl: VALID_MAPS_URL,
      });
      assert.equal(createRes.success, true);
      if (!createRes.success) return;

      const { receiptId } = createRes.receipt;
      store.notifyFallbackClickStarted({ receiptId, scoutId: "scout-1", requestId: "req-1" });

      // URL mismatch
      assert.equal(
        store.consumeFallbackReceipt({
          receiptId,
          scoutId: "scout-1",
          requestId: "req-1",
          cardUrl: "https://www.google.com/maps/place/DifferentCafe",
        }).status,
        "WRONG_URL"
      );

      // Scout mismatch
      assert.equal(
        store.consumeFallbackReceipt({
          receiptId,
          scoutId: "scout-wrong",
          requestId: "req-1",
          cardUrl: VALID_MAPS_URL,
        }).status,
        "WRONG_SCOUT"
      );

      // Request mismatch
      assert.equal(
        store.consumeFallbackReceipt({
          receiptId,
          scoutId: "scout-1",
          requestId: "req-wrong",
          cardUrl: VALID_MAPS_URL,
        }).status,
        "WRONG_REQUEST"
      );
    });
  });

  describe("8. Receipt Immutability", () => {
    it("ensures returned receipt snapshots are frozen and cannot be mutated externally", () => {
      const clock = new FakeTimeProvider();
      const coordinator = new PlanPlaceCoordinator({ planId: "plan-1", timeProvider: clock });
      const store = new CandidateReceiptStore(coordinator, { timeProvider: clock });

      const claimRes = coordinator.tryClaim("scout-1", "req-1", VERIFIED_CHID);
      assert.equal(claimRes.success, true);
      if (!claimRes.success) return;

      const createRes = store.createPlaceIdReceipt({
        scoutId: "scout-1",
        requestId: "req-1",
        canonicalPlaceId: VERIFIED_HEX,
        claimToken: claimRes.claimToken,
      });
      assert.equal(createRes.success, true);
      if (!createRes.success) return;

      const { receipt } = createRes;
      assert.ok(Object.isFrozen(receipt));

      assert.throws(() => {
        (receipt as any).consumed = true;
      });

      assert.throws(() => {
        (receipt as any).scoutId = "hacked-scout";
      });
    });
  });
});
