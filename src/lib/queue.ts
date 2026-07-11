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

  await boss.start();

  for (const queueName of Object.values(QUEUES)) {
    await boss.createQueue(queueName);
  }

  bossInstance = boss;
  return boss;
}
