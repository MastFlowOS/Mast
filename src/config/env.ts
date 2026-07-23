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
  //   STALE_TASK_TIMEOUT_MS          : discovery_tasks (default 8 min)
  //   STALE_BUSINESS_TASK_TIMEOUT_MS : business_processing_tasks (default 5 min)
  STALE_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(8 * 60 * 1000),
  STALE_BUSINESS_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(5 * 60 * 1000),
  //   STALE_SCRAPE_JOB_TIMEOUT_MS    : scrape_jobs stuck 'streaming' (default 10 min)
  // AUDIT FIX (Verification Report, Finding 6): poolExpandJob had no
  // heartbeat/stale-reclaim mechanism at all — see migrations/020 and
  // jobs/staleScrapeJobSweep.ts. Longer than STALE_TASK_TIMEOUT_MS since a
  // poolExpand run can legitimately span multiple niches/countries/rounds.
  STALE_SCRAPE_JOB_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(10 * 60 * 1000),

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

  // PHASE 8 — AI Opportunity Intelligence (Executive Briefings, Weekly
  // Intelligence, Opportunity Insights, Pipeline Coaching). Optional: if
  // unset, /v1/intelligence's AI-backed endpoints return 503 rather than
  // failing gateway startup — Discover/CRM/Pipeline/Mission never depend
  // on this being configured. Opportunity Explanations (/explain/:leadId)
  // are unaffected either way, since they're deterministic, not AI.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
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
