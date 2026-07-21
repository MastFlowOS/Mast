import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { env } from "../config/env.js";
import { workerMetrics } from "../lib/observability.js";

export type EngineLead = {
  name: string;
  address: string;
  city: string;
  country: string;
  query: string;
  niche: string;
  region: string;
  phone: string;
  email: string;
  website: string;
  instagram: string;
  facebook: string;
  linkedin: string;
  contact_form: string;
  maps_link: string;
  rating: number | null;
  reviews: number;
  category: string;
  price_range: string;
  has_photos: boolean;
  has_popular_times: boolean;
  owner_responds_to_reviews: boolean;
  is_google_verified: boolean;
  multi_location: boolean;
  closed: boolean;
  ig_followers: number | null;
  ig_bio: string;
  ig_activity: string;
  ig_last_post_days: number | null;
  ig_legitimacy: number;
  tech_stack: Record<string, unknown>;
  score: number;
  quality: string;
  tier: string;
  action: string;
  fingerprints: string[];
  /** Phase 6 — chain/cannabis verdict from Part 1's own is_chain/is_cannabis */
  is_disqualified: boolean;

  // ── Quality & Intelligence pass additions ──────────────────────────────
  /** C5 fix — every email found, role-ranked: [{email, role}] */
  emails?: { email: string; role: string }[];
  /** C5 fix — every distinct phone number found */
  phones?: string[];
  /** C3 fix — only keys actually detected; never a fabricated negative */
  growth_signals?: { hiring?: boolean; new_location?: boolean };
  /** Priority 5 — on-page SEO signals from already-fetched HTML */
  seo?: { has_title?: boolean; title_length?: number; has_meta_description?: boolean; meta_description_length?: number };
  /** Priority 5/6 — blog/news presence + staleness */
  blog?: { has_blog?: boolean; blog_url?: string; last_post_days?: number };
  /** I2 fix — real certificate probe, not a string check. null = http:// or not crawled */
  ssl_valid?: boolean | null;
  /** I3 fix — real page-load timing from the crawler's own goto() */
  load_time_ms?: number | null;
  /** Priority 2/3 — per-field source attribution built during enrichment */
  field_provenance?: Record<string, { value: unknown; source: string; method: string }>;
  /** O2 fix — single source of truth for "weak/templated site", computed once by the engine */
  website_is_weak?: boolean;

  [key: string]: unknown;
};

export type EngineQueryParams = {
  query: string;
  city: string;
  country?: string;
  niche?: string;
  region?: string;
  max_results?: number;
  max_ig_followers?: number;
  max_reviews?: number;
  min_score?: number;
  fast?: boolean;
  skip_ig?: boolean;
  skip_site_crawl?: boolean;
  require_viability?: boolean;
  discovery_only?: boolean;
  db_path?: string;
};

export type EngineVerifyParams = {
  website?: string;
  instagram?: string;
  headless?: boolean;
};

export type EngineVerifyResult = {
  website_ok: boolean | null;
  website_data: {
    instagram?: string;
    facebook?: string;
    linkedin?: string;
    email?: string;
    emails?: { email: string; role: string }[];
    contact_form?: string;
    phone?: string;
    phones?: string[];
    tech_stack?: Record<string, unknown>;
    growth_signals?: { hiring?: boolean; new_location?: boolean };
    seo?: Record<string, unknown>;
    blog?: Record<string, unknown>;
    ssl_valid?: boolean | null;
    load_time_ms?: number | null;
    field_sources?: Record<string, { source_url: string; method: string }>;
  };
  instagram_ok: boolean | null;
  instagram_data: {
    followers?: number | null;
    posts?: number | null;
    bio?: string;
    last_post_days?: number | null;
    legitimacy_score?: number;
    private?: boolean;
    blocked?: boolean;
  };
};

const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";

function killProcessTree(child: ReturnType<typeof spawn>) {
  if (child.pid === undefined) return;
  console.log(`[scraper-bridge] Killing process tree for child PID: ${child.pid}`);
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", child.pid.toString()]);
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (err) {
      try {
        child.kill("SIGKILL");
      } catch (e) {}
    }
  }
}

/** Grace period given to the child after SIGTERM before we escalate to
 * SIGKILL — long enough for run_query()'s cleanup (browser shutdown,
 * profiler report) to finish; short enough not to noticeably delay the
 * next spawn. */
const GRACEFUL_SHUTDOWN_MS = 3000;

/**
 * BUG FIX (missing profiler report): like killProcessTree, but gives the
 * child a chance to shut down on its own first. This matters specifically
 * for the "consumer stopped iterating early" case in runEngineQuery's
 * cleanup below — that path fires on nearly every successful run (callers
 * deliberately ask the engine for more leads than they need and break out
 * once satisfied), so the engine isn't misbehaving there, it's still
 * mid-cleanup. An immediate SIGKILL never gave it a chance to reach
 * run_query()'s `finally` in Python (store close, profiler report,
 * __done__ sentinel) — service.py now installs a SIGTERM handler that
 * cancels the run gracefully so that cleanup can still complete. Genuine
 * failure/abort paths (user cancellation, stuck subprocess) keep using the
 * immediate killProcessTree above, unchanged.
 */
async function gracefulKillProcessTree(child: ReturnType<typeof spawn>, graceMs = GRACEFUL_SHUTDOWN_MS) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // No SIGTERM-equivalent process-tree signal on Windows.
    killProcessTree(child);
    return;
  }

  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (err) {
    killProcessTree(child);
    return;
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
  ]);

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    console.log(`[scraper-bridge] PID ${child.pid} did not exit within ${graceMs}ms of SIGTERM — sending SIGKILL`);
    killProcessTree(child);
  }
}

/**
 * One-shot (non-streaming) call to `python service.py verify` — re-checks a
 * single already-known business's website/instagram directly, no Maps
 * search. Separate from runEngineQuery() because this is a single request/
 * response, not a stream of many results.
 */
export async function runEngineVerify(params: EngineVerifyParams, signal?: AbortSignal): Promise<EngineVerifyResult> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  const child = spawn(PYTHON_CMD, ["service.py", "verify"], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const onAbort = () => {
    console.log(`[scraper-bridge:verify] Abort signal triggered for PID: ${child.pid}`);
    killProcessTree(child);
  };
  signal?.addEventListener("abort", onAbort);

  try {
    child.stdin.write(JSON.stringify(params));
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      console.debug(`[scraper-bridge:verify] ${chunk.toString().trimEnd()}`);
    });

    const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
    if (exitCode !== 0) {
      throw new Error(`verify subprocess exited with code ${exitCode}`);
    }

    return JSON.parse(stdout) as EngineVerifyResult;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child);
    }
  }
}

export type EngineDoneInfo = {
  delivered: number;
  requested: number;
  /** true when the engine's own search space ran out before `requested` was reached */
  exhausted: boolean;
  /** Phase 2: structured performance report from the Python profiler */
  perf?: Record<string, unknown>;
};

/** Phase 2: timing probes captured during a runEngineQuery() call. */
export type EngineBridgeTimings = {
  /** ms from spawn() call to child process being forked */
  spawnMs: number;
  /** ms from spawn() to first stdout line received */
  firstLineMs: number | null;
  /** ms from spawn() to first non-__done__ lead line */
  firstLeadMs: number | null;
};

/**
 * Spawns `python service.py` inside the Part 1 engine directory and streams
 * results back as they're discovered — one JSON object per stdout line.
 *
 * This is the entire integration surface with the Python engine. Nothing
 * upstream of this function (job handlers, routes) knows or cares that the
 * engine is Python; they just get an async iterator of lead objects.
 *
 * `onDone`, when provided, receives the engine's `__done__` sentinel
 * (delivered/requested/exhausted) once the subprocess finishes streaming —
 * this is how callers distinguish "this query is genuinely exhausted, try
 * another niche/variation" from "we just didn't need any more of these".
 */
export async function* runEngineQuery(
  params: EngineQueryParams,
  signal?: AbortSignal,
  onDone?: (info: EngineDoneInfo) => void,
): AsyncGenerator<EngineLead> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  // Phase 2: spawn timing
  const _t0 = process.hrtime.bigint();
  const hrElapsedMs = () => Number(process.hrtime.bigint() - _t0) / 1e6;

  const child = spawn(PYTHON_CMD, ["service.py"], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const spawnMs = hrElapsedMs();

  // Phase 7 observability: track active subprocess count (best-effort, non-blocking).
  workerMetrics.browserLaunches += 1;
  workerMetrics.activeBrowsers += 1;

  let firstLineMs: number | null = null;
  let firstLeadMs: number | null = null;

  const onAbort = () => {
    console.log(`[scraper-bridge] Abort signal triggered for PID: ${child.pid}`);
    killProcessTree(child);
  };
  signal?.addEventListener("abort", onAbort);

  child.stdin.write(JSON.stringify(params));
  child.stdin.end();

  child.stderr.on("data", (chunk) => {
    // The engine logs verbosely to stderr via its own logger (get_logger) —
    // surface it as debug output rather than treating it as failure; only
    // a non-zero exit code is treated as an actual error, below.
    const line = chunk.toString();
    console.debug(`[scraper-bridge] ${line.trimEnd()}`);
    // Phase 7: detect crash patterns in stderr output (best-effort).
    if (/crash|chromium|oom|killed|sigkill|playwright.*error/i.test(line)) {
      workerMetrics.browserCrashes += 1;
    }
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let readError: unknown = null;
  // Observability only: tracks whether the __done__ sentinel was ever seen,
  // so we can explicitly flag the "process exited but __done__ never arrived"
  // case distinctly from a normal, sentinel-confirmed completion.
  let sawDone = false;

  const lineIterator = (async function* () {
    for await (const line of rl) {
      if (!line.trim()) continue;
      yield line;
    }
    // rl's for-await loop only ends when child.stdout itself closes.
    console.log(`[scraper-bridge] stdout closed (PID: ${child.pid}, sawDone=${sawDone})`);
  })();

  try {
    for await (const line of lineIterator) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        console.error(`[scraper-bridge] non-JSON line from engine, skipping: ${line.slice(0, 200)}`);
        continue;
      }

      if (parsed.__done__) {
        sawDone = true;
        const perfPayload = parsed.__perf__ as Record<string, unknown> | undefined;
        console.log(`[scraper-bridge] received __done__ — delivered=${parsed.delivered} exhausted=${parsed.exhausted} spawnMs=${spawnMs.toFixed(0)} firstLineMs=${firstLineMs?.toFixed(0) ?? "n/a"} firstLeadMs=${firstLeadMs?.toFixed(0) ?? "n/a"}`);
        onDone?.({
          delivered: Number(parsed.delivered ?? 0),
          requested: Number(parsed.requested ?? 0),
          exhausted: Boolean(parsed.exhausted),
          perf: perfPayload,
        });
        continue;
      }

      // Phase 2: record first-line and first-lead timestamps
      if (firstLineMs === null) firstLineMs = hrElapsedMs();
      if (firstLeadMs === null) firstLeadMs = hrElapsedMs();

      yield parsed as EngineLead;
    }
  } catch (err) {
    readError = err;
    throw err;
  } finally {
    rl.close();
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      console.log(`[scraper-bridge] Generator exited or break occurred early. Cleaning up PID: ${child.pid}`);
      await gracefulKillProcessTree(child);
    }
  }

  const [exitCode, closeSignal]: [number, NodeJS.Signals | null] = await new Promise((resolve) =>
    child.on("close", (code, signal) => resolve([code as unknown as number, signal])),
  );

  // Phase 7 observability: decrement active browsers counter on exit.
  workerMetrics.activeBrowsers = Math.max(0, workerMetrics.activeBrowsers - 1);
  if (exitCode !== 0 && exitCode !== null) {
    workerMetrics.subprocessRestarts += 1;
  }

  console.log(
    `[scraper-bridge] process exited — PID: ${child.pid}, exitCode=${exitCode}, closeSignal=${closeSignal ?? "none"}, sawDone=${sawDone}`,
  );
  if (!sawDone) {
    // Explicit flag for the exact gap this audit called out: the process
    // ended (for whatever reason) without ever emitting the __done__
    // sentinel — this is observability only, no behavior change below.
    console.warn(
      `[scraper-bridge] __done__ was NEVER received before process exit (PID: ${child.pid}, exitCode=${exitCode}, closeSignal=${closeSignal ?? "none"}) — stream ended without engine confirmation`,
    );
  }
  if (exitCode !== 0 && !readError) {
    throw new Error(`scraper engine exited with code ${exitCode}`);
  }
}
