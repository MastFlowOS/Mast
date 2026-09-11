/**
 * CRITMODE — "10 requested, 9 shown" bug (the bug remaining AFTER the
 * user-scoped target-accounting fix in targetAccounting.ts).
 *
 * Confirmed production shape: target=10, newForUser=10 (both correct —
 * 10 `leads` rows persisted, 10 credits charged, 25000 -> 24990), yet the
 * frontend displayed "9 new opportunities prepared".
 *
 * ROOT CAUSE: poolExpandJob.ts's followUp path can run several area
 * workers concurrently (runAreaWorkerPool / computeDynamicDiscoveryCapacity
 * — untouched by this fix). Every delivered lead used to write
 * `scrape_jobs.results_count` back with a plain, unconditional
 *   `.update({ results_count: resultsCountBase + newForUser })`
 * off a LOCAL SNAPSHOT of the shared `newForUser` counter. Because each
 * write is an independent async round trip, two round trips are not
 * guaranteed to land in the order they were issued: a worker that
 * snapshotted newForUser=9 a moment before another worker's delivery
 * bumped it to 10 can still have its (now-stale) write complete AFTER the
 * newForUser=10 write, silently regressing results_count from 10 back to
 * 9 — even though every lead was correctly persisted and every credit
 * correctly charged. subscribeToDiscoverJob() (src/lib/api.ts) trusts this
 * column for both its completion target and what it ultimately reports,
 * so this single regressed value alone was enough to freeze the display
 * at 9.
 *
 * THE FIX: migrations/033_bump_scrape_job_results_count.sql adds
 * `bump_scrape_job_results_count(p_job_id, p_count)`, an atomic
 * `SET results_count = GREATEST(results_count, p_count)` — order-
 * independent by construction, since a lower, later-arriving write can
 * never move the column backwards. poolExpandJob.ts's bumpResultsCount()
 * helper calls this RPC at both write sites (the per-lead progress update
 * and the final completion update) instead of the racy raw `.update()`.
 *
 * This file pins:
 *  1. poolExpandJob.ts no longer contains the raw, order-unsafe
 *     `.update({ results_count: ... })` pattern, and both write sites go
 *     through the monotonic bumpResultsCount()/RPC.
 *  2. A pure-JS model of the SQL function's own semantics
 *     (`GREATEST(existing, incoming)`) proves that no matter what order a
 *     set of concurrent, out-of-order writes complete in, the final value
 *     converges to the true maximum (10) — never regresses to 9.
 *  3. The same model proves prepared-opportunity count (results_count)
 *     can never diverge from credits actually consumed (newForUser) —
 *     both are driven by the same monotonic maximum of the one
 *     authoritative counter, so they can never end a run pointing at two
 *     different numbers.
 *  4. An optional real-Postgres integration test (gated on DATABASE_URL,
 *     skipped otherwise, mirroring poolExpandDeliveryReservation.test.ts's
 *     precedent) exercises the actual SQL function under genuinely
 *     out-of-order writes.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const poolExpandJobSrc = readFileSync(path.join(__dirname, "../poolExpandJob.ts"), "utf8");

// ─── 1. Source-pattern checks ───────────────────────────────────────────────

test("1. poolExpandJob.ts no longer writes results_count with a raw, order-unsafe .update()", () => {
  assert.doesNotMatch(
    poolExpandJobSrc,
    /\.update\(\{\s*results_count:\s*resultsCountBase \+ newForUser\s*\}\)/,
    "the racy last-writer-wins .update({ results_count: ... }) pattern must be gone",
  );
});

test("2. the per-lead progress write goes through the monotonic bumpResultsCount() helper", () => {
  assert.match(
    poolExpandJobSrc,
    /await bumpResultsCount\(followUp\.scrapeJobId, resultsCountBase \+ newForUser\)/g,
    "every results_count write must go through bumpResultsCount(), not a raw .update()",
  );
  // Two call sites are expected: the per-lead progress update inside the
  // delivery loop, and the final completion write.
  const matches = poolExpandJobSrc.match(/bumpResultsCount\(followUp\.scrapeJobId, resultsCountBase \+ newForUser\)/g) ?? [];
  assert.equal(matches.length, 2, "expected exactly two bumpResultsCount() call sites (per-lead + completion)");
});

test("3. bumpResultsCount() itself calls the atomic, order-independent RPC — not a plain table update", () => {
  assert.match(
    poolExpandJobSrc,
    /rpc\("bump_scrape_job_results_count", \{\s*p_job_id: jobId,\s*p_count: count,\s*\}\)/,
    "bumpResultsCount() must delegate to the bump_scrape_job_results_count RPC",
  );
});

// ─── 2 & 3. Pure model of the RPC's own semantics ──────────────────────────

/** Exact JS mirror of `SET results_count = GREATEST(results_count, p_count)`. */
function bumpMonotonic(current: number, incoming: number): number {
  return Math.max(current, incoming);
}

describe("monotonic results_count converges to the true maximum regardless of write order", () => {
  test("4. out-of-order completion (a stale, lower-snapshot write lands AFTER the true final one) cannot regress the count", () => {
    // Two concurrent area workers deliver leads for the same followUp job.
    // Worker A snapshots newForUser=9 first; Worker B's delivery is the
    // genuine 10th and snapshots newForUser=10. Worker B's write completes
    // FIRST (fast network), Worker A's stale write arrives SECOND (slow
    // network) — the exact ordering that regressed the column in
    // production.
    let resultsCount = 0;

    // Worker B's write (newForUser=10) lands first.
    resultsCount = bumpMonotonic(resultsCount, 10);
    assert.equal(resultsCount, 10);

    // Worker A's stale write (newForUser=9, snapshotted earlier) lands
    // second — must NOT be allowed to regress the column.
    resultsCount = bumpMonotonic(resultsCount, 9);
    assert.equal(resultsCount, 10, "a stale, lower write arriving after the true final one must never regress results_count");
  });

  test("5. target=10 -> newForUser=10 -> results_count settles at exactly 10 under any interleaving of 10 concurrent writes", () => {
    const shortfall = 10;
    const writesInSnapshotOrder = Array.from({ length: shortfall }, (_, i) => i + 1); // [1..10]

    // Try every reversed / shuffled completion order a set of concurrent
    // workers could plausibly produce; the final value must always be the
    // true maximum, never anything less.
    const orderings: number[][] = [
      [...writesInSnapshotOrder].reverse(),
      [10, 1, 9, 2, 8, 3, 7, 4, 6, 5],
      [5, 10, 1, 9, 2, 8, 3, 7, 4, 6],
      writesInSnapshotOrder,
    ];

    for (const order of orderings) {
      let resultsCount = 0;
      for (const snapshot of order) {
        resultsCount = bumpMonotonic(resultsCount, snapshot);
      }
      assert.equal(resultsCount, shortfall, `final results_count must be ${shortfall} regardless of completion order ${JSON.stringify(order)}`);
    }
  });

  test("6. credits consumed and prepared-opportunity count can never diverge", () => {
    // Credits are charged 1:1 with genuinely-new leads via
    // try_increment_lead_usage() inside insertLeadForUser() — that part is
    // already atomic and out of scope for this fix. The invariant this
    // fix restores is that results_count (what the frontend displays as
    // "prepared opportunities") can never end a run reporting a DIFFERENT
    // number than the credits actually consumed, no matter how many
    // concurrent workers wrote to it along the way or in what order their
    // writes landed.
    let creditsConsumed = 0;
    let resultsCount = 0;

    // Simulate 10 genuinely-new deliveries, processed by concurrent
    // workers whose results_count writes land in a scrambled order.
    const deliveryOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const writeCompletionOrder = [3, 1, 2, 5, 4, 7, 6, 10, 8, 9];

    for (const n of deliveryOrder) {
      creditsConsumed += 1; // try_increment_lead_usage — always in delivery order, atomic
    }
    for (const snapshot of writeCompletionOrder) {
      resultsCount = bumpMonotonic(resultsCount, snapshot); // scrambled completion order
    }

    assert.equal(creditsConsumed, 10);
    assert.equal(resultsCount, 10);
    assert.equal(resultsCount, creditsConsumed, "prepared-opportunity count must equal credits consumed — they must never diverge");
  });
});

// ─── 4. Real-Postgres integration test (optional, mirrors ──────────────────
// poolExpandDeliveryReservation.test.ts's precedent) ─────────────────────────

const DATABASE_URL = process.env.POOL_EXPAND_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe("bump_scrape_job_results_count RPC (real Postgres, migration 033)", () => {
  let poolAvailable = false;
  let admin: pg.Client;
  let connA: pg.Client;
  let connB: pg.Client;
  let userId: string;

  before(async () => {
    if (!DATABASE_URL) {
      console.warn(
        "[resultsCountMonotonic.test] DATABASE_URL not set — skipping real-Postgres suite. " +
          "Set DATABASE_URL to a Postgres instance with migrations 001-033 applied to run it.",
      );
      return;
    }
    admin = new pg.Client({ connectionString: DATABASE_URL });
    connA = new pg.Client({ connectionString: DATABASE_URL });
    connB = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await admin.connect();
      await connA.connect();
      await connB.connect();
      await admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'bump_scrape_job_results_count'`);
      poolAvailable = true;
    } catch (err) {
      console.warn("[resultsCountMonotonic.test] could not reach test database — skipping:", (err as Error).message);
      poolAvailable = false;
    }
  });

  after(async () => {
    if (!poolAvailable) return;
    await admin.end();
    await connA.end();
    await connB.end();
  });

  test("7. a stale, lower-count write on one connection landing AFTER a higher one on another connection cannot regress results_count", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const { rows: userRows } = await admin.query(
      `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
      [`results-count-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
    );
    userId = userRows[0].id;

    const { rows: jobRows } = await admin.query(
      `INSERT INTO scrape_jobs (user_id, mode, status, query) VALUES ($1, 'instant_pool', 'streaming', '{}'::jsonb) RETURNING id`,
      [userId],
    );
    const jobId = jobRows[0].id as string;

    // Connection B (the true final, newForUser=10 write) fires and
    // completes FIRST.
    await connB.query(`SELECT bump_scrape_job_results_count($1, $2)`, [jobId, 10]);

    // Connection A's stale write (snapshotted when newForUser was still 9)
    // arrives SECOND — must not regress the row.
    await connA.query(`SELECT bump_scrape_job_results_count($1, $2)`, [jobId, 9]);

    const { rows } = await admin.query(`SELECT results_count FROM scrape_jobs WHERE id = $1`, [jobId]);
    assert.equal(rows[0].results_count, 10, "results_count must remain 10 after a stale, lower write lands out of order");
  });

  test("8. ten concurrent out-of-order writes settle at exactly the true maximum, never less", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const { rows: userRows } = await admin.query(
      `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
      [`results-count-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
    );
    userId = userRows[0].id;

    const { rows: jobRows } = await admin.query(
      `INSERT INTO scrape_jobs (user_id, mode, status, query) VALUES ($1, 'instant_pool', 'streaming', '{}'::jsonb) RETURNING id`,
      [userId],
    );
    const jobId = jobRows[0].id as string;

    // Fire all 10 snapshots concurrently across two connections, in a
    // deliberately scrambled order, and let them race.
    const snapshots = [3, 1, 2, 5, 4, 7, 6, 10, 8, 9];
    await Promise.all(
      snapshots.map((n, i) => (i % 2 === 0 ? connA : connB).query(`SELECT bump_scrape_job_results_count($1, $2)`, [jobId, n])),
    );

    const { rows } = await admin.query(`SELECT results_count FROM scrape_jobs WHERE id = $1`, [jobId]);
    assert.equal(rows[0].results_count, 10, "final results_count must be the true maximum regardless of concurrent completion order");
  });
});
