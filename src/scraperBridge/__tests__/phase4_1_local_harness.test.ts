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
} from "../pythonBridge.js";
import {
  assertLocalIsolation,
  enforceLocalSyntheticEnv,
  IsolationBreachError,
} from "../isolationGuard.js";

const MOCK_PORT = 8776;
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
  throw new Error("Failed to start mock server on port " + MOCK_PORT);
}

describe("MAST Phase 4.1 — Local Isolated Validation Harness", { concurrency: 1 }, () => {
  test.before(async () => {
    // 1. Enforce hard synthetic isolation boundary before any test runs
    enforceLocalSyntheticEnv();
    assertLocalIsolation();

    // 2. Enable persistent enrichment opt-in
    process.env.USE_PERSISTENT_ENRICHMENT = "true";

    // 3. Start local synthetic web corpus mock server
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

  describe("1. Hard Isolation Boundary Verification", () => {
    test("assertLocalIsolation fails closed if DATABASE_URL contains production Supabase", () => {
      const originalDb = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = "postgres://postgres:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
        assert.throws(
          () => assertLocalIsolation(),
          IsolationBreachError,
          "Must fail closed when DATABASE_URL points to Supabase pooler",
        );
      } finally {
        process.env.DATABASE_URL = originalDb;
      }
    });

    test("assertLocalIsolation fails closed if SUPABASE_URL contains production host", () => {
      const originalSupabase = process.env.SUPABASE_URL;
      try {
        process.env.SUPABASE_URL = "https://xyzcompany.supabase.co";
        assert.throws(
          () => assertLocalIsolation(),
          IsolationBreachError,
          "Must fail closed when SUPABASE_URL points to live Supabase",
        );
      } finally {
        process.env.SUPABASE_URL = originalSupabase;
      }
    });

    test("assertLocalIsolation fails closed if VITE_API_BASE_URL points to Railway", () => {
      const originalApi = process.env.VITE_API_BASE_URL;
      try {
        process.env.VITE_API_BASE_URL = "https://mast-backend-production.up.railway.app";
        assert.throws(
          () => assertLocalIsolation(),
          IsolationBreachError,
          "Must fail closed when VITE_API_BASE_URL points to Railway",
        );
      } finally {
        process.env.VITE_API_BASE_URL = originalApi;
      }
    });

    test("enforceLocalSyntheticEnv properly sanitizes environment for 100% local operation", () => {
      enforceLocalSyntheticEnv();
      assert.doesNotThrow(() => assertLocalIsolation());
      assert.ok(process.env.DATABASE_URL?.includes("localhost"));
      assert.ok(process.env.SUPABASE_URL?.includes("127.0.0.1"));
    });
  });

  describe("2. One-Shot vs. Persistent Parity & Low-Concurrency Benchmark", () => {
    const testCases = [
      { file: "doc_01_small_business.html", name: "Small Business" },
      { file: "doc_02_medium_wordpress.html", name: "Medium WordPress" },
      { file: "doc_04_obfuscated_contacts.html", name: "Obfuscated Contacts" },
      { file: "doc_05_international_formats.html", name: "International Formats" },
    ];

    test("100% extraction and score parity between one-shot and persistent worker", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2); // Safe low concurrency

      for (const tc of testCases) {
        const url = `${MOCK_URL}/doc/${tc.file}?delay=10`;

        // 1. Execute via One-Shot baseline
        const t0OneShot = Date.now();
        const oneShotRes = await runEngineEnrichOneShot({ website: url });
        const oneShotDuration = Date.now() - t0OneShot;

        // 2. Execute via Persistent worker
        const t0Persistent = Date.now();
        const persistentRes = await runEngineEnrich({ website: url });
        const persistentDuration = Date.now() - t0Persistent;

        const pAny = persistentRes as any;
        const osAny = oneShotRes as any;

        // Verify Reachability Parity
        assert.equal(
          persistentRes.website_reachable,
          oneShotRes.website_reachable,
          `Reachability parity mismatch on ${tc.name}`,
        );

        // Verify Extracted Contacts Parity
        assert.deepEqual(
          pAny.extracted_contacts?.emails?.sort(),
          osAny.extracted_contacts?.emails?.sort(),
          `Email extraction parity mismatch on ${tc.name}`,
        );
        assert.deepEqual(
          pAny.extracted_contacts?.phones?.sort(),
          osAny.extracted_contacts?.phones?.sort(),
          `Phone extraction parity mismatch on ${tc.name}`,
        );
        assert.deepEqual(
          pAny.extracted_contacts?.social_links,
          osAny.extracted_contacts?.social_links,
          `Social links parity mismatch on ${tc.name}`,
        );

        // Verify Opportunity & Health Scores Parity
        assert.equal(
          pAny.opportunity_score,
          osAny.opportunity_score,
          `Opportunity score parity mismatch on ${tc.name}`,
        );
        assert.equal(
          pAny.health_score,
          osAny.health_score,
          `Health score parity mismatch on ${tc.name}`,
        );

        console.log(
          `[PARITY VERIFIED] ${tc.name.padEnd(25)} | One-Shot: ${oneShotDuration}ms | Persistent: ${persistentDuration}ms`,
        );
      }
    });

    test("Domain LRU cache reuse accelerates repeated requests for same domain", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);
      const url = `${MOCK_URL}/doc/doc_01_small_business.html?delay=50`;

      // Warm call 1: fetches from HTTP
      const t1 = Date.now();
      const r1 = await runEngineEnrich({ website: url });
      const d1 = Date.now() - t1;

      // Warm call 2: hits domain LRU cache
      const t2 = Date.now();
      const r2 = await runEngineEnrich({ website: url });
      const d2 = Date.now() - t2;

      // Warm call 3: hits domain LRU cache
      const t3 = Date.now();
      const r3 = await runEngineEnrich({ website: url });
      const d3 = Date.now() - t3;

      assert.equal(r1.website_reachable, true);
      assert.equal(r2.website_reachable, true);
      assert.equal(r3.website_reachable, true);

      // Cache hits should complete in < 50ms
      assert.ok(d2 < 100, `Cache hit 2 duration (${d2}ms) must be fast (<100ms)`);
      assert.ok(d3 < 100, `Cache hit 3 duration (${d3}ms) must be fast (<100ms)`);
      console.log(`[CACHE REUSE] Call 1: ${d1}ms | Call 2 (cache): ${d2}ms | Call 3 (cache): ${d3}ms`);
    });
  });

  describe("3. Concurrency, Queue Backpressure & Cancellation Under Low Concurrency (2)", () => {
    test("bounded queue rejects 5th queued item when maxQueue=4 under concurrency=2", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);
      persistentEnrichmentBridge.setMaxQueueLength(4);

      // Warm up daemon first
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

      // Dispatch 2 slow requests (occupies 2 active slots)
      const p1 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=600` });
      const p2 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=600` });

      // Enqueue 4 waiting requests (fills waitQueue to capacity: 4)
      const q1 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      const q2 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      const q3 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      const q4 = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 2);
      assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 4);

      // 7th request (5th in queue) must throw EnrichmentOverloadError immediately
      await assert.rejects(
        async () => {
          await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
        },
        EnrichmentOverloadError,
        "Must reject excess queued request with EnrichmentOverloadError",
      );

      // Await completion of all admitted requests
      const results = await Promise.all([p1, p2, q1, q2, q3, q4]);
      assert.equal(results.length, 6);
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
      assert.equal(persistentEnrichmentBridge.getWaitQueueLength(), 0);
    });

    test("in-flight cancellation retains backend accounting and frees slot only on completion", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);

      // Warm up daemon
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });

      const controller = new AbortController();
      const slowReq = runEngineEnrich(
        { website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=500` },
        controller.signal,
      );

      // Caller aborts after 30ms
      setTimeout(() => controller.abort(), 30);

      await assert.rejects(slowReq, (err: any) => {
        assert.match(err.message, /aborted/i);
        return true;
      });

      // Crucial: Caller is rejected, but backend slot is still accounted for!
      assert.equal(persistentEnrichmentBridge.getCallerPendingCount(), 0);
      assert.equal(persistentEnrichmentBridge.getAbandonedPendingCount(), 1);
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 1);

      // Wait up to 3500ms for backend to actually complete and release slot
      const deadline = Date.now() + 3500;
      while (persistentEnrichmentBridge.getActiveConcurrency() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // After backend yields response line, slot must be cleanly released
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
      assert.equal(persistentEnrichmentBridge.getAbandonedPendingCount(), 0);
    });
  });

  describe("4. Timeout Recovery, Daemon Restart & Bounded Shutdown", () => {
    test("backend safety timeout terminates hung daemon and reclaims slot cleanly", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);

      // Warm up daemon
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      const initialPid = persistentEnrichmentBridge.getChildPid();
      assert.ok(initialPid !== undefined && initialPid > 0);

      // Set fast backend timeout of 350ms
      persistentEnrichmentBridge.setBackendTimeoutMs(350);

      // Dispatch request with 1500ms delay — triggers backend timeout at 350ms
      await assert.rejects(
        async () => {
          await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=1500` });
        },
        /backend execution timed out after 350ms/,
        "Must reject with backend execution timeout",
      );

      // Wait briefly for OS process close event
      await new Promise((r) => setTimeout(r, 150));

      // Slot must be reclaimed and old PID must be dead
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
      assert.ok(persistentEnrichmentBridge.getChildPid() !== initialPid);

      // Subsequent request spawns fresh daemon and succeeds
      persistentEnrichmentBridge.setBackendTimeoutMs(45000);
      const subRes = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.equal(subRes.website_reachable, true);
      assert.ok(persistentEnrichmentBridge.getChildPid() !== undefined);
      assert.ok(persistentEnrichmentBridge.getChildPid() !== initialPid);
    });

    test("orderly shutdown drains active work and leaves zero orphaned Python processes", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);

      // Warm up daemon
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` });
      assert.ok(persistentEnrichmentBridge.isProcessAlive());

      // 1. Dispatch in-flight request
      const inFlightReq = runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=100` });

      // Wait 30ms for it to begin active execution
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 1);

      // 2. Trigger graceful shutdown with 3000ms drain window
      const shutdownStart = Date.now();
      const shutdownPromise = closePersistentEnrichmentWorkerGraceful(3000);

      // 3. New requests submitted during shutdown must be rejected immediately
      await assert.rejects(
        runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10` }),
        (err: any) => /shutting down/i.test(err.message),
        "New requests during shutdown must be rejected",
      );

      // 4. In-flight request must successfully complete
      const inFlightRes = await inFlightReq;
      assert.equal(inFlightRes.website_reachable, true);

      // 5. Graceful shutdown finishes cleanly
      await shutdownPromise;
      const shutdownDuration = Date.now() - shutdownStart;

      assert.ok(shutdownDuration < 3500, `Shutdown duration (${shutdownDuration}ms) must remain bounded`);
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
      assert.equal(persistentEnrichmentBridge.getActiveConcurrency(), 0);
    });

    test("memory footprint remains stable and bounded across operations", async () => {
      persistentEnrichmentBridge.setMaxConcurrency(2);

      const initialMem = process.memoryUsage();

      // Run 20 synthetic enrichment calls through the persistent worker
      for (let i = 0; i < 20; i++) {
        await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=5` });
      }

      const finalMem = process.memoryUsage();
      const heapDeltaMb = (finalMem.heapUsed - initialMem.heapUsed) / 1024 / 1024;

      console.log(
        `[MEMORY CHECK] Initial Heap: ${(initialMem.heapUsed / 1024 / 1024).toFixed(1)}MB | Final Heap: ${(finalMem.heapUsed / 1024 / 1024).toFixed(1)}MB | Delta: ${heapDeltaMb.toFixed(1)}MB`,
      );

      // Heap delta across 20 calls must be minimal (< 35MB growth)
      assert.ok(heapDeltaMb < 35, `Heap memory growth (${heapDeltaMb.toFixed(1)}MB) must remain bounded`);
    });
  });
});
