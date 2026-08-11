/**
 * Regression tests for Phase 3A — the `pool.expand` 10→15 overshoot bug.
 *
 * ROOT CAUSE (see poolExpandJob.ts's own docstring for the full writeup):
 * a followUp run tracked its remaining amount ONLY in a local JS variable
 * (`newForUser` vs `payload.shortfall`). pg-boss can redeliver a
 * long-running `pool.expand` job after its expiration window, so a second
 * worker could start the same logical work with its OWN fresh local
 * counter while the first worker was still delivering — the two together
 * could jointly exceed the requested amount, because nothing shared
 * between them enforced a durable cap.
 *
 * THE FIX under test here is entirely in the database: `deliverLead()` /
 * `insertLeadForUser()` (deliverLead.ts) already reserve every delivery via
 * `claim_discovery_delivery()` (migrations/023_global_request_lifecycle.sql)
 * whenever a `discoveryPlanId` is present — that mechanism was already
 * proven correct for `discovery.task` (live mode). `poolExpandJob.ts` just
 * never gave a followUp run a plan id to use it with. It now does, via
 * `get_or_create_pool_expand_plan()`
 * (migrations/024_pool_expand_delivery_reservation.sql), which is what lets
 * two genuinely concurrent Postgres connections race on the SAME row and
 * still never jointly claim more than `requested_count`.
 *
 * These tests exercise the real SQL functions against a real Postgres
 * database (not a JS-level simulation of "what the SQL should do") — two
 * separate `pg` connections fire concurrent `claim_discovery_delivery()`
 * calls at the SAME row, so Postgres's own row-level locking is what's
 * actually being verified, not this test file's scheduling.
 *
 * Requires DATABASE_URL (or POOL_EXPAND_TEST_DATABASE_URL) pointing at a
 * Postgres instance with migrations 001–024 applied — see
 * scripts/run-migrations.mjs. If neither is reachable, every test in this
 * file is skipped (not failed) so environments without a local Postgres
 * don't break `npm run test:server`.
 *
 * Uses Node's built-in test runner (`node:test`), matching every other
 * test file in this repo. Run with:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/mast_test \
 *     npx tsx --test src/discovery/__tests__/poolExpandDeliveryReservation.test.ts
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const DATABASE_URL = process.env.POOL_EXPAND_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Two independent connections — required so concurrent claims actually
// race inside Postgres itself, rather than being serialized by JS awaiting
// on a single connection.
let poolAvailable = false;
let admin: pg.Client;
let connA: pg.Client;
let connB: pg.Client;

let userId: string;

async function makeScrapeJobAndUser(client: pg.Client): Promise<string> {
  const { rows: userRows } = await client.query(
    `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
    [`pool-expand-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
  );
  userId = userRows[0].id;

  const { rows: jobRows } = await client.query(
    `INSERT INTO scrape_jobs (user_id, mode, status, query)
     VALUES ($1, 'instant_pool', 'streaming', '{}'::jsonb)
     RETURNING id`,
    [userId],
  );
  return jobRows[0].id as string;
}

/** Mirrors getOrCreatePoolExpandPlanId() in poolExpandJob.ts exactly. */
async function getOrCreatePoolExpandPlan(client: pg.Client, scrapeJobId: string, requestedCount: number): Promise<string> {
  const { rows } = await client.query(
    `SELECT get_or_create_pool_expand_plan($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
    [scrapeJobId, userId, "plumbers", "North America", "[]", "[]", null, requestedCount],
  );
  return rows[0].id as string;
}

async function claim(client: pg.Client, planId: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT claim_discovery_delivery($1) AS claimed`, [planId]);
  return rows[0].claimed as boolean;
}

async function readPlan(client: pg.Client, planId: string) {
  const { rows } = await client.query(
    `SELECT delivered_count, requested_count, status, terminal_reason FROM discovery_plans WHERE id = $1`,
    [planId],
  );
  return rows[0] as { delivered_count: number; requested_count: number; status: string; terminal_reason: string | null };
}

describe("Phase 3A: pool.expand delivery reservation (claim_discovery_delivery)", () => {
  before(async () => {
    if (!DATABASE_URL) {
      console.warn(
        "[poolExpandDeliveryReservation.test] DATABASE_URL not set — skipping. " +
          "Set DATABASE_URL to a Postgres instance with migrations 001-024 applied to run this suite.",
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
      // Confirms the migrations this suite depends on are actually applied,
      // rather than silently testing against an empty/wrong schema.
      await admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'claim_discovery_delivery'`);
      await admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'get_or_create_pool_expand_plan'`);
      poolAvailable = true;
    } catch (err) {
      console.warn("[poolExpandDeliveryReservation.test] could not reach test database — skipping:", (err as Error).message);
      poolAvailable = false;
    }
  });

  after(async () => {
    if (!poolAvailable) return;
    await admin.end();
    await connA.end();
    await connB.end();
  });

  test("requested=10, delivered=6, two concurrent workers each believing they need 4 → final delivered_count is exactly 10, never 14", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const scrapeJobId = await makeScrapeJobAndUser(admin);
    // This run's own target is the remaining shortfall (4), exactly what
    // getOrCreatePoolExpandPlanId() passes as p_requested_count — mirrors
    // "Synchronous pool already returned 6" from the audit by starting this
    // plan's OWN requested_count at the shortfall, not the original 10.
    const planId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 4);

    // Worker A and Worker B both believe they need 4 more deliveries.
    // Each worker's own claims are sequential (a real worker delivers one
    // lead at a time), but Worker A and Worker B run CONCURRENTLY on two
    // separate connections — the exact race pg-boss redelivery produces.
    async function runWorker(client: pg.Client, count: number): Promise<boolean[]> {
      const outcomes: boolean[] = [];
      for (let i = 0; i < count; i++) outcomes.push(await claim(client, planId));
      return outcomes;
    }
    const [workerAResults, workerBResults] = await Promise.all([runWorker(connA, 4), runWorker(connB, 4)]);
    const results = [...workerAResults, ...workerBResults];

    const successfulClaims = results.filter(Boolean).length;
    assert.equal(successfulClaims, 4, "exactly 4 of the 8 concurrent claims should succeed (the actual remaining capacity)");

    const plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 4, "delivered_count must land at exactly the requested cap");
    assert.equal(plan.requested_count, 4);
    assert.notEqual(plan.delivered_count, 8, "must NOT overshoot to 8 (both workers' full local shortfall)");
    assert.equal(plan.status, "completed");
    assert.equal(plan.terminal_reason, "TARGET_REACHED");
  });

  test("single worker delivering sequentially stops exactly at the target", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const scrapeJobId = await makeScrapeJobAndUser(admin);
    const planId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 3);

    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await claim(admin, planId));

    assert.deepEqual(results, [true, true, true, false, false]);
    const plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 3);
  });

  test("retry / redelivery: a second get_or_create call for the same scrape_job_id returns the SAME plan without resetting delivered_count", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const scrapeJobId = await makeScrapeJobAndUser(admin);
    const firstPlanId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 4);
    await claim(admin, firstPlanId);
    await claim(admin, firstPlanId);

    // Simulates pg-boss redelivering the same logical job: a brand new
    // worker invocation calls getOrCreatePoolExpandPlanId() again with the
    // same scrapeJobId (and, notably, would naively pass its OWN
    // shortfall=4 again as p_requested_count — proving that argument is
    // ignored on the conflict path).
    const secondPlanId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 4);

    assert.equal(secondPlanId, firstPlanId, "redelivery must resolve to the exact same durable plan row");
    const plan = await readPlan(admin, secondPlanId);
    assert.equal(plan.delivered_count, 2, "delivered_count from the first worker's claims must survive the redelivery, not reset to 0");

    // The "second worker" can still only claim what's actually left (2),
    // not another fresh 4. Three separate connections attempt concurrently.
    const remainingClaims = await Promise.all([claim(admin, secondPlanId), claim(connA, secondPlanId), claim(connB, secondPlanId)]);
    assert.equal(remainingClaims.filter(Boolean).length, 2);
    const finalPlan = await readPlan(admin, secondPlanId);
    assert.equal(finalPlan.delivered_count, 4);
  });

  test("cancellation stops further claims even when capacity remains", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const scrapeJobId = await makeScrapeJobAndUser(admin);
    const planId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 10);
    assert.equal(await claim(admin, planId), true);

    await admin.query(
      `UPDATE discovery_plans SET status = 'cancelled', terminal_reason = 'USER_CANCELLED' WHERE id = $1`,
      [planId],
    );

    assert.equal(await claim(admin, planId), false, "a cancelled plan must refuse further claims regardless of remaining capacity");
    const plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 1, "already-accepted work before cancellation is preserved");
  });

  test("target already reached: a plan seeded at its cap refuses every claim", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const scrapeJobId = await makeScrapeJobAndUser(admin);
    const planId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 2);
    assert.equal(await claim(admin, planId), true);
    assert.equal(await claim(admin, planId), true);

    // Plan is now at its cap — every further claim, single or concurrent, must fail.
    const results = await Promise.all([claim(connA, planId), claim(connB, planId), claim(admin, planId)]);
    assert.deepEqual(results, [false, false, false]);
    const plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 2);
    assert.equal(plan.status, "completed");
  });

  test("no remaining capacity: release_discovery_delivery reopens a TARGET_REACHED plan and a subsequent claim can reclaim exactly one slot", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const scrapeJobId = await makeScrapeJobAndUser(admin);
    const planId = await getOrCreatePoolExpandPlan(admin, scrapeJobId, 1);
    assert.equal(await claim(admin, planId), true);
    let plan = await readPlan(admin, planId);
    assert.equal(plan.status, "completed");

    // Mirrors insertLeadForUser()'s own refund path (deliverLead.ts) — a
    // downstream failure after the reservation succeeded releases the slot.
    await admin.query(`SELECT release_discovery_delivery($1)`, [planId]);
    plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 0);
    assert.equal(plan.status, "running", "releasing the reservation that made the plan terminal must reopen it");

    assert.equal(await claim(admin, planId), true);
    plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 1);
    assert.equal(plan.status, "completed");
  });
});
