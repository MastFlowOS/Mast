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
  db_path?: string;
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

  const onAbort = () => {
    console.log(`[scraper-bridge:enrich] Abort signal triggered for PID: ${child.pid}`);
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
  | "SCRAPER_ERROR";

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
  /** Present only when `success` is false. */
  failureReason?: EngineDiscoveryFailureReason;
  /** Present only when `success` is false — human-readable detail for logs. */
  failureDetail?: string;
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

  // ROOT CAUSE FIX (Part 9 — bounded subprocess lifecycle): see
  // SCRAPER_SUBPROCESS_MAX_MS in src/config/env.ts. Without this, a
  // discovery attempt that hangs inside the Python engine (stuck
  // navigation, a selector that never resolves, a wedged browser) had no
  // ceiling of its own — nothing here ever called killProcessTree() for
  // it short of the caller's own AbortSignal (typically only wired to
  // user cancellation / quantity-reached, not a timeout) or the much
  // coarser whole-job stale-task sweep. Graceful (SIGTERM-first) so
  // run_query()'s own cleanup — browser/context/page close, profiler
  // report — still gets a chance to run before the hard kill, same as
  // every other planned shutdown path in this file.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    console.warn(
      `[scraper-bridge] subprocess exceeded SCRAPER_SUBPROCESS_MAX_MS=` +
        `${env.SCRAPER_SUBPROCESS_MAX_MS}ms (PID: ${child.pid}) — terminating`,
    );
    void gracefulKillProcessTree(child);
  }, env.SCRAPER_SUBPROCESS_MAX_MS);
  watchdog.unref?.();

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

      if (parsed.__done__) {
        sawDone = true;
        const perfPayload = parsed.__perf__ as Record<string, unknown> | undefined;
        // ROOT CAUSE FIX (Part 8): `success` defaults to true when absent
        // (an engine build without this field never fails this way, same
        // as before this fix existed) — but when the engine explicitly
        // reports `success: false`, `exhausted` is never trusted, matching
        // what service.py's _main_cli now guarantees on its side
        // (`exhausted` is always written as `false` alongside a failure).
        const success = parsed.success === undefined ? true : Boolean(parsed.success);
        const failureReason = success ? undefined : (parsed.failure_reason as EngineDiscoveryFailureReason | undefined);
        const failureDetail = success ? undefined : (parsed.failure_detail as string | undefined);
        console.log(
          `[scraper-bridge] received __done__ — delivered=${parsed.delivered} ` +
            `exhausted=${parsed.exhausted} success=${success} ` +
            `${!success ? `failureReason=${failureReason} ` : ""}` +
            `spawnMs=${spawnMs.toFixed(0)} firstLineMs=${firstLineMs?.toFixed(0) ?? "n/a"} firstLeadMs=${firstLeadMs?.toFixed(0) ?? "n/a"}`,
        );
        if (!success) {
          console.warn(
            `[scraper-bridge] discovery FAILED (not exhausted) — reason=${failureReason} detail=${failureDetail ?? "n/a"}`,
          );
        }
        onDone?.({
          delivered: Number(parsed.delivered ?? 0),
          requested: Number(parsed.requested ?? 0),
          exhausted: success ? Boolean(parsed.exhausted) : false,
          success,
          failureReason,
          failureDetail,
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
    clearTimeout(watchdog);
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
  if (timedOut) {
    // Meaningful, specific failure status (Part 9) rather than the generic
    // "exited with code N" below — a watchdog kill has a known, named
    // cause, not an arbitrary crash, and callers (discoverJob.ts et al.)
    // should be able to tell "this attempt hung" apart from "the process
    // crashed" or "Google blocked us" just from the error text.
    throw new Error(
      `scraper engine subprocess exceeded SCRAPER_SUBPROCESS_MAX_MS=${env.SCRAPER_SUBPROCESS_MAX_MS}ms and was terminated`,
    );
  }
  if (exitCode !== 0 && !readError) {
    throw new Error(`scraper engine exited with code ${exitCode}`);
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
