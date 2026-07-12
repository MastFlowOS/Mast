import PgBoss from "pg-boss";
import { env } from "../config/env.js";

/**
 * Job queue, backed by the same Postgres instance as Supabase (via pg-boss's
 * own schema, `pgboss`). No separate Redis/queue infra to run — this is why
 * pg-boss was chosen over BullMQ for a "Supabase for data" deployment: one
 * fewer service to keep alive on Railway/Render/Fly, and jobs survive a
 * worker restart because they live in Postgres, not memory.
 *
 * Queues:
 *  - "discover.live"  Free tier — scrape happens now, results stream in
 *  - "pool.expand"     Background scrape to grow the pool after an Instant
 *                       Discovery response fell short, decoupled from the
 *                       request that triggered it
 *  - "pool.verify"     Recurring (~14 day) re-verification of existing
 *                       businesses in the Global Lead Pool
 *
 * Phase 1/2 had a fourth queue, "discover.instant", for Starter/Pro/Premium.
 * Phase 3 removed it: the doc requires Instant Discovery to "return
 * instantly," and a queue -> worker round trip (even a fast one) can't
 * deliver that — the gateway now does the pool lookup synchronously in the
 * request handler (src/lib/poolLookup.ts) and only reaches for a queue
 * (pool.expand) for the part that's explicitly allowed to happen later.
 */
export const QUEUES = {
  discoverLive: "discover.live",
  poolExpand: "pool.expand",
  poolVerify: "pool.verify",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // Retention/retry defaults are conservative; tune per queue in Phase 2
    // once real job durations from the scraper are known.
    retryLimit: 3,
    retryBackoff: true,
  });

  boss.on("error", (err) => console.error("[pg-boss] error", err));

  try {
    await boss.start();
  } catch (err) {
    // pg-boss needs LISTEN/NOTIFY + session-scoped prepared statements.
    // Supabase's Transaction pooler (port 6543 / pgbouncer transaction mode)
    // supports neither, and fails here with an opaque low-level error. This
    // is the single most common cause of "discover" jobs failing right
    // after boss.start() is reached — re-thrown with an explicit pointer to
    // the fix rather than surfacing only the raw driver error.
    const hint =
      "pg-boss failed to start. If DATABASE_URL points at Supabase's " +
      "Transaction pooler (port 6543), switch to the Session pooler or a " +
      "direct connection (port 5432) — pg-boss requires LISTEN/NOTIFY and " +
      "session-scoped prepared statements, which the transaction pooler " +
      "does not support.";
    console.error(`[pg-boss] ${hint}`, err);
    throw new Error(`${hint} Original error: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const queueName of Object.values(QUEUES)) {
    await boss.createQueue(queueName);
  }

  bossInstance = boss;
  return boss;
}
