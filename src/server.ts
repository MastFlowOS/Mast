import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { accountRouter } from "./routes/account.js";
import { discoverRouter } from "./routes/discover.js";
import { intelligenceRouter } from "./routes/intelligence.js";

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

// Centralized error handler — anything thrown/next(err)'d in a route lands here.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  req.log?.error(err);
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ code: "internal_error", message });
});

app.listen(env.PORT, () => {
  console.log(`[gateway] listening on :${env.PORT} (${env.NODE_ENV})`);
});
