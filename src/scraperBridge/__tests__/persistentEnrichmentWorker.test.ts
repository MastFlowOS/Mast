import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import {
  runEngineEnrich,
  runEngineEnrichOneShot,
  persistentEnrichmentBridge,
  closePersistentEnrichmentWorker,
  closePersistentEnrichmentWorkerGraceful,
  PersistentEnrichmentBridge,
  EnrichmentOverloadError,
  EnrichmentShutdownError,
} from "../pythonBridge.js";

/**
 * Mock ChildProcess helper for deterministic testing of:
 * - Ping / Pong handshake sequencing
 * - Cold-start concurrency & startup promise sharing
 * - Timeouts, exit races, malformed payloads
 * - Backpressure bounds and graceful shutdown
 */
class MockChildProcess extends EventEmitter {
  public pid = 990000 + Math.floor(Math.random() * 9999);
  public killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public stdin = new PassThrough();
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public _isMock = true;
  public sentLines: string[] = [];
  private stdinBuf = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinBuf += chunk.toString("utf8");
      const lines = this.stdinBuf.split("\n");
      this.stdinBuf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.sentLines.push(trimmed);
        }
      }
    });
  }

  public kill(signal?: NodeJS.Signals | string): boolean {
    this.killed = true;
    this.signalCode = (signal as NodeJS.Signals) || "SIGKILL";
    this.exitCode = null;
    this.emit("close", null, this.signalCode);
    return true;
  }

  public exit(code: number = 0): void {
    this.killed = true;
    this.exitCode = code;
    this.emit("close", code, null);
  }

  public emitStdoutLine(line: string): void {
    this.stdout.write(line + "\n");
  }

  public emitStderrLine(line: string): void {
    this.stderr.write(line + "\n");
  }
}

describe("MAST Bottleneck 4 — True Python Enrichment Daemon Warmup & Readiness Handshake", { concurrency: 1 }, () => {
  describe("Group 1: Readiness & Handshake Protocol (Tests 1–5)", () => {
    test("Test 1: daemon sends ping and verifies pong response before marking ready", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const warmupPromise = bridge.warmup();

      // Give stream a tick to process stdin write
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.sentLines.length, 1);
      const pingMsg = JSON.parse(mock.sentLines[0]);
      assert.ok(pingMsg.id.startsWith("__handshake__"));
      assert.equal(pingMsg.ping, true);
      assert.equal(bridge.isReady, false);

      // Daemon responds with valid pong
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));
      await warmupPromise;

      assert.equal(bridge.isReady, true);
      assert.equal(bridge.isDaemonReady(), true);
      bridge.close();
    });

    test("Test 2: warmup resolves only after pong received", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      let resolved = false;
      const warmupPromise = bridge.warmup().then(() => {
        resolved = true;
      });

      await new Promise((r) => setTimeout(r, 40));
      assert.equal(resolved, false, "Warmup must not resolve before pong");

      const pingMsg = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));

      await warmupPromise;
      assert.equal(resolved, true, "Warmup must resolve after pong");
      bridge.close();
    });

    test("Test 3: isReady / alive state accurately reflects post-handshake status", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      // Unstarted
      assert.equal(bridge.isProcessAlive(), false);
      assert.equal(bridge.isReady, false);

      // Starting (in handshake)
      const p = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bridge.isProcessAlive(), true);
      assert.equal(bridge.isReady, false);

      // Post-handshake
      const pingMsg = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));
      await p;
      assert.equal(bridge.isProcessAlive(), true);
      assert.equal(bridge.isReady, true);

      // After close
      bridge.close();
      assert.equal(bridge.isProcessAlive(), false);
      assert.equal(bridge.isReady, false);
    });

    test("Test 4: standard enrichment payload is NOT sent before handshake completes", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const enrichPromise = bridge.enrich({ website: "https://example.com" });

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(mock.sentLines.length, 1);
      const pingMsg = JSON.parse(mock.sentLines[0]);
      assert.equal(pingMsg.ping, true);

      // Verify no business request was dispatched
      const hasPayload = mock.sentLines.some((l) => l.includes("example.com"));
      assert.equal(hasPayload, false, "Enrichment payload must not be written to stdin before readiness");

      // Complete handshake
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));
      await new Promise((r) => setTimeout(r, 30));

      // Now business request must be sent
      assert.equal(mock.sentLines.length, 2);
      const enrichMsg = JSON.parse(mock.sentLines[1]);
      assert.equal(enrichMsg.params.website, "https://example.com");

      // Reply to enrichment
      mock.emitStdoutLine(
        JSON.stringify({
          id: enrichMsg.id,
          result: { website_reachable: true, http_status: 200 },
        }),
      );
      const res = await enrichPromise;
      assert.equal(res.website_reachable, true);
      bridge.close();
    });

    test("Test 5: subsequent calls reuse warm daemon without additional handshakes", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const w = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));
      const pingMsg = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));
      await w;

      const linesAfterWarmup = mock.sentLines.length;
      assert.equal(linesAfterWarmup, 1);

      // Calling warmup again should be an immediate no-op
      await bridge.warmup();
      assert.equal(mock.sentLines.length, linesAfterWarmup);

      // Calling enrich should write business request directly, NO new handshake ping
      const p = bridge.enrich({ website: "https://test.com" });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.sentLines.length, linesAfterWarmup + 1);
      const enrichMsg = JSON.parse(mock.sentLines[1]);
      assert.equal(enrichMsg.params.website, "https://test.com");
      assert.equal(enrichMsg.ping, undefined);

      mock.emitStdoutLine(JSON.stringify({ id: enrichMsg.id, result: { website_reachable: true } }));
      await p;
      bridge.close();
    });
  });

  describe("Group 2: Concurrency & Cold Start Races (Tests 6–10)", () => {
    test("Test 6: multiple concurrent calls during startup await the single shared startup promise", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const p1 = bridge.getOrSpawn();
      const p2 = bridge.getOrSpawn();
      const p3 = bridge.getOrSpawn();

      // All three must be awaiting the exact same underlying promise
      assert.equal(p1, p2);
      assert.equal(p2, p3);

      await new Promise((r) => setTimeout(r, 20));
      const pingMsg = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));

      const [c1, c2, c3] = await Promise.all([p1, p2, p3]);
      assert.equal(c1, mock);
      assert.equal(c2, mock);
      assert.equal(c3, mock);
      bridge.close();
    });

    test("Test 7: no duplicate daemon processes spawned during concurrent startup", async () => {
      let spawnCount = 0;
      let activeMock: MockChildProcess | null = null;

      const customSpawn = () => {
        spawnCount++;
        activeMock = new MockChildProcess();
        return activeMock as unknown as ChildProcess;
      };

      const bridge = new PersistentEnrichmentBridge(customSpawn);

      // Launch 8 concurrent operations while cold
      const ops = [
        bridge.warmup(),
        bridge.warmup(),
        bridge.getOrSpawn(),
        bridge.getOrSpawn(),
        bridge.enrich({ website: "https://c1.com" }),
        bridge.enrich({ website: "https://c2.com" }),
        bridge.enrich({ website: "https://c3.com" }),
        bridge.warmup(),
      ];

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(spawnCount, 1, "Exactly one process must be spawned for concurrent startup");

      const pingMsg = JSON.parse(activeMock!.sentLines[0]);
      activeMock!.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));

      // Answer enrichment requests
      await new Promise((r) => setTimeout(r, 30));
      for (const line of activeMock!.sentLines.slice(1)) {
        const msg = JSON.parse(line);
        activeMock!.emitStdoutLine(JSON.stringify({ id: msg.id, result: { website_reachable: true } }));
      }

      await Promise.all(ops);
      bridge.close();
    });

    test("Test 8: first-candidate payload queued during warmup is dispatched immediately upon handshake completion", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      const pCandidate = bridge.enrich({ website: "https://first-candidate.com" });

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.sentLines.length, 1);
      const pingMsg = JSON.parse(mock.sentLines[0]);

      // Complete handshake
      mock.emitStdoutLine(JSON.stringify({ id: pingMsg.id, pong: true }));
      await pWarm;

      // Candidate payload must be dispatched immediately
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.sentLines.length, 2);
      const enrichMsg = JSON.parse(mock.sentLines[1]);
      assert.equal(enrichMsg.params.website, "https://first-candidate.com");

      mock.emitStdoutLine(JSON.stringify({ id: enrichMsg.id, result: { website_reachable: true } }));
      const res = await pCandidate;
      assert.equal(res.website_reachable, true);
      bridge.close();
    });

    test("Test 9: queue backpressure (256) respected even during startup", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);
      bridge.setMaxConcurrency(2);
      bridge.setMaxQueueLength(2);

      // Start daemon in handshake
      const p1 = bridge.enrich({ website: "https://slot1.com" });
      const p2 = bridge.enrich({ website: "https://slot2.com" });
      const q1 = bridge.enrich({ website: "https://queue1.com" });
      const q2 = bridge.enrich({ website: "https://queue2.com" });

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bridge.getWaitQueueLength(), 2);

      // 5th request exceeds maxWaitQueue=2 -> must throw EnrichmentOverloadError immediately
      await assert.rejects(
        async () => {
          await bridge.enrich({ website: "https://overflow.com" });
        },
        EnrichmentOverloadError,
      );

      // Clean up in-flight promises before close so they don't produce unhandled rejections
      p1.catch(() => {});
      p2.catch(() => {});
      q1.catch(() => {});
      q2.catch(() => {});

      bridge.close();
    });

    test("Test 10: concurrency limit (16) respected once warm", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);
      bridge.setMaxConcurrency(2);

      const w = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));
      const ping = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: ping.id, pong: true }));
      await w;

      const e1 = bridge.enrich({ website: "https://slow1.com" });
      const e2 = bridge.enrich({ website: "https://slow2.com" });
      const e3 = bridge.enrich({ website: "https://queued.com" });

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bridge.getActiveConcurrency(), 2);
      assert.equal(bridge.getWaitQueueLength(), 1);

      // Complete e1 -> e3 promoted
      const line1 = JSON.parse(mock.sentLines[1]);
      mock.emitStdoutLine(JSON.stringify({ id: line1.id, result: { website_reachable: true } }));
      await e1;

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(bridge.getWaitQueueLength(), 0);
      assert.equal(bridge.getActiveConcurrency(), 2);

      e2.catch(() => {});
      e3.catch(() => {});
      bridge.close();
    });
  });

  describe("Group 3: Failure Modes, Timeouts & Self-Healing (Tests 11–18)", () => {
    test("Test 11: handshake timeout (configurable ms) terminates process and rejects callers cleanly", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);
      bridge.setStartupTimeoutMs(60);

      const pWarm = bridge.warmup();
      await assert.rejects(
        pWarm,
        /handshake timed out after 60ms/i,
      );

      assert.equal(mock.killed, true);
      assert.equal(bridge.isReady, false);
      bridge.close();
    });

    test("Test 12: process exit during handshake rejects startup promise and does not deadlock", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      // Child process dies before pong
      mock.exit(1);

      await assert.rejects(
        pWarm,
        /process exited during handshake|exited unexpectedly/i,
      );
      assert.equal(bridge.isReady, false);
      bridge.close();
    });

    test("Test 13: subsequent request after failed handshake triggers fresh spawn and handshake retry", async () => {
      let spawnCount = 0;
      let currentMock: MockChildProcess | null = null;

      const bridge = new PersistentEnrichmentBridge(() => {
        spawnCount++;
        currentMock = new MockChildProcess();
        return currentMock as unknown as ChildProcess;
      });

      // Attempt 1: fails
      const p1 = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));
      currentMock!.exit(1);
      await assert.rejects(p1);

      assert.equal(spawnCount, 1);
      assert.equal(bridge.isReady, false);

      // Attempt 2: retry spawns a brand new process and succeeds
      const p2 = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(spawnCount, 2);

      const ping = JSON.parse(currentMock!.sentLines[0]);
      currentMock!.emitStdoutLine(JSON.stringify({ id: ping.id, pong: true }));
      await p2;

      assert.equal(bridge.isReady, true);
      bridge.close();
    });

    test("Test 14: stderr output during startup is captured/logged without corrupting stdout stream", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      // Emit stderr logs while booting
      mock.emitStderrLine("[pipeline] Initializing Playwright browser pool");
      mock.emitStderrLine("[candidate-audit] Loading machine LRU caches");

      const ping = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: ping.id, pong: true }));
      await pWarm;

      assert.equal(bridge.isReady, true);
      bridge.close();
    });

    test("Test 15: invalid stdout output prior to pong is ignored/logged without crashing", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      // Python library banner or warnings before redirection
      mock.emitStdoutLine("Warning: InsecureRequestWarning");
      mock.emitStdoutLine("{ not valid json");
      mock.emitStdoutLine("");

      const ping = JSON.parse(mock.sentLines[0]);
      mock.emitStdoutLine(JSON.stringify({ id: ping.id, pong: true }));
      await pWarm;

      assert.equal(bridge.isReady, true);
      bridge.close();
    });

    test("Test 16: malformed pong is handled cleanly without false-positive readiness", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      const ping = JSON.parse(mock.sentLines[0]);
      // Pong is false or malformed
      mock.emitStdoutLine(JSON.stringify({ id: ping.id, pong: false }));

      await assert.rejects(
        pWarm,
        /malformed response|handshake failed/i,
      );
      assert.equal(bridge.isReady, false);
      assert.equal(mock.killed, true);
      bridge.close();
    });

    test("Test 17: unrelated error on child process rejects handshake", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      mock.emit("error", new Error("EACCES permission denied"));

      await assert.rejects(
        pWarm,
        /EACCES permission denied|Enrichment daemon error/i,
      );
      assert.equal(bridge.isReady, false);
      bridge.close();
    });

    test("Test 18: fallback to one-shot enrichment if persistent mode fails with daemon error (when configured)", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
      const bridge = persistentEnrichmentBridge;
      bridge.close();

      // Configure a failing spawn temporarily
      const failingMock = new MockChildProcess();
      bridge.setSpawnFn(() => {
        setTimeout(() => failingMock.exit(1), 10);
        return failingMock as unknown as ChildProcess;
      });

      // Even though persistent mode fails, runEngineEnrich falls back to one-shot
      const result = await runEngineEnrich({ website: "https://example.com" });
      assert.ok(result);
      assert.equal(result.website_reachable, true);

      // Restore normal spawn
      bridge.setSpawnFn(spawn);
      bridge.close();
      delete process.env.USE_PERSISTENT_ENRICHMENT;
    });
  });

  describe("Group 4: Lifecycle & Shutdown Edge Cases (Tests 19–21)", () => {
    test("Test 19: graceful shutdown during warmup cancels handshake and cleans up child process tree", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      const shutdownPromise = bridge.gracefulShutdown(500);

      await assert.rejects(pWarm, EnrichmentShutdownError);
      await shutdownPromise;

      assert.equal(mock.killed, true);
      assert.equal(bridge.isReady, false);
    });

    test("Test 20: close during active warmup clears all timers and promises", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));

      bridge.close();
      await assert.rejects(pWarm);

      assert.equal(bridge.getActiveHandshakeId(), null);
      assert.equal(bridge.isProcessAlive(), false);
      assert.equal(bridge.isReady, false);
    });

    test("Test 21: late pong arriving after shutdown/timeout is ignored", async () => {
      const mock = new MockChildProcess();
      const bridge = new PersistentEnrichmentBridge(() => mock as unknown as ChildProcess);

      const pWarm = bridge.warmup();
      await new Promise((r) => setTimeout(r, 20));
      const ping = JSON.parse(mock.sentLines[0]);

      bridge.close();
      await assert.rejects(pWarm);

      // Late pong arrives
      mock.emitStdoutLine(JSON.stringify({ id: ping.id, pong: true }));
      await new Promise((r) => setTimeout(r, 20));

      // Must remain safely not ready and not revived
      assert.equal(bridge.isReady, false);
    });
  });

  describe("Group 5: Server Integration & Opt-Out Guarantees (Tests 22–26)", () => {
    test("Test 22: warmup runs when USE_PERSISTENT_ENRICHMENT=true", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
      let warmed = false;
      const bridge = new PersistentEnrichmentBridge(() => {
        const m = new MockChildProcess();
        setTimeout(() => {
          if (m.sentLines.length > 0) {
            const p = JSON.parse(m.sentLines[0]);
            m.emitStdoutLine(JSON.stringify({ id: p.id, pong: true }));
          }
        }, 10);
        return m as unknown as ChildProcess;
      });

      if (process.env.USE_PERSISTENT_ENRICHMENT === "true") {
        await bridge.warmup();
        warmed = true;
      }

      assert.equal(warmed, true);
      assert.equal(bridge.isReady, true);
      bridge.close();
      delete process.env.USE_PERSISTENT_ENRICHMENT;
    });

    test("Test 23: warmup failure does not crash HTTP server or process", async () => {
      const failingBridge = new PersistentEnrichmentBridge(() => {
        const m = new MockChildProcess();
        setTimeout(() => m.exit(1), 10);
        return m as unknown as ChildProcess;
      });

      let errorCaught = false;
      await failingBridge
        .warmup()
        .then(() => {})
        .catch((err) => {
          errorCaught = true;
          assert.ok(err);
        });

      assert.equal(errorCaught, true, "Warmup error must be cleanly catchable by server background task");
      failingBridge.close();
    });

    test("Test 24: pre-warmed daemon serves first enrichment request in warm speed (<1.5s)", async () => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
      closePersistentEnrichmentWorker();

      // Real live warmup with Python daemon
      await persistentEnrichmentBridge.warmup();
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
      assert.equal(persistentEnrichmentBridge.isReady, true);

      // Now first request runs against already warm daemon
      const t0 = Date.now();
      const res = await runEngineEnrich({ website: "https://example.com" });
      const elapsed = Date.now() - t0;

      assert.equal(res.website_reachable, true);
      assert.ok(
        elapsed < 2000,
        `First request against pre-warmed daemon should complete promptly (<2000ms), took ${elapsed}ms`,
      );
    });

    test("Test 25: server shutdown cleanly closes persistent daemon", async () => {
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
      await closePersistentEnrichmentWorkerGraceful(2000);
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
      assert.equal(persistentEnrichmentBridge.isReady, false);
    });

    test("Test 26: opt-out behavior: USE_PERSISTENT_ENRICHMENT not set or false bypasses warmup", async () => {
      closePersistentEnrichmentWorker();
      delete process.env.USE_PERSISTENT_ENRICHMENT;

      const res = await runEngineEnrich({ website: "https://example.com" });
      assert.equal(res.website_reachable, true);
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
    });
  });

  describe("Group 6: End-to-End Live Execution & Cache Reuse (Preserved)", () => {
    test.before(() => {
      process.env.USE_PERSISTENT_ENRICHMENT = "true";
    });

    test.after(() => {
      delete process.env.USE_PERSISTENT_ENRICHMENT;
      closePersistentEnrichmentWorker();
    });

    test("persistent enrichment worker - executes successfully and returns expected fields", async () => {
      const result = await runEngineEnrich({ website: "https://example.com" });
      assert.ok(result, "Result should be defined");
      assert.equal(result.website_reachable, true);
      assert.equal(typeof result.http_status, "number");
      assert.ok(result.http_status !== null && result.http_status >= 200 && result.http_status < 400);
      assert.ok(Array.isArray(result.emails));
      assert.ok(Array.isArray(result.phones));
      assert.ok("opportunity_score" in result);
    });

    test("persistent enrichment worker - warm calls reuse process and domain cache", async () => {
      const t0 = Date.now();
      const res1 = await runEngineEnrich({ website: "https://example.com" });
      assert.equal(res1.website_reachable, true);

      const t1 = Date.now();
      const res2 = await runEngineEnrich({ website: "https://example.com" });
      const warmDuration = Date.now() - t1;
      assert.equal(res2.website_reachable, true);

      assert.ok(
        warmDuration < 2000,
        `Warm duration (${warmDuration}ms) should complete promptly`,
      );
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
    });

    test("persistent enrichment worker - concurrent requests correlate correctly", async () => {
      const targets = [
        { website: "https://example.com" },
        { website: "https://example.org" },
        { website: "https://example.net" },
        { website: "https://example.com" },
      ];

      const results = await Promise.all(targets.map((params) => runEngineEnrich(params)));
      assert.equal(results.length, 4);
      results.forEach((r, idx) => {
        assert.equal(r.website_reachable, true, `Target ${idx} should be reachable`);
        assert.ok(typeof r.final_url === "string", `Target ${idx} should have final_url`);
      });
    });

    test("persistent enrichment worker - per-request failure isolation", async () => {
      const [validRes, invalidRes] = await Promise.all([
        runEngineEnrich({ website: "https://example.com" }),
        runEngineEnrich({ website: "https://invalid-non-existent-domain-123456789.org" }),
      ]);

      assert.equal(validRes.website_reachable, true, "Valid site should succeed");
      assert.equal(invalidRes.website_reachable, false, "Invalid site should report unreachable without throwing");
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true, "Worker should stay alive after failed lead");
    });

    test("persistent enrichment worker - cancellation via AbortSignal aborts request cleanly", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await runEngineEnrich({ website: "https://example.com" }, controller.signal);
        },
        /aborted/i,
        "Should reject when signal is aborted",
      );
    });

    test("persistent enrichment worker - crash recovery and automatic restart", async () => {
      await runEngineEnrich({ website: "https://example.com" });
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);

      closePersistentEnrichmentWorker();
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);

      const recoveredResult = await runEngineEnrich({ website: "https://example.com" });
      assert.equal(recoveredResult.website_reachable, true);
      assert.equal(persistentEnrichmentBridge.isProcessAlive(), true);
    });

    test("fallback to one-shot enrichment when USE_PERSISTENT_ENRICHMENT=false", async () => {
      closePersistentEnrichmentWorker();
      process.env.USE_PERSISTENT_ENRICHMENT = "false";
      try {
        const res = await runEngineEnrich({ website: "https://example.com" });
        assert.equal(res.website_reachable, true);
        assert.equal(persistentEnrichmentBridge.isProcessAlive(), false);
      } finally {
        delete process.env.USE_PERSISTENT_ENRICHMENT;
      }
    });
  });
});
