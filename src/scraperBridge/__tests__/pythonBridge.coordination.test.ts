import { describe, it } from "node:test";
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

const { runEngineQuery } = await import("../pythonBridge.js");
const { env } = await import("../../config/env.js");
const { PlanPlaceCoordinator } = await import("../../discovery/planPlaceCoordinator.js");
const {
  scoutProcessManager,
  ScoutHandshakeError,
  ScoutHandshakeTimeoutError,
  ScoutHandshakeMismatchedNonceError,
  ScoutHandshakeMismatchedSessionError,
  ScoutHandshakeDuplicateReadyError,
} = await import("../../discovery/scoutProcessManager.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

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

describe("PythonBridge Dynamic IPC Handshake & Gate 2 Coordination (Gate 4)", () => {
  const originalEnginePath = env.SCRAPER_ENGINE_PATH;

  describe("1. Coordinated Discovery Execution with Gate 2 Coordinator", () => {
    it("completes full handshake, delivers query, streams leads, and releases claims on natural exit", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-normal-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_coord_test_01" });
      const scoutId = "scout_coord_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      // 1. Scout pre-claims place ID in Gate 2 coordinator
      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      let doneInfo: any = null;
      const leads: any[] = [];

      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "cafes", city: "Cairo", max_results: 1 },
            undefined,
            (info) => {
              doneInfo = info;
            },
            {
              coordinator,
              scoutId,
              planId: "plan_coord_test_01",
            }
          )) {
            leads.push(lead);
          }
        })(),
        10_000,
        "runEngineQuery coordinated success"
      );

      assert.equal(leads.length, 1);
      assert.ok(doneInfo);
      assert.equal(doneInfo.success, true);
      assert.equal(doneInfo.targetReached, true);

      // Verify that after natural exit, coordinator claims were released
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "CLAIM_ACQUIRED",
        "Place claim should have been released upon verified process termination"
      );

      // Verify session was unregistered
      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });
  });

  describe("2. Handshake Validation and Failure Handling", () => {
    it("rejects handshake on startup nonce mismatch and terminates child", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-nonce-engine");
      const scoutId = "scout_bad_nonce_01";

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { scoutId, requireCoordination: true }
          )) {
            // Should not yield any lead
          }
        },
        (err: any) => {
          return (
            err instanceof ScoutHandshakeMismatchedNonceError ||
            (err instanceof ScoutHandshakeError && err.message.includes("Startup nonce mismatch"))
          );
        }
      );

      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });

    it("rejects handshake on scout ID mismatch and terminates child", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-scout-engine");
      const scoutId = "scout_expected_01";

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { scoutId, requireCoordination: true }
          )) {
            // Should not yield any lead
          }
        },
        (err: any) => {
          return (
            err instanceof ScoutHandshakeMismatchedSessionError ||
            (err instanceof ScoutHandshakeError && err.message.includes("Scout ID mismatch"))
          );
        }
      );

      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });

    it("terminates child and throws ScoutHandshakeTimeoutError when READY times out", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-timeout-engine");
      const scoutId = "scout_timeout_01";

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { scoutId, requireCoordination: true, handshakeTimeoutMs: 500 }
          )) {
            // Should not yield any lead
          }
        },
        (err: any) => {
          return err instanceof ScoutHandshakeTimeoutError;
        }
      );

      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });

    it("handles early child exit during handshake", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-early-exit-engine");
      const scoutId = "scout_early_exit_01";

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { scoutId, requireCoordination: true }
          )) {
            // Should not yield any lead
          }
        },
        (err: any) => {
          return (
            err instanceof ScoutHandshakeError &&
            (err.message.includes("exited early") || err.message.includes("Stdout closed"))
          );
        }
      );

      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });

    it("detects duplicate READY message during streaming and aborts", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-duplicate-ready-engine");
      const scoutId = "scout_dup_ready_01";

      await assert.rejects(
        async () => {
          for await (const _ of runEngineQuery(
            { query: "test", city: "Testville" },
            undefined,
            undefined,
            { scoutId, requireCoordination: true }
          )) {
            // Reads lead, then encounters duplicate ready line
          }
        },
        (err: any) => {
          return err instanceof ScoutHandshakeDuplicateReadyError;
        }
      );

      assert.equal(scoutProcessManager.getSession(scoutId), undefined);
    });
  });

  describe("3. Legacy Uncoordinated Backwards Compatibility", () => {
    it("operates normally without handshake when coordination is not requested", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "normal-engine");

      let doneInfo: any = null;
      const leads: any[] = [];

      for await (const lead of runEngineQuery(
        { query: "uncoordinated", city: "LegacyVille" },
        undefined,
        (info) => {
          doneInfo = info;
        }
      )) {
        leads.push(lead);
      }

      assert.equal(leads.length, 1);
      assert.ok(doneInfo);
      assert.equal(doneInfo.success, true);
    });
  });

  describe("4. Process-Tree Termination Confirmation & Claim Preservation (Gate 4 Final)", () => {
    it("preserves claims when child exits normally without termination confirmation", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-exit-no-term-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_no_term_01" });
      const scoutId = "scout_no_term_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      // Pre-claim place in coordinator
      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "cafes", city: "Cairo", max_results: 1 },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_no_term_01" }
          )) {
            leads.push(lead);
          }
        })(),
        10_000,
        "runEngineQuery no term confirmation"
      );

      assert.equal(leads.length, 1);

      // Verify claims were NOT released because no termination confirmation was emitted
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "ALREADY_CLAIMED",
        "Claim must be PRESERVED when process exits without authenticated termination confirmation"
      );
    });

    it("preserves claims when child crashes during execution without confirmation", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-crash-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_crash_01" });
      const scoutId = "scout_crash_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      let doneInfo: any = null;
      for await (const _ of runEngineQuery(
        { query: "cafes", city: "Cairo", max_results: 1 },
        undefined,
        (info) => {
          doneInfo = info;
        },
        { coordinator, scoutId, planId: "plan_crash_01" }
      )) {
        // Should not yield leads before crash
      }

      // Verify claim is preserved
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "ALREADY_CLAIMED",
        "Claim must be PRESERVED when child crashes without tree termination confirmation"
      );
    });

    it("preserves claims when MAST_JOB_TERMINATED has mismatched scout ID", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-scout-term-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_bad_scout_term_01" });
      const scoutId = "scout_bad_scout_term_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "cafes", city: "Cairo", max_results: 1 },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_bad_scout_term_01" }
          )) {
            leads.push(lead);
          }
        })(),
        10_000,
        "runEngineQuery bad scout term"
      );

      assert.equal(leads.length, 1);

      // Verify claims were NOT released because scoutId mismatched
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "ALREADY_CLAIMED",
        "Claim must be PRESERVED when termination message has mismatched scoutId"
      );
    });

    it("preserves claims when MAST_JOB_TERMINATED has mismatched nonce", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-bad-nonce-term-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_bad_nonce_term_01" });
      const scoutId = "scout_bad_nonce_term_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "cafes", city: "Cairo", max_results: 1 },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_bad_nonce_term_01" }
          )) {
            leads.push(lead);
          }
        })(),
        10_000,
        "runEngineQuery bad nonce term"
      );

      assert.equal(leads.length, 1);

      // Verify claims were NOT released because nonce mismatched
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "ALREADY_CLAIMED",
        "Claim must be PRESERVED when termination message has mismatched nonce"
      );
    });

    it("preserves claims when MAST_JOB_TERMINATED is malformed", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-malformed-term-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_malformed_term_01" });
      const scoutId = "scout_malformed_term_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "cafes", city: "Cairo", max_results: 1 },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_malformed_term_01" }
          )) {
            leads.push(lead);
          }
        })(),
        10_000,
        "runEngineQuery malformed term"
      );

      assert.equal(leads.length, 1);

      // Verify claims were NOT released because termination message was unparseable
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "ALREADY_CLAIMED",
        "Claim must be PRESERVED when termination message is malformed"
      );
    });

    it("releases claims when no browser was launched and empty ownership is confirmed", async () => {
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-empty-launch-engine");
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_empty_launch_01" });
      const scoutId = "scout_empty_launch_01";
      const placeId = "ChIJN1t_tDeuEmsRUsoyG83frY4";

      const claim = coordinator.tryClaim(scoutId, "req_1", placeId);
      assert.equal(claim.status, "CLAIM_ACQUIRED");

      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "nonexistent query", city: "VoidCity", max_results: 1 },
            undefined,
            undefined,
            { coordinator, scoutId, planId: "plan_empty_launch_01" }
          )) {
            leads.push(lead);
          }
        })(),
        10_000,
        "runEngineQuery empty launch"
      );

      assert.equal(leads.length, 0);

      // Verify claims WERE released because valid confirmation was emitted for empty launch
      const reclaim = coordinator.tryClaim("scout_other_02", "req_2", placeId);
      assert.equal(
        reclaim.status,
        "CLAIM_ACQUIRED",
        "Claim must be RELEASED when empty ownership state is confirmed"
      );
    });

    it("enforces scout isolation across concurrent scouts: only confirmed scout claims are released", async () => {
      const coordinator = new PlanPlaceCoordinator({ planId: "plan_concurrent_01" });
      const scout1 = "scout_conc_01";
      const scout2 = "scout_conc_02";
      const place1 = "ChIJN1t_tDeuEmsRUsoyG83frY4";
      const place2 = "ChIJd8BlQ2BZwokRAFUEcm_qrcA";

      // Pre-claim place 1 for Scout 1, place 2 for Scout 2
      coordinator.tryClaim(scout1, "req_1", place1);
      coordinator.tryClaim(scout2, "req_2", place2);

      // Scout 1 runs with valid confirmation
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-normal-engine");
      for await (const _ of runEngineQuery(
        { query: "cafes", city: "City1", max_results: 1 },
        undefined,
        undefined,
        { coordinator, scoutId: scout1, planId: "plan_concurrent_01" }
      )) {}

      // Scout 2 runs WITHOUT confirmation
      env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "coordinated-exit-no-term-engine");
      for await (const _ of runEngineQuery(
        { query: "cafes", city: "City2", max_results: 1 },
        undefined,
        undefined,
        { coordinator, scoutId: scout2, planId: "plan_concurrent_01" }
      )) {}

      // Place 1 should be released (Scout 1 confirmed)
      const reclaim1 = coordinator.tryClaim("scout_conc_03", "req_3", place1);
      assert.equal(reclaim1.status, "CLAIM_ACQUIRED", "Scout 1 place should be released");

      // Place 2 should STILL be claimed (Scout 2 unconfirmed)
      const reclaim2 = coordinator.tryClaim("scout_conc_03", "req_3", place2);
      assert.equal(reclaim2.status, "ALREADY_CLAIMED", "Scout 2 place must remain claimed");
    });
  });
});
