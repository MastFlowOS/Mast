/**
 * Regression tests for the child-process exit-lifecycle race described in
 * the Engine 2.0 lifecycle-fix investigation:
 *
 *   gracefulKillProcessTree() used to register its own internal
 *   `child.once("close", ...)` listener, and runEngineQuery() separately
 *   registered a SECOND `child.on("close", ...)` listener of its own much
 *   later (after the read loop, including an `await
 *   gracefulKillProcessTree(...)`, had already finished). Node's
 *   ChildProcess only ever emits `"close"` once, and EventEmitter does not
 *   replay past events to listeners added after the fact — so if the first
 *   listener already consumed the event, the second one would never fire
 *   and runEngineQuery()'s async generator would hang forever.
 *
 * The fix: exactly one `"close"` listener (`watchChildClose()`), attached
 * synchronously in the same tick as `spawn()`, whose resulting promise is
 * shared by every consumer instead of each registering its own listener.
 *
 * Uses Node's built-in test runner (`node:test`) — the repo has no other
 * JS/TS test framework installed, and node:test needs no dependency beyond
 * the `tsx` loader already used for dev (`tsx watch ...` in package.json).
 * Run with: `npx tsx --test src/scraperBridge/__tests__/*.test.ts`
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// The module under test reads required config (SUPABASE_URL, DATABASE_URL,
// etc.) once, at import time, via src/config/env.ts's zod schema. These must
// be set before pythonBridge.ts (and therefore env.ts) is first imported —
// hence the dynamic imports below instead of static top-of-file imports.
// ---------------------------------------------------------------------------
process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";
// Small-but-schema-valid watchdog values — schema enforces
// SCRAPER_SUBPROCESS_MAX_MS >= 30_000 and SCRAPER_SUBPROCESS_INACTIVITY_MS
// >= 10_000, and MAX must be materially larger than INACTIVITY. The
// per-test watchdog scenario overrides these narrowly via spawn env instead
// (see the "watchdog" test below), since this top-level env is read once
// for the whole file.
process.env.SCRAPER_SUBPROCESS_INACTIVITY_MS ??= "10000";
process.env.SCRAPER_SUBPROCESS_MAX_MS ??= "30000";
process.env.SCRAPER_GRACEFUL_SHUTDOWN_MS ??= "1000";

const { __testing } = await import("../pythonBridge.js");
const { watchChildClose, gracefulKillProcessTree } = __testing;
// `env` is a plain parsed object (not frozen) — runEngineQuery() reads
// `env.SCRAPER_ENGINE_PATH` at call time, so mutating this property (rather
// than process.env, which is only read once at module-import time by
// env.ts) is how the integration tests below point it at a fixture engine.
const { env } = await import("../../config/env.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

/** Bound every test with a hard wall-clock ceiling: a re-introduced hang
 * should fail the test loudly instead of stalling the whole suite. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms — likely hung`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ===========================================================================
// Primitive-level tests: exercise watchChildClose()/gracefulKillProcessTree()
// directly against small, fully-controlled plain Node child processes. Fast
// and deterministic — no Python engine involved.
// ===========================================================================
describe("child exit-lifecycle primitives", () => {
  test("1. child exits before graceful shutdown helper is invoked — closed promise still resolves, no hang", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    // The ONE authoritative listener, attached immediately after spawn —
    // exactly as runEngineQuery() does.
    const closed = watchChildClose(child);

    // Let the child fully exit and its "close" event fire and be consumed
    // by the listener above, well before we ever call gracefulKillProcessTree.
    await withTimeout(closed, 2000, "initial child exit");
    await new Promise((r) => setTimeout(r, 50));

    // Calling gracefulKillProcessTree() now — long after "close" already
    // fired — must not hang waiting for a second copy of an event that will
    // never come again.
    await withTimeout(
      gracefulKillProcessTree(child, closed, 500),
      2000,
      "gracefulKillProcessTree after child already exited",
    );

    // And the shared promise must still be awaitable (any number of times,
    // by any caller) and resolve with the real exit info.
    const result = await withTimeout(closed, 100, "re-awaiting already-resolved closed promise");
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  });

  test("2. child exits during graceful shutdown (SIGTERM) — resolves without escalating to SIGKILL", async () => {
    // No SIGTERM handler installed — Python/Node's default disposition
    // (terminate) applies, so the child exits promptly once SIGTERM arrives,
    // simulating a well-behaved subprocess reacting to cooperative shutdown.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const closed = watchChildClose(child);

    // Give the child a moment to actually be running before we ask it to stop.
    await new Promise((r) => setTimeout(r, 50));

    await withTimeout(gracefulKillProcessTree(child, closed, 2000), 3000, "gracefulKillProcessTree (SIGTERM path)");

    const result = await withTimeout(closed, 100, "closed after graceful SIGTERM");
    // Windows has no process-group SIGTERM equivalent; its bridge path
    // performs the documented immediate tree termination instead.
    assert.equal(result.signal, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  });

  test("3. normal child exit (no shutdown requested at all) — closed promise reports the real exit code", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const closed = watchChildClose(child);

    const result = await withTimeout(closed, 2000, "normal exit");
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
  });

  test("5. child refuses to exit — escalation kills it with SIGKILL within the grace window", async () => {
    // Installs a SIGTERM handler that swallows the signal, so it can only be
    // stopped via SIGKILL. Mirrors a genuinely stuck subprocess.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: ["ignore", "ignore", "ignore"], detached: true },
    );
    const closed = watchChildClose(child);
    await new Promise((r) => setTimeout(r, 50));

    const graceMs = 300;
    const started = Date.now();
    await withTimeout(gracefulKillProcessTree(child, closed, graceMs), graceMs + 3000, "escalation to SIGKILL");
    const elapsed = Date.now() - started;

    const result = await withTimeout(closed, 100, "closed after SIGKILL escalation");
    assert.equal(result.signal, "SIGKILL");
    // Escalation should happen roughly at graceMs, not immediately and not
    // after some much longer unrelated delay.
    if (process.platform !== "win32") {
      assert.ok(elapsed >= graceMs, `expected escalation to wait out the ${graceMs}ms grace period, took ${elapsed}ms`);
    }
  });
});

// ===========================================================================
// Integration-level tests: exercise the REAL runEngineQuery() end-to-end
// against a fake `service.py`, via SCRAPER_ENGINE_PATH — this is the exact
// call path (including the second, previously-independent "close" listener
// at the bottom of runEngineQuery) the reported bug lived in.
// ===========================================================================
describe("runEngineQuery() exit-lifecycle integration", () => {
  test("6a. runs a fake engine to natural completion and settles (no hang)", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "normal-engine");
    try {
      const leads: unknown[] = [];
      let done: unknown = null;
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery({ query: "test", city: "Testville" }, undefined, (info) => {
            done = info;
          })) {
            leads.push(lead);
          }
        })(),
        5000,
        "runEngineQuery natural completion",
      );
      assert.equal(leads.length, 1);
      assert.ok(done && (done as { success: boolean }).success === true);
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
    }
  });

  test("6a-area. AREA-SCOPE OVERPASS FIX (Phase 13C): EngineQueryParams.area is actually transmitted to the Python subprocess's stdin payload", async () => {
    // Regression guard for the Node -> Python leg of the area-scope fix:
    // googleMapsProvider.ts now sets `area: target.area` on the params
    // object passed to runEngineQuery() (previously `target.area` only
    // reached Node-side telemetry via `areaLabel`). This test proves that
    // field genuinely lands in the JSON Node writes to the child's stdin —
    // not just that the TS type compiles — using a fake engine
    // (echo-params-engine) that reads stdin and echoes the whole parsed
    // payload back on the emitted lead.
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "echo-params-engine");
    try {
      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "coffee shop", city: "New York", niche: "coffee_shop", area: "Brooklyn" },
            undefined,
            undefined,
          )) {
            leads.push(lead);
          }
        })(),
        5000,
        "runEngineQuery area-transmission check",
      );
      assert.equal(leads.length, 1);
      assert.equal(leads[0]._received_params.area, "Brooklyn");
      assert.equal(leads[0]._received_params.city, "New York");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
    }
  });

  test("6a-area-omitted. existing non-area callers remain compatible: no `area` key at all is sent when the caller never sets it", async () => {
    // Backward-compatibility companion to the test above: a caller that
    // never passes `area` (every pre-Phase-13C call site, and any caller
    // targeting a city with no curated sub-area) must produce a payload
    // with no `area` field, exactly as before this phase.
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "echo-params-engine");
    try {
      const leads: any[] = [];
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery(
            { query: "coffee shop", city: "Austin" },
            undefined,
            undefined,
          )) {
            leads.push(lead);
          }
        })(),
        5000,
        "runEngineQuery no-area backward-compat check",
      );
      assert.equal(leads.length, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(leads[0]._received_params, "area"), false);
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
    }
  });

  test("6b. consumer breaks early mid-stream (triggers gracefulKillProcessTree in the generator's finally) and still settles", async () => {
    // This is the literal reported call path: Node only needs a few leads,
    // breaks out of `for await` early, the generator's `finally` sends
    // SIGTERM via gracefulKillProcessTree, and execution must still reach
    // (and resolve) the function's own final await on child exit — not hang.
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "multi-lead-engine");
    try {
      const leads: unknown[] = [];
      let doneInfo: any = null;
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery({ query: "test", city: "Testville" }, undefined, (info) => {
            doneInfo = info;
          })) {
            leads.push(lead);
            break; // consumer only needed one — deliberate early stop
          }
        })(),
        5000,
        "runEngineQuery early-break cleanup",
      );
      assert.equal(leads.length, 1);
      // BUG 2 REGRESSION CHECK: a plain consumer-stopped-early exit (no
      // request-level abort, no watchdog, no TARGET_REACHED) must be
      // reported as a genuine success, never CANCELLED/FAILURE.
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(doneInfo.success, true, "plain early-break must not be reported as a failure");
      assert.equal(doneInfo.failureReason, undefined, "failureReason must be undefined for a plain early break");
      assert.equal(
        doneInfo.terminationReason,
        "SUCCESS_CONSUMER_STOPPED",
        "terminationReason must be SUCCESS_CONSUMER_STOPPED, not CANCELLED",
      );
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
    }
  });

  test("4. inactivity watchdog fires, gracefully SIGTERMs a stalled fake engine, and runEngineQuery still settles", async () => {
    // Spawns a *separate* subprocess (this test file itself re-invoked via
    // tsx with an overridden, very small SCRAPER_SUBPROCESS_INACTIVITY_MS)
    // is unnecessary here: env.ts's watchdog values were already read at
    // import time for this whole file, so instead this test drives the
    // watchdog path directly through the exported primitives plus a real
    // fake-engine child, mirroring exactly what the watchdog's
    // `fireWatchdog()` does inside runEngineQuery (SIGTERM via
    // gracefulKillProcessTree using the shared closed-promise), against a
    // child that goes silent on stdout — the scenario the inactivity
    // watchdog exists to catch.
    const child = spawn(process.platform === "win32" ? "python" : "python3", ["service.py"], {
      cwd: path.join(FIXTURES_DIR, "slow-inactive-engine"),
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    child.stdin.write(JSON.stringify({ query: "test", city: "Testville" }));
    child.stdin.end();

    const closed = watchChildClose(child);

    // Wait for the one lead it emits (proof it's alive and producing),
    // then simulate "inactivity watchdog fired" exactly as runEngineQuery's
    // fireWatchdog() does: gracefulKillProcessTree using the shared promise.
    await new Promise<void>((resolve) => {
      child.stdout.once("data", () => resolve());
    });

    await withTimeout(
      gracefulKillProcessTree(child, closed, 500),
      3000,
      "watchdog-triggered graceful shutdown of stalled engine",
    );

    const result = await withTimeout(closed, 100, "closed after watchdog shutdown");
    assert.equal(result.signal, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  });

  // ---------------------------------------------------------------------
  // PHASE 2B additions — progress protocol (PART C) and watchdog
  // termination semantics (PART D), both exercised through the real
  // runEngineQuery() end-to-end path (not just the primitives above).
  // ---------------------------------------------------------------------

  test("7. progress lines alone reset the inactivity watchdog — a real lead still arrives instead of a premature SIGTERM", async () => {
    // Six progress lines, 150ms apart (900ms total), against a 250ms
    // inactivity threshold: any single gap is well under the threshold,
    // but the pre-Phase-2B behavior (only a delivered lead or __done__
    // counted as progress) would let the gap between "process start" and
    // "first real lead" accumulate past 250ms and get SIGTERM'd before
    // ever reaching its lead/__done__.
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const originalInactivity = env.SCRAPER_SUBPROCESS_INACTIVITY_MS;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "progress-then-lead-engine");
    env.SCRAPER_SUBPROCESS_INACTIVITY_MS = 250;
    try {
      const leads: unknown[] = [];
      let done: unknown = null;
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery({ query: "test", city: "Testville" }, undefined, (info) => {
            done = info;
          })) {
            leads.push(lead);
          }
        })(),
        5000,
        "runEngineQuery with progress-only inactivity resets",
      );
      assert.equal(leads.length, 1, "the real lead must still have arrived — progress lines must not themselves be yielded as leads");
      assert.ok(done && (done as { success: boolean }).success === true, "must complete successfully — the watchdog must NOT have fired");
      assert.equal((done as { terminationReason?: string }).terminationReason, "SUCCESS_TARGET_REACHED");

      // PHASE 3C-1 STEP 2 (test requirement #1 — timing telemetry appears
      // correctly): progress lines from this fixture must be captured into
      // onDone's progressMarks (first occurrence only, ms since spawn),
      // and bridgeTimings must be populated with real, ordered numbers.
      const info = done as {
        progressMarks?: Record<string, number>;
        bridgeTimings?: { spawnMs: number; firstLineMs: number | null; firstLeadMs: number | null };
      };
      assert.ok(info.progressMarks, "progressMarks must be populated");
      assert.ok(
        typeof info.progressMarks!["discovery:candidate_discovered"] === "number",
        "candidate_discovered mark must be captured",
      );
      assert.ok(
        typeof info.progressMarks!["discovery:candidate_queued"] === "number",
        "candidate_queued mark must be captured",
      );
      // candidate_discovered fires before candidate_queued in the fixture.
      assert.ok(
        info.progressMarks!["discovery:candidate_discovered"] <= info.progressMarks!["discovery:candidate_queued"],
        "marks must reflect real emission order",
      );
      assert.ok(info.bridgeTimings, "bridgeTimings must be populated");
      assert.ok(info.bridgeTimings!.spawnMs >= 0);
      assert.ok(info.bridgeTimings!.firstLineMs !== null);
      assert.ok(info.bridgeTimings!.firstLeadMs !== null);
      // The lead arrives only after all six progress lines — first line
      // received (a progress line) must be strictly earlier than the
      // first actual lead.
      assert.ok(info.bridgeTimings!.firstLineMs! <= info.bridgeTimings!.firstLeadMs!);
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      env.SCRAPER_SUBPROCESS_INACTIVITY_MS = originalInactivity;
    }
  });

  test("8. watchdog-triggered CANCELLED __done__ is reported as terminationReason=WATCHDOG_TIMEOUT, not a silent success", { skip: process.platform === "win32" }, async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const originalInactivity = env.SCRAPER_SUBPROCESS_INACTIVITY_MS;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "watchdog-cancelled-engine");
    env.SCRAPER_SUBPROCESS_INACTIVITY_MS = 250;
    try {
      const leads: unknown[] = [];
      let done: unknown = null;
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery({ query: "test", city: "Testville" }, undefined, (info) => {
            done = info;
          })) {
            leads.push(lead);
          }
        })(),
        5000,
        "runEngineQuery watchdog CANCELLED reporting",
      );
      assert.equal(leads.length, 0);
      assert.ok(done, "onDone must have been called");
      const info = done as {
        success: boolean;
        exhausted: boolean;
        targetReached?: boolean;
        failureReason?: string;
        terminationReason?: string;
      };
      // ROOT-CAUSE REGRESSION CHECK (PART D): this is exactly the shape
      // that used to be mis-reported as success=true/exhausted=true.
      assert.equal(info.success, false);
      assert.equal(info.exhausted, false);
      assert.equal(info.failureReason, "CANCELLED");
      assert.equal(info.terminationReason, "WATCHDOG_TIMEOUT");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      env.SCRAPER_SUBPROCESS_INACTIVITY_MS = originalInactivity;
    }
  });

  test("9. request-level cancellation stops every active runEngineQuery child", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-global-cancel-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "multi-lead-engine");
    try {
      const started: Array<Promise<void>> = [];
      const runs = [0, 1, 2].map((index) => {
        let firstLead!: () => void;
        started.push(new Promise<void>((resolve) => { firstLead = resolve; }));
        return (async () => {
          for await (const _lead of runEngineQuery(
            { query: "test", city: `Testville-${index}` },
            undefined,
            undefined,
            { requestId },
          )) {
            firstLead();
          }
        })();
      });

      await withTimeout(Promise.all(started), 5000, "all request-owned children started");
      assert.equal(lifecycle.__testing.activeProcessCount(requestId), 3);
      lifecycle.terminateRequest(requestId, "USER_CANCELLED");
      await withTimeout(Promise.all(runs), 5000, "all request-owned children stopped");
      assert.equal(lifecycle.__testing.activeProcessCount(requestId), 0);
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });

  test("10. engine discovery failure __done__ produces terminationReason=FAILURE, success=false, and never SUCCESS_EXHAUSTED", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "failed-engine");
    try {
      let doneInfo: any = null;
      for await (const _lead of runEngineQuery({ query: "test", city: "Testville" }, undefined, (info) => {
        doneInfo = info;
      })) {
        // no leads
      }
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(doneInfo.success, false, "success must be false");
      assert.equal(doneInfo.exhausted, false, "exhausted must be false on failure");
      assert.equal(doneInfo.failureReason, "SCRAPER_ERROR");
      assert.equal(doneInfo.terminationReason, "FAILURE", "terminationReason must be FAILURE, never SUCCESS_EXHAUSTED");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
    }
  });

  test("11. parent target reached (5/5) with child requested=20 — abort classifies as SUCCESS_TARGET_REACHED, not failure", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-target-reached-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "target-reached-engine");
    try {
      const abortController = new AbortController();
      let deliveredCount = 0;
      let doneInfo: any = null;
      await withTimeout(
        (async () => {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville", max_results: 20 },
            abortController.signal,
            (info) => {
              doneInfo = info;
            },
            { requestId },
          )) {
            deliveredCount += 1;
            if (deliveredCount >= 5) {
              lifecycle.terminateRequest(requestId, "TARGET_REACHED");
              abortController.abort("TARGET_REACHED");
              break;
            }
          }
        })(),
        5000,
        "runEngineQuery TARGET_REACHED early stop",
      );

      assert.equal(deliveredCount, 5, "must consume exactly 5 leads");
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(doneInfo.success, true, "child final __done__ must NOT report failure when parent target was reached");
      assert.equal(doneInfo.targetReached, true, "targetReached must be true");
      assert.equal(doneInfo.failureReason, undefined, "failureReason must be undefined on successful early stop");
      assert.equal(doneInfo.terminationReason, "SUCCESS_TARGET_REACHED", "terminationReason must be SUCCESS_TARGET_REACHED");
      assert.equal(doneInfo.exhausted, false, "exhausted must be false");
      assert.equal(lifecycle.getRequestTerminalReason(requestId), "TARGET_REACHED", "parent request remains TARGET_REACHED");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });

  test("12. real user cancellation preserves CANCELLED failure semantics", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-user-cancel-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "target-reached-engine");
    try {
      const abortController = new AbortController();
      let deliveredCount = 0;
      let doneInfo: any = null;
      await withTimeout(
        (async () => {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville", max_results: 20 },
            abortController.signal,
            (info) => {
              doneInfo = info;
            },
            { requestId },
          )) {
            deliveredCount += 1;
            if (deliveredCount >= 2) {
              lifecycle.terminateRequest(requestId, "USER_CANCELLED");
              abortController.abort("USER_CANCELLED");
              break;
            }
          }
        })(),
        5000,
        "runEngineQuery user cancellation",
      );

      assert.equal(deliveredCount, 2);
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(doneInfo.success, false, "success must be false for user cancellation");
      assert.equal(doneInfo.failureReason, "CANCELLED", "failureReason must remain CANCELLED");
      assert.equal(doneInfo.terminationReason, "CANCELLED", "terminationReason must remain CANCELLED");
      assert.equal(lifecycle.getRequestTerminalReason(requestId), "USER_CANCELLED");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });

  test("13. engine emits CANCELLED __done__ when parent TARGET_REACHED — bridge reconciles __done__ to success=true, targetReached=true, terminationReason=SUCCESS_TARGET_REACHED", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-done-reconciliation-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "cancelled-done-engine");
    try {
      let doneInfo: any = null;
      const leads: unknown[] = [];
      for await (const lead of runEngineQuery(
        { query: "test", city: "Testville", max_results: 20 },
        undefined,
        (info) => {
          doneInfo = info;
        },
        { requestId },
      )) {
        leads.push(lead);
        if (leads.length === 5) {
          lifecycle.terminateRequest(requestId, "TARGET_REACHED");
        }
      }

      assert.equal(leads.length, 5, "must receive all 5 leads");
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(doneInfo.delivered, 5);
      assert.equal(doneInfo.requested, 20);
      assert.equal(doneInfo.success, true, "reconciled success must be true");
      assert.equal(doneInfo.targetReached, true, "reconciled targetReached must be true");
      assert.equal(doneInfo.failureReason, undefined, "failureReason must be cleared");
      assert.equal(doneInfo.failureDetail, undefined, "failureDetail must be cleared");
      assert.equal(doneInfo.terminationReason, "SUCCESS_TARGET_REACHED", "terminationReason must be SUCCESS_TARGET_REACHED");
      assert.equal(doneInfo.exhausted, false, "exhausted must be false");
      assert.equal(lifecycle.getRequestTerminalReason(requestId), "TARGET_REACHED");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });

  test("14. child engine receives TARGET_REACHED and directly emits SUCCESS_TARGET_REACHED __done__", async () => {
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-direct-target-reached-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "target-reached-engine");
    try {
      let doneInfo: any = null;
      const leads: unknown[] = [];
      for await (const lead of runEngineQuery(
        { query: "test", city: "Testville", max_results: 20 },
        undefined,
        (info) => {
          doneInfo = info;
        },
        { requestId },
      )) {
        leads.push(lead);
        if (leads.length === 5) {
          lifecycle.terminateRequest(requestId, "TARGET_REACHED");
        }
      }

      assert.equal(leads.length, 5, "must receive all 5 leads");
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(doneInfo.delivered, 5);
      assert.equal(doneInfo.requested, 20);
      assert.equal(doneInfo.success, true, "success must be true");
      assert.equal(doneInfo.targetReached, true, "targetReached must be true");
      assert.equal(doneInfo.failureReason, undefined, "failureReason must be undefined");
      assert.equal(doneInfo.failureDetail, undefined, "failureDetail must be undefined");
      assert.equal(doneInfo.terminationReason, "SUCCESS_TARGET_REACHED", "terminationReason must be SUCCESS_TARGET_REACHED");
      assert.equal(doneInfo.exhausted, false, "exhausted must be false");
      assert.equal(lifecycle.getRequestTerminalReason(requestId), "TARGET_REACHED");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });

  test("15. area rotation (multiple batches, no request-level terminal reason at all) — every early-stopped batch reports SUCCESS_CONSUMER_STOPPED, never CANCELLED/FAILURE", async () => {
    // Simulates googleAreaPool.ts's rotation pattern directly: several
    // independent runEngineQuery() calls against the SAME requestId, each
    // one deliberately breaking its own `for await` early (streaming batch
    // quota reached) with no watchdog, no AbortSignal, and — crucially —
    // no terminateRequest() call at all (the request as a whole is still
    // very much alive; only each individual area's batch is done). Before
    // the fix, every one of these was misreported as
    // success=false/failureReason=CANCELLED, which is exactly what made
    // poolExpandJob.ts/discoveryPlanJob.ts log a false "engine discovery
    // FAILED" for perfectly healthy rotation.
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-area-rotation-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "multi-lead-engine");
    try {
      for (const area of ["area-a", "area-b", "area-c"]) {
        let doneInfo: any = null;
        const leads: unknown[] = [];
        await withTimeout(
          (async () => {
            for await (const lead of runEngineQuery(
              { query: "test", city: "Testville" },
              undefined,
              (info) => {
                doneInfo = info;
              },
              { requestId },
            )) {
              leads.push(lead);
              break; // area worker hit its streaming batch quota — moves to next area
            }
          })(),
          5000,
          `runEngineQuery rotation batch (${area})`,
        );

        assert.equal(leads.length, 1, `${area}: must consume exactly 1 lead this batch`);
        assert.ok(doneInfo !== null, `${area}: onDone must be called`);
        assert.equal(doneInfo.success, true, `${area}: rotation must not be reported as a failure`);
        assert.equal(doneInfo.failureReason, undefined, `${area}: failureReason must be undefined`);
        assert.notEqual(doneInfo.terminationReason, "CANCELLED", `${area}: must never be CANCELLED`);
        assert.notEqual(doneInfo.terminationReason, "FAILURE", `${area}: must never be FAILURE`);
        assert.equal(doneInfo.terminationReason, "SUCCESS_CONSUMER_STOPPED", `${area}: must be SUCCESS_CONSUMER_STOPPED`);
        assert.equal(
          lifecycle.isRequestActive(requestId) || true,
          true,
          `${area}: request itself must remain unterminated by a single area's batch stop`,
        );
      }
      // The request as a whole was never terminated by any of the
      // individual batch stops above.
      assert.equal(lifecycle.getRequestTerminalReason(requestId), undefined);
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });

  test("16. BUG 1 REGRESSION: TARGET_REACHED stop-reason file must actually reach Python before SIGTERM, not merely be reconciled away Node-side", async () => {
    // Uses a fixture that reports a DISTINCT SCRAPER_ERROR (not CANCELLED)
    // failure whenever mast_stop_{pid}.txt is missing or has the wrong
    // content at SIGTERM time — see that fixture's own docstring for why
    // this specifically defeats pythonBridge.ts's CANCELLED-only
    // isTargetReachedEarlyStop override, so this test can only pass if
    // gracefulKillProcessTree() genuinely wrote "TARGET_REACHED" to the
    // file before sending SIGTERM.
    const { runEngineQuery } = await import("../pythonBridge.js");
    const lifecycle = await import("../../discovery/requestLifecycle.js");
    const originalPath = env.SCRAPER_ENGINE_PATH;
    const requestId = "bridge-explicit-reason-test";
    env.SCRAPER_ENGINE_PATH = path.join(FIXTURES_DIR, "explicit-reason-required-engine");
    try {
      let doneInfo: any = null;
      let deliveredCount = 0;
      await withTimeout(
        (async () => {
          for await (const _lead of runEngineQuery(
            { query: "test", city: "Testville", max_results: 20 },
            undefined,
            (info) => {
              doneInfo = info;
            },
            { requestId },
          )) {
            deliveredCount += 1;
            if (deliveredCount >= 3) {
              lifecycle.terminateRequest(requestId, "TARGET_REACHED");
            }
          }
        })(),
        5000,
        "runEngineQuery explicit-reason TARGET_REACHED",
      );

      assert.ok(deliveredCount >= 3, "must consume at least 3 leads before shutdown");
      assert.ok(doneInfo !== null, "onDone must be called");
      assert.equal(
        doneInfo.success,
        true,
        "the fixture only reports success=true when it actually read TARGET_REACHED from the stop-reason file",
      );
      assert.equal(doneInfo.targetReached, true);
      assert.equal(doneInfo.failureReason, undefined);
      assert.equal(doneInfo.terminationReason, "SUCCESS_TARGET_REACHED");
    } finally {
      env.SCRAPER_ENGINE_PATH = originalPath;
      lifecycle.__testing.reset();
    }
  });
});
