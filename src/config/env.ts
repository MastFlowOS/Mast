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

  // PHASE 12D — HYBRID ADAPTIVE AREA STOPPING. Shared "time since last
  // qualification" window used by src/discovery/areaProductivity.ts for
  // BOTH of its two clocks:
  //   - before an area's first qualified lead: the bounded EXPLORATION
  //     window an area gets before it's declared unproductive and replaced;
  //   - after an area's first qualified lead: the INACTIVITY window that
  //     resets every time the area qualifies another lead, so a steadily-
  //     productive area is never stopped by this timer.
  //
  // The Phase 12C production audit observed first-qualified latency in the
  // ~56-85 SECOND range. This default (120s) is set comfortably above that
  // observed range so a genuinely-still-exploring area is not mistaken for
  // an unproductive one during rollout — it is a CONSERVATIVE INITIAL
  // ROLLOUT VALUE, not a proven optimum. Tune down as real production data
  // accumulates on how this adaptive behavior performs; do not treat 120s
  // as a permanent constant.
  AREA_PRODUCTIVITY_IDLE_MS: z.coerce.number().int().min(10_000).default(120_000),

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
