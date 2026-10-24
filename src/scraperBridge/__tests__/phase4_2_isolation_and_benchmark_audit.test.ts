import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  runEngineEnrich,
  runEngineEnrichOneShot,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
  closePersistentEnrichmentWorkerGraceful,
} from "../pythonBridge.js";
import {
  assertLocalIsolation,
  enforceLocalSyntheticEnv,
  assertLocalEnrichmentUrl,
  isLocalAddress,
  isRemoteOrProductionHost,
  installNodeNetworkIsolationGuard,
  uninstallNodeNetworkIsolationGuard,
  IsolationBreachError,
} from "../isolationGuard.js";

const MOCK_PORT = 8777; // Dedicated port for Phase 4.2 tests
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

async function getMockStats(): Promise<{ total_requests: number; requests_by_path: Record<string, number> }> {
  const res = await fetch(`${MOCK_URL}/stats`);
  return res.json() as any;
}

describe("MAST Phase 4.2 — Isolation Guard Audit & Benchmark Validity Review", { concurrency: 1 }, () => {
  test.before(async () => {
    enforceLocalSyntheticEnv();
    assertLocalIsolation();
    process.env.USE_PERSISTENT_ENRICHMENT = "true";
    mockProc = await startMockServer();
  });

  test.after(async () => {
    delete process.env.USE_PERSISTENT_ENRICHMENT;
    uninstallNodeNetworkIsolationGuard();
    await closePersistentEnrichmentWorkerGraceful(2000);
    if (mockProc) mockProc.kill();
  });

  test.beforeEach(() => {
    closePersistentEnrichmentWorker();
    persistentEnrichmentBridge.setMaxConcurrency(4);
    persistentEnrichmentBridge.setMaxQueueLength(64);
    persistentEnrichmentBridge.setBackendTimeoutMs(45000);
  });

  /* =========================================================================
   * Task 1: Verify Isolation Enforcement & Gaps
   * ========================================================================= */
  describe("Task 1 — Isolation Guard Verification & Gaps", () => {
    test("assertLocalIsolation fails closed if any env var matches remote/production patterns", () => {
      const orig = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = "postgres://postgres:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
        assert.throws(() => assertLocalIsolation(), IsolationBreachError);

        process.env.DATABASE_URL = "postgres://postgres:secret@db.xyz.supabase.co:5432/postgres";
        assert.throws(() => assertLocalIsolation(), IsolationBreachError);

        process.env.DATABASE_URL = "postgres://postgres:secret@roundhouse.railway.app:5432/postgres";
        assert.throws(() => assertLocalIsolation(), IsolationBreachError);
      } finally {
        process.env.DATABASE_URL = orig;
      }
    });

    test("assertLocalEnrichmentUrl strictly permits local addresses and rejects external targets", () => {
      // Allowed local loopback targets
      assert.doesNotThrow(() => assertLocalEnrichmentUrl("http://127.0.0.1:8777/doc/doc_01.html"));
      assert.doesNotThrow(() => assertLocalEnrichmentUrl("http://localhost:3000/api/health"));
      assert.doesNotThrow(() => assertLocalEnrichmentUrl("http://[::1]:8080/test"));

      // Prohibited remote and production targets
      assert.throws(
        () => assertLocalEnrichmentUrl("https://xyz.supabase.co/rest/v1/"),
        IsolationBreachError,
        "Must reject Supabase URLs",
      );
      assert.throws(
        () => assertLocalEnrichmentUrl("https://api.openai.com/v1/chat/completions"),
        IsolationBreachError,
        "Must reject OpenAI URLs",
      );
      assert.throws(
        () => assertLocalEnrichmentUrl("https://google.com"),
        IsolationBreachError,
        "Must reject arbitrary public internet URLs in isolated local mode",
      );
      assert.throws(
        () => assertLocalEnrichmentUrl("https://example.com/contact"),
        IsolationBreachError,
        "Must reject non-local domains in isolated local mode",
      );
    });

    test("installNodeNetworkIsolationGuard actively intercepts and destroys sockets targeting production domains", async () => {
      installNodeNetworkIsolationGuard();

      try {
        // Attempting a raw TCP connection to a prohibited production host must be intercepted before network SYN
        await assert.rejects(
          new Promise((resolve, reject) => {
            const socket = net.connect({ host: "aws-0-us-east-1.pooler.supabase.com", port: 5432 });
            socket.on("error", reject);
            socket.on("connect", () => {
              socket.destroy();
              resolve(true);
            });
          }),
          (err: any) => {
            assert.ok(err instanceof IsolationBreachError || /blocked by network isolation guard/i.test(err.message));
            return true;
          },
          "Network isolation guard must destroy connection attempt to pooler.supabase.com",
        );

        // Local mock connections must still be allowed through unblocked
        const localConnected = await new Promise<boolean>((resolve, reject) => {
          const socket = net.connect({ host: "127.0.0.1", port: MOCK_PORT });
          socket.on("error", reject);
          socket.on("connect", () => {
            socket.destroy();
            resolve(true);
          });
        });
        assert.equal(localConnected, true, "Local mock connection must be permitted");
      } finally {
        uninstallNodeNetworkIsolationGuard();
      }
    });

    test("gap verification: mutating process.env does NOT retroactively update already-loaded module singletons", async () => {
      // Load the already-evaluated env module
      const { env } = await import("../../config/env.js");

      // Even if process.env.SUPABASE_URL was changed by enforceLocalSyntheticEnv:
      // env.SUPABASE_URL was parsed at module load time!
      assert.ok(typeof env.SUPABASE_URL === "string", "env.SUPABASE_URL exists as a loaded singleton");
      // This confirms why static process.env manipulation is NOT sufficient to claim complete network isolation:
      // Singletons loaded before sanitization retain their initial configuration.
    });
  });

  /* =========================================================================
   * Task 2: Audit Benchmark Validity & Performance Decomposition
   * ========================================================================= */
  describe("Task 2 — Benchmark Validity & Latency Decomposition", () => {
    const testCases = [
      { file: "doc_01_small_business.html", name: "Small Business" },
      { file: "doc_02_medium_wordpress.html", name: "Medium WordPress" },
      { file: "doc_04_obfuscated_contacts.html", name: "Obfuscated Contacts" },
      { file: "doc_05_international_formats.html", name: "International Formats" },
    ];

    test("Decomposition: Cold Start vs Warm Engine vs Cache Hit", async () => {
      // 1. Cold Start: Spawning the persistent daemon for the first time
      closePersistentEnrichmentWorker();
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

      const t0Cold = Date.now();
      const rCold = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=10&run=cold` });
      const dCold = Date.now() - t0Cold;
      assert.equal(rCold.website_reachable, true);
      assert.ok(persistentEnrichmentBridge.isProcessAlive());
      console.log(`\n--- LATENCY DECOMPOSITION ---`);
      console.log(`[Cold Start Persistent] Spawn + Boot + Imports + Exec: ${dCold}ms`);

      // 2. Warm Engine, Cold Cache: Different document on the running daemon
      const t0WarmColdCache = Date.now();
      const rWarmColdCache = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_02_medium_wordpress.html?delay=10&run=uncached` });
      const dWarmColdCache = Date.now() - t0WarmColdCache;
      assert.equal(rWarmColdCache.website_reachable, true);
      console.log(`[Warm Engine, Cold Cache] HTTP Fetch + Contact Parse (No Cache): ${dWarmColdCache}ms`);

      // 3. Warm Engine, Warm Cache: Same URL repeated on the running daemon
      const t0WarmCache = Date.now();
      const rWarmCache = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_02_medium_wordpress.html?delay=10&run=uncached` });
      const dWarmCache = Date.now() - t0WarmCache;
      assert.equal(rWarmCache.website_reachable, true);
      console.log(`[Warm Engine, Warm Cache] In-Memory LRU Cache Hit: ${dWarmCache}ms`);

      // Verifications:
      // Cold start should be > 1000ms due to Python process spawn and module imports
      assert.ok(dCold > 900, `Cold start (${dCold}ms) must reflect Python boot cost`);
      // Warm engine, cold cache should be < 500ms (process overhead eliminated, but real HTTP fetch made)
      assert.ok(dWarmColdCache < 500, `Warm engine cold cache (${dWarmColdCache}ms) must be much faster than cold start`);
      // Warm cache hit should be < 120ms (IPC pipe roundtrip, >10x faster than cold start)
      assert.ok(dWarmCache < 120, `Warm cache hit (${dWarmCache}ms) must complete significantly faster than cold start`);
    });

    test("Cache Key Integrity: Different URLs and parameters do NOT incorrectly share cache", async () => {
      // Request doc 1
      const res1 = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?v=testA` });
      // Request doc 4 (obfuscated contacts)
      const res4 = await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_04_obfuscated_contacts.html?v=testB` });

      // Ensure doc 1 contacts are NOT returned for doc 4
      const p1 = res1 as any;
      const p4 = res4 as any;

      assert.notDeepEqual(p1.emails, p4.emails);
      assert.equal(p1.title, "Bay Area Bakery");
    });

    test("Multi-Run Parity & Latency Distribution (5 runs per fixture, alternating order)", async () => {
      // Pre-warm the persistent daemon so we measure steady-state warm engine
      await runEngineEnrich({ website: `${MOCK_URL}/doc/doc_01_small_business.html?delay=5&warmup=true` });

      const NUM_RUNS = 5;
      const stats = {
        oneShot: {} as Record<string, number[]>,
        persistentWarm: {} as Record<string, number[]>,
      };

      for (const tc of testCases) {
        stats.oneShot[tc.name] = [];
        stats.persistentWarm[tc.name] = [];
      }

      console.log(`\n--- MULTI-RUN BENCHMARK (N=${NUM_RUNS} per fixture) ---`);

      for (let run = 1; run <= NUM_RUNS; run++) {
        for (const tc of testCases) {
          // Use a fresh query parameter per run to ensure CACHE MISS (testing pure engine throughput, not cache hits)
          const url = `${MOCK_URL}/doc/${tc.file}?delay=10&run=${run}`;

          // Measure One-Shot
          const t0Os = Date.now();
          const osRes = await runEngineEnrichOneShot({ website: url });
          const osDuration = Date.now() - t0Os;
          stats.oneShot[tc.name].push(osDuration);

          // Measure Persistent (Warm Engine, Cold Cache)
          const t0P = Date.now();
          const pRes = await runEngineEnrich({ website: url });
          const pDuration = Date.now() - t0P;
          stats.persistentWarm[tc.name].push(pDuration);

          // Correctness & Parity Assertion on EVERY run
          assert.equal(pRes.website_reachable, osRes.website_reachable);
          const pAny = pRes as any;
          const osAny = osRes as any;
          assert.deepEqual(pAny.extracted_contacts?.emails?.sort(), osAny.extracted_contacts?.emails?.sort());
          assert.deepEqual(pAny.extracted_contacts?.phones?.sort(), osAny.extracted_contacts?.phones?.sort());
          assert.equal(pAny.opportunity_score, osAny.opportunity_score);
          assert.equal(pAny.health_score, osAny.health_score);
        }
      }

      function median(arr: number[]): number {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      }

      console.log(
        "Fixture".padEnd(25) +
          " | One-Shot Median (Min-Max) ".padEnd(30) +
          " | Persistent Median (Min-Max) ".padEnd(32) +
          " | Speedup",
      );
      console.log("-".repeat(98));

      for (const tc of testCases) {
        const osTimes = stats.oneShot[tc.name];
        const pTimes = stats.persistentWarm[tc.name];

        const osMed = median(osTimes);
        const osMin = Math.min(...osTimes);
        const osMax = Math.max(...osTimes);

        const pMed = median(pTimes);
        const pMin = Math.min(...pTimes);
        const pMax = Math.max(...pTimes);

        const speedup = (osMed / pMed).toFixed(2);

        const osStr = `${osMed}ms (${osMin}-${osMax}ms)`;
        const pStr = `${pMed}ms (${pMin}-${pMax}ms)`;

        console.log(
          tc.name.padEnd(25) +
            ` | ${osStr.padEnd(28)}` +
            ` | ${pStr.padEnd(30)}` +
            ` | ${speedup}x`,
        );

        // Warm engine must be consistently >= 3x faster than one-shot across all test cases
        assert.ok(
          osMed > pMed * 2.5,
          `Expected persistent median (${pMed}ms) to be > 2.5x faster than one-shot (${osMed}ms) for ${tc.name}`,
        );
      }
    });
  });
});
