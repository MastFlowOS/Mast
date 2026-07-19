import dns from "node:dns";
import PgBoss from "pg-boss";
import { env } from "../config/env.js";

/**
 * Railway (like most PaaS containers) has no outbound IPv6 route. Node 18+
 * defaults DNS ordering to "verbatim" — i.e. whatever order the OS resolver
 * returns, which for a dual-stack hostname can be the AAAA (IPv6) record
 * first. That alone would just cost a slow fallback to the A record on a
 * network *with* IPv6 support; on Railway there is no IPv6 route at all, so
 * the connection attempt fails outright with ENETUNREACH instead of falling
 * back. Forcing IPv4-first here is cheap, global, and correct for every
 * outbound TCP connection this process makes (pg-boss's raw `pg` socket
 * included) — it protects us even if some *other* dual-stack host ends up in
 * DATABASE_URL later. Set once, at module load, before anything connects.
 */
dns.setDefaultResultOrder("ipv4first");

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
  /** Durable planner + independently claimable country/city work units. */
  discoveryPlan: "discovery.plan",
  discoveryTask: "discovery.task",
  /** Legacy queue retained only so already-enqueued jobs can drain safely. */
  discoverLive: "discover.live",
  poolExpand: "pool.expand",
  poolVerify: "pool.verify",
  businessEnrich: "business.enrich",
  businessScore: "business.score",
  priorityAging: "priority-aging",
} as const;


export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let bossInstance: PgBoss | null = null;

/**
 * Supabase's "direct connection" host (`db.<project-ref>.supabase.co`) has,
 * since Supabase's IPv4 deprecation, no A record on projects that haven't
 * bought the IPv4 add-on — it resolves to an AAAA (IPv6) address only. That
 * is exactly what produced the `connect ENETUNREACH 2a05:...:5432` failure:
 * Railway's network has no IPv6 route, so the direct-connection host was
 * never reachable from there, regardless of DNS ordering.
 *
 * `ipv4first` (above) cannot fix this case, because there is no IPv4 address
 * to prefer — the fix has to be a different *host*. Supabase's Session
 * Pooler (`aws-0-<region>.pooler.supabase.com`) is dual-stack/IPv4-reachable
 * *and* runs in session mode, so it also satisfies pg-boss's requirement for
 * LISTEN/NOTIFY and session-scoped prepared statements (unlike the
 * Transaction pooler on port 6543). It is the only one of the three options
 * that works from Railway, so we fail fast and say so if the direct host
 * sneaks back into DATABASE_URL instead of surfacing a bare ENETUNREACH.
 */
function assertRailwayReachableHost(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // Not a parseable URL — let pg-boss's own connection attempt surface the error.
    return;
  }

  if (/^db\.[^.]+\.supabase\.co$/i.test(host)) {
    throw new Error(
      `DATABASE_URL host "${host}" is Supabase's direct-connection host, which is IPv6-only ` +
        "on projects without the IPv4 add-on and is NOT reachable from Railway (no IPv6 egress) " +
        "— this is what caused the prior \"connect ENETUNREACH 2a05:...\" failure. Switch " +
        "DATABASE_URL to the Session Pooler instead: " +
        "postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres " +
        "(find the exact string under Supabase -> Project Settings -> Database -> Connection " +
        "string -> Session pooler). Do not use the Transaction pooler (port 6543) — pg-boss " +
        "needs LISTEN/NOTIFY and session-scoped prepared statements, which only Session mode supports.",
    );
  }
}

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;

  assertRailwayReachableHost(env.DATABASE_URL);

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
    const message = err instanceof Error ? err.message : String(err);
    const isNetUnreachable = /ENETUNREACH|EHOSTUNREACH/.test(message);

    // pg-boss needs LISTEN/NOTIFY + session-scoped prepared statements.
    // Supabase's Transaction pooler (port 6543 / pgbouncer transaction mode)
    // supports neither, and fails here with an opaque low-level error. This
    // is one common cause of "discover" jobs failing right after
    // boss.start() is reached — re-thrown with an explicit pointer to the
    // fix rather than surfacing only the raw driver error. The other common
    // cause, an unreachable IPv6-only host, gets its own message below.
    const hint = isNetUnreachable
      ? "pg-boss failed to start: the database host could not be reached " +
        "(ENETUNREACH/EHOSTUNREACH), almost always because it resolved to an " +
        "IPv6 address on a network without IPv6 egress (e.g. Railway). Use " +
        "Supabase's Session Pooler host (aws-0-<region>.pooler.supabase.com:5432), " +
        "not the direct db.<project-ref>.supabase.co host."
      : "pg-boss failed to start. If DATABASE_URL points at Supabase's " +
        "Transaction pooler (port 6543), switch to the Session pooler " +
        "(aws-0-<region>.pooler.supabase.com:5432) — pg-boss requires " +
        "LISTEN/NOTIFY and session-scoped prepared statements, which the " +
        "transaction pooler does not support.";
    console.error(`[pg-boss] ${hint}`, err);
    throw new Error(`${hint} Original error: ${message}`);
  }

  for (const queueName of Object.values(QUEUES)) {
    await boss.createQueue(queueName);
  }

  bossInstance = boss;
  return boss;
}
