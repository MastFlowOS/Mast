import "dotenv/config";
import { z } from "zod";
import type { PlanId } from "../config/plans.js";


const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),

  // Supabase — same project the frontend already uses. The backend uses the
  // service-role key exclusively; it is never sent to the client.
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1), // used to verify user access tokens locally, no round trip per request

  // Postgres connection string for pg-boss (same Supabase Postgres instance).
  // Must be the SESSION pooler host (aws-0-<region>.pooler.supabase.com:5432)
  // — pg-boss needs LISTEN/NOTIFY and session-scoped prepared statements, so
  // it should NOT go through the transaction pooler (pgbouncer in
  // transaction mode, port 6543). It also must NOT be the "direct
  // connection" host (db.<project-ref>.supabase.co): on projects without
  // Supabase's paid IPv4 add-on that host is IPv6-only, and Railway has no
  // IPv6 egress, so it fails at TCP level with `connect ENETUNREACH`
  // before Postgres ever sees the connection. See src/lib/queue.ts for the
  // startup check that enforces this.
  DATABASE_URL: z.string().min(1),

  // Where the frontend is deployed, for CORS.
  ALLOWED_ORIGIN: z.string().url(),

  // Path to the Part 1 engine on disk (see scraper-bridge/README.md). The
  // worker fleet shells out to this as a subprocess in Phase 2 — the gateway
  // never calls it directly.
  SCRAPER_ENGINE_PATH: z.string().default("../mast-lead-engine"),

  // LIFECYCLE FIX (bridge delivery / watchdog / graceful shutdown phase —
  // supersedes the "ROOT CAUSE FIX (Engine 2.0 Part 9)" note this
  // replaces): a single fixed wall-clock ceiling was too blunt an
  // instrument — a live test proved a legitimately-progressing Playwright
  // discovery run (yielding real leads the whole time) got killed simply
  // because the clock ran out, not because anything was actually stuck.
  // The watchdog is now TWO independent timers:
  //
  //   SCRAPER_SUBPROCESS_INACTIVITY_MS — resets every time the subprocess
  //     reports genuine protocol progress (a parsed lead line, or the
  //     __done__ sentinel — see the `resetInactivityTimer()` call sites in
  //     runEngineQuery below). If NO progress arrives for this long, the
  //     subprocess is presumed genuinely stalled and graceful termination
  //     begins. Deliberately NOT reset by stderr output — the engine logs
  //     verbosely there for reasons unrelated to forward progress (see
  //     "Do NOT reset the inactivity timer for every random stderr log
  //     line" in this phase's spec), so a chatty-but-stuck process must
  //     still be caught.
  //
  //   SCRAPER_SUBPROCESS_MAX_MS — an absolute safety ceiling that never
  //     resets, for the pathological case of a process that keeps
  //     reporting *something* forever without ever finishing (a genuine
  //     runaway). Kept comfortably larger than the inactivity timeout so
  //     it only fires for a truly wedged/runaway subprocess, not a slow
  //     but honest one — raised well above the old 4-minute default,
  //     which was proven too short for real Playwright-driven Maps
  //     discovery (rate-limited, deliberately human-paced scrolling) plus
  //     the enrichment pipeline that follows it.
  SCRAPER_SUBPROCESS_INACTIVITY_MS: z.coerce.number().int().min(10_000).default(90_000),
  SCRAPER_SUBPROCESS_MAX_MS: z.coerce.number().int().min(30_000).default(20 * 60 * 1000),

  // LIFECYCLE FIX: grace period given to the child after SIGTERM before
  // escalating to SIGKILL (src/scraperBridge/pythonBridge.ts's
  // gracefulKillProcessTree). Raised from a flat 3s — service.py's own
  // cooperative shutdown (COOPERATIVE_SHUTDOWN_GRACE_S there) now gets up
  // to ~12s to wind down active discovery/enrichment work and still write
  // the __done__ sentinel before falling back to a forced cancellation;
  // this must stay comfortably above that so Python's own graceful path
  // has a real chance to finish first. Deliberately still far shorter
  // than either watchdog timer above — this only bounds how long we wait
  // for a process that has ALREADY been asked to stop.
  SCRAPER_GRACEFUL_SHUTDOWN_MS: z.coerce.number().int().min(1_000).default(15_000),

  // Worker-local concurrency. Horizontal scale is achieved by adding worker
  // services; these caps protect Maps and the browser in each service.
  DISCOVERY_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  ENRICHMENT_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  INTELLIGENCE_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  // Stale-task timeouts (milliseconds). A discovery_task or
  // business_processing_task that has been in 'running' state for longer
  // than the corresponding threshold — without an updated heartbeat — is
  // assumed to belong to a crashed worker and may be re-claimed. Set to a
  // value comfortably longer than the expected worst-case single-task
  // runtime so a slow-but-alive worker is not prematurely preempted.
  //   STALE_TASK_TIMEOUT_MS          : discovery_tasks (default 25 min)
  //   STALE_BUSINESS_TASK_TIMEOUT_MS : business_processing_tasks (default 5 min)
  // LIFECYCLE FIX: a discovery_task can now legitimately drive a single
  // runEngineQuery() subprocess for up to SCRAPER_SUBPROCESS_MAX_MS above
  // (20 min by default) before the bridge's own absolute ceiling would
  // even consider it wedged — this must stay comfortably above that or a
  // perfectly healthy, still-progressing subprocess risks being reclaimed
  // by a second worker out from under the first, mid-run. Raised from 8
  // min accordingly (was already shorter than the old, since-removed
  // 4-min-default reasoning implied once multiple retries/backoff are
  // considered; now explicit).
  STALE_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(25 * 60 * 1000),
  STALE_BUSINESS_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(5 * 60 * 1000),
  //   STALE_SCRAPE_JOB_TIMEOUT_MS    : scrape_jobs stuck 'streaming' (default 30 min)
  // AUDIT FIX (Verification Report, Finding 6): poolExpandJob had no
  // heartbeat/stale-reclaim mechanism at all — see migrations/020 and
  // jobs/staleScrapeJobSweep.ts. Longer than STALE_TASK_TIMEOUT_MS since a
  // poolExpand run can legitimately span multiple niches/countries/rounds.
  // LIFECYCLE FIX: raised from 10 min to stay above the raised
  // STALE_TASK_TIMEOUT_MS just above, for the same reason.
  STALE_SCRAPE_JOB_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(30 * 60 * 1000),

  // PHASE 5 — Configurable plan concurrency limits (Refinement 1).
  // JSON blob mapping PlanId → max browser-backed running tasks for that plan.
  // Takes precedence over the workerConcurrency defaults in config/plans.ts.
  // Changed at runtime (Railway env var) without a deploy; validated at startup.
  //
  // Example: PLAN_CONCURRENCY_OVERRIDES={"premium":12,"pro":6}
  // Invalid JSON or unknown plan keys cause the worker to exit with a clear
  // error rather than silently using wrong values.
  PLAN_CONCURRENCY_OVERRIDES: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return {} as Partial<Record<PlanId, number>>;
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PLAN_CONCURRENCY_OVERRIDES is not valid JSON" });
        return z.NEVER;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PLAN_CONCURRENCY_OVERRIDES must be a JSON object" });
        return z.NEVER;
      }
      const valid: Partial<Record<PlanId, number>> = {};
      const validPlanIds = new Set<string>(["free", "starter", "pro", "premium"]);
      for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (!validPlanIds.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `PLAN_CONCURRENCY_OVERRIDES: unknown plan id "${key}"` });
          return z.NEVER;
        }
        if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `PLAN_CONCURRENCY_OVERRIDES["${key}"] must be a positive integer` });
          return z.NEVER;
        }
        valid[key as PlanId] = val;
      }
      return valid;
    })
    .default("{}"),

  // PHASE 5 — Worker capacity advertisement (Refinement 4).
  // Conservative estimate of peak memory consumed by a single Playwright/
  // Chromium browser process with one page open.  Adjust when deploying to
  // a different container size to avoid OOM.  Combined with free memory at
  // startup to derive the effective worker concurrency ceiling.
  BROWSER_MEMORY_ESTIMATE_MB: z.coerce.number().int().min(50).default(350),

  // Memory to reserve for the Node process itself plus OS overhead, so the
  // capacity calculator doesn't allocate every last MB to browser slots.
  WORKER_MEMORY_RESERVE_MB: z.coerce.number().int().min(64).default(256),

  // GOOGLE MAPS AREA WORKER POOL (Worker Pools B) — how many concurrent
  // Google Maps area workers a SINGLE discovery task may fan out to for a
  // city that has a curated area list (src/lib/geo/cityAreas.ts). This is
  // deliberately Google-only and deliberately separate from
  // DISCOVERY_TASK_CONCURRENCY above, which bounds how many discovery_tasks
  // this worker process pulls at once — not how many browsers ONE task can
  // itself spawn.
  //
  // Conservative default of 1 (today's behavior — one browser per task,
  // unchanged) until deliberately raised. The B-0 audit found no existing
  // evidence in this codebase for a higher safe default, and the capacity
  // model (workerCapacity.ts's browserSlotPool) is what actually prevents
  // OOM once this is raised — the config ceiling alone is not a safety
  // mechanism, just an intent. Bounded at 16 as a sanity ceiling (raised
  // from 8 in Phase 6 so a resource-proven 100-lead tier is not clipped by
  // this config knob before it ever reaches the real, measured ceiling);
  // the real, resource-aware ceiling is enforced at runtime by
  // resourceCapacity.ts + browserSlotPool, not by this max().
  GOOGLE_MAPS_AREA_WORKERS: z.coerce.number().int().min(1).max(16).default(8),

  // PHASE 25 (was PHASE 12D) — HYBRID ADAPTIVE AREA STOPPING. Shared
  // "time since last PRODUCTIVE ACTIVITY" window used by
  // src/discovery/areaProductivity.ts's `evaluateAreaProductivity()` for
  // BOTH the pre-first-qualified and post-first-qualified windows (PHASE 25
  // unified what PHASE 12D ran as two separate clocks — see that module's
  // doc comment for the full writeup). "Productive activity" is broader
  // than "qualified lead" as of PHASE 25: candidate discovery/queueing and
  // delivery also count (see areaProductivity.ts's ProductiveEventType),
  // so this window is now a genuine STALL detector, not a "how long until
  // the next qualified lead" detector.
  //
  // The Phase 12C production audit observed first-qualified latency in the
  // ~56-85 SECOND range. This default (120s) is kept UNCHANGED from PHASE
  // 12D rather than tightened: PHASE 25's semantics are strictly more
  // permissive than PHASE 12D's for the SAME numeric value (an area now
  // survives on discovery/queueing activity alone, where PHASE 12D would
  // have required an actual qualified lead), so 120s remains at least as
  // conservative as before with no new false-stop risk. It is still a
  // CONSERVATIVE INITIAL ROLLOUT VALUE, not a proven optimum — tune down
  // as real production data accumulates; do not treat 120s as permanent.
  AREA_PRODUCTIVITY_IDLE_MS: z.coerce.number().int().min(10_000).default(120_000),

  // PHASE 25 — hard wall-clock ceiling on ONE area's total runtime,
  // independent of how much productive activity it keeps reporting (STEP 4
  // of the phase prompt: "a pathological provider cannot run forever").
  // This is a SEPARATE bound from AREA_PRODUCTIVITY_IDLE_MS above: an area
  // that never goes idle (keeps discovering/qualifying/delivering right up
  // to this ceiling) is stopped here regardless.
  //
  // Grounded in the same Coffee Shop benchmark audit the Phase 25 prompt
  // supplied: the slowest genuinely-productive area observed (Queens) was
  // still actively discovering at ~240s with 3 qualified leads when the
  // OLD (pre-Phase-25) logic killed it early. This default (600s / 10min)
  // gives that kind of steadily-productive area 2.5x the observed longest
  // legitimate runtime as headroom before the hard ceiling fires, while
  // still bounding a truly pathological (e.g. stuck-in-a-crash-recovery-
  // loop) provider to a fixed, finite worst case. CONSERVATIVE INITIAL
  // ROLLOUT VALUE — tune down once more production runtime data exists for
  // genuinely-productive long-tail areas.
  AREA_PRODUCTIVITY_MAX_RUNTIME_MS: z.coerce.number().int().min(60_000).default(600_000),

  // PHASE 30 — AREA YIELD / ROTATION OPTIMIZATION. Independent of the two
  // knobs above: an area that keeps discovering/queueing candidates never
  // trips AREA_PRODUCTIVITY_IDLE_MS (by design, since PHASE 25), which is
  // exactly the regression this phase fixes — a low-yield-but-busy area
  // could occupy one of only a handful of worker slots for minutes,
  // starving other queued areas (production regression: ~100 leads/6min →
  // ~53 leads/30min). See areaProductivity.ts's `classifyAreaYield`.
  //
  // Stage A gate (STEP 3's "early exploration window"): an area is never
  // yield-evaluated before BOTH this much time AND
  // AREA_YIELD_MIN_CANDIDATE_VOLUME candidates have accumulated — kept
  // deliberately shorter than AREA_PRODUCTIVITY_IDLE_MS (120s) so a
  // genuinely low-yield area can be rotated out well before it would ever
  // reach the idle/max-runtime ceilings, while still comfortably exceeding
  // the ~56-85s first-qualified latency the Phase 12C audit observed for
  // areas that DO qualify quickly. CONSERVATIVE INITIAL ROLLOUT VALUE.
  AREA_YIELD_MIN_ELAPSED_MS: z.coerce.number().int().min(10_000).default(90_000),

  // Stage A gate, volume half — see AREA_YIELD_MIN_ELAPSED_MS above. An
  // area with fewer than this many discovered+queued candidates is never
  // yield-evaluated, regardless of elapsed time (STEP 3: "do not stop an
  // area solely because qualified=0 if candidate volume is still low").
  AREA_YIELD_MIN_CANDIDATE_VOLUME: z.coerce.number().int().min(1).default(15),

  // Stage B: once evaluation is allowed, qualified-or-delivered / candidate
  // volume at or below this fraction is classified LOW_YIELD (the only
  // class that can stop an area — see evaluateAreaYieldStop). 0.05 means an
  // area that has produced 20+ candidates with at most 1 qualified/
  // delivered lead is treated as low yield.
  AREA_YIELD_LOW_MAX_RATE: z.coerce.number().min(0).max(1).default(0.05),

  // Stage B: ratio strictly above AREA_YIELD_LOW_MAX_RATE and at or below
  // this fraction is MARGINAL — kept alive, never stopped by the yield
  // classifier (STEP 3: "prefer a conservative two-stage model" /
  // marginal yield → keep temporarily). Must stay >= AREA_YIELD_LOW_MAX_RATE.
  AREA_YIELD_MARGINAL_MAX_RATE: z.coerce.number().min(0).max(1).default(0.15),

  // PHASE 32 — AREA SCAN-BUDGET OPTIMIZATION. Before this phase, every
  // concurrent area independently received `computeAskFor(streamTarget)`
  // (streamTarget * this same multiplier) as its own `max_results` scan
  // budget — for a normal target=100 request with 3 concurrent areas, that
  // meant ~400 raw Maps candidates PER area (up to ~1200 total), massively
  // over-scanning low-yield areas and holding scarce browser slots. This
  // multiplier now sizes a single SHARED global scan budget
  // (`computeGlobalScanBudget` in areaScanBudget.ts) that concurrent areas
  // draw slices from, instead of each replicating it independently.
  // UNCHANGED numeric default (4) from the old `computeAskFor` multiplier —
  // this phase only changes how the resulting budget is DISTRIBUTED across
  // concurrent areas, not the total intended scan volume for one
  // streamTarget's worth of work.
  AREA_SCAN_BUDGET_MULTIPLIER: z.coerce.number().min(1).default(4),

  // A single area's INITIAL slice of the shared global scan budget
  // (globalScanBudget / activeAreaCount) is never allowed to fall below
  // streamTarget * this factor, regardless of how many areas are
  // concurrently active — a lone/slow area must still receive a realistic
  // chance at finding streamTarget qualified leads in one pass. Default 1
  // (never below streamTarget itself) is the same implicit floor
  // `computeAskFor` always guaranteed before this phase (it never returned
  // less than streamTarget). CONSERVATIVE INITIAL ROLLOUT VALUE — see the
  // Phase 32 prompt's STEP 8 safety check; tune only once a benchmark shows
  // headroom.
  AREA_SCAN_BUDGET_MIN_FACTOR: z.coerce.number().min(0).default(1),

  // A single area's CUMULATIVE allocation (initial + all expansions) is
  // never allowed to exceed streamTarget * this factor. Default equals
  // AREA_SCAN_BUDGET_MULTIPLIER so that, even after unlimited expansion
  // grants, one area can never receive MORE than the old (pre-Phase-32)
  // per-area formula would have given it — this is what keeps a single
  // productive area from ever consuming the entire shared budget (STEP 5:
  // "one area cannot consume the entire global scan budget") while still
  // preserving the exact historical fast-run ceiling for the legacy
  // single-active-area case (STEP 8).
  AREA_SCAN_BUDGET_MAX_FACTOR: z.coerce.number().min(1).default(4),

  // Size (in streamTarget units) of ONE expansion grant handed to a
  // demonstrably productive area that has exhausted its current scan
  // budget without reaching its own streamTarget yet (STEP 3: "a
  // productive area may receive additional scan budget"). Default 1 is a
  // conservative, single-streamTarget-sized top-up — never larger than the
  // area's own original ask — rather than a large re-grant; combined with
  // AREA_SCAN_BUDGET_MAX_FACTOR above and remaining global headroom, this
  // naturally self-limits (STEP 3: "a low-yield area should NOT receive
  // unlimited additional scan budget").
  AREA_SCAN_BUDGET_EXPANSION_FACTOR: z.coerce.number().min(0).default(1),

  // PHASE 6 — resource-aware safe concurrency (replaces the old hardcoded
  // "safeResourceWorkers = 2"). Each Google area worker is NOT just one
  // browser slot's worth of memory — it is one Python subprocess (its own
  // ExecutionDriver thread + one producer thread + one thread per active
  // discovery provider, see engine/execution_driver.py and
  // providers/parallel_composite_provider.py), driving Playwright (which
  // itself launches a Node-based driver process), which in turn launches a
  // full multi-process Chromium tree (main + zygote + GPU + renderer +
  // network utility processes, each independently multi-threaded).
  // Linux's `pids` cgroup controller counts every one of those THREADS as
  // well as every process against the container's pids.max — which is
  // exactly the resource "can't start new thread" /
  // "pthread_create: Resource temporarily unavailable" was hitting even
  // while free memory (and therefore browserSlots) still looked enormous.
  // resourceCapacity.ts measures pids.max/pids.current from the real
  // cgroup at worker startup and derives a safe area-worker ceiling from
  // it instead of a guessed constant.
  //
  // PIDS_PER_AREA_WORKER: measured PID/thread footprint of ONE area worker
  // (Python process + its threads + Playwright driver + full Chromium
  // process tree). This default is a documented conservative estimate,
  // NOT a real production measurement — re-measure it on the target
  // container by sampling /sys/fs/cgroup/pids.current immediately before
  // and after a single isolated area run (GOOGLE_MAPS_AREA_WORKERS=1) and
  // set this env var to the observed delta plus headroom. Do not change
  // this default in code without that measurement.
  PIDS_PER_AREA_WORKER: z.coerce.number().int().min(1).default(220),

  // PIDs to reserve for the Node worker process itself, pg-boss, other
  // in-flight non-Google-Maps tasks in this same process, and OS baseline
  // — subtracted from pids.max before dividing by PIDS_PER_AREA_WORKER.
  PIDS_RESERVE_BUDGET: z.coerce.number().int().min(0).default(300),

  // Fallback ceiling used ONLY when the cgroup `pids` controller cannot be
  // read at all (non-Linux dev machine, or a host without the pids
  // controller enabled) — i.e. when PID accounting is genuinely
  // unavailable, not merely "unlimited". Unavailable accounting must never
  // be treated as "safe to go unbounded"; it falls back to this
  // known-safe, previously-validated value (Phase 1B's controlled
  // 2-worker validation — see googleAreaPool.test.ts "Phase 1B" cases).
  GOOGLE_MAPS_SAFE_RESOURCE_WORKERS_FALLBACK: z.coerce.number().int().min(1).max(16).default(2),

  // Optional manual override/sanity-cap layered on top of the measured
  // resource-aware ceiling (final = min(this, measured) when set). Unset
  // by default so the measured ceiling from resourceCapacity.ts is
  // authoritative; set this only to force a lower cap during a rollout or
  // incident, never to raise above what was actually measured.
  GOOGLE_MAPS_SAFE_RESOURCE_WORKERS: z.coerce.number().int().min(1).max(16).optional(),

  // PHASE 18 — resource-aware ENRICHMENT concurrency. Mirrors Phase 16's
  // area-worker treatment, applied to the businessEnrich (Website+Contact,
  // one runEngineEnrich() subprocess call per business — see
  // businessProcessingJob.ts's enrichBusiness()) and businessScore
  // (Instagram, same subprocess mechanism) pg-boss queues, which together
  // are the enrichment throughput bottleneck the Phase 18 production audit
  // measured (~2/min against a 3.33/min target).
  //
  // ENRICHMENT_PIDS_PER_WORKER: measured PID/thread footprint of ONE
  // enrichment job's `service.py enrich`/`service.py score` subprocess.
  // Deliberately NOT the same as PIDS_PER_AREA_WORKER (220): the Engine
  // 2.0 WebsiteWorker/ContactWorker/InstagramWorker this subprocess drives
  // are plain `urllib.request` HTTP inspectors (workers/website_worker.py,
  // workers/contact_worker.py, workers/instagram_worker.py's own module
  // docstrings) — no Playwright driver process, no Chromium process tree.
  // This default (20) is a documented CONSERVATIVE ROLLOUT BASELINE, not a
  // real production measurement — re-measure it the same way
  // PIDS_PER_AREA_WORKER's own comment describes (sample
  // /sys/fs/cgroup/pids.current immediately before/after a single isolated
  // enrichment job) once enrichment_configured_concurrency /
  // enrichment_safe_resource_concurrency / enrichment_final_concurrency
  // telemetry (resourceCapacity.ts) has real data, and set this env var to
  // the observed delta plus headroom. Do not change this default in code
  // without that measurement.
  ENRICHMENT_PIDS_PER_WORKER: z.coerce.number().int().min(1).default(20),

  // Optional cgroup-memory-based enrichment ceiling, parallel to
  // BROWSER_MEMORY_ESTIMATE_MB above. Left unset by default: unlike
  // discovery's browser slots, no trustworthy per-enrichment-worker memory
  // measurement exists yet either (see ENRICHMENT_PIDS_PER_WORKER above) —
  // an invented number here would be exactly the "optimistic assumption"
  // Phase 18 was told not to invent. When unset, the enrichment capacity
  // model folds in ONLY the measured PID ceiling (still real and still
  // resource-aware); set this once a real per-worker RSS delta has been
  // measured to also fold in a memory-derived ceiling.
  ENRICHMENT_MEMORY_MB_PER_WORKER: z.coerce.number().int().min(1).optional(),

  // Fallback ceiling used ONLY when the cgroup `pids` controller cannot be
  // read at all — same "unavailable, not merely unlimited" contract as
  // GOOGLE_MAPS_SAFE_RESOURCE_WORKERS_FALLBACK. Defaults to the SUM of
  // today's two fixed concurrency knobs (ENRICHMENT_TASK_CONCURRENCY +
  // INTELLIGENCE_TASK_CONCURRENCY = 8 + 8 = 16) precisely because that is
  // the already-running, already-safe combined concurrency production
  // runs today with zero resource-awareness at all — i.e. "can't measure
  // it" must fall back to "the number that was already proven fine",
  // never to an unbounded or invented figure.
  ENRICHMENT_SAFE_RESOURCE_WORKERS_FALLBACK: z.coerce.number().int().min(1).max(128).default(16),

  // Optional manual override/sanity-cap on the TOTAL (businessEnrich +
  // businessScore combined) resource-aware enrichment ceiling, mirroring
  // GOOGLE_MAPS_SAFE_RESOURCE_WORKERS. Unset by default so the measured
  // ceiling is authoritative; set only to force a lower combined cap
  // during rollout or incident response, never to raise above measured.
  ENRICHMENT_SAFE_RESOURCE_WORKERS: z.coerce.number().int().min(0).max(128).optional(),

  // PROCESS REGISTRY EXPLOSION FIX (log-volume half): discoveryPlanJob.ts's
  // per-candidate tracing block (PIPELINE/DISCOVERED/EXITED HERE/reason=/
  // BUSINESS_UPSERTED/ENSURE_ENRICHED_*/CHANNELS_*/DELIVER_LEAD_*/
  // INSERT_LEAD_*/FINISHED) emits ~10-15 console.log lines PER CANDIDATE
  // at the default INFO level — with the engine intentionally over-fetching
  // (askFor = streamTarget*4) to compensate for enrichment/filter/dedup
  // loss, a single 10-lead request can scan hundreds of candidates, which
  // is what actually produced "Railway dropped 7,123 messages": this one
  // block, not the lifecycle/target/failure/final summary lines (those stay
  // unconditional — see runOneAreaAttempt's own summary console.info calls,
  // untouched by this flag). Defaults OFF so production log volume is the
  // lifecycle/target/failure/final metrics only; set true to re-enable full
  // per-candidate pipeline tracing for a specific investigation.
  DISCOVERY_PIPELINE_TRACE_LOGS: z.coerce.boolean().default(false),

  // PHASE 8 — AI Opportunity Intelligence (Executive Briefings, Weekly
  // Intelligence, Opportunity Insights, Pipeline Coaching). Optional: if
  // unset, /v1/intelligence's AI-backed endpoints return 503 rather than
  // failing gateway startup — Discover/CRM/Pipeline/Mission never depend
  // on this being configured. Opportunity Explanations (/explain/:leadId)
  // are unaffected either way, since they're deterministic, not AI.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
})
  // LIFECYCLE FIX: enforce the ordering invariant section 7 of this
  // phase's spec requires ("the hard ceiling must be materially larger
  // than the inactivity timeout") at config-load time, not just in a
  // comment — a misconfigured deployment (e.g. someone lowering
  // SCRAPER_SUBPROCESS_MAX_MS without also lowering the inactivity
  // timeout) fails loudly at startup instead of silently making the
  // absolute ceiling fire before the inactivity timeout ever could.
  .superRefine((val, ctx) => {
    if (val.SCRAPER_SUBPROCESS_MAX_MS <= val.SCRAPER_SUBPROCESS_INACTIVITY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SCRAPER_SUBPROCESS_MAX_MS"],
        message:
          `SCRAPER_SUBPROCESS_MAX_MS (${val.SCRAPER_SUBPROCESS_MAX_MS}ms) must be ` +
          `materially larger than SCRAPER_SUBPROCESS_INACTIVITY_MS ` +
          `(${val.SCRAPER_SUBPROCESS_INACTIVITY_MS}ms) — the absolute safety ceiling ` +
          `must never fire before the inactivity timeout could have already caught a ` +
          `genuinely stalled subprocess.`,
      });
    }
    // PHASE 30: same "fail loudly at startup, not silently at runtime"
    // treatment for the new yield thresholds' own ordering invariant —
    // classifyAreaYield's Stage B assumes marginalMaxRate >= lowMaxRate
    // (see areaProductivity.ts's AreaYieldLimits doc comment).
    if (val.AREA_YIELD_MARGINAL_MAX_RATE < val.AREA_YIELD_LOW_MAX_RATE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AREA_YIELD_MARGINAL_MAX_RATE"],
        message:
          `AREA_YIELD_MARGINAL_MAX_RATE (${val.AREA_YIELD_MARGINAL_MAX_RATE}) must be >= ` +
          `AREA_YIELD_LOW_MAX_RATE (${val.AREA_YIELD_LOW_MAX_RATE}) — the marginal band sits ` +
          `above the low-yield cutoff by definition.`,
      });
    }
    // PHASE 32: same treatment for the scan-budget factor ordering
    // invariant — allocateInitialAreaScanBudget/requestAreaScanBudgetExpansion
    // (areaScanBudget.ts) assume maxFactor >= minFactor, or every initial
    // allocation would be clamped down below its own floor.
    if (val.AREA_SCAN_BUDGET_MAX_FACTOR < val.AREA_SCAN_BUDGET_MIN_FACTOR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AREA_SCAN_BUDGET_MAX_FACTOR"],
        message:
          `AREA_SCAN_BUDGET_MAX_FACTOR (${val.AREA_SCAN_BUDGET_MAX_FACTOR}) must be >= ` +
          `AREA_SCAN_BUDGET_MIN_FACTOR (${val.AREA_SCAN_BUDGET_MIN_FACTOR}) — a single area's ` +
          `budget ceiling can never sit below its own guaranteed floor.`,
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
