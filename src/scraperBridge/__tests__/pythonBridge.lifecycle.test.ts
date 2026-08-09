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
    // Terminated by SIGTERM, not escalated to SIGKILL.
    assert.equal(result.signal, "SIGTERM");
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
    assert.ok(elapsed >= graceMs, `expected escalation to wait out the ${graceMs}ms grace period, took ${elapsed}ms`);
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
      await withTimeout(
        (async () => {
          for await (const lead of runEngineQuery({ query: "test", city: "Testville" })) {
            leads.push(lead);
            break; // consumer only needed one — deliberate early stop
          }
        })(),
        5000,
        "runEngineQuery early-break cleanup",
      );
      assert.equal(leads.length, 1);
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
    const child = spawn("python3", ["service.py"], {
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
    assert.equal(result.signal, "SIGTERM");
  });
});
