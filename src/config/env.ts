import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),

  // Supabase — same project the frontend already uses. The backend uses the
  // service-role key exclusively; it is never sent to the client.
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1), // used to verify user access tokens locally, no round trip per request

  // Postgres connection string for pg-boss (same Supabase Postgres instance,
  // via the "session" pooler / direct connection — pg-boss needs LISTEN/NOTIFY
  // and long-lived connections, so it should NOT go through the transaction
  // pooler (pgbouncer in transaction mode)).
  DATABASE_URL: z.string().min(1),

  // Where the frontend is deployed, for CORS.
  ALLOWED_ORIGIN: z.string().url(),

  // Path to the Part 1 engine on disk (see scraper-bridge/README.md). The
  // worker fleet shells out to this as a subprocess in Phase 2 — the gateway
  // never calls it directly.
  SCRAPER_ENGINE_PATH: z.string().default("../mast-lead-engine"),

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
