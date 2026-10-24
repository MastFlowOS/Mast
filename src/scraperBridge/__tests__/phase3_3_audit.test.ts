import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  runEngineEnrich,
  runEngineEnrichOneShot,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
  closePersistentEnrichmentWorkerGraceful,
  EnrichmentOverloadError,
  EnrichmentShutdownError,
} from "../pythonBridge.js";

const MOCK_PORT = 8773;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

let mockProc: ChildProcess | null = null;

async function startMockServer(): Promise<ChildProcess> {
  const serverPath = path.resolve(
    "C:/Users/Beboo/.gemini/antigravity/brain/854d10fa-ba51-4763-9ab2-87c1cb1ad634/scratch/enrichment_benchmark/mock_server/server.py",
  );
  const proc = spawn("python", [serverPath, String(MOCK_PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`${MOCK_URL}/stats`);
      if (res.ok) {
        return proc;
      }
    } catch {
      // wait
    }
  }
  throw new Error("Failed to start mock server");
}

describe("MAST Phase 3.3 — Admission, Cancellation & Safe-Default Audit", { concurrency: 1 }, () => {
  test.before(async () => {
    mockProc = await startMockServer();
  });

  test.after(async () => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    await closePersistentEnrichmentWorkerGraceful(2000);
    if (mockProc) mockProc.kill();
  });

  describe("1. Explicit Opt-In Safe Defaults", () => {
    test.beforeEach(() => {
      // Ensure daemon is closed before each opt-in test
      closePersistentEnrichmentWorker();
    });

    test("default (unset) routes to one-shot and does NOT spawn persistent daemon", async () => {
      delete process.env.USE_PERSISTENT_ENRICHMENT;
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.equal(res.website_reachable, true);

      // The persistent daemon child process must NOT have been spawned!
      assert.equal(
        persistentEnrichmentBridge.isProcessAlive(),
        false,
        "Daemon must not be spawned when USE_PERSISTENT_ENRICHMENT is unset",
      );
    });

    test("explicit 'false' routes to one-shot and does NOT spawn persistent daemon", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "false";
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.equal(res.website_reachable, true);

      assert.equal(
        persistentEnrichmentBridge.isProcessAlive(),
        false,
        "Daemon must not be spawned when USE_PERSISTENT_ENRICHMENT='false'",
      );
    });

    test("unexpected values ('0', 'no', 'invalid') route to one-shot and do NOT spawn daemon", async () => {
      const invalidValues = ["0", "no", "invalid", "", "TRUE"]; // strict case check
      for (const val of invalidValues) {
        process.env.USE_PERSISTENT_ENRICHMENT = val;
        assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

        const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
        assert.equal(res.website_reachable, true);

        assert.equal(
          persistentEnrichmentBridge.isProcessAlive(),
          false,
          `Daemon must not be spawned when USE_PERSISTENT_ENRICHMENT='${val}'`,
        );
      }
    });

    test("explicit 'true' routes to persistent bridge and spawns daemon", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

      const res = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.equal(res.website_reachable, true);

      // Must be alive and persistent
      assert.equal(
        persistentEnrichmentBridge.isProcessAlive(),
        true,
        "Daemon must be spawned when USE_PERSISTENT_ENRICHMENT='true'",
      );
    });
  });

  describe("2. Cancellation Under Repeated Load Stress Test", () => {
    test.beforeEach(() => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
    });

    test("in-flight cancellation retains backend slot accounting until Python completes", async () => {
      // Set concurrency to exactly 2
      persistentEnrichmentBridge.setMaxConcurrency(2);
      persistentEnrichmentBridge.setMaxQueueLength(10);

      try {
        const slowUrl = `${MOCK_URL}/doc/doc_01_small_business.html?delay=1000`;

        // Step 1: Dispatch 2 slow requests
        const ac1 = new AbortController();
        const ac2 = new AbortController();

        const p1 = runEngineEnrich({ website: `${slowUrl}&storm=1` }, ac1.signal);
        const p2 = runEngineEnrich({ website: `${slowUrl}&storm=2` }, ac2.signal);

        // Wait brief delay so both acquire slots and are written to child.stdin
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 2);
        assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 2);
        assert.equal(persistentEnrichmentBridge.getCallerPendingCount(), 2);
        assert.equal(persistentEnrichmentBridge.getAbandonedPendingCount(), 0);

        // Step 2: Cancel caller 1 and caller 2
        ac1.abort();
        ac2.abort();

        // Both caller promises must reject IMMEDIATELY
        await assert.rejects(p1, (err: Error) => err.message.includes("aborted"));
        await assert.rejects(p2, (err: Error) => err.message.includes("aborted"));

        // Step 3: Verify backend slots are STILL OCCUPIED while Python runs!
        // Callers are gone, but backend is still processing 2 abandoned requests!
        assert.equal(
          persistentEnrichmentBridge.getActiveConcurrency(),
          2,
          "activeConcurrency must remain 2 while Python finishes abandoned work",
        );
        assert.equal(persistentEnrichmentBridge.getAbandonedPendingCount(), 2);
        assert.equal(persistentEnrichmentBridge.getCallerPendingCount(), 0);

        // Step 4: Immediately submit replacement requests 3 and 4
        // Because activeConcurrency is 2, replacement requests MUST WAIT IN QUEUE!
        const p3 = runEngineEnrich({ website: `${slowUrl}&storm=3` });
        const p4 = runEngineEnrich({ website: `${slowUrl}&storm=4` });

        // Verify replacements are queued, NOT dispatched to Python
        assert.equal(
          persistentEnrichmentBridge.getWaitQueueLength(),
          2,
          "Replacement requests must queue because Python is still executing previous work",
        );
        assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 2);

        // Step 5: Await replacements. Once Python finishes abandoned 1 & 2,
        // slots are freed and replacements 3 & 4 execute and succeed cleanly!
        const [res3, res4] = await Promise.all([p3, p4]);
        assert.equal(res3.website_reachable, true);
        assert.equal(res4.website_reachable, true);

        // Everything returns to idle
        assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
        assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 0);
        assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
        persistentEnrichmentBridge.setMaxQueueLength(256);
      }
    });

    test("sustained cancellation storm does not flood Python with unbounded work", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);
      persistentEnrichmentBridge.setMaxQueueLength(5);

      try {
        const slowUrl = `${MOCK_URL}/doc/doc_01_small_business.html?delay=600`;

        // Rapidly dispatch and abort 6 requests in sequence
        for (let i = 0; i < 6; i++) {
          const ac = new AbortController();
          const p = runEngineEnrich({ website: `${slowUrl}&cycle=${i}` }, ac.signal);
          // Yield just enough for slot acquisition or queue insertion
          await new Promise((r) => setTimeout(r, 10));
          ac.abort();
          await assert.rejects(p, (err: Error) => err.message.includes("aborted"));

          // Assert active concurrency admitted to Python NEVER exceeds 2!
          assert.ok(
            persistentEnrichmentBridge.getActiveConcurrency() <= 2,
            `activeConcurrency (${persistentEnrichmentBridge.getActiveConcurrency()}) must not exceed limit 2`,
          );
        }

        // Wait for all lingering Python executions to complete
        const deadline = Date.now() + 4000;
        while (persistentEnrichmentBridge.getActiveConcurrency() > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }

        assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
        assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);

        // Final normal request succeeds cleanly
        const finalRes = await runEngineEnrich({
          website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10&post_storm=1`,
        });
        assert.equal(finalRes.website_reachable, true);
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
        persistentEnrichmentBridge.setMaxQueueLength(256);
      }
    });
  });

  describe("3. Graceful Teardown Under In-Flight Abandoned Work", () => {
    test.beforeEach(() => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
    });

    test("shutdown cleanly drains underlying Python execution even when callers aborted", async () => {
      // 1. Dispatch slow request and abort caller immediately
      const ac = new AbortController();
      const p = runEngineEnrich(
        { website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=400&drain_test=1` },
        ac.signal,
      );
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      await assert.rejects(p, (err: Error) => err.message.includes("aborted"));

      // Backend is still executing the abandoned request
      assert.equal(persistentEnrichmentBridge.getAbandonedPendingCount(), 1);

      // 2. Initiate graceful shutdown
      const pShutdown = closePersistentEnrichmentWorkerGraceful(3000);

      // Shutdown awaits underlying work, closes stdin, and child exits cleanly
      await pShutdown;

      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
      assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
    });
  });
});
