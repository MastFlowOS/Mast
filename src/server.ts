import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { healthRouter } from "./server/routes/health.js";
import { accountRouter } from "./server/routes/account.js";
import { discoverRouter } from "./server/routes/discover.js";
import { intelligenceRouter } from "./server/routes/intelligence.js";

// Catch anything that escapes Express entirely (e.g. an unawaited promise
// rejection deep in pg-boss/Supabase client internals) — without these,
// such a failure prints nothing on Railway and can silently kill the
// process or leave it hung.
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException", { message: err?.message, stack: err?.stack, err });
});
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection", { reason });
});

const app = express();

app.use(pinoHttp());
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: env.ALLOWED_ORIGIN,
    credentials: true,
  }),
);

app.use("/health", healthRouter);
app.use("/v1/account", accountRouter);
app.use("/v1/discover", discoverRouter);
app.use("/v1/intelligence", intelligenceRouter);

/**
 * Serializes an unknown thrown value into a plain object with every field
 * worth seeing in Railway's log stream. Supabase/PostgREST errors (the
 * overwhelming majority of what this gateway throws) are plain objects with
 * `.message` / `.code` / `.details` / `.hint` — NOT Error instances — so a
 * generic `instanceof Error` check misses exactly the fields that explain
 * failures like "permission denied for table X" (Postgres error code
 * 42501) or "relation does not exist" (42P01). Every field present is kept;
 * nothing is dropped in favor of a generic message.
 */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      // Supabase's PostgrestError extends Error but adds these — surfaced
      // explicitly since they carry the actual Postgres error code/detail.
      code: (err as { code?: string }).code,
      details: (err as { details?: string }).details,
      hint: (err as { hint?: string }).hint,
    };
  }
  if (err && typeof err === "object") {
    return { ...(err as Record<string, unknown>) };
  }
  return { message: String(err) };
}

// Centralized error handler — anything thrown/next(err)'d in a route lands here.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const serialized = serializeError(err);
  const logPayload = { err: serialized, method: req.method, url: req.originalUrl, userId: req.user?.id };

  // Primary: structured pino log (JSON, picked up by Railway's log drain).
  req.log?.error(logPayload, "unhandled_request_error");
  // Fallback: guaranteed plain-text stdout line, independent of pino/its
  // transport ever being misconfigured — this is the actual fix for
  // "backend only logs generic HTTP 500s" (problem #8).
  console.error(`[gateway] ${req.method} ${req.originalUrl} -> 500:`, serialized);

  const message = err instanceof Error ? err.message : (serialized.message as string) || "Internal server error";
  res.status(500).json({ code: "internal_error", message });
});

app.listen(env.PORT, () => {
  console.log(`[gateway] listening on :${env.PORT} (${env.NODE_ENV})`);
});
