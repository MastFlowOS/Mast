import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  runEngineEnrich,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
  closePersistentEnrichmentWorkerGraceful,
} from "../pythonBridge.js";

const MOCK_PORT = 8775;
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

describe("MAST Phase 3.4 — Backend Timeout Audit & Timeout Storm", { concurrency: 1 }, () => {
  test.before(async () => {
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
    mockProc = await startMockServer();
  });

  test.after(async () => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    await closePersistentEnrichmentWorkerGraceful(2000);
    if (mockProc) mockProc.kill();
  });

  test.beforeEach(() => {
    closePersistentEnrichmentWorker();
    persistentEnrichmentBridge.setMaxConcurrency(16);
    persistentEnrichmentBridge.setMaxQueueLength(256);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);
  });

  test("1. Backend safety timeout terminates hung Python process tree and reclaims slot cleanly", async () => {
    persistentEnrichmentBridge.setMaxConcurrency(2);
    // Keep safe default for initial warmup spawn
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);

    // Warm up daemon first so child process is live
    const warmRes = await runEngineEnrich({
      website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10`,
    });
    assert.equal(warmRes.website_reachable, true);

    const initialPid = persistentEnrichmentBridge.getChildPid();
    assert.ok(initialPid !== undefined && initialPid > 0, "Daemon process must have a valid PID");
    assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);

    // Now set fast backend timeout of 400ms for deterministic test
    persistentEnrichmentBridge.setBackendTimeoutMs(400);

    // Send a slow request with 2000ms delay — this will exceed backend timeout (400ms)
    const startTime = Date.now();
    await assert.rejects(
      async () => {
        await runEngineEnrich({
          website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=2000`,
        });
      },
      (err: any) => {
        const elapsed = Date.now() - startTime;
        assert.ok(elapsed >= 350 && elapsed < 2000, `Elapsed ${elapsed}ms should match backend timeout`);
        assert.match(err.message, /backend execution timed out after 400ms/);
        return true;
      },
      "Must reject with backend timeout error",
    );

    // Wait briefly for OS process close event
    await new Promise((r) => setTimeout(r, 200));

    // Backend slot MUST be reclaimed
    assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0, "Active concurrency must return to 0");
    assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0, "Pending count must return to 0");

    // The hung process must have been terminated
    const currentPid = persistentEnrichmentBridge.getChildPid();
    assert.ok(currentPid !== initialPid, "Old hung daemon PID must not remain active");

    // Restore safe timeout and verify subsequent request spawns a fresh daemon and succeeds
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);
    const subRes = await runEngineEnrich({
      website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10`,
    });
    assert.equal(subRes.website_reachable, true);
    const newPid = persistentEnrichmentBridge.getChildPid();
    assert.ok(newPid !== undefined && newPid !== initialPid, "A fresh daemon PID must be spawned");
  });

  test("2. Timeout storm: repeated timeouts and replacements strictly bound concurrency and executor work", async () => {
    persistentEnrichmentBridge.setMaxConcurrency(2);
    persistentEnrichmentBridge.setMaxQueueLength(4);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);

    // Warm up daemon first
    await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

    // Set fast backend timeout for the storm test
    persistentEnrichmentBridge.setBackendTimeoutMs(400);

    // Track observed concurrency across the storm
    let maxObservedActiveConcurrency = 0;
    const interval = setInterval(() => {
      const active = persistentEnrichmentBridge.getActiveConcurrency();
      if (active > maxObservedActiveConcurrency) {
        maxObservedActiveConcurrency = active;
      }
    }, 10);

    try {
      // Dispatch 2 slow requests (concurrency = 2 fills the slots)
      const p1 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=1500` });
      const p2 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=1500` });

      // Immediately submit 2 replacement requests (they must wait in waitQueue)
      const p3 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      const p4 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 2, "Active concurrency must be 2");
      assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 2, "2 requests must wait in queue");

      // Both p1 and p2 should time out at ~400ms, terminating the hung daemon
      await assert.rejects(p1);
      await assert.rejects(p2);

      // Once the hung daemon terminates, slots are released and p3 and p4 are admitted to a fresh daemon
      // Allow p3 and p4 safe timeout
      persistentEnrichmentBridge.setBackendTimeoutMs(45000);
      const res3 = await p3;
      const res4 = await p4;

      assert.equal(res3.website_reachable, true);
      assert.equal(res4.website_reachable, true);

      // Invariant: Concurrency must NEVER exceed maxConcurrency (2)
      assert.ok(
        maxObservedActiveConcurrency <= 2,
        `Max observed concurrency (${maxObservedActiveConcurrency}) must not exceed maxConcurrency (2)`,
      );
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
      assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 0);
    } finally {
      clearInterval(interval);
    }
  });

  test("3. No stale result leak: timed out request never resolves caller promise even if backend finishes", async () => {
    persistentEnrichmentBridge.setMaxConcurrency(2);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);

    // Warm up
    await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

    const controller = new AbortController();
    const reqPromise = runEngineEnrich(
      { website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=600` },
      controller.signal,
    );

    // Abort after 50ms (caller stops waiting)
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(reqPromise, (err: any) => {
      assert.match(err.message, /aborted/i);
      return true;
    });

    // Wait 1000ms for backend to complete
    await new Promise((r) => setTimeout(r, 1000));

    // Invariant: caller promise was rejected and remained rejected.
    // Backend result was safely discarded in rl.on("line") without throwing unhandled rejection.
    assert.equal(persistentEnrichmentBridge.getCallerPendingCount(), 0);
    assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
  });

  test("4. Operations interrupted by daemon termination are NOT ambiguously duplicated", async () => {
    persistentEnrichmentBridge.setMaxConcurrency(2);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);

    // Warm up daemon
    await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

    // Set fast backend timeout for the test
    persistentEnrichmentBridge.setBackendTimeoutMs(400);

    // Submit 2 requests simultaneously on the same daemon:
    // Req A will hang (1500ms delay) and trigger backend timeout at 400ms.
    // Req B is also slow (1500ms delay).
    const reqA = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=1500` });
    const reqB = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=1500` });

    // When Req A triggers backend timeout, it terminates the daemon.
    // Both Req A and Req B must reject with clear termination/timeout errors.
    // Neither should be silently duplicated or retried by the bridge.
    const [resA, resB] = await Promise.allSettled([reqA, reqB]);

    assert.equal(resA.status, "rejected");
    assert.equal(resB.status, "rejected");

    // Wait briefly for process reap
    await new Promise((r) => setTimeout(r, 150));

    // Daemon should be dead, active concurrency 0
    assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
    assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);
  });

  test("5. Orderly shutdown remains bounded when timeout or active work is in flight", async () => {
    persistentEnrichmentBridge.setMaxConcurrency(2);
    persistentEnrichmentBridge.setBackendTimeoutMs(10000);

    // Warm up daemon
    await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
    assert.ok(persistentEnrichmentBridge.isProcessAlive());

    // Dispatch an in-flight slow request (4000ms delay)
    const slowReq = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=4000` });
    const slowReqPromise = assert.rejects(slowReq);

    // Wait 100ms so the request is actively executing in Python
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 1);

    // Trigger graceful shutdown with a tight 500ms deadline
    const shutdownStart = Date.now();
    await closePersistentEnrichmentWorkerGraceful(500);
    const shutdownDuration = Date.now() - shutdownStart;

    // Shutdown must complete boundedly within ~3000ms (500ms grace + 1500ms exit window + taskkill)
    assert.ok(
      shutdownDuration < 3500,
      `Shutdown duration (${shutdownDuration}ms) must remain bounded under active work`,
    );

    // Child must be cleanly dead
    assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
    assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);

    // Ensure rejection handled cleanly
    await slowReqPromise;
  });
});
