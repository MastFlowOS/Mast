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
  // mechanism, just an intent. Bounded at 8 as a sanity ceiling; the real,
  // memory-aware ceiling is enforced at runtime by browserSlotPool, not by
  // this max().
  GOOGLE_MAPS_AREA_WORKERS: z.coerce.number().int().min(1).max(8).default(8),

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
