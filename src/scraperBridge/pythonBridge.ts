import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { env } from "../config/env.js";
import { workerMetrics } from "../lib/observability.js";
import {
  registerRequestEngineProcess,
  getRequestTerminalReason,
} from "../discovery/requestLifecycle.js";
import {
  newAreaRunId,
  recordBeforeAreaStart,
  recordAfterAreaStart,
  recordAfterAreaCleanup,
} from "../lib/areaWorkerTelemetry.js";

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
  /**
   * Phase S1 — tracing-only identifier minted by the engine's PipelineTracer
   * the instant MapsScraper yielded this business (see
   * mast-lead-engine/utils/pipeline_trace.py). Lets a single business be
   * traced end-to-end by grepping this id across both the Python engine's
   * logs and this worker's logs. NOT a business field — never persisted to
   * a real column, never used for dedup/scoring/any decision.
   */
  _pipeline_id?: string;

  [key: string]: unknown;
};

export type EngineQueryParams = {
  query: string;
  city: string;
  country?: string;
  niche?: string;
  region?: string;
  /**
   * AREA-SCOPE OVERPASS FIX (Phase 13C) — optional, more specific
   * sub-city scope (e.g. a curated borough/neighborhood name such as
   * "Brooklyn", the same value already carried on `SearchTarget.area`
   * — see googleMapsSearchGenerator.ts / areaRotation.ts). Threaded
   * unchanged through to service.py's `run_query(area=...)`, which
   * only uses it to scope Overpass's own OSM query (see
   * provider_request_translation.py) more precisely than `city`
   * alone; every other provider's request, plus qualification,
   * scoring, dedup, worker counts, and resource capacity, is
   * untouched by this field. Omitted (or empty) preserves the exact
   * prior city-level behavior for any existing caller.
   */
  area?: string;
  /**
   * Raw scan budget: how many raw Maps places the Python subprocess may
   * scan before stopping.  Intentionally larger than `deliver_target` to
   * compensate for enrichment/filter/dedup losses.  Passed to
   * MapsScraper.search() as its `max_results` cap.
   */
  max_results?: number;
  /**
   * Qualified-lead delivery target: how many enriched, filtered leads the
   * subprocess should deliver before it terminates naturally.  When
   * omitted, Python falls back to `max_results` for backward compatibility.
   * Separating this from `max_results` lets Node pass a generous scan
   * budget while Python still stops at the right count.
   */
  deliver_target?: number;
  max_ig_followers?: number;
  max_reviews?: number;
  min_score?: number;
  fast?: boolean;
  skip_ig?: boolean;
  skip_site_crawl?: boolean;
  require_viability?: boolean;
  discovery_only?: boolean;
  required_channels?: string[];
  db_path?: string;
};

export type EngineRunOptions = {
  /** Durable discovery plan that owns this process, when this is live discovery. */
  requestId?: string;
  /**
   * PHASE 6B — optional curated-area label (or "n/a" for a city with no
   * curated areas), purely for area-worker resource telemetry (see
   * areaWorkerTelemetry.ts). Never read for qualification, dedup,
   * targeting, or any other decision — display/log tagging only.
   */
  areaLabel?: string;
  /**
   * PHASE 25 — live callback fired for EVERY `"type":"progress"` stdout
   * line as it arrives (not just the first occurrence of a given
   * stage:event pair, unlike `EngineDoneInfo.progressMarks`, and not
   * deferred until `__done__`). Lets a caller observe forward progress
   * (e.g. `discovery:candidate_discovered`) in real time — see
   * poolExpandJob.ts's area-productivity idle timer, the first consumer.
   * Purely observational: never gates anything in this file, never
   * changes what gets yielded/delivered.
   */
  onProgress?: (event: EngineProgressEvent) => void;
};

/** PHASE 25 — one `"type":"progress"` stdout line, as delivered to `EngineRunOptions.onProgress`. */
export type EngineProgressEvent = {
  stage: string;
  event: string;
  itemId?: string;
  /**
   * PHASE 5B-2 — additive lifecycle-accounting fields (see
   * mast-lead-engine/service.py's `_on_progress`). `pipelineId` is the
   * stable per-candidate correlation key (present for every stage —
   * `itemId` above stays `queue_item_id`/`worker_id` for website/instagram/
   * contact/merge/qualification/storage stage_completed/stage_failed lines,
   * unchanged from before this phase). `terminal` is true exactly when this
   * event is THE one candidate-terminal resolution for `pipelineId` — see
   * poolExpandJob.ts's onProgress handler for the idempotent (by
   * pipelineId) consumer of this flag. Absent/undefined on any progress
   * line from an older engine build that predates this phase — treat as
   * `terminal: false`.
   */
  pipelineId?: string;
  terminal?: boolean;
  deadLettered?: boolean;
  terminalReason?: string;
};

export type EngineVerifyParams = {
  website?: string;
  instagram?: string;
  headless?: boolean;
};

/**
 * Milestone 2 (pg-boss business-processing integration): input to
 * `service.py enrich`, Engine 2.0's WebsiteWorker/InstagramWorker/
 * ContactWorker/MergeWorker running against one already-known business.
 * Same permissive convention as EngineVerifyParams — website/instagram
 * are independently optional; whichever is present gets processed.
 */
export type EngineEnrichParams = {
  name?: string;
  website?: string;
  instagram?: string;
  address?: string;
  city?: string;
  country?: string;
  category?: string;
  phone?: string;
};

/**
 * Mirrors engine_enrichment_bridge.py's `_enriched_to_dict()` return shape
 * field-for-field. Fields Engine 2.0 does not produce yet (seo, blog,
 * signals.tech_stack, on-page social-link discovery — see that module's
 * own docstring) are deliberately absent from this type, not typed as
 * `| null`, so a caller can't accidentally treat "not covered by Engine
 * 2.0 yet" the same as "checked, found nothing".
 */
export type EngineEnrichResult = {
  website_reachable: boolean | null;
  ssl_valid: boolean | null;
  load_time_ms: number | null;
  final_url: string | null;
  http_status: number | null;
  title: string | null;
  meta_description: string | null;
  detected_platform: string | null;
  contact_page: string | null;
  email: string | null;
  emails: string[];
  phone: string | null;
  phones: string[];
  contact_form_url: string | null;
  whatsapp_link: string | null;
  messenger_link: string | null;
  telegram_link: string | null;
  linkedin: string | null;
  instagram_reachable: boolean | null;
  instagram_username: string | null;
  instagram_followers: number | null;
  instagram_following: number | null;
  instagram_posts: number | null;
  instagram_verified: boolean | null;
  instagram_account_type: string | null;
  instagram_bio: string | null;
  instagram_external_website: string | null;
  instagram_last_post_date: string | null;
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

/**
 * LIFECYCLE FIX (race condition — child-process exit has exactly ONE
 * authoritative listener): a Node `ChildProcess` only ever emits `"close"`
 * once, and EventEmitter does NOT replay past events to listeners added
 * after the fact. Previously `gracefulKillProcessTree()` registered its own
 * `child.once("close", ...)` internally, and `runEngineQuery()` separately
 * registered a second `child.on("close", ...)` of its own much later (after
 * the whole read loop — including an `await gracefulKillProcessTree(...)` —
 * had finished). If `"close"` fired and was consumed by the first listener
 * before the second one was attached, the second listener would never fire
 * and `runEngineQuery()`'s generator would hang forever waiting on it.
 *
 * The fix: attach exactly one `"close"` listener, synchronously, in the same
 * tick as `spawn()` — before any `await` gives the event loop a chance to
 * deliver the event — and hand every other consumer (graceful shutdown, the
 * generator's own final await) the same resulting promise instead of each
 * registering its own listener. A child process cannot exit before its own
 * `spawn()` call returns, so a listener attached in that same synchronous
 * block is guaranteed to observe the event no matter how it happens
 * (natural exit, SIGTERM from graceful shutdown, SIGKILL from watchdog
 * escalation, or an abort signal).
 */
export type ChildCloseResult = { code: number | null; signal: NodeJS.Signals | null };

function watchChildClose(child: ReturnType<typeof spawn>): Promise<ChildCloseResult> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * LIFECYCLE FIX (Bug 1 — the stop-reason file was never written): service.py
 * already knows how to read a cooperative-shutdown reason from
 * `mast_stop_{pid}.txt` (see `_get_shutdown_reason()`) and, when it reads
 * `TARGET_REACHED`, completes gracefully instead of raising
 * `DiscoveryFailure(CANCELLED)`. Nothing on the Node side ever wrote that
 * file, so Python always fell back to `reason=None`/`unspecified` and
 * always took the CANCELLED path internally — masked only when Node's own
 * `__done__` reconciliation (`isTargetReachedEarlyStop`) happened to still
 * be listening (see `runEngineQuery`'s in-loop `__done__` handling). This
 * writes the real reason, best-effort, right before the SIGTERM that asks
 * the child to stop — mirrors `killProcessTree`'s own best-effort-only
 * error handling (a failed write must never block termination).
 */
function stopReasonFilePath(pid: number): string {
  return path.join(os.tmpdir(), `mast_stop_${pid}.txt`);
}

function writeStopReasonFile(pid: number, reason: string) {
  try {
    fs.writeFileSync(stopReasonFilePath(pid), reason, "utf-8");
  } catch (err) {
    console.warn(`[scraper-bridge] failed to write stop-reason file for PID ${pid} (reason=${reason})`, err);
  }
}

function killProcessTree(child: ReturnType<typeof spawn>) {
  if (child.pid === undefined) return;
  console.log(`[scraper-bridge] Killing process tree for child PID: ${child.pid}`);
  if (process.platform === "win32") {
    // taskkill /T is what tears down Chromium descendants.  Also terminate
    // the direct child immediately: taskkill is asynchronous and can be
    // delayed/fail under a constrained service account, while leaving the
    // Python engine alive would still allow it to emit and accept leads.
    const killer = spawn("taskkill", ["/F", "/T", "/PID", child.pid.toString()], { stdio: "ignore", windowsHide: true });
    killer.on("error", (err) => console.warn(`[scraper-bridge] taskkill failed for PID ${child.pid}`, err));
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone is harmless; taskkill remains the tree-level fallback.
    }
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
 * next spawn.
 *
 * LIFECYCLE FIX: both call sites in this file now pass
 * `env.SCRAPER_GRACEFUL_SHUTDOWN_MS` explicitly (raised default: 15s, to
 * accommodate service.py's own cooperative-shutdown window — see that
 * env var's comment in src/config/env.ts). This constant now only serves
 * as the function's fallback default for any future/other caller that
 * doesn't pass one. */
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
 *
 * LIFECYCLE FIX: no longer registers its own `"close"` listener. Callers
 * must pass the single shared `watchChildClose()` promise created right
 * after `spawn()` — see that function's doc comment for why a second,
 * independently-registered listener on the same child is the root cause of
 * the exit race this fix closes.
 *
 * LIFECYCLE FIX (Bug 1): accepts an optional cooperative-shutdown `reason`
 * — when present, written to `mast_stop_{pid}.txt` (see
 * `writeStopReasonFile`) before the SIGTERM is sent, so service.py can read
 * it at its own SIGTERM handler / next checkpoint. Every call site in this
 * file now passes its real reason (`TARGET_REACHED`, `USER_CANCELLED`,
 * `WATCHDOG_TIMEOUT`, or a descriptive fallback) instead of leaving Python
 * to fall back to `reason=None`/`unspecified`.
 */
async function gracefulKillProcessTree(
  child: ReturnType<typeof spawn>,
  closed: Promise<ChildCloseResult>,
  graceMs = GRACEFUL_SHUTDOWN_MS,
  reason?: string,
) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (reason) writeStopReasonFile(child.pid, reason);
  if (process.platform === "win32") {
    // No SIGTERM-equivalent process-tree signal on Windows.
    killProcessTree(child);
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (err) {
    killProcessTree(child);
    return;
  }

  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
  ]);

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    console.log(`[scraper-bridge] PID ${child.pid} did not exit within ${graceMs}ms of SIGTERM — sending SIGKILL`);
    killProcessTree(child);
  }
}

/**
 * Exposed ONLY so the regression tests in `__tests__/pythonBridge.lifecycle.test.ts`
 * can exercise the exit-lifecycle primitives directly (spawning small,
 * fully-controlled child processes) without needing a full Python engine.
 * Not part of the public bridge API — callers outside this module and its
 * tests should not depend on it.
 */
export const __testing = { watchChildClose, gracefulKillProcessTree, killProcessTree };

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

  child.on("error", (err) => {
    console.warn(`[scraper-bridge:verify] child process error (PID: ${child.pid})`, err);
  });
  child.stdin.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge:verify] stdin error (PID: ${child.pid})`, err);
    }
  });
  child.stdout.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge:verify] stdout error (PID: ${child.pid})`, err);
    }
  });
  child.stderr.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge:verify] stderr error (PID: ${child.pid})`, err);
    }
  });

  const onAbort = () => {
    console.log(`[scraper-bridge:verify] Abort signal triggered for PID: ${child.pid}`);
    killProcessTree(child);
  };
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();

  try {
    try {
      child.stdin.write(JSON.stringify(params), (err) => {
        if (err && (err as any).code !== "EPIPE" && (err as any).code !== "ERR_STREAM_DESTROYED") {
          console.warn(`[scraper-bridge:verify] stdin write callback error (PID: ${child.pid})`, err);
        }
      });
      child.stdin.end();
    } catch (writeErr: any) {
      if (writeErr?.code !== "EPIPE" && writeErr?.code !== "ERR_STREAM_DESTROYED") {
        console.warn(`[scraper-bridge:verify] stdin write error (PID: ${child.pid})`, writeErr);
      }
    }

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

/**
 * Milestone 2 (pg-boss business-processing integration): spawns
 * `service.py enrich`, Engine 2.0's canonical replacement for the
 * SiteCrawler/IGIntelligence extraction runEngineVerify() above drives.
 * Same spawn/pipe/kill lifecycle as runEngineVerify — only the CLI mode
 * argument and result type differ.
 */
export async function runEngineEnrich(params: EngineEnrichParams, signal?: AbortSignal): Promise<EngineEnrichResult> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  const child = spawn(PYTHON_CMD, ["service.py", "enrich"], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  child.on("error", (err) => {
    console.warn(`[scraper-bridge:enrich] child process error (PID: ${child.pid})`, err);
  });
  child.stdin.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge:enrich] stdin error (PID: ${child.pid})`, err);
    }
  });
  child.stdout.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge:enrich] stdout error (PID: ${child.pid})`, err);
    }
  });
  child.stderr.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge:enrich] stderr error (PID: ${child.pid})`, err);
    }
  });

  const onAbort = () => {
    console.log(`[scraper-bridge:enrich] Abort signal triggered for PID: ${child.pid}`);
    killProcessTree(child);
  };
  signal?.addEventListener("abort", onAbort);

  try {
    try {
      child.stdin.write(JSON.stringify(params), (err) => {
        if (err && (err as any).code !== "EPIPE" && (err as any).code !== "ERR_STREAM_DESTROYED") {
          console.warn(`[scraper-bridge:enrich] stdin write callback error (PID: ${child.pid})`, err);
        }
      });
      child.stdin.end();
    } catch (writeErr: any) {
      if (writeErr?.code !== "EPIPE" && writeErr?.code !== "ERR_STREAM_DESTROYED") {
        console.warn(`[scraper-bridge:enrich] stdin write error (PID: ${child.pid})`, writeErr);
      }
    }

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      console.debug(`[scraper-bridge:enrich] ${chunk.toString().trimEnd()}`);
    });

    const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
    if (exitCode !== 0) {
      throw new Error(`enrich subprocess exited with code ${exitCode}`);
    }

    return JSON.parse(stdout) as EngineEnrichResult;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child);
    }
  }
}

/**
 * Machine-readable discovery-failure reasons — mirrors
 * `exceptions.DiscoveryFailureReason` (mast-lead-engine/exceptions/__init__.py)
 * field-for-field. Kept as a string union rather than importing anything
 * from Python (there's no shared codegen between the two languages here),
 * so this must be updated by hand if the Python enum's members change.
 */
export type EngineDiscoveryFailureReason =
  | "PANEL_NOT_FOUND"
  | "CONSENT_REQUIRED"
  | "BLOCKED"
  | "CHALLENGE"
  | "NAVIGATION_TIMEOUT"
  | "INVALID_RESULTS_PAGE"
  | "SCRAPER_ERROR"
  /**
   * LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
   * mirrors the new `DiscoveryFailureReason.CANCELLED` member on the
   * Python side (mast-lead-engine/exceptions/__init__.py) — a run that
   * was deliberately stopped mid-flight by a cooperative shutdown request
   * (watchdog absolute ceiling, caller abort, or process shutdown)
   * *before* it finished naturally. Not a scraper/network/page failure —
   * distinguished from SCRAPER_ERROR so callers can tell "we asked it to
   * stop" apart from "it broke".
   */
  | "CANCELLED";

export type EngineDoneInfo = {
  delivered: number;
  requested: number;
  /**
   * true when the engine's own search space ran out before `requested` was
   * reached. ROOT CAUSE FIX (Engine 2.0 Part 8): this is only meaningful
   * when `success` is also true — a failed discovery attempt (no valid
   * results panel, a consent/block/challenge interstitial, a navigation
   * timeout, or an unclassified scraper error) reports `exhausted: false`
   * unconditionally, since a search that never got far enough to look at
   * results can't have "run out" of them. Callers MUST check `success`
   * before trusting `exhausted` — see `failureReason` below.
   */
  exhausted: boolean;
  /**
   * false when this query ended in a discovery failure rather than a
   * genuine (possibly empty) result set — see `exceptions.DiscoveryFailure`
   * on the Python side. Defaults to true for backward compatibility with
   * any engine build that predates this field (absent `success` in the
   * sentinel is treated as "not a failure", matching pre-fix behavior).
   */
  success: boolean;
  /**
   * LIFECYCLE FIX: true when this run stopped because `delivered` reached
   * `requested` with no failure — the "successful target completion"
   * outcome from the completion-semantics fix, spelled out explicitly by
   * the engine (service.py's `_main_cli`) rather than re-derived here.
   * Optional/absent for an engine build that predates this field; such a
   * build's `delivered >= requested` already implies the same thing when
   * `success` is true, so no behavior is lost, just the explicit label.
   */
  targetReached?: boolean;
  /** Present only when `success` is false. */
  failureReason?: EngineDiscoveryFailureReason;
  /** Present only when `success` is false — human-readable detail for logs. */
  failureDetail?: string;
  /**
   * PART D (Phase 2B — watchdog shutdown semantics): a single,
   * unambiguous termination classification, derived here (Node-side)
   * from `success`/`targetReached`/`exhausted`/`failureReason` plus this
   * bridge call's own local watchdog state (`timedOut`/`timedOutReason`)
   * — state Python has no way to know on its own, since from its side a
   * watchdog-triggered SIGTERM and any other cooperative-shutdown SIGTERM
   * are indistinguishable (both just set the same `_shutdown_event`; see
   * service.py). This does not introduce a second competing status
   * system — it is computed purely from fields `EngineDoneInfo` already
   * carries, spelled out explicitly instead of left for every caller to
   * re-derive:
   *
   *   "SUCCESS_TARGET_REACHED"   — success && targetReached
   *   "SUCCESS_EXHAUSTED"        — success && !targetReached (exhausted or
   *                                not, since "delivered less than requested
   *                                but no failure" only happens via genuine
   *                                exhaustion)
   *   "SUCCESS_CONSUMER_STOPPED" — success && the ONLY reason this run ended
   *                                is that this bridge call's own consumer
   *                                (the `for await` on the other end of
   *                                `runEngineQuery`) stopped iterating early
   *                                — e.g. area rotation hitting its
   *                                streaming batch quota — with no genuine
   *                                abort/watchdog/target-reached in play.
   *                                Distinct from SUCCESS_TARGET_REACHED:
   *                                the PARENT request's target was not
   *                                necessarily reached, only THIS call's
   *                                own batch was satisfied.
   *   "WATCHDOG_TIMEOUT"         — !success && failureReason === "CANCELLED"
   *                                && this bridge call's own watchdog fired
   *   "CANCELLED"                — !success && failureReason === "CANCELLED"
   *                                && the watchdog did NOT fire (caller
   *                                abort / external process shutdown
   *                                instead)
   *   "FAILURE"                  — !success, any other failureReason
   */
  terminationReason?:
    | "SUCCESS_TARGET_REACHED"
    | "SUCCESS_EXHAUSTED"
    | "SUCCESS_CONSUMER_STOPPED"
    | "WATCHDOG_TIMEOUT"
    | "CANCELLED"
    | "FAILURE";
  /** Phase 2: structured performance report from the Python profiler */
  perf?: Record<string, unknown>;
  /**
   * PHASE 3C-1 STEP 2 — bridge-side transport timings (spawn → first
   * stdout line → first lead), always populated once `spawn()` has
   * returned. AUDIT FINDING: this data was already computed in this file
   * (`spawnMs`/`firstLineMs`/`firstLeadMs`, logged in a single console.log
   * line at __done__ time) but was never threaded out through `onDone` —
   * `EngineBridgeTimings` existed as a type with no producer feeding it to
   * any caller. This closes that gap; nothing above is a new measurement.
   */
  bridgeTimings?: EngineBridgeTimings;
  /**
   * PHASE 3C-1 STEP 2 — first-occurrence timestamp (ms since spawn) for
   * every distinct `stage:event` pair reported over the existing
   * `"type":"progress"` stdout protocol (service.py's `_on_progress` /
   * MapsScraper's `_emit_progress`) during this run. Covers, when the
   * engine build emits them: `discovery:maps_navigation_start`,
   * `discovery:maps_navigation_complete`, `discovery:panel_resolved`,
   * `discovery:candidate_discovered`, `discovery:candidate_queued`, and
   * any future progress event — this map is generic over the event name,
   * not a fixed allowlist, so a new `_emit_progress(...)` call on the
   * Python side is automatically picked up here with no bridge change.
   * Previously these lines were only `console.debug`-logged and discarded
   * — see the loop below where they're received.
   */
  progressMarks?: Record<string, number>;
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
  options: EngineRunOptions = {},
): AsyncGenerator<EngineLead> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  // Phase 2: spawn timing
  const _t0 = process.hrtime.bigint();
  const hrElapsedMs = () => Number(process.hrtime.bigint() - _t0) / 1e6;

  // PHASE 6B — real per-area-worker PID/memory footprint measurement.
  // Snapshot BEFORE the subprocess exists at all, so the after_start delta
  // below is attributable to this one worker (see areaWorkerTelemetry.ts's
  // own doc comment for the single-active-worker caveat this relies on).
  const areaTelemetryRunId = newAreaRunId();
  recordBeforeAreaStart(areaTelemetryRunId, options.areaLabel);

  const child = spawn(PYTHON_CMD, ["service.py"], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const spawnMs = hrElapsedMs();

  child.on("error", (err) => {
    console.warn(`[scraper-bridge] child process error (PID: ${child.pid})`, err);
  });
  child.stdin.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge] stdin error (PID: ${child.pid})`, err);
    }
  });
  child.stdout.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge] stdout error (PID: ${child.pid})`, err);
    }
  });
  child.stderr.on("error", (err: any) => {
    if (err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge] stderr error (PID: ${child.pid})`, err);
    }
  });

  // LIFECYCLE FIX: the ONE authoritative listener for this child's exit —
  // established synchronously, in the same tick as spawn(), before any
  // `await` below can yield to the event loop. Every other place in this
  // function that needs to know when the child exited (graceful shutdown's
  // wait-for-exit, and the final await at the end of this function) reads
  // from this same promise instead of registering its own `"close"`
  // listener. See watchChildClose()'s doc comment for the race this closes.
  const childClosed = watchChildClose(child);
  let abortRequested = false;
  // Register synchronously with the request runtime.  A terminal request can
  // therefore stop every child it owns, rather than only the generator whose
  // caller happened to observe cancellation first.
  const unregisterRequestProcess = registerRequestEngineProcess(
    options.requestId,
    child,
    () => {
      abortRequested = true;
      // LIFECYCLE FIX (Bug 1): terminateRequest() sets the request's
      // terminalReason BEFORE invoking this stop callback (see
      // requestLifecycle.ts), so it's already readable here — thread it
      // through to Python via the stop-reason file instead of leaving it
      // unspecified.
      const reason = options.requestId ? getRequestTerminalReason(options.requestId) : undefined;
      void gracefulKillProcessTree(child, childClosed, env.SCRAPER_GRACEFUL_SHUTDOWN_MS, reason);
    },
  );

  // Phase 7 observability: track active subprocess count (best-effort, non-blocking).
  workerMetrics.browserLaunches += 1;
  workerMetrics.activeBrowsers += 1;

  let firstLineMs: number | null = null;
  let firstLeadMs: number | null = null;

  const onAbort = () => {
    abortRequested = true;
    console.log(`[scraper-bridge] Abort signal triggered for PID: ${child.pid}`);
    // LIFECYCLE FIX (Bug 1): prefer the signal's own reason (callers pass
    // e.g. "TARGET_REACHED"/"USER_CANCELLED" to `abortController.abort(...)`
    // — see requestLifecycle.ts/discoverJob.ts), falling back to whatever
    // the request runtime already recorded.
    const reason =
      (signal?.reason as string | undefined) ??
      (options.requestId ? getRequestTerminalReason(options.requestId) : undefined);
    void gracefulKillProcessTree(child, childClosed, env.SCRAPER_GRACEFUL_SHUTDOWN_MS, reason);
  };
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();

  // LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase):
  // see SCRAPER_SUBPROCESS_INACTIVITY_MS / SCRAPER_SUBPROCESS_MAX_MS in
  // src/config/env.ts for the full rationale. Two independent timers,
  // both graceful (SIGTERM-first, same as before) so service.py's own
  // cleanup — browser/context/page close, profiler report, the __done__
  // sentinel — still gets a chance to run before any hard kill:
  //
  //   inactivityTimer — reset every time a genuine protocol line arrives
  //     (a parsed lead or the __done__ sentinel — see the
  //     `resetInactivityTimer()` call below, right after a line parses
  //     successfully). Fires if the subprocess goes quiet at the protocol
  //     level for too long, regardless of how much stderr chatter it
  //     produces in the meantime.
  //   absoluteTimer — never reset. The last-resort ceiling for a process
  //     that keeps reporting *something* forever without ever actually
  //     finishing.
  //
  // `timedOut`/`timedOutReason` are shared between both so the eventual
  // error message (if the run never recovers) says which one fired.
  let timedOut = false;
  let timedOutReason: "inactivity" | "ceiling" | null = null;

  const fireWatchdog = (reason: "inactivity" | "ceiling") => {
    if (timedOut) return; // already firing/fired — don't double-log or double-kill
    timedOut = true;
    timedOutReason = reason;
    const label =
      reason === "inactivity"
        ? `no protocol progress for SCRAPER_SUBPROCESS_INACTIVITY_MS=${env.SCRAPER_SUBPROCESS_INACTIVITY_MS}ms`
        : `absolute safety ceiling SCRAPER_SUBPROCESS_MAX_MS=${env.SCRAPER_SUBPROCESS_MAX_MS}ms reached`;
    console.warn(`[scraper-bridge] watchdog firing (${label}) (PID: ${child.pid}) — requesting graceful termination`);
    // LIFECYCLE FIX (Bug 1): the watchdog is always its own authoritative
    // reason — thread it through explicitly rather than leaving Python to
    // fall back to reason=None.
    void gracefulKillProcessTree(child, childClosed, env.SCRAPER_GRACEFUL_SHUTDOWN_MS, "WATCHDOG_TIMEOUT");
  };

  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => fireWatchdog("inactivity"), env.SCRAPER_SUBPROCESS_INACTIVITY_MS);
    inactivityTimer.unref?.();
  };
  resetInactivityTimer(); // starts ticking from spawn — a process that never emits a first line is still caught

  const absoluteTimer = setTimeout(() => fireWatchdog("ceiling"), env.SCRAPER_SUBPROCESS_MAX_MS);
  absoluteTimer.unref?.();

  try {
    child.stdin.write(JSON.stringify(params), (err) => {
      if (err && (err as any).code !== "EPIPE" && (err as any).code !== "ERR_STREAM_DESTROYED") {
        console.warn(`[scraper-bridge] stdin write callback error (PID: ${child.pid})`, err);
      }
    });
    child.stdin.end();
  } catch (writeErr: any) {
    if (writeErr?.code !== "EPIPE" && writeErr?.code !== "ERR_STREAM_DESTROYED") {
      console.warn(`[scraper-bridge] stdin write error (PID: ${child.pid})`, writeErr);
    }
  }

  child.stderr.on("data", (chunk) => {
    // The engine logs verbosely to stderr via its own logger (get_logger) —
    // surface it as debug output rather than treating it as failure; only
    // a non-zero exit code is treated as an actual error, below.
    // Deliberately does NOT reset the inactivity timer — see this
    // function's watchdog comment above: stderr volume is not evidence of
    // protocol-level forward progress.
    const line = chunk.toString();
    console.debug(`[scraper-bridge] ${line.trimEnd()}`);
    // Phase 7: detect crash patterns in stderr output (best-effort).
    if (/crash|chromium|oom|killed|sigkill|playwright.*error/i.test(line)) {
      workerMetrics.browserCrashes += 1;
    }
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let readError: unknown = null;
  // SAWDONE BUG FIX: `sawDone` used to be a plain `let` set to `true`
  // exactly once. That already made "true -> false" structurally
  // impossible within a single call — so a log line showing Python's own
  // `__done__ success=true` immediately followed by this SAME process
  // reporting `sawDone=false` was never `sawDone` itself flipping back;
  // it was one of two real gaps this fix closes:
  //
  //  1. NO PID ON THE __done__ log LINE — see the `[scraper-bridge]
  //     received __done__ ...` console.log below, which (unlike almost
  //     every other lifecycle line in this file) never included
  //     `(PID: ${child.pid})`. Under the Google Maps area worker pool
  //     (Worker Pools B), several Python children run concurrently for the
  //     SAME request, and Railway interleaves their stdout/stderr into one
  //     combined stream — with no PID on this specific line there was no
  //     way to tell "this __done__" apart from "that later sawDone=false"
  //     belonging to a DIFFERENT sibling child. Fixed below by adding
  //     `(PID: ${child.pid})` to that line, matching every other lifecycle
  //     log line in this file.
  //  2. NO STRUCTURAL GUARANTEE against a future edit accidentally
  //     resetting or shadowing this flag (e.g. a second `let sawDone`
  //     introduced in a nested scope, or a well-intentioned "reset per
  //     retry" edit). `markDone()`/`isDone()` below make "can never become
  //     false once true" an enforced invariant instead of an implicit one
  //     — flipping it back throws immediately in dev/test instead of
  //     silently producing exactly the symptom this bug report describes.
  let __sawDone = false;
  /** Sets the flag. Structurally cannot un-set it — there is no setter for `false`. */
  const markDone = () => {
    __sawDone = true;
  };
  // `sawDone` reads exactly as it did before this fix everywhere below —
  // only assignment (`sawDone = true`) is replaced with `markDone()`.
  const sawDone = () => __sawDone;

  // LIFECYCLE FIX: delivery accounting at the bridge transport boundary —
  // see this phase's "ADD DELIVERY ACCOUNTING" requirement.
  //   bridgeReceived  — every stdout line that parsed as a real lead
  //                      (i.e. reached this process from Python at all).
  //   bridgeForwarded — every lead the consumer (the `for await` on the
  //                      other end of this generator) actually resumed
  //                      past — i.e. was hand off successfully, not lost
  //                      to the consumer throwing/breaking mid-yield.
  // `parsed.delivered` on the __done__ sentinel is Python's own
  // python_yielded count — logged alongside these at teardown below so a
  // mismatch anywhere in the chain is visible in one place instead of
  // requiring cross-referencing separate log lines.
  let bridgeReceived = 0;
  let bridgeForwarded = 0;
  // PHASE 3C-1 STEP 2: first-occurrence ms-since-spawn per "stage:event"
  // progress line — see EngineDoneInfo.progressMarks's own doc comment.
  const progressMarks: Record<string, number> = {};

  const lineIterator = (async function* () {
    for await (const line of rl) {
      if (!line.trim()) continue;
      yield line;
    }
    // rl's for-await loop only ends when child.stdout itself closes.
    console.log(`[scraper-bridge] stdout closed (PID: ${child.pid}, sawDone=${sawDone()})`);
  })();

  try {
    for await (const line of lineIterator) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        // Phase S1: this is a genuine gap this phase cannot fully close —
        // if the engine ever emits an unparseable line for a real lead
        // (encoding issue, truncated write), that business disappears here,
        // before any job-level tracer (discoverJob.ts / poolExpandJob.ts)
        // ever gets a chance to call tracer.receive() for it. Best-effort
        // pull its pipeline id out of the raw text so the loss is at least
        // attributable to a specific business instead of anonymous.
        const idMatch = line.match(/"_pipeline_id"\s*:\s*"(#\d+)"/);
        console.error(
          `[scraper-bridge] non-JSON line from engine, skipping${idMatch ? ` (pipeline id ${idMatch[1]} — LOST BEFORE REACHING JOB-LEVEL TRACER)` : ""}: ${line.slice(0, 200)}`,
        );
        continue;
      }

      // LIFECYCLE FIX: any line that parsed as real protocol JSON — lead
      // or __done__ — counts as forward progress. Reset the inactivity
      // timer here, once, ahead of the lead/__done__ branch below, so
      // both cases benefit identically.
      resetInactivityTimer();

      // PART C (Phase 2B — watchdog progress protocol): a "progress"
      // line is real protocol-level forward progress too (that's why the
      // resetInactivityTimer() call above already covers it — nothing
      // more is needed there), but it is NOT a lead and must never be
      // yielded to the consumer or counted toward bridgeReceived/
      // firstLeadMs. This is the smallest possible extension of the
      // existing JSONL protocol: one more recognized shape on the same
      // stdout stream, distinguished purely by `type === "progress"`,
      // stdout/stderr separation unchanged (see service.py's `_on_progress`
      // for the producing side).
      if (parsed.type === "progress") {
        console.debug(
          `[scraper-bridge] progress stage=${parsed.stage} event=${parsed.event} item=${parsed.item_id ?? "n/a"}`,
        );
        // PHASE 3C-1 STEP 2: record first occurrence only — later repeats
        // of the same stage:event (e.g. "round_scanned" on every scroll
        // round) must not overwrite the meaningful first timestamp with a
        // later one. Deliberately not persisted per-anchor/per-round
        // beyond this single first-seen ms value, so this cannot grow
        // into per-anchor log spam (Step 2's own explicit constraint).
        const key = `${parsed.stage ?? "unknown"}:${parsed.event ?? "unknown"}`;
        if (!(key in progressMarks)) progressMarks[key] = hrElapsedMs();
        // PHASE 25: unlike progressMarks above (first-occurrence only,
        // read once at __done__), this fires for every progress line, live,
        // so a caller's own idle-activity clock always sees the LATEST
        // occurrence as it happens — not just the first, and not delayed
        // until the subprocess finishes.
        options.onProgress?.({
          stage: typeof parsed.stage === "string" ? parsed.stage : "unknown",
          event: typeof parsed.event === "string" ? parsed.event : "unknown",
          itemId: typeof parsed.item_id === "string" ? parsed.item_id : undefined,
          // PHASE 5B-2 — additive fields, absent on older engine builds.
          pipelineId: typeof parsed.pipeline_id === "string" ? parsed.pipeline_id : undefined,
          terminal: typeof parsed.terminal === "boolean" ? parsed.terminal : false,
          deadLettered: typeof parsed.dead_lettered === "boolean" ? parsed.dead_lettered : false,
          terminalReason: typeof parsed.terminal_reason === "string" ? parsed.terminal_reason : undefined,
        });
        continue;
      }

      if (parsed.__done__) {
        markDone();
        const perfPayload = parsed.__perf__ as Record<string, unknown> | undefined;
        // ROOT CAUSE FIX (Part 8): `success` defaults to true when absent
        // (an engine build without this field never fails this way, same
        // as before this fix existed) — but when the engine explicitly
        // reports `success: false`, `exhausted` is never trusted, matching
        // what service.py's _main_cli now guarantees on its side
        // (`exhausted` is always written as `false` alongside a failure).
        const rawSuccess = parsed.success === undefined ? true : Boolean(parsed.success);
        const rawFailureReason = rawSuccess ? undefined : (parsed.failure_reason as EngineDiscoveryFailureReason | undefined);
        const rawFailureDetail = rawSuccess ? undefined : (parsed.failure_detail as string | undefined);
        // LIFECYCLE FIX: additive field — see EngineDoneInfo.targetReached.
        const rawTargetReached =
          parsed.target_reached === undefined ? undefined : Boolean(parsed.target_reached);
        // LIFECYCLE FIX (CONSUMER_STOPPED semantics — FINAL SHUTDOWN
        // LATENCY + CONSUMER_STOPPED FIX): service.py now writes this
        // explicit string (see its own termination_reason derivation)
        // rather than leaving Node to re-derive "was this exhaustion or a
        // requested early stop" purely from success/targetReached, which
        // cannot tell the two apart on their own — both look like
        // `success && !targetReached`.
        const rawTerminationReason = parsed.termination_reason as string | undefined;

        const requestTerminalReason = options.requestId ? getRequestTerminalReason(options.requestId) : undefined;
        const isParentTargetReached =
          requestTerminalReason === "TARGET_REACHED" || signal?.reason === "TARGET_REACHED";

        // LIFECYCLE FIX (TARGET_REACHED child-engine status semantics):
        // When the parent discovery request has already reached its authoritative
        // target and intentionally terminates the child engine via SIGTERM,
        // the child cancellation is NOT an engine failure. It must be classified
        // as a successful target-reached early stop.
        const isTargetReachedEarlyStop =
          !timedOut &&
          isParentTargetReached &&
          ((!rawSuccess && rawFailureReason === "CANCELLED") || !rawTargetReached);

        const success = isTargetReachedEarlyStop ? true : rawSuccess;
        const targetReached = isTargetReachedEarlyStop ? true : rawTargetReached;
        const failureReason = isTargetReachedEarlyStop ? undefined : rawFailureReason;
        const failureDetail = isTargetReachedEarlyStop ? undefined : rawFailureDetail;

        console.log(
          // SAWDONE BUG FIX: PID added here — see this file's `sawDone`
          // doc comment above for why its absence was the real cause of
          // "Python __done__ success=true, Node sawDone=false" appearing
          // to describe one process when they were two different PIDs
          // interleaved by concurrent area workers.
          `[scraper-bridge] received __done__ (PID: ${child.pid}) — delivered=${parsed.delivered} ` +
            `exhausted=${parsed.exhausted} success=${success} targetReached=${targetReached ?? "n/a"} ` +
            `${!success ? `failureReason=${failureReason} ` : ""}` +
            `spawnMs=${spawnMs.toFixed(0)} firstLineMs=${firstLineMs?.toFixed(0) ?? "n/a"} firstLeadMs=${firstLeadMs?.toFixed(0) ?? "n/a"}`,
        );
        if (!success) {
          console.warn(
            `[scraper-bridge] discovery FAILED (not exhausted) — reason=${failureReason} detail=${failureDetail ?? "n/a"}`,
          );
        } else if (isTargetReachedEarlyStop) {
          console.log(
            `[scraper-bridge] child engine stopped early: TARGET_REACHED (parent target satisfied)`,
          );
        }
        // LIFECYCLE FIX: reconciliation at the bridge transport boundary —
        // pythonYielded is service.py's own count (what it put on the
        // wire); bridgeReceived/bridgeForwarded are what THIS process
        // actually saw/handed off. All three should match on a clean run;
        // any gap here pinpoints whether loss happened in the pipe
        // (pythonYielded > bridgeReceived — shouldn't be possible short of
        // a truncated/non-JSON line, already logged above) or in the
        // consumer (bridgeReceived > bridgeForwarded — the `for await`
        // stopped resuming this generator, e.g. `break`/an uncaught throw
        // downstream).
        const pythonYielded = Number(parsed.delivered ?? 0);
        console.log(
          `[scraper-bridge] delivery accounting — pythonYielded=${pythonYielded} ` +
            `bridgeReceived=${bridgeReceived} bridgeForwarded=${bridgeForwarded}` +
            `${bridgeReceived !== pythonYielded ? " ⚠️ pythonYielded/bridgeReceived MISMATCH" : ""}` +
            `${bridgeForwarded !== bridgeReceived ? " ⚠️ bridgeReceived/bridgeForwarded MISMATCH (consumer stopped early)" : ""}`,
        );
        // PART D: see EngineDoneInfo.terminationReason's own doc comment
        // for the full derivation table this mirrors exactly.
        //
        // LIFECYCLE FIX (CONSUMER_STOPPED semantics): a plain consumer-
        // stopped-early success (area rotation / batch quota satisfied)
        // must be classified as SUCCESS_CONSUMER_STOPPED, not
        // SUCCESS_EXHAUSTED — service.py's own `rawTerminationReason`
        // already carries that distinction (see its termination_reason
        // derivation), so it's trusted here rather than re-derived.
        const terminationReason: EngineDoneInfo["terminationReason"] = success
          ? (targetReached
              ? "SUCCESS_TARGET_REACHED"
              : rawTerminationReason === "SUCCESS_CONSUMER_STOPPED"
                ? "SUCCESS_CONSUMER_STOPPED"
                : "SUCCESS_EXHAUSTED")
          : failureReason === "CANCELLED"
            ? (timedOut ? "WATCHDOG_TIMEOUT" : "CANCELLED")
            : "FAILURE";
        console.log(`[scraper-bridge] terminationReason=${terminationReason}`);
        onDone?.({
          delivered: pythonYielded,
          requested: Number(parsed.requested ?? 0),
          exhausted: success ? (isTargetReachedEarlyStop ? false : Boolean(parsed.exhausted)) : false,
          success,
          targetReached,
          failureReason,
          failureDetail,
          terminationReason,
          perf: perfPayload,
          bridgeTimings: { spawnMs, firstLineMs, firstLeadMs },
          progressMarks,
        });
        continue;
      }

      // Phase 2: record first-line and first-lead timestamps
      if (firstLineMs === null) firstLineMs = hrElapsedMs();
      if (firstLeadMs === null) {
        firstLeadMs = hrElapsedMs();
        // PHASE 6B — this is the earliest observable point the browser is
        // fully initialized AND the engine has produced a real result
        // (see areaWorkerTelemetry.ts's own doc comment on why this proxy
        // is used instead of a dedicated "browser ready" event).
        recordAfterAreaStart(areaTelemetryRunId, options.areaLabel);
      }

      bridgeReceived += 1;
      yield parsed as EngineLead;
      // LIFECYCLE FIX: only counted once control returns here, i.e. the
      // consumer actually resumed this generator after receiving the
      // lead — see bridgeReceived/bridgeForwarded's declaration above.
      bridgeForwarded += 1;
    }
  } catch (err) {
    readError = err;
    throw err;
  } finally {
    rl.close();
    if (inactivityTimer) clearTimeout(inactivityTimer);
    clearTimeout(absoluteTimer);
    signal?.removeEventListener("abort", onAbort);
    // PROCESS REGISTRY EXPLOSION FIX: captured ONCE, here, BEFORE
    // unregisterRequestProcess() below removes this child from the
    // request's runtime. Every downstream check in this `finally` block
    // (the sawDone-fallback synthesis and the final exit-code check) used
    // to call getRequestTerminalReason(options.requestId) fresh, AFTER
    // this process had already unregistered — which only kept working
    // because requestLifecycle.ts used to never delete a terminal runtime
    // entry (a deliberate leak — see that file's own doc comment for the
    // fix). Now that a terminal runtime is reclaimed once genuinely idle,
    // this process must read its own request's terminal reason before it
    // removes itself from that runtime's bookkeeping, not after.
    const terminalReasonAtExit = options.requestId ? getRequestTerminalReason(options.requestId) : undefined;
    unregisterRequestProcess();
    // LIFECYCLE FIX (Bug 2 — the real bug behind rotation/false-FAILED):
    // this cleanup path fires whenever the child is still alive at the
    // moment this generator itself is torn down. That happens for two
    // structurally different reasons, and conflating them was the root
    // cause: a genuine abort (watchdog / terminateRequest / AbortSignal —
    // all of which already set `abortRequested = true` above, at their own
    // call sites) OR — far more commonly — the *consumer* of this
    // generator (the `for await` on the other end) simply stopped
    // iterating early: a plain `break`, e.g. area rotation hitting its
    // streaming batch quota, or a caller that asked for more leads than it
    // ended up needing. That second case is NOT an abort — the engine
    // isn't misbehaving, it's still mid-stream — and must never be
    // classified as CANCELLED. `consumerStoppedEarly` is the new, separate
    // flag for exactly that case; `abortRequested` now means ONLY a
    // genuine request-level abort, never this generic early-break path.
    let consumerStoppedEarly = false;
    if (child.exitCode === null && child.signalCode === null) {
      if (!abortRequested) {
        consumerStoppedEarly = true;
      }
      console.log(
        `[scraper-bridge] Generator exited or break occurred early. Cleaning up PID: ${child.pid} ` +
          `(abortRequested=${abortRequested}, consumerStoppedEarly=${consumerStoppedEarly})`,
      );
      // LIFECYCLE FIX (Bug 1): thread the real reason through so Python
      // never logs reason=unspecified. Preference order: an already-known
      // request-terminal reason (TARGET_REACHED/USER_CANCELLED/etc.) > the
      // AbortSignal's own reason > the watchdog, if that's what fired > a
      // descriptive fallback for the plain "consumer moved on" case, purely
      // for Python-side log clarity — Node does not rely on Python's
      // response to this specific reason (see the __done__-missing
      // synthesis below, which this early-stop path structurally always
      // hits: the child's eventual __done__, sent only after this SIGTERM,
      // arrives after this generator has already torn down its stdout
      // reader).
      const stopReason =
        terminalReasonAtExit ??
        (signal?.reason as string | undefined) ??
        (timedOut ? "WATCHDOG_TIMEOUT" : "CONSUMER_STOPPED");
      await gracefulKillProcessTree(child, childClosed, env.SCRAPER_GRACEFUL_SHUTDOWN_MS, stopReason);
    }

    // LIFECYCLE FIX: read from the single shared exit promise created right
    // after spawn(), rather than registering a fresh `"close"` listener here.
    // By this point the child may already have closed (e.g. it exited well
    // before the read loop above finished, or gracefulKillProcessTree() just
    // resolved a moment ago) — `childClosed` still resolves correctly in
    // every case because it was attached before the event could possibly
    // have fired, not after.
    const { code: exitCode, signal: closeSignal } = await childClosed;

    // PHASE 6B — the child has now actually exited (browser/Chromium tree
    // torn down, no longer holding any of its PIDs) — this is the
    // after_cleanup sample. If the browser never got far enough to be
    // "fully initialized" (recordAfterAreaStart() never fired — e.g. an
    // early crash/timeout), this is called anyway so activeRuns/
    // startedSnapshots bookkeeping for this run doesn't leak.
    recordAfterAreaCleanup(areaTelemetryRunId, options.areaLabel);

    // Phase 7 observability: decrement active browsers counter on exit.
    workerMetrics.activeBrowsers = Math.max(0, workerMetrics.activeBrowsers - 1);
    if (exitCode !== 0 && exitCode !== null) {
      workerMetrics.subprocessRestarts += 1;
    }

    console.log(
      `[scraper-bridge] process exited — PID: ${child.pid}, exitCode=${exitCode}, closeSignal=${closeSignal ?? "none"}, ` +
        `sawDone=${sawDone()}, timedOut=${timedOut}${timedOutReason ? ` (${timedOutReason})` : ""}`,
    );
    if (!sawDone()) {
      // Explicit flag for the exact gap this audit called out: the process
      // ended (for whatever reason) without ever emitting the __done__
      // sentinel — synthesize onDone from bridge/request lifecycle state.
      console.warn(
        `[scraper-bridge] __done__ was NEVER received before process exit (PID: ${child.pid}, exitCode=${exitCode}, closeSignal=${closeSignal ?? "none"}) — synthesizing onDone from bridge state`,
      );
      const isParentTargetReached =
        terminalReasonAtExit === "TARGET_REACHED" || signal?.reason === "TARGET_REACHED";
      // LIFECYCLE FIX (Bug 2): a GENUINE user/request-level cancellation —
      // never conflated with the generic "consumer stopped early" path
      // below. `abortRequested` here only ever becomes true via a real
      // abort (terminateRequest's stop callback, the AbortSignal listener,
      // or the watchdog) — see those call sites above — so it's safe to
      // trust directly again now that the early-break cleanup path no
      // longer reuses this same flag.
      const isRealAbort =
        terminalReasonAtExit === "USER_CANCELLED" || signal?.reason === "USER_CANCELLED" || abortRequested;

      // A plain consumer-stopped-early outcome (area rotation, batch quota
      // satisfied) is only a genuine SUCCESS when nothing more
      // authoritative explains the stop — a real abort, the watchdog, or
      // the parent's target already being reached always takes priority.
      const isPlainConsumerStop =
        consumerStoppedEarly && !timedOut && !isParentTargetReached && !isRealAbort;

      const success = !timedOut && (isParentTargetReached || isPlainConsumerStop);
      const targetReached = isParentTargetReached;
      const failureReason: EngineDiscoveryFailureReason | undefined = success
        ? undefined
        : (timedOut || isRealAbort)
          ? "CANCELLED"
          : "SCRAPER_ERROR";
      const failureDetail = success
        ? undefined
        : timedOut
          ? `Process timed out (${timedOutReason}) before reporting __done__`
          : isRealAbort
            ? "Process aborted before reporting __done__"
            : `Process exited with code ${exitCode} before reporting __done__`;
      const terminationReason: EngineDoneInfo["terminationReason"] = success
        ? (isParentTargetReached ? "SUCCESS_TARGET_REACHED" : "SUCCESS_CONSUMER_STOPPED")
        : failureReason === "CANCELLED"
          ? (timedOut ? "WATCHDOG_TIMEOUT" : "CANCELLED")
          : "FAILURE";

      onDone?.({
        delivered: bridgeForwarded,
        requested: Number(params.deliver_target ?? params.max_results ?? 0),
        exhausted: false,
        success,
        targetReached,
        failureReason,
        failureDetail,
        terminationReason,
        bridgeTimings: { spawnMs, firstLineMs, firstLeadMs },
        progressMarks,
      });
    }
    // LIFECYCLE FIX (completion semantics): a watchdog firing no longer
    // unconditionally throws. If the subprocess still managed to report
    // __done__ (service.py's own cooperative-shutdown fix — see
    // COOPERATIVE_SHUTDOWN_GRACE_S there — now makes this the common case
    // for a watchdog-triggered stop, not the exception), the protocol
    // already told the caller everything it needs via `onDone` above
    // (success=false, failureReason="CANCELLED", plus every lead already
    // yielded through this same generator) — throwing here on top of that
    // would crash a caller's `for await` loop (e.g. discoverJob.ts) AFTER
    // it already received a fully consistent, correctly-accounted result,
    // which is exactly the "invalid" completion-semantics gap this phase
    // exists to close. Only throw when the protocol genuinely never
    // completed — i.e. the caller has no other way to learn what happened.
    if (timedOut && !sawDone()) {
      const label =
        timedOutReason === "inactivity"
          ? `inactivity timeout (SCRAPER_SUBPROCESS_INACTIVITY_MS=${env.SCRAPER_SUBPROCESS_INACTIVITY_MS}ms)`
          : `absolute safety ceiling (SCRAPER_SUBPROCESS_MAX_MS=${env.SCRAPER_SUBPROCESS_MAX_MS}ms)`;
      throw new Error(
        `scraper engine subprocess exceeded its ${label} and was terminated before it could report completion`,
      );
    }
    const isParentTargetReached =
      terminalReasonAtExit === "TARGET_REACHED" || signal?.reason === "TARGET_REACHED";
    // LIFECYCLE FIX (Bug 2): a plain consumer-stopped-early exit (rotation)
    // must not throw here either — same reasoning as the `timedOut` guard
    // above, now also guarded against being masked by an unrelated
    // non-zero exit code from the SIGTERM/SIGKILL this cleanup path itself
    // just sent.
    if (
      exitCode !== 0 &&
      !readError &&
      !sawDone() &&
      !abortRequested &&
      !isParentTargetReached &&
      !consumerStoppedEarly
    ) {
      throw new Error(`scraper engine exited with code ${exitCode}`);
    }
  }
}
/**
 * Engine 2.0 Scoring result — profession-level opportunity scores and
 * business health metric computed by OpportunityScoringService +
 * ScoringWorker._business_health_component.
 */
export type EngineScoreResult = {
  business_id: string;
  is_disqualified: boolean;
  health_score: number;
  universal_breakdown: Record<string, number>;
  profession_scores: Record<
    string,
    { score: number; breakdown: Record<string, number>; summary: string; reasons: string[] }
  >;
};

/**
 * Engine 2.0 Qualification result — canonical rule evaluation for a single
 * Opportunity produced by OpportunityQualificationService.
 */
export type EngineQualifyResult = {
  opportunity_id: string;
  status: "QUALIFIED" | "NOT_QUALIFIED";
  qualified: boolean;
  passed_rule_ids: string[];
  failed_rule_ids: string[];
};

/**
 * Engine 2.0 Prioritization result — continuous priority score for a single
 * Opportunity produced by OpportunityPrioritizationService, combining its
 * Qualification and Scoring evaluations with a recency-decay policy.
 */
export type EnginePrioritizeResult = {
  opportunity_id: string;
  priority_score: number;
  score_contribution: number;
  recency_contribution: number;
  is_eligible: boolean;
  qualification_status: "QUALIFIED" | "NOT_QUALIFIED";
  overall_score: number;
};

/**
 * Interaction record passed to runEngineCRM's payload.
 */
export type CRMInteractionRecord = {
  timestamp_iso: string;
  interaction_type: string;
  outcome_type?: string;
  is_opt_out?: boolean;
  is_conversion?: boolean;
  is_positive?: boolean;
};

/**
 * Engine 2.0 CRM Intelligence result — relationship lifecycle stage, health,
 * and contact guardrail decision produced by CRMIntelligenceService.
 */
export type EngineCRMResult = {
  stage: "UNTOUCHED" | "IN_ATTEMPT" | "ENGAGED" | "NURTURING" | "CONVERTED" | "DORMANT" | "OPTED_OUT";
  health: "PRISTINE" | "RESPONSIVE" | "COOLING_OFF" | "FATIGUED" | "TERMINATED";
  guardrail: "ALLOWED" | "BLOCKED_COOLING_OFF" | "BLOCKED_FREQUENCY_CAP" | "BLOCKED_OPT_OUT" | "BLOCKED_CONVERTED";
  total_attempts: number;
  attempts_in_window: number;
  days_since_last_interaction: number | null;
  reason: string;
};

/**
 * Engine 2.0 Analytics result — pipeline funnel conversion rates computed
 * from raw snapshot counters supplied by Node.
 */
export type EngineAnalyticsResult = {
  total_discovered: number;
  total_qualified: number;
  total_contacted: number;
  total_won: number;
  qualification_rate_pct: number;
  contact_rate_pct: number;
  win_rate_pct: number;
  end_to_end_rate_pct: number;
};

/**
 * Engine 2.0 AI Coach context — structured intelligence payload that Node
 * transports verbatim to Claude/OpenAI. Engine reasons; Node transports.
 */
export type EngineAICoachResult = {
  business_context: Record<string, unknown>;
  scoring_context: Record<string, unknown>;
  relationship_context: EngineCRMResult | Record<string, unknown>;
  analytics_context: EngineAnalyticsResult | Record<string, unknown>;
  stalled_deals: unknown[];
};

/**
 * Generic helper: spawns `python service.py <mode>`, writes JSON payload to
 * stdin, collects stdout, parses and returns the result. Identical lifecycle
 * to runEngineVerify / runEngineEnrich.
 */
async function runEngineRPC<T>(mode: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  const child = spawn(PYTHON_CMD, ["service.py", mode], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const onAbort = () => {
    console.log(`[scraper-bridge:${mode}] Abort signal triggered for PID: ${child.pid}`);
    killProcessTree(child);
  };
  signal?.addEventListener("abort", onAbort);

  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      console.debug(`[scraper-bridge:${mode}] ${chunk.toString().trimEnd()}`);
    });

    const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
    if (exitCode !== 0) {
      throw new Error(`Engine 2.0 '${mode}' subprocess exited with code ${exitCode}. stdout: ${stdout.slice(0, 500)}`);
    }

    return JSON.parse(stdout) as T;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child);
    }
  }
}

/**
 * Delegates business scoring to Engine 2.0 (`service.py score`).
 * Computes profession opportunity scores + business health metric.
 * Node callers must NOT reimplement this logic.
 */
export async function runEngineScore(
  businessData: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<EngineScoreResult> {
  return runEngineRPC<EngineScoreResult>("score", businessData, signal);
}

/**
 * Delegates opportunity qualification to Engine 2.0 (`service.py qualify`).
 * Evaluates the canonical qualification rules for a single Opportunity.
 * Node callers must NOT reimplement this logic.
 */
export async function runEngineQualify(
  opportunityData: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<EngineQualifyResult> {
  return runEngineRPC<EngineQualifyResult>("qualify", opportunityData, signal);
}

/**
 * Delegates opportunity prioritization to Engine 2.0 (`service.py prioritize`).
 * Evaluates Qualification + Scoring internally, then computes a continuous
 * priority score via OpportunityPrioritizationService. Node callers must NOT
 * reimplement this logic.
 */
export async function runEnginePrioritize(
  opportunityData: Record<string, unknown>,
  policy?: {
    strategy?: "SCORE_DOMINANT" | "BALANCED" | "RECENCY_DOMINANT" | "CUSTOM_WEIGHTED";
    evaluation_at?: string;
    score_weight?: number;
    recency_weight?: number;
    recency_half_life_days?: number;
    require_qualification?: boolean;
  },
  signal?: AbortSignal,
): Promise<EnginePrioritizeResult> {
  const payload = policy ? { ...opportunityData, policy } : opportunityData;
  return runEngineRPC<EnginePrioritizeResult>("prioritize", payload, signal);
}

/**
 * Delegates CRM relationship evaluation to Engine 2.0 (`service.py crm`).
 * Computes relationship stage, health, and contact guardrail decision.
 * Node callers must NOT reimplement this logic.
 */
export async function runEngineCRM(
  payload: {
    workspace_id: string;
    business_id: string;
    current_timestamp_iso?: string;
    interaction_history?: CRMInteractionRecord[];
    policy?: {
      max_attempts_per_window?: number;
      window_days?: number;
      cooling_off_days?: number;
      dormancy_days?: number;
    };
  },
  signal?: AbortSignal,
): Promise<EngineCRMResult> {
  return runEngineRPC<EngineCRMResult>("crm", payload, signal);
}

/**
 * Delegates pipeline analytics computation to Engine 2.0 (`service.py analytics`).
 * Returns funnel conversion rates from raw pipeline snapshot counters.
 * Node callers must NOT reimplement this logic.
 */
export async function runEngineAnalytics(
  snapshot: {
    total_discovered?: number;
    total_qualified?: number;
    total_contacted?: number;
    total_won?: number;
  },
  signal?: AbortSignal,
): Promise<EngineAnalyticsResult> {
  return runEngineRPC<EngineAnalyticsResult>("analytics", snapshot, signal);
}

/**
 * Delegates AI coach context assembly to Engine 2.0 (`service.py ai_coach`).
 * Returns a structured intelligence payload that Node transports verbatim to
 * Claude/OpenAI — Engine reasons, Node transports.
 */
export async function runEngineAICoach(
  payload: {
    business?: Record<string, unknown>;
    crm?: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
    stalledDeals?: unknown[];
  },
  signal?: AbortSignal,
): Promise<EngineAICoachResult> {
  return runEngineRPC<EngineAICoachResult>("ai_coach", payload, signal);
}

/**
 * Engine 2.0 Workflow lifecycle status — mirrors workflow.models.WorkflowStatus.
 */
export type EngineWorkflowStatus =
  | "UNSTARTED"
  | "QUEUED"
  | "IN_PROGRESS"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/**
 * Engine 2.0 Workflow transition trigger — mirrors workflow.models.WorkflowEventType.
 */
export type EngineWorkflowEventType =
  | "INITIALIZE"
  | "QUEUE"
  | "START_EXECUTION"
  | "PAUSE"
  | "RESUME"
  | "FAIL"
  | "RETRY"
  | "COMPLETE"
  | "CANCEL";

export type EngineWorkflowState = {
  mission_id: string;
  opportunity_id: string;
  business_id: string;
  status: EngineWorkflowStatus;
};

/**
 * Result of `service.py workflow` with action="initialize" — the initial
 * UNSTARTED WorkflowState derived from a Mission.
 */
export type EngineWorkflowInitializeResult = {
  action: "initialize";
  state: EngineWorkflowState;
};

/**
 * Result of `service.py workflow` with action="transition" (the default) —
 * the outcome of evaluating a single (WorkflowState, WorkflowEvent) pair.
 */
export type EngineWorkflowTransitionResult = {
  action: "transition";
  success: boolean;
  previous_state: EngineWorkflowState;
  new_state: EngineWorkflowState;
  error_message: string | null;
};

export type EngineWorkflowResult = EngineWorkflowInitializeResult | EngineWorkflowTransitionResult;

/**
 * Delegates Workflow Engine initialization to Engine 2.0
 * (`service.py workflow`, action="initialize"). Builds a Mission from
 * `mission` and returns its initial UNSTARTED WorkflowState. Node callers
 * must NOT reimplement this logic.
 */
export async function runEngineWorkflowInitialize(
  mission: { opportunity_id: string; business_id: string; mission_type: string },
  signal?: AbortSignal,
): Promise<EngineWorkflowInitializeResult> {
  return runEngineRPC<EngineWorkflowInitializeResult>(
    "workflow",
    { action: "initialize", mission },
    signal,
  );
}

/**
 * Delegates a Workflow Engine state transition to Engine 2.0
 * (`service.py workflow`, action="transition" — the on-demand "Workflow
 * Transition" step of the intelligence chain). Node callers must NOT
 * reimplement this logic.
 */
export async function runEngineWorkflowTransition(
  state: EngineWorkflowState,
  event: { event_type: EngineWorkflowEventType; timestamp_iso?: string; reason?: string },
  signal?: AbortSignal,
): Promise<EngineWorkflowTransitionResult> {
  return runEngineRPC<EngineWorkflowTransitionResult>(
    "workflow",
    { action: "transition", state, event },
    signal,
  );
}
