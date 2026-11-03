import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  generateScoutSessionIdentity,
  validateReadyMessage,
  validateTerminatedMessage,
  createAckMessage,
  ScoutSession,
  ScoutProcessManager,
  scoutProcessManager,
  ScoutHandshakeError,
  ScoutHandshakeTimeoutError,
  ScoutHandshakeMismatchedNonceError,
  ScoutHandshakeMismatchedSessionError,
  ScoutHandshakeDuplicateReadyError,
  ScoutTerminationError,
  ScoutTerminationMismatchedNonceError,
  ScoutTerminationMismatchedSessionError,
  ScoutTerminationDuplicateError,
} from "../scoutProcessManager.js";
import { PlanPlaceCoordinator } from "../planPlaceCoordinator.js";

/** Helper to create a dummy mock ChildProcess with writable stdin */
function createMockChild(options?: {
  writable?: boolean;
  destroyed?: boolean;
  writeError?: Error;
}): ChildProcess {
  const chunks: string[] = [];
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      if (options?.writeError) {
        callback(options.writeError);
      } else {
        chunks.push(chunk.toString());
        callback();
      }
    },
  });

  // Attach a no-op error listener to prevent Node from treating stream write errors as uncaught exceptions
  stdin.on("error", () => {});

  if (options?.writable === false) {
    Object.defineProperty(stdin, "writable", { value: false });
  }
  if (options?.destroyed) {
    stdin.destroy();
  }

  return {
    stdin,
    pid: 12345,
    exitCode: null,
    signalCode: null,
    chunks,
  } as unknown as ChildProcess & { chunks: string[] };
}

describe("ScoutProcessManager & Dynamic IPC Handshake (Gate 4)", () => {
  beforeEach(() => {
    scoutProcessManager.clearAll();
  });

  describe("1. Scout Session Identity Generation", () => {
    it("generates cryptographically secure scoutId, nonce, and jobName", () => {
      const id1 = generateScoutSessionIdentity();
      const id2 = generateScoutSessionIdentity();

      assert.ok(id1.scoutId.startsWith("scout_"), "scoutId should start with scout_ prefix");
      assert.notEqual(id1.scoutId, id2.scoutId, "scoutIds should be unique");
      assert.equal(id1.startupNonce.length, 32, "startupNonce should be 32 hex chars (16 bytes)");
      assert.notEqual(id1.startupNonce, id2.startupNonce, "nonces should be unique");
      assert.ok(
        id1.jobName.startsWith("Local\\MAST_JOB_"),
        `jobName should start with Local\\MAST_JOB_: got ${id1.jobName}`
      );
      assert.ok(id1.jobName.includes(id1.startupNonce), "jobName should embed startupNonce");
    });

    it("respects caller-provided scoutId and nonce", () => {
      const custom = generateScoutSessionIdentity({
        scoutId: "custom_scout_01",
        nonce: "abcdef0123456789abcdef0123456789",
      });

      assert.equal(custom.scoutId, "custom_scout_01");
      assert.equal(custom.startupNonce, "abcdef0123456789abcdef0123456789");
      assert.equal(
        custom.jobName,
        "Local\\MAST_JOB_custom_scout_01_abcdef0123456789abcdef0123456789"
      );
    });
  });

  describe("2. MAST_JOB_READY Validation", () => {
    const identity = generateScoutSessionIdentity({
      scoutId: "scout_alpha",
      nonce: "11112222333344445555666677778888",
    });

    it("accepts valid MAST_JOB_READY payload on Windows", () => {
      const payload = {
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 4321,
      };

      const res = validateReadyMessage(payload, identity, { isWindows: true });
      assert.equal(res.valid, true);
      if (res.valid) {
        assert.equal(res.ready.scoutId, identity.scoutId);
        assert.equal(res.ready.jobName, identity.jobName);
        assert.equal(res.ready.nonce, identity.startupNonce);
        assert.equal(res.ready.pid, 4321);
      }
    });

    it("accepts valid MAST_JOB_READY payload on POSIX without strict Local\\ prefix requirement", () => {
      const payload = {
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: "posix_pgid_4321",
        nonce: identity.startupNonce,
        pid: 4321,
      };

      const res = validateReadyMessage(payload, identity, { isWindows: false });
      assert.equal(res.valid, true);
    });

    it("rejects non-object or null payload", () => {
      assert.equal(validateReadyMessage(null, identity).valid, false);
      assert.equal(validateReadyMessage("string", identity).valid, false);
      assert.equal(validateReadyMessage([1, 2, 3], identity).valid, false);
    });

    it("rejects wrong message type", () => {
      const payload = {
        type: "SOMETHING_ELSE",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 4321,
      };
      const res = validateReadyMessage(payload, identity);
      assert.equal(res.valid, false);
      assert.match(res.reason, /Expected type 'MAST_JOB_READY'/);
    });

    it("rejects scoutId mismatch", () => {
      const payload = {
        type: "MAST_JOB_READY",
        scoutId: "different_scout",
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 4321,
      };
      const res = validateReadyMessage(payload, identity);
      assert.equal(res.valid, false);
      assert.equal(res.errorClass, ScoutHandshakeMismatchedSessionError);
    });

    it("rejects nonce mismatch", () => {
      const payload = {
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: "wrong_nonce_value",
        pid: 4321,
      };
      const res = validateReadyMessage(payload, identity);
      assert.equal(res.valid, false);
      assert.equal(res.errorClass, ScoutHandshakeMismatchedNonceError);
    });

    it("rejects invalid Windows Job Object name", () => {
      const payload = {
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: "Global\\Wrong_Prefix",
        nonce: identity.startupNonce,
        pid: 4321,
      };
      const res = validateReadyMessage(payload, identity, { isWindows: true });
      assert.equal(res.valid, false);
      assert.match(res.reason, /Invalid or missing jobName/);
    });

    it("rejects invalid PID (<= 0 or non-integer)", () => {
      const badPids = [0, -1, 3.14, NaN, "1234"];
      for (const pid of badPids) {
        const payload = {
          type: "MAST_JOB_READY",
          scoutId: identity.scoutId,
          jobName: identity.jobName,
          nonce: identity.startupNonce,
          pid,
        };
        const res = validateReadyMessage(payload, identity, { isWindows: true });
        assert.equal(res.valid, false, `PID ${pid} should be rejected`);
        assert.match(res.reason, /Invalid process PID/);
      }
    });
  });

  describe("3. MAST_JOB_ACK Generation", () => {
    it("creates properly structured ACK message with matching nonce", () => {
      const nonce = "test_nonce_12345";
      const ack = createAckMessage(nonce);
      assert.deepEqual(ack, {
        type: "MAST_JOB_ACK",
        status: "CONFIRMED",
        nonce: "test_nonce_12345",
      });
    });
  });

  describe("4. ScoutSession State Machine & Handshake Lifecycle", () => {
    it("completes full handshake lifecycle: IDLE -> READY_RECEIVED -> ACK_SENT -> query delivered", async () => {
      const identity = generateScoutSessionIdentity({ scoutId: "scout_lifecycle_01" });
      const session = new ScoutSession({ identity, isWindows: true });

      assert.equal(session.status, "IDLE");

      // 1. Process valid READY line
      const readyLine = JSON.stringify({
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 5678,
      });

      const readyMsg = session.processReadyLine(readyLine);
      assert.equal(session.status, "READY_RECEIVED");
      assert.equal(session.childPid, 5678);
      assert.deepEqual(session.readyMessage, readyMsg);

      // 2. Send ACK
      const mockChild = createMockChild();
      await session.sendAck(mockChild);
      assert.equal(session.status, "ACK_SENT");

      const childChunks = (mockChild as any).chunks;
      assert.equal(childChunks.length, 1);
      const ackObj = JSON.parse(childChunks[0].trim());
      assert.equal(ackObj.type, "MAST_JOB_ACK");
      assert.equal(ackObj.status, "CONFIRMED");
      assert.equal(ackObj.nonce, identity.startupNonce);

      // 3. Write query payload
      await session.writeQueryPayload(mockChild, { query: "cafes", city: "Cairo" });
      assert.equal(childChunks.length, 2);
      const queryObj = JSON.parse(childChunks[1].trim());
      assert.equal(queryObj.query, "cafes");
      assert.equal(queryObj.city, "Cairo");
    });

    it("rejects duplicate READY message after handshake completion", async () => {
      const identity = generateScoutSessionIdentity();
      const session = new ScoutSession({ identity });

      const readyLine = JSON.stringify({
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 9999,
      });

      session.processReadyLine(readyLine);
      const mockChild = createMockChild();
      await session.sendAck(mockChild);

      assert.throws(
        () => session.processReadyLine(readyLine),
        ScoutHandshakeDuplicateReadyError
      );
    });

    it("rejects sending ACK before READY is received", async () => {
      const session = new ScoutSession();
      const mockChild = createMockChild();

      await assert.rejects(
        async () => session.sendAck(mockChild),
        /Cannot send MAST_JOB_ACK in state 'IDLE'/
      );
    });

    it("rejects writing query payload before ACK is sent", async () => {
      const session = new ScoutSession();
      const mockChild = createMockChild();

      await assert.rejects(
        async () => session.writeQueryPayload(mockChild, { query: "test" }),
        /Cannot write query payload in state 'IDLE'/
      );
    });

    it("rejects sendAck when stdin is not writable", async () => {
      const identity = generateScoutSessionIdentity();
      const session = new ScoutSession({ identity });

      const readyLine = JSON.stringify({
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 1234,
      });
      session.processReadyLine(readyLine);

      const mockChild = createMockChild({ writable: false });
      await assert.rejects(
        async () => session.sendAck(mockChild),
        /Child stdin stream is not writable for MAST_JOB_ACK/
      );
      assert.equal(session.status, "FAILED");
    });

    it("rejects sendAck when stdin write fails with error", async () => {
      const identity = generateScoutSessionIdentity();
      const session = new ScoutSession({ identity });

      const readyLine = JSON.stringify({
        type: "MAST_JOB_READY",
        scoutId: identity.scoutId,
        jobName: identity.jobName,
        nonce: identity.startupNonce,
        pid: 1234,
      });
      session.processReadyLine(readyLine);

      const mockChild = createMockChild({ writeError: new Error("EPIPE: broken pipe") });
      await assert.rejects(
        async () => session.sendAck(mockChild),
        /Failed to write MAST_JOB_ACK: EPIPE/
      );
      assert.equal(session.status, "FAILED");
    });
  });

  describe("5. MAST_JOB_TERMINATED Validation & Line Processing", () => {
    const identity = generateScoutSessionIdentity({
      scoutId: "scout_term_test_01",
      nonce: "11223344556677889900aabbccddeeff",
    });

    it("accepts valid MAST_JOB_TERMINATED payload", () => {
      const payload = {
        type: "MAST_JOB_TERMINATED",
        scoutId: identity.scoutId,
        nonce: identity.startupNonce,
        status: "CONFIRMED",
      };
      const result = validateTerminatedMessage(payload, identity);
      assert.equal(result.valid, true);
      if (result.valid) {
        assert.equal(result.terminated.type, "MAST_JOB_TERMINATED");
        assert.equal(result.terminated.scoutId, identity.scoutId);
        assert.equal(result.terminated.nonce, identity.startupNonce);
        assert.equal(result.terminated.status, "CONFIRMED");
      }
    });

    it("rejects non-object or null payload", () => {
      assert.equal(validateTerminatedMessage(null, identity).valid, false);
      assert.equal(validateTerminatedMessage("not-json", identity).valid, false);
      assert.equal(validateTerminatedMessage([1, 2, 3], identity).valid, false);
    });

    it("rejects wrong message type", () => {
      const res = validateTerminatedMessage(
        { type: "MAST_JOB_READY", scoutId: identity.scoutId, nonce: identity.startupNonce, status: "CONFIRMED" },
        identity
      );
      assert.equal(res.valid, false);
      assert.match(res.reason, /Expected type 'MAST_JOB_TERMINATED'/);
    });

    it("rejects mismatched scout ID", () => {
      const res = validateTerminatedMessage(
        { type: "MAST_JOB_TERMINATED", scoutId: "scout_wrong_01", nonce: identity.startupNonce, status: "CONFIRMED" },
        identity
      );
      assert.equal(res.valid, false);
      assert.equal(res.errorClass, ScoutTerminationMismatchedSessionError);
    });

    it("rejects mismatched nonce", () => {
      const res = validateTerminatedMessage(
        { type: "MAST_JOB_TERMINATED", scoutId: identity.scoutId, nonce: "wrong_nonce_value", status: "CONFIRMED" },
        identity
      );
      assert.equal(res.valid, false);
      assert.equal(res.errorClass, ScoutTerminationMismatchedNonceError);
    });

    it("rejects status other than CONFIRMED", () => {
      const res = validateTerminatedMessage(
        { type: "MAST_JOB_TERMINATED", scoutId: identity.scoutId, nonce: identity.startupNonce, status: "FAILED" },
        identity
      );
      assert.equal(res.valid, false);
      assert.match(res.reason, /Termination status must be 'CONFIRMED'/);
    });

    it("processTerminatedLine parses valid line and updates session state", () => {
      const session = new ScoutSession({ identity });
      assert.equal(session.isTerminationMessageReceived, false);
      assert.equal(session.terminatedMessage, undefined);

      const line = JSON.stringify({
        type: "MAST_JOB_TERMINATED",
        scoutId: identity.scoutId,
        nonce: identity.startupNonce,
        status: "CONFIRMED",
      });
      const parsed = session.processTerminatedLine(line);
      assert.equal(parsed.status, "CONFIRMED");
      assert.equal(session.isTerminationMessageReceived, true);
      assert.equal(session.terminatedMessage?.nonce, identity.startupNonce);
    });

    it("processTerminatedLine rejects malformed JSON", () => {
      const session = new ScoutSession({ identity });
      assert.throws(
        () => session.processTerminatedLine("{malformed-json"),
        /Malformed JSON in MAST_JOB_TERMINATED/
      );
      assert.equal(session.isTerminationMessageReceived, false);
    });

    it("processTerminatedLine rejects duplicate termination messages", () => {
      const session = new ScoutSession({ identity });
      const line = JSON.stringify({
        type: "MAST_JOB_TERMINATED",
        scoutId: identity.scoutId,
        nonce: identity.startupNonce,
        status: "CONFIRMED",
      });
      session.processTerminatedLine(line);
      assert.throws(
        () => session.processTerminatedLine(line),
        ScoutTerminationDuplicateError
      );
    });
  });

  describe("6. Gate 2 Coordinator Integration & Dual-Auth Claim Release Invariants", () => {
    it("releases claims strictly when BOTH childExitConfirmed AND terminationMessageReceived are true", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_test_01" });
      const identity = generateScoutSessionIdentity({ scoutId: "scout_confirmed_01" });
      const session = new ScoutSession({ identity, coordinator });

      // Claim a place in Gate 2 coordinator
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const claim = coordinator.tryClaim(identity.scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      // Deliver authenticated termination line
      const termLine = JSON.stringify({
        type: "MAST_JOB_TERMINATED",
        scoutId: identity.scoutId,
        nonce: identity.startupNonce,
        status: "CONFIRMED",
      });
      session.processTerminatedLine(termLine);
      assert.equal(session.isTerminationMessageReceived, true);

      // Confirm termination with childExitConfirmed: true
      const result = session.confirmTerminationAndReleaseClaims(true, "PROCESS_EXIT_NORMAL");
      assert.ok(result);
      assert.equal(result.releasedCount, 1);
      assert.equal(session.isTerminationConfirmed, true);
      assert.equal(session.areClaimsReleased, true);

      // Verify the claim can now be claimed by another scout
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(reclaim.status, "CLAIM_ACQUIRED");
    });

    it("preserves claims when child exits normally (childExit=true) but NO termination message was received", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_test_02" });
      const identity = generateScoutSessionIdentity({ scoutId: "scout_unconfirmed_01" });
      const session = new ScoutSession({ identity, coordinator });

      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const claim = coordinator.tryClaim(identity.scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      // Child exited, but Python failed to emit valid MAST_JOB_TERMINATED
      assert.equal(session.isTerminationMessageReceived, false);
      const result = session.confirmTerminationAndReleaseClaims(true, "PROCESS_EXIT_NORMAL");
      assert.equal(result, null);
      assert.equal(session.isTerminationConfirmed, false);
      assert.equal(session.areClaimsReleased, false);

      // Verify claim is STILL held and cannot be claimed by another scout
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(reclaim.status, "ALREADY_CLAIMED");
    });

    it("preserves claims when termination message was received but child process has NOT exited (childExit=false)", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_test_02b" });
      const identity = generateScoutSessionIdentity({ scoutId: "scout_not_exited_01" });
      const session = new ScoutSession({ identity, coordinator });

      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const claim = coordinator.tryClaim(identity.scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      // Termination message received, but child process is still alive
      const termLine = JSON.stringify({
        type: "MAST_JOB_TERMINATED",
        scoutId: identity.scoutId,
        nonce: identity.startupNonce,
        status: "CONFIRMED",
      });
      session.processTerminatedLine(termLine);
      assert.equal(session.isTerminationMessageReceived, true);

      // Child exit is FALSE
      const result = session.confirmTerminationAndReleaseClaims(false, "PROCESS_STILL_ALIVE");
      assert.equal(result, null);
      assert.equal(session.isTerminationConfirmed, false);
      assert.equal(session.areClaimsReleased, false);

      // Verify claim is STILL held
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(reclaim.status, "ALREADY_CLAIMED");
    });

    it("enforces idempotency: multiple calls to confirmTerminationAndReleaseClaims do not double-release", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_test_03" });
      const identity = generateScoutSessionIdentity({ scoutId: "scout_idempotent_01" });
      const session = new ScoutSession({ identity, coordinator });

      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      coordinator.tryClaim(identity.scoutId, "req_1", placeId);

      // Authenticate termination
      session.processTerminatedLine(JSON.stringify({
        type: "MAST_JOB_TERMINATED",
        scoutId: identity.scoutId,
        nonce: identity.startupNonce,
        status: "CONFIRMED",
      }));

      const res1 = session.confirmTerminationAndReleaseClaims(true, "PROCESS_EXIT_NORMAL");
      assert.ok(res1);
      assert.equal(res1.releasedCount, 1);

      // Second call returns null without re-executing
      const res2 = session.confirmTerminationAndReleaseClaims(true, "PROCESS_EXIT_NORMAL");
      assert.equal(res2, null);
    });

    it("enforces scout isolation: terminating Scout 1 only releases Scout 1 claims, Scout 2 claims remain intact", () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_test_04" });
      const id1 = generateScoutSessionIdentity({ scoutId: "scout_iso_01" });
      const id2 = generateScoutSessionIdentity({ scoutId: "scout_iso_02" });

      const session1 = new ScoutSession({ identity: id1, coordinator });
      const session2 = new ScoutSession({ identity: id2, coordinator });

      const place1 = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const place2 = "ChIJd8BlQ2BZwokRAFUEcm_qrcA";

      coordinator.tryClaim(id1.scoutId, "req_1", place1);
      coordinator.tryClaim(id2.scoutId, "req_2", place2);

      // Authenticate termination ONLY for Scout 1
      session1.processTerminatedLine(JSON.stringify({
        type: "MAST_JOB_TERMINATED",
        scoutId: id1.scoutId,
        nonce: id1.startupNonce,
        status: "CONFIRMED",
      }));

      // Terminate Scout 1
      const res1 = session1.confirmTerminationAndReleaseClaims(true, "PROCESS_EXIT_NORMAL");
      assert.equal(res1?.releasedCount, 1);

      // Place 1 is now free
      const claim1 = coordinator.tryClaim("scout_iso_03", "req_3", place1);
      assert.equal(claim1.status, "CLAIM_ACQUIRED");

      // Place 2 is STILL held by Scout 2
      const claim2 = coordinator.tryClaim("scout_iso_03", "req_3", place2);
      assert.equal(claim2.status, "ALREADY_CLAIMED");
    });
  });

  describe("7. ScoutProcessManager Registry", () => {
    it("registers, retrieves, and unregisters active scout sessions", () => {
      const session1 = new ScoutSession({ scoutId: "scout_reg_01" });
      const session2 = new ScoutSession({ scoutId: "scout_reg_02" });

      assert.equal(scoutProcessManager.getActiveCount(), 0);

      scoutProcessManager.registerSession(session1);
      scoutProcessManager.registerSession(session2);
      assert.equal(scoutProcessManager.getActiveCount(), 2);

      assert.equal(scoutProcessManager.getSession("scout_reg_01"), session1);
      assert.equal(scoutProcessManager.getSession("scout_reg_02"), session2);

      const removed = scoutProcessManager.unregisterSession("scout_reg_01");
      assert.equal(removed, true);
      assert.equal(scoutProcessManager.getActiveCount(), 1);
      assert.equal(scoutProcessManager.getSession("scout_reg_01"), undefined);
    });

    it("rejects duplicate scout registration", () => {
      const session1 = new ScoutSession({ scoutId: "scout_dup_01" });
      const session2 = new ScoutSession({ scoutId: "scout_dup_01" });

      scoutProcessManager.registerSession(session1);
      assert.throws(
        () => scoutProcessManager.registerSession(session2),
        /Scout session 'scout_dup_01' is already registered/
      );
    });
  });
});
