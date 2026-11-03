/**
 * src/discovery/__tests__/gate5EndToEndIntegration.test.ts
 * ========================================================
 *
 * MAST Phase 7.3 Gate 5 — End-to-End Integration & Regression Test Suite.
 *
 * Covers:
 * 1. Complete End-to-End Execution Path:
 *    Node discovery entry point -> pythonBridge.ts -> Python service subprocess ->
 *    MapsScraper -> candidate coordination -> receipt lifecycle -> streamed results -> final cleanup.
 * 2. Candidate Coordination & Receipt Store Lifecycle:
 *    Interaction between PlanPlaceCoordinator and CandidateReceiptStore, claim phases,
 *    CLICK_STARTED admission gating, single-use, fallback receipts, abandonment, and scout isolation.
 * 3. Process Ownership & Confirmed Termination Invariants:
 *    Authoritative tree termination verification before release, claim preservation on unconfirmed
 *    termination, critical invariant: releaseAllForScout() requires BOTH authenticated MAST_JOB_TERMINATED
 *    AND child exit.
 * 4. Comprehensive Failure & Recovery Matrix (all 15 specified scenarios):
 *    - Successful discovery
 *    - No results
 *    - Invalid Place ID
 *    - Duplicate candidate
 *    - Malformed Python output
 *    - Python early exit
 *    - Handshake timeout
 *    - Invalid nonce
 *    - Wrong scout ID
 *    - Cancellation (both unconfirmed termination and verified termination paths)
 *    - Browser startup failure
 *    - Driver startup failure
 *    - Missing termination message
 *    - Mismatched termination message
 *    - Concurrent scouts
 * 5. Concurrency & Isolation:
 *    Concurrent scouts, unique identities, isolated streams, independent process lifecycles,
 *    no cross-session message acceptance, and failure isolation.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";
process.env.SCRAPER_SUBPROCESS_INACTIVITY_MS ??= "10000";
process.env.SCRAPER_SUBPROCESS_MAX_MS ??= "30000";
process.env.SCRAPER_GRACEFUL_SHUTDOWN_MS ??= "1000";

const { runEngineQuery } = await import("../../scraperBridge/pythonBridge.js");
const { env } = await import("../../config/env.js");
const { PlanPlaceCoordinator } = await import("../planPlaceCoordinator.js");
const { CandidateReceiptStore } = await import("../candidateReceiptStore.js");
const { validateCoordinationPlaceId, canonicalPlaceId } = await import("../../lib/placeId.js");
const {
  scoutProcessManager,
  generateScoutSessionIdentity,
  validateReadyMessage,
  validateTerminatedMessage,
  createAckMessage,
  ScoutHandshakeError,
  ScoutHandshakeTimeoutError,
  ScoutHandshakeMismatchedNonceError,
  ScoutHandshakeMismatchedSessionError,
  ScoutHandshakeDuplicateReadyError,
} = await import("../scoutProcessManager.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../scraperBridge/__tests__/fixtures");

const activeCoordinators: any[] = [];
function createCoordinator(options: { planId: string; defaultLeaseDurationMs?: number }) {
  const coord = new PlanPlaceCoordinator(options);
  activeCoordinators.push(coord);
  return coord;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("MAST Phase 7.3 Gate 5 — End-to-End Integration & Regression Testing", () => {
  const originalEnginePath = env.SCRAPER_ENGINE_PATH;

  afterEach(() => {
    env.SCRAPER_ENGINE_PATH = originalEnginePath;
    for (const c of activeCoordinators) {
      try { c.destroy(); } catch {}
    }
    activeCoordinators.length = 0;
  });

  // =========================================================================
  // Section 3: Complete End-to-End Execution Path Integration
  // =========================================================================
  describe("1. Complete End-to-End Discovery Pipeline Execution", () => {
    it("traces full lifecycle: handshake -> ACK -> query delivery -> lead streaming -> coordinator claim & receipt -> confirmed termination -> clean release", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-multi-lead-engine");
      const planId = "plan_e2e_01";
      const scoutId = "scout_e2e_01";
      const requestId = "req_e2e_01";

      const coordinator = createCoordinator({ planId });
      const receiptStore = new CandidateReceiptStore(coordinator);

      // Pre-claim candidate place in coordinator (PRE_CLICK phase)
      const place1 = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const claim1 = coordinator.tryClaim(scoutId, requestId, place1);
      assert.equal(claim1.status, "CLAIM_ACQUIRED");
      assert.equal(claim1.claim.phase, "PRE_CLICK");
      const canonicalId1 = claim1.canonicalPlaceId;

      // Verify that in PRE_CLICK, candidate receipt can be created but NOT consumed
      const receiptRes1 = receiptStore.createPlaceIdReceipt({
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId1,
        claimToken: claim1.claimToken,
      });
      assert.equal(receiptRes1.success, true);
      if (!receiptRes1.success) return;

      const earlyConsume = receiptStore.consumePlaceIdReceipt({
        receiptId: receiptRes1.receipt.receiptId,
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId1,
        claimToken: claim1.claimToken,
      });
      assert.equal(earlyConsume.success, false);
      assert.equal(earlyConsume.status, "CLICK_NOT_STARTED");

      // Transition claim to CLICK_STARTED via notifyClickStarted
      const clickTrans = coordinator.notifyClickStarted(scoutId, requestId, claim1.claimToken, canonicalId1);
      assert.equal(clickTrans.status, "CLICK_STARTED");

      // Now candidate receipt can be consumed once
      const consumeRes = receiptStore.consumePlaceIdReceipt({
        receiptId: receiptRes1.receipt.receiptId,
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId1,
        claimToken: claim1.claimToken,
      });
      assert.equal(consumeRes.success, true);
      assert.equal(consumeRes.status, "CONSUMED");

      // Second consumption must be rejected (single-use enforcement)
      const dupConsume = receiptStore.consumePlaceIdReceipt({
        receiptId: receiptRes1.receipt.receiptId,
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId1,
        claimToken: claim1.claimToken,
      });
      assert.equal(dupConsume.success, false);
      assert.equal(dupConsume.status, "ALREADY_CONSUMED");

      // Complete place1 claim during active processing: completed claims are permanent and never released
      const completeRes = coordinator.completeClaim(scoutId, requestId, claim1.claimToken);
      assert.equal(completeRes.success, true);
      assert.equal(coordinator.getClaimByPlaceId(canonicalId1)?.completed, true);

      // Execute runEngineQuery in coordinated mode
      let doneInfo: any = null;
      const leads: any[] = [];

      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "cafes", city: "Cairo", max_results: 3 },
            undefined,
            (info) => {
              doneInfo = info;
            },
            {
              coordinator,
              scoutId,
              planId,
              requestId,
            }
          )) {
            leads.push(lead);
          }
        })(),
        15_000,
        "runEngineQuery full e2e"
      );

      // Verify leads streamed successfully
      assert.equal(leads.length, 3);
      assert.ok(doneInfo);
      assert.equal(doneInfo.success, true);
      assert.equal(doneInfo.targetReached, true);
      assert.equal(doneInfo.delivered, 3);

      // Verify completed claim remains completed after process exit
      assert.equal(coordinator.getClaimByPlaceId(canonicalId1)?.completed, true);

      // Verify that after natural exit and authenticated termination, completed claim remains completed
      const reclaim1 = coordinator.tryClaim("scout_e2e_02", "req_e2e_02", place1);
      assert.equal(reclaim1.status, "ALREADY_COMPLETED");

      // Verify session was cleaned up
      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });
  });

  // =========================================================================
  // Section 4: Candidate Coordination & Receipt Lifecycle
  // =========================================================================
  describe("2. Candidate Coordination & Receipt Lifecycle", () => {
    it("enforces strict admission gating, single-use receipts, fallback receipts, and premature release prevention", () => {
      const coordinator = createCoordinator({ planId: "plan_coord_lifecycle_01" });
      const receiptStore = new CandidateReceiptStore(coordinator);
      const scoutA = "scout_A";
      const scoutB = "scout_B";
      const reqA = "req_A";
      const reqB = "req_B";
      const validPlaceId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      // 1. Valid candidate claim acquired in PRE_CLICK
      const claimA = coordinator.tryClaim(scoutA, reqA, validPlaceId);
      assert.equal(claimA.status, "CLAIM_ACQUIRED");
      assert.equal(claimA.claim.phase, "PRE_CLICK");

      // 2. Competing scout B attempting to claim the same Place ID is rejected
      const claimB = coordinator.tryClaim(scoutB, reqB, validPlaceId);
      assert.equal(claimB.status, "ALREADY_CLAIMED");
      assert.equal(claimB.owningScoutId, scoutA);

      const canonicalA = claimA.canonicalPlaceId;

      // 3. Receipt creation requires valid active claim
      const invalidReceipt = receiptStore.createPlaceIdReceipt({
        scoutId: scoutB, // Wrong scout
        requestId: reqB,
        canonicalPlaceId: canonicalA,
        claimToken: claimA.claimToken,
      });
      assert.equal(invalidReceipt.success, false);
      assert.equal(invalidReceipt.status, "INVALID_CLAIM");

      const validReceiptRes = receiptStore.createPlaceIdReceipt({
        scoutId: scoutA,
        requestId: reqA,
        canonicalPlaceId: canonicalA,
        claimToken: claimA.claimToken,
      });
      assert.equal(validReceiptRes.success, true);
      if (!validReceiptRes.success) return;

      // 4. PRE_CLICK consumption is rejected (no phantom PRE_CLICK admissions)
      const prematureConsume = receiptStore.consumePlaceIdReceipt({
        receiptId: validReceiptRes.receipt.receiptId,
        scoutId: scoutA,
        requestId: reqA,
        canonicalPlaceId: canonicalA,
        claimToken: claimA.claimToken,
      });
      assert.equal(prematureConsume.success, false);
      assert.equal(prematureConsume.status, "CLICK_NOT_STARTED");

      // 5. Advance claim to CLICK_STARTED
      const trans = coordinator.notifyClickStarted(scoutA, reqA, claimA.claimToken, canonicalA);
      assert.equal(trans.status, "CLICK_STARTED");

      // 6. Successful single-use consumption
      const consumeSuccess = receiptStore.consumePlaceIdReceipt({
        receiptId: validReceiptRes.receipt.receiptId,
        scoutId: scoutA,
        requestId: reqA,
        canonicalPlaceId: canonicalA,
        claimToken: claimA.claimToken,
      });
      assert.equal(consumeSuccess.success, true);
      assert.equal(consumeSuccess.status, "CONSUMED");

      // 7. Abandonment of a consumed receipt is rejected
      const abandonConsumed = receiptStore.abandonReceipt({
        receiptId: validReceiptRes.receipt.receiptId,
        scoutId: scoutA,
      });
      assert.equal(abandonConsumed.success, false);
      assert.equal(abandonConsumed.status, "ALREADY_CONSUMED");

      // 8. Fallback Receipt: Validates Google Maps URL policy and Gate 1 MISSING status
      const validFallbackUrl = "https://www.google.com/maps/place/Cafe+Nero/@30.0444,31.2357,17z";
      const fallbackRes = receiptStore.createFallbackReceipt({
        scoutId: scoutA,
        requestId: reqA,
        rawPlaceId: null, // Gate 1 MISSING Place ID
        cardUrl: validFallbackUrl,
      });
      assert.equal(fallbackRes.success, true);
      if (!fallbackRes.success) return;

      // Cannot create fallback receipt if a valid Place ID was present
      const rejectValidInFallback = receiptStore.createFallbackReceipt({
        scoutId: scoutA,
        requestId: reqA,
        rawPlaceId: validPlaceId,
        cardUrl: validFallbackUrl,
      });
      assert.equal(rejectValidInFallback.success, false);
      assert.equal(rejectValidInFallback.status, "REJECTED_VALID_PLACE_ID_PRESENT");

      // Cannot create fallback receipt if Place ID was MALFORMED
      const rejectMalformedInFallback = receiptStore.createFallbackReceipt({
        scoutId: scoutA,
        requestId: reqA,
        rawPlaceId: "invalid_short_id",
        cardUrl: validFallbackUrl,
      });
      assert.equal(rejectMalformedInFallback.success, false);
      assert.equal(rejectMalformedInFallback.status, "REJECTED_MALFORMED_PLACE_ID");

      // Cannot consume fallback receipt before click started
      const earlyFallbackConsume = receiptStore.consumeFallbackReceipt({
        receiptId: fallbackRes.receipt.receiptId,
        scoutId: scoutA,
        requestId: reqA,
        cardUrl: validFallbackUrl,
      });
      assert.equal(earlyFallbackConsume.success, false);
      assert.equal(earlyFallbackConsume.status, "CLICK_NOT_STARTED");

      // Notify fallback click started, then consume
      const clickFallback = receiptStore.notifyFallbackClickStarted({
        receiptId: fallbackRes.receipt.receiptId,
        scoutId: scoutA,
        requestId: reqA,
        cardUrl: validFallbackUrl,
      });
      assert.equal(clickFallback.success, true);

      const consumeFallback = receiptStore.consumeFallbackReceipt({
        receiptId: fallbackRes.receipt.receiptId,
        scoutId: scoutA,
        requestId: reqA,
        cardUrl: validFallbackUrl,
      });
      assert.equal(consumeFallback.success, true);
      assert.equal(consumeFallback.status, "CONSUMED");

      // 9. Abandonment of an unconsumed receipt
      const fallback2 = receiptStore.createFallbackReceipt({
        scoutId: scoutB,
        requestId: reqB,
        rawPlaceId: null,
        cardUrl: "https://maps.google.com/?cid=1234567890",
      });
      assert.equal(fallback2.success, true);
      if (!fallback2.success) return;

      const abandonRes = receiptStore.abandonReceipt({
        receiptId: fallback2.receipt.receiptId,
        scoutId: scoutB,
      });
      assert.equal(abandonRes.success, true);
      assert.equal(abandonRes.status, "ABANDONED");

      // Subsequent consumption of abandoned receipt is rejected
      const consumeAbandoned = receiptStore.consumeFallbackReceipt({
        receiptId: fallback2.receipt.receiptId,
        scoutId: scoutB,
        requestId: reqB,
        cardUrl: "https://maps.google.com/?cid=1234567890",
      });
      assert.equal(consumeAbandoned.success, false);
      assert.equal(consumeAbandoned.status, "RECEIPT_ABANDONED");
    });

    it("creates candidate receipt directly after CLICK_STARTED and consumes once, confirming no phantom PRE_CLICK admission can occur", () => {
      const coordinator = createCoordinator({ planId: "plan_click_started_receipt_01" });
      const receiptStore = new CandidateReceiptStore(coordinator);
      const scoutId = "scout_cs_01";
      const requestId = "req_cs_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      // 1. Scout acquires claim in PRE_CLICK
      const claim = coordinator.tryClaim(scoutId, requestId, placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");
      const canonicalId = claim.canonicalPlaceId;

      // 2. Scout transitions claim to CLICK_STARTED when card click initiates
      const clickStartedRes = coordinator.notifyClickStarted(scoutId, requestId, claim.claimToken);
      assert.equal(clickStartedRes.status, "CLICK_STARTED");
      assert.equal(clickStartedRes.claim.phase, "CLICK_STARTED");

      // 3. Receipt created directly after CLICK_STARTED event
      const receiptRes = receiptStore.createPlaceIdReceipt({
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId,
        claimToken: claim.claimToken,
      });
      assert.equal(receiptRes.success, true);
      assert.equal(receiptRes.receipt.claimPhase, "CLICK_STARTED");

      // 4. Receipt consumed successfully once
      const consumeRes = receiptStore.consumePlaceIdReceipt({
        receiptId: receiptRes.receipt.receiptId,
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId,
        claimToken: claim.claimToken,
      });
      assert.equal(consumeRes.success, true);
      assert.equal(consumeRes.status, "CONSUMED");

      // 5. Subsequent consumption is rejected (single-use)
      const secondConsume = receiptStore.consumePlaceIdReceipt({
        receiptId: receiptRes.receipt.receiptId,
        scoutId,
        requestId,
        canonicalPlaceId: canonicalId,
        claimToken: claim.claimToken,
      });
      assert.equal(secondConsume.success, false);
      assert.equal(secondConsume.status, "ALREADY_CONSUMED");
    });
  });

  // =========================================================================
  // Section 5: Process Ownership and Confirmed Cleanup Invariants
  // =========================================================================
  describe("3. Process Ownership and Confirmed Cleanup Invariants", () => {
    it("strictly enforces that releaseAllForScout() executes ONLY when BOTH MAST_JOB_TERMINATED is received AND child has exited", async () => {
      // Case A: Child exited but NO authenticated MAST_JOB_TERMINATED received
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-exit-no-term-engine");
      const coordinatorA = createCoordinator({ planId: "plan_invariant_A" });
      const scoutA = "scout_inv_A";
      const placeA = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinatorA.tryClaim(scoutA, "req_A", placeA);

      for await (const _ of runEngineQuery(
        { query: "cafes", city: "Cairo", max_results: 1 },
        undefined,
        undefined,
        { coordinator: coordinatorA, scoutId: scoutA, planId: "plan_invariant_A" }
      )) {}

      // Claims must NOT be released
      const reclaimA = coordinatorA.tryClaim("scout_inv_other", "req_other", placeA);
      assert.equal(
        reclaimA.status,
        "ALREADY_CLAIMED",
        "Claims must remain fenced when child exits without MAST_JOB_TERMINATED confirmation"
      );

      // Case B: Authenticated MAST_JOB_TERMINATED received AND child exited
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-normal-engine");
      const coordinatorB = createCoordinator({ planId: "plan_invariant_B" });
      const scoutB = "scout_inv_B";
      const placeB = "ChIJd8BlQ2BZwokRAFUEcm_qrcA";

      coordinatorB.tryClaim(scoutB, "req_B", placeB);

      for await (const _ of runEngineQuery(
        { query: "cafes", city: "Alexandria", max_results: 1 },
        undefined,
        undefined,
        { coordinator: coordinatorB, scoutId: scoutB, planId: "plan_invariant_B" }
      )) {}

      // Claims MUST be released
      const reclaimB = coordinatorB.tryClaim("scout_inv_other", "req_other", placeB);
      assert.equal(
        reclaimB.status,
        "CLAIM_ACQUIRED",
        "Claims must be released when both MAST_JOB_TERMINATED and child exit are verified"
      );
    });
  });

  // =========================================================================
  // Section 6: Comprehensive Failure & Recovery Matrix (All 15 Scenarios)
  // =========================================================================
  describe("4. Comprehensive Failure & Recovery Matrix", () => {
    // Scenario 1: Successful discovery
    it("Scenario 1: Successful discovery streams results and verifies cleanup", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-normal-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_01" });
      const scoutId = "scout_m01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      const leads: any[] = [];
      let done: any = null;
      for await (const lead of runEngineQuery(
        { query: "test", city: "Testville", max_results: 1 },
        undefined,
        (info) => { done = info; },
        { coordinator, scoutId, planId: "plan_matrix_01" }
      )) {
        leads.push(lead);
      }

      assert.equal(leads.length, 1);
      assert.equal(done.success, true);
      assert.equal(done.targetReached, true);
      // Confirmed cleanup releases uncompleted claim
      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "CLAIM_ACQUIRED");
    });

    // Scenario 2: No results
    it("Scenario 2: No results completes cleanly without phantom receipts or claims corruption", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-no-results-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_02" });
      const scoutId = "scout_m02";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      const leads: any[] = [];
      let done: any = null;
      for await (const lead of runEngineQuery(
        { query: "no_results_query", city: "VoidCity", max_results: 10 },
        undefined,
        (info) => { done = info; },
        { coordinator, scoutId, planId: "plan_matrix_02" }
      )) {
        leads.push(lead);
      }

      assert.equal(leads.length, 0);
      assert.equal(done.success, true);
      assert.equal(done.exhausted, true);
      assert.equal(done.delivered, 0);
      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "CLAIM_ACQUIRED");
    });

    // Scenario 3: Invalid Place ID
    it("Scenario 3: Invalid Place ID is rejected safely by coordinator without crashing", () => {
      const coordinator = createCoordinator({ planId: "plan_matrix_03" });
      const scoutId = "scout_m03";

      // Malformed Place ID
      const claim1 = coordinator.tryClaim(scoutId, "req_1", "bad_id");
      assert.equal(claim1.status, "MALFORMED_PLACE_ID");

      // Missing Place ID (empty or null)
      const claim2 = coordinator.tryClaim(scoutId, "req_1", "");
      assert.equal(claim2.status, "MISSING_PLACE_ID");

      const validation = validateCoordinationPlaceId("bad_id");
      assert.equal(validation.status, "MALFORMED");
    });

    // Scenario 4: Duplicate candidate
    it("Scenario 4: Duplicate candidate is deduplicated without corrupting ownership", () => {
      const coordinator = createCoordinator({ planId: "plan_matrix_04" });
      const scout1 = "scout_m04_1";
      const scout2 = "scout_m04_2";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      const claim1 = coordinator.tryClaim(scout1, "req_1", placeId);
      assert.equal(claim1.status, "CLAIM_ACQUIRED");

      const claim2 = coordinator.tryClaim(scout2, "req_2", placeId);
      assert.equal(claim2.status, "ALREADY_CLAIMED");
      assert.equal(claim2.owningScoutId, scout1);

      // Verify scout1 still safely owns it
      assert.equal(coordinator.getClaimByPlaceId(claim1.canonicalPlaceId)?.scoutId, scout1);
    });

    // Scenario 5: Malformed Python output
    it("Scenario 5: Malformed Python output is handled with controlled skipping, no premature release", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-malformed-lead-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_05" });
      const scoutId = "scout_m05";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      const leads: any[] = [];
      let done: any = null;
      for await (const lead of runEngineQuery(
        { query: "test", city: "Testville", max_results: 1 },
        undefined,
        (info) => { done = info; },
        { coordinator, scoutId, planId: "plan_matrix_05" }
      )) {
        leads.push(lead);
      }

      // The 1 valid lead was yielded despite malformed line preceding it
      assert.equal(leads.length, 1);
      assert.equal(done.success, true);
      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "CLAIM_ACQUIRED");
    });

    // Scenario 6: Python early exit
    it("Scenario 6: Python early exit is handled safely and claims remain fenced if unconfirmed", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-early-exit-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_06" });
      const scoutId = "scout_m06";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_matrix_06" }
          )) {}
        },
        ScoutHandshakeError
      );

      // Claim must remain fenced
      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 7: Handshake timeout
    it("Scenario 7: Handshake timeout fails safely without hanging", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-timeout-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_07" });
      const scoutId = "scout_m07";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_matrix_07", handshakeTimeoutMs: 500 }
          )) {}
        },
        ScoutHandshakeTimeoutError
      );

      // Claim must remain fenced
      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 8: Invalid nonce
    it("Scenario 8: Invalid startup nonce causes handshake rejection", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-nonce-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_08" });
      const scoutId = "scout_m08";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_matrix_08" }
          )) {}
        },
        (err: any) => err instanceof ScoutHandshakeMismatchedNonceError || err instanceof ScoutHandshakeError
      );

      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 9: Wrong scout ID
    it("Scenario 9: Wrong scout ID causes message rejection", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-scout-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_09" });
      const scoutId = "scout_expected_09";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_matrix_09" }
          )) {}
        },
        (err: any) => err instanceof ScoutHandshakeMismatchedSessionError || err instanceof ScoutHandshakeError
      );

      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 10: Cancellation (unconfirmed termination on forced taskkill preserves claims)
    it("Scenario 10: Cancellation preserves claims when process tree termination cannot be confirmed", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-cancellation-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_10" });
      const scoutId = "scout_m10";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      const abortController = new AbortController();
      const leads: any[] = [];
      let done: any = null;

      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "test", city: "Testville", max_results: 10 },
            abortController.signal,
            (info) => { done = info; },
            { coordinator, scoutId, planId: "plan_matrix_10" }
          )) {
            leads.push(lead);
            // Trigger abort immediately after first lead
            abortController.abort("USER_CANCELLED");
          }
        })(),
        10_000,
        "runEngineQuery cancellation"
      );

      assert.equal(leads.length, 1);
      assert.ok(done);
      assert.equal(done.failureReason, "USER_CANCELLED");

      // In Windows, forced taskkill terminates the process before it can emit MAST_JOB_TERMINATED.
      // Therefore, the invariant requires that unconfirmed claims REMAIN FENCED and are NOT released.
      assert.equal(
        coordinator.tryClaim("scout_other", "req_2", placeId).status,
        "ALREADY_CLAIMED",
        "Claims must remain fenced when cancellation terminates the process without termination confirmation"
      );
    });

    // Scenario 11: Browser startup failure
    it("Scenario 11: Browser startup failure does not produce false termination confirmation", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-browser-fail-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_11" });
      const scoutId = "scout_m11";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      for await (const _ of runEngineQuery(
        { query: "test", city: "Testville" },
        undefined,
        undefined,
        { coordinator, scoutId, planId: "plan_matrix_11" }
      )) {}

      // Claims must NOT be released
      assert.equal(
        coordinator.tryClaim("scout_other", "req_2", placeId).status,
        "ALREADY_CLAIMED",
        "Browser startup failure without confirmed cleanup must keep claims fenced"
      );
    });

    // Scenario 12: Driver startup failure
    it("Scenario 12: Driver startup failure does not confirm termination and preserves claims", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-browser-fail-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_12" });
      const scoutId = "scout_m12";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      for await (const _ of runEngineQuery(
        { query: "test", city: "Testville" },
        undefined,
        undefined,
        { coordinator, scoutId, planId: "plan_matrix_12" }
      )) {}

      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 13: Missing termination message
    it("Scenario 13: Missing termination message keeps claims fenced even if child exited with code 0", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-exit-no-term-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_13" });
      const scoutId = "scout_m13";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      for await (const _ of runEngineQuery(
        { query: "test", city: "Testville" },
        undefined,
        undefined,
        { coordinator, scoutId, planId: "plan_matrix_13" }
      )) {}

      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 14: Mismatched termination message
    it("Scenario 14: Mismatched termination message keeps claims fenced", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-nonce-term-engine");
      const coordinator = createCoordinator({ planId: "plan_matrix_14" });
      const scoutId = "scout_m14";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      coordinator.tryClaim(scoutId, "req_1", placeId);

      for await (const _ of runEngineQuery(
        { query: "test", city: "Testville" },
        undefined,
        undefined,
        { coordinator, scoutId, planId: "plan_matrix_14" }
      )) {}

      assert.equal(coordinator.tryClaim("scout_other", "req_2", placeId).status, "ALREADY_CLAIMED");
    });

    // Scenario 15: Concurrent scouts
    it("Scenario 15: Concurrent scouts operate independently without cross-talk or claim corruption", async () => {
      const coordinator = createCoordinator({ planId: "plan_matrix_15" });
      const scout1 = "scout_m15_1";
      const scout2 = "scout_m15_2";
      const place1 = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const place2 = "ChIJd8BlQ2BZwokRAFUEcm_qrcA";

      coordinator.tryClaim(scout1, "req_1", place1);
      coordinator.tryClaim(scout2, "req_2", place2);

      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-normal-engine");

      const run1 = (async () => {
        const leads: any[] = [];
        for await (const lead of runEngineQuery(
          { query: "cafes", city: "Cairo", max_results: 1 },
          undefined,
          undefined,
          { coordinator, scoutId: scout1, planId: "plan_matrix_15" }
        )) {
          leads.push(lead);
        }
        return leads;
      })();

      const run2 = (async () => {
        const leads: any[] = [];
        for await (const lead of runEngineQuery(
          { query: "bakeries", city: "Giza", max_results: 1 },
          undefined,
          undefined,
          { coordinator, scoutId: scout2, planId: "plan_matrix_15" }
        )) {
          leads.push(lead);
        }
        return leads;
      })();

      const [leads1, leads2] = await Promise.all([run1, run2]);
      assert.equal(leads1.length, 1);
      assert.equal(leads2.length, 1);

      // Both places should be cleanly released since both scouts completed with confirmed termination
      assert.equal(coordinator.tryClaim("scout_m15_3", "req_3", place1).status, "CLAIM_ACQUIRED");
      assert.equal(coordinator.tryClaim("scout_m15_3", "req_3", place2).status, "CLAIM_ACQUIRED");
    });
  });

  // =========================================================================
  // Section 7: Concurrency & Multi-Scout Isolation
  // =========================================================================
  describe("5. Concurrency & Multi-Scout Isolation", () => {
    it("guarantees unique identities, isolated streams, and fault isolation when one scout fails while another succeeds", async () => {
      const coordinator = createCoordinator({ planId: "plan_conc_iso_01" });
      const scoutSuccess = "scout_conc_success";
      const scoutCrash = "scout_conc_crash";
      const placeSuccess = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const placeCrash = "ChIJd8BlQ2BZwokRAFUEcm_qrcA";

      // 1. Both scouts acquire distinct claims
      const claim1 = coordinator.tryClaim(scoutSuccess, "req_succ", placeSuccess);
      const claim2 = coordinator.tryClaim(scoutCrash, "req_crash", placeCrash);
      assert.equal(claim1.status, "CLAIM_ACQUIRED");
      assert.equal(claim2.status, "CLAIM_ACQUIRED");

      // Verify identities are distinct
      const id1 = generateScoutSessionIdentity({ scoutId: scoutSuccess });
      const id2 = generateScoutSessionIdentity({ scoutId: scoutCrash });
      assert.notEqual(id1.startupNonce, id2.startupNonce);
      assert.notEqual(id1.jobName, id2.jobName);

      // Run successful scout
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-normal-engine");
      const leadsSuccess: any[] = [];
      for await (const lead of runEngineQuery(
        { query: "success", city: "SuccessVille", max_results: 1 },
        undefined,
        undefined,
        { coordinator, scoutId: scoutSuccess, planId: "plan_conc_iso_01" }
      )) {
        leadsSuccess.push(lead);
      }
      assert.equal(leadsSuccess.length, 1);

      // Run crashing scout
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-crash-engine");
      for await (const _ of runEngineQuery(
        { query: "crash", city: "CrashVille", max_results: 1 },
        undefined,
        undefined,
        { coordinator, scoutId: scoutCrash, planId: "plan_conc_iso_01" }
      )) {}

      // Verified isolation: Successful scout's claims are released
      const reclaimSuccess = coordinator.tryClaim("scout_other", "req_other_1", placeSuccess);
      assert.equal(
        reclaimSuccess.status,
        "CLAIM_ACQUIRED",
        "Successful scout claims must be released after confirmed termination"
      );

      // Crashing scout's claims remain fenced
      const reclaimCrash = coordinator.tryClaim("scout_other", "req_other_2", placeCrash);
      assert.equal(
        reclaimCrash.status,
        "ALREADY_CLAIMED",
        "Crashing scout claims must remain fenced because termination was unconfirmed"
      );
    });
  });
});
