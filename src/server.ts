import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import {
  redactSensitiveData,
  redactSensitiveHeaders,
  sanitizeRequestUrl,
  serializeError,
} from "./lib/safeRequestLog.js";
import { env } from "./config/env.js";
import { healthRouter } from "./server/routes/health.js";
import { accountRouter } from "./server/routes/account.js";
import { discoverRouter } from "./server/routes/discover.js";
import { intelligenceRouter } from "./server/routes/intelligence.js";
import { outreachRouter } from "./server/routes/outreach.js";
import { observabilityRouter } from "./server/routes/observability.js";
import { desktopRouter } from "./server/routes/desktop.js";
import { closePersistentEnrichmentWorkerGraceful } from "./scraperBridge/pythonBridge.js";

// Catch anything that escapes Express entirely (e.g. an unawaited promise
// rejection deep in pg-boss/Supabase client internals) — without these,
// such a failure prints nothing on Railway and can silently kill the
// process or leave it hung.
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException", redactSensitiveData(serializeError(err)));
});
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection", redactSensitiveData(serializeError(reason)));
});

const app = express();

app.use(pinoHttp({
  // pino-http wraps custom serializers in its default serializers unless
  // explicitly disabled. We return the final safe shape, so disable wrapping.
  wrapSerializers: false,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.proxy-authorization",
      "req.headers.cookie",
      "req.headers.set-cookie",
      "req.headers['set-cookie']",
      "req.headers.x-api-key",
      "req.headers.x-auth-token",
      "req.headers['refresh-token']",
      "req.headers['x-refresh-token']",
      "res.headers['set-cookie']",
    ],
    censor: "[Redacted]",
  },
  // Explicit allowlist serializers for req, res, and err:
  // Prevents headers, cookies, tokens, or nested client error trees from leaking.
  serializers: {
    req(req) {
      return {
        id: (req as typeof req & { id?: string }).id,
        method: req.method,
        url: sanitizeRequestUrl(req.url ?? ""),
        headers: redactSensitiveHeaders(req.headers ?? {}),
        remoteAddress: req.socket?.remoteAddress,
        remotePort: req.socket?.remotePort,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
    err(err) {
      return redactSensitiveData(serializeError(err));
    },
  },
}));
app.use(express.json({ limit: "1mb" }));
const configuredOrigins = (env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (requestOrigin, callback) => {
      if (!requestOrigin) return callback(null, true);
      const cleanOrigin = requestOrigin.replace(/\/+$/, "");
      const isConfigured = configuredOrigins.some((allowed) => {
        if (allowed === cleanOrigin) return true;
        const allowedHost = allowed.replace(/^https?:\/\//, "");
        const cleanHost = cleanOrigin.replace(/^https?:\/\//, "");
        return (
          allowedHost === `www.${cleanHost}` ||
          cleanHost === `www.${allowedHost}` ||
          allowedHost === cleanHost
        );
      });

      if (
        isConfigured ||
        cleanOrigin.endsWith(".vercel.app") ||
        cleanOrigin.includes("localhost") ||
        cleanOrigin.includes("127.0.0.1")
      ) {
        return callback(null, true);
      }
      return callback(null, configuredOrigins[0] || true);
    },
    credentials: true,
  }),
);

app.use("/health", healthRouter);
app.use("/v1/account", accountRouter);
app.use("/v1/discover", discoverRouter);
app.use("/v1/desktop", desktopRouter);
app.use("/v1/intelligence", intelligenceRouter);
app.use("/v1/outreach", outreachRouter);
app.use("/v1/observability", observabilityRouter);



// Centralized error handler — anything thrown/next(err)'d in a route lands here.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const serialized = serializeError(err);
  // Sanitize both structured and fallback logs. HTTP-client errors can embed
  // their request config (including Authorization) inside nested properties.
  const safeSerialized = redactSensitiveData(serialized) as Record<string, unknown>;
  const safeUrl = sanitizeRequestUrl(req.originalUrl);
  const logPayload = { err: safeSerialized, method: req.method, url: safeUrl, userId: req.user?.id };

  const status =
    typeof (err as any)?.status === "number" && (err as any).status >= 400 && (err as any).status <= 599
      ? (err as any).status
      : typeof (err as any)?.statusCode === "number" && (err as any).statusCode >= 400 && (err as any).statusCode <= 599
        ? (err as any).statusCode
        : 500;

  // Primary: structured pino log (JSON, picked up by Railway's log drain).
  req.log?.error(logPayload, "unhandled_request_error");
  // Fallback: guaranteed plain-text stdout line, with the same redaction.
  console.error(`[gateway] ${req.method} ${safeUrl} -> ${status}:`, safeSerialized);

  const message = typeof safeSerialized.message === "string" ? safeSerialized.message : "Internal server error";
  const code = (err as any)?.code || (status >= 500 ? "internal_error" : "request_error");
  res.status(status).json({ code, message });
});

const server = app.listen(env.PORT, () => {
  console.log(`[gateway] listening on :${env.PORT} (${env.NODE_ENV})`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
// Railway sends SIGTERM (SIGINT for local Ctrl+C) before killing the
// container. Without a handler, in-flight HTTP requests (e.g. a
// discover.ts pool lookup mid-response) are cut off immediately instead of
// being allowed to finish.
//
// http.Server#close() is Node's own graceful-stop primitive: it stops
// accepting new connections right away but lets already-open requests
// complete on their own; the close() callback only fires once every
// in-flight connection has ended. That's bounded here by a hard timeout so
// a slow/stuck request can't hang shutdown forever — Railway will SIGKILL
// shortly after SIGTERM regardless, so this just makes sure we exit
// intentionally first.
const GRACEFUL_STOP_TIMEOUT_MS = 25_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gateway] received ${signal}, starting graceful shutdown (timeout=${GRACEFUL_STOP_TIMEOUT_MS}ms)`);

  const forceExitTimer = setTimeout(() => {
    console.error(`[gateway] graceful shutdown exceeded ${GRACEFUL_STOP_TIMEOUT_MS}ms — forcing exit`);
    process.exit(1);
  }, GRACEFUL_STOP_TIMEOUT_MS);
  forceExitTimer.unref();

  server.close(async (err) => {
    try {
      await closePersistentEnrichmentWorkerGraceful(5000);
    } catch (daemonErr) {
      console.warn("[gateway] error during enrichment daemon graceful shutdown (non-fatal):", daemonErr);
    }
    clearTimeout(forceExitTimer);
    if (err) {
      console.error("[gateway] error during graceful shutdown", err);
      process.exit(1);
    }
    console.log("[gateway] all connections closed — exiting");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
