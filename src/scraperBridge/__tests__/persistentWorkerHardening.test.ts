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

const MOCK_PORT = 8771;
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

describe("MAST Phase 3.2 — Persistent Enrichment Worker Operational Hardening", { concurrency: 1 }, () => {
  test.before(async () => {
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
    mockProc = await startMockServer();
    // Warm up daemon
    await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
  });

  test.after(async () => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    await closePersistentEnrichmentWorkerGraceful(2000);
    if (mockProc) mockProc.kill();
  });

  describe("1. Bounded Admission & Queue Backpressure", () => {
    test("rejects excess queued requests with EnrichmentOverloadError without fallback", async () => {
      // Configure tight bounds: 2 active slots, 2 max queue depth
      persistentEnrichmentBridge.setMaxConcurrency(2);
      persistentEnrichmentBridge.setMaxQueueLength(2);

      try {
        const slowUrl = `${MOCK_URL}/doc/doc_01_small_business.html?delay=800`;

        // Slot 1 & 2: Active in-flight
        const p1 = runEngineEnrich({ website: `${slowUrl}&s=1` });
        const p2 = runEngineEnrich({ website: `${slowUrl}&s=2` });

        // Wait a few ms to ensure p1 and p2 have acquired slots
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 2);

        // Queue item 1 & 2: Waiting in queue
        const q1 = runEngineEnrich({ website: `${slowUrl}&q=1` });
        const q2 = runEngineEnrich({ website: `${slowUrl}&q=2` });

        assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 2);

        // 5th request: Exceeds maxWaitQueue (2). Must reject IMMEDIATELY with EnrichmentOverloadError!
        let rejectedWithError: any = null;
        try {
          await runEngineEnrich({ website: `${slowUrl}&q=overflow` });
        } catch (err: any) {
          rejectedWithError = err;
        }

        assert.ok(rejectedWithError, "5th request should reject immediately due to overload");
        assert.ok(
          rejectedWithError instanceof EnrichmentOverloadError ||
            rejectedWithError?.code === "ENRICHMENT_OVERLOAD",
          `Expected EnrichmentOverloadError, got ${rejectedWithError}`,
        );
        assert.ok(
          rejectedWithError.message.includes("Enrichment queue limit reached"),
          `Expected queue limit message, got ${rejectedWithError.message}`,
        );

        // Await in-flight and queued to finish cleanly
        const results = await Promise.all([p1, p2, q1, q2]);
        assert.equal(results.length, 4);
        for (const res of results) {
          assert.equal(res.website_reachable, true);
        }

        // Verify queue and active count are back to 0
        assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 0);
        assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
        persistentEnrichmentBridge.setMaxQueueLength(256);
      }
    });

    test("cancellation of a queued request removes it from waitQueue immediately", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(1);
      persistentEnrichmentBridge.setMaxQueueLength(5);

      try {
        const slowUrl = `${MOCK_URL}/doc/doc_01_small_business.html?delay=1000`;

        // Occupy the 1 slot
        const pActive = runEngineEnrich({ website: `${slowUrl}&occupy=1` });
        await new Promise((r) => setTimeout(r, 30));

        // Queue a second request with an AbortController
        const ac = new AbortController();
        const pQueued = runEngineEnrich({ website: `${slowUrl}&will_abort=1` }, ac.signal);

        assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 1);

        // Abort while waiting in queue
        ac.abort();

        await assert.rejects(pQueued, (err: Error) => {
          return err.message.includes("aborted");
        });

        // Must be removed from waitQueue immediately!
        assert.equal(
          persistentEnrichmentBridge.getWaitQueueLength(),
          0,
          "Aborted queued request must be spliced from waitQueue",
        );

        // Active request finishes normally
        const activeRes = await pActive;
        assert.equal(activeRes.website_reachable, true);

        // Subsequent request succeeds normally
        const nextRes = await runEngineEnrich({
          website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=20&subsequent=1`,
        });
        assert.equal(nextRes.website_reachable, true);
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
        persistentEnrichmentBridge.setMaxQueueLength(256);
      }
    });

    test("subsequent successful requests succeed after capacity becomes available", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);
      persistentEnrichmentBridge.setMaxQueueLength(2);

      try {
        const urls = [
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=100&batch1=1`,
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=100&batch1=2`,
          `${MOCK_URL}/doc/doc_01_small_business.html?delay=100&batch1=3`,
        ];

        const batch1 = await Promise.all(urls.map((u) => runEngineEnrich({ website: u })));
        assert.equal(batch1.length, 3);

        // Now run batch 2; all should succeed smoothly
        const batch2 = await Promise.all(urls.map((u) => runEngineEnrich({ website: u })));
        assert.equal(batch2.length, 3);
        assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);
        assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 0);
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
        persistentEnrichmentBridge.setMaxQueueLength(256);
      }
    });
  });

  describe("2. Orderly Shutdown Semantics", () => {
    test("gracefulShutdown stops admitting, drains active requests, closes stdin, and exits cleanly", async () => {
      // 1. Ensure daemon is running
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);

      // 2. Dispatch an active request with 300ms delay
      const pInFlight = runEngineEnrich({
        website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=300&in_flight=1`,
      });

      // Brief yield so it acquires slot
      await new Promise((r) => setTimeout(r, 30));

      // 3. Initiate graceful shutdown
      const pShutdown = closePersistentEnrichmentWorkerGraceful(5000);

      // 4. Verify new requests submitted during shutdown are rejected immediately with EnrichmentShutdownError
      await assert.rejects(
        runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10&rejected=1` }),
        (err: any) => {
          return err instanceof EnrichmentShutdownError || err?.code === "ENRICHMENT_SHUTDOWN";
        },
      );

      // 5. In-flight request completes successfully
      const inFlightRes = await pInFlight;
      assert.equal(inFlightRes.website_reachable, true);

      // 6. Graceful shutdown settles cleanly
      await pShutdown;

      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
      assert.equal(persistentEnrichmentBridge.getActivePendingCount(), 0);
      assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 0);
    });
  });

  describe("3. Overload vs Crash vs One-Shot Fallback Isolation", () => {
    test("one-shot fallback is bypassed on EnrichmentOverloadError", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(1);
      persistentEnrichmentBridge.setMaxQueueLength(1);

      try {
        const slowUrl = `${MOCK_URL}/doc/doc_01_small_business.html?delay=500`;
        const p1 = runEngineEnrich({ website: `${slowUrl}&f=1` });
        const p2 = runEngineEnrich({ website: `${slowUrl}&f=2` });

        await new Promise((r) => setTimeout(r, 20));

        // 3rd should throw EnrichmentOverloadError and NOT run one-shot
        await assert.rejects(
          runEngineEnrich({ website: `${slowUrl}&f=3` }),
          (err: any) => {
            return err instanceof EnrichmentOverloadError || err?.code === "ENRICHMENT_OVERLOAD";
          },
        );

        await Promise.all([p1, p2]);
      } finally {
        persistentEnrichmentBridge.setMaxConcurrency(16);
        persistentEnrichmentBridge.setMaxQueueLength(256);
      }
    });

    test("fallback to one-shot occurs when USE_PERSISTENT_ENRICHMENT=false", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "false";
      try {
        const res = await runEngineEnrich({
          website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10&flag_test=1`,
        });
        assert.equal(res.website_reachable, true);
        assert.ok((res as any).opportunity_score !== undefined);
      } finally {
        delete process.env.USE_PERSISTENT_ENRICHMENT;
      }
    });
  });
});
