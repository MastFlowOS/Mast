/**
 * Phase 3B — Discovery Concurrency Audit + Implementation.
 *
 * These tests exercise the REAL row-claim semantics multiple concurrent
 * `discovery.task` workers rely on — against a real Postgres database, not
 * a JS-level simulation — matching the existing convention in this
 * directory (poolExpandDeliveryReservation.test.ts). Two things are under
 * test here that dispatchConcurrency.test.ts (pure-logic, no DB) cannot
 * cover:
 *
 *   1. discovery_tasks row claiming: the same conditional
 *      `UPDATE ... WHERE status = 'queued' ... RETURNING id` pattern
 *      handleDiscoveryTask (discoveryPlanJob.ts) uses to claim a task must
 *      let two genuinely concurrent workers claim two DIFFERENT queued
 *      rows, and never let two workers both win a claim on the SAME row
 *      (Test A / Test F: no duplicate delivery of one city's work).
 *
 *   2. `claim_discovery_delivery()` (Phase 3A, migrations/015 — untouched
 *      by this phase) already enforces `accepted <= requested` for the
 *      live-discovery path exactly the way poolExpandDeliveryReservation
 *      proved it for pool.expand. This suite re-proves the SAME invariant
 *      here for a `discovery_plans` row fed by multiple concurrent
 *      "discovery task workers" each racing to deliver, which is the
 *      scenario Phase 3B's concurrency actually introduces (Phase 3A's
 *      test only exercised the pool.expand follow-up path).
 *
 * Requires DATABASE_URL (or DISCOVERY_CONCURRENCY_TEST_DATABASE_URL)
 * pointing at a Postgres instance with migrations 001-025 applied. If
 * neither is reachable, every test in this file is skipped (not failed).
 *
 * Uses Node's built-in test runner (`node:test`). Run with:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/mast_test \
 *     npx tsx --test src/discovery/__tests__/discoveryConcurrency.integration.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const DATABASE_URL = process.env.DISCOVERY_CONCURRENCY_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let poolAvailable = false;
let admin: pg.Client;
let connA: pg.Client;
let connB: pg.Client;
let connC: pg.Client;

async function makeScrapeJobAndUser(client: pg.Client): Promise<{ userId: string; scrapeJobId: string }> {
  const { rows: userRows } = await client.query(
    `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
    [`discovery-concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const userId = userRows[0].id as string;

  const { rows: jobRows } = await client.query(
    `INSERT INTO scrape_jobs (user_id, mode, status, query)
     VALUES ($1, 'live', 'queued', '{}'::jsonb)
     RETURNING id`,
    [userId],
  );
  return { userId, scrapeJobId: jobRows[0].id as string };
}

async function makePlan(client: pg.Client, userId: string, scrapeJobId: string, requestedCount: number): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO discovery_plans (scrape_job_id, user_id, niche, region, requested_count, status)
     VALUES ($1, $2, 'plumbers', 'North America', $3, 'running')
     RETURNING id`,
    [scrapeJobId, userId, requestedCount],
  );
  return rows[0].id as string;
}

async function makeQueuedTask(client: pg.Client, planId: string, userId: string, city: string): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO discovery_tasks (plan_id, user_id, niche, country_code, country_name, city, candidate_budget, priority, plan_tier_id)
     VALUES ($1, $2, 'plumbers', 'US', 'United States', $3, 20, 10, 'pro')
     RETURNING id`,
    [planId, userId, city],
  );
  return rows[0].id as string;
}

/** Mirrors handleDiscoveryTask's own claim UPDATE (discoveryPlanJob.ts) exactly. */
async function claimTask(client: pg.Client, taskId: string): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE discovery_tasks SET status = 'running', started_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING id`,
    [taskId],
  );
  return rows.length === 1;
}

async function claimDelivery(client: pg.Client, planId: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT claim_discovery_delivery($1) AS claimed`, [planId]);
  return rows[0].claimed as boolean;
}

async function readPlan(client: pg.Client, planId: string) {
  const { rows } = await client.query(
    `SELECT delivered_count, requested_count, status FROM discovery_plans WHERE id = $1`,
    [planId],
  );
  return rows[0] as { delivered_count: number; requested_count: number; status: string };
}

describe("Phase 3B: discovery concurrency — task claiming + accepted<=requested under concurrent workers", () => {
  before(async () => {
    if (!DATABASE_URL) {
      console.warn(
        "[discoveryConcurrency.integration.test] DATABASE_URL not set — skipping. " +
          "Set DATABASE_URL to a Postgres instance with migrations 001-025 applied to run this suite.",
      );
      return;
    }
    admin = new pg.Client({ connectionString: DATABASE_URL });
    connA = new pg.Client({ connectionString: DATABASE_URL });
    connB = new pg.Client({ connectionString: DATABASE_URL });
    connC = new pg.Client({ connectionString: DATABASE_URL });
    try {
      await admin.connect();
      await connA.connect();
      await connB.connect();
      await connC.connect();
      await admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'claim_discovery_delivery'`);
      await admin.query(`SELECT plan_tier_id FROM discovery_tasks LIMIT 0`); // confirms migration 025 is applied
      poolAvailable = true;
    } catch (err) {
      console.warn("[discoveryConcurrency.integration.test] could not reach test database — skipping:", (err as Error).message);
      poolAvailable = false;
    }
  });

  after(async () => {
    if (!poolAvailable) return;
    await admin.end();
    await connA.end();
    await connB.end();
    await connC.end();
  });

  // ── Test A / Test B analog: distinct city/provider tasks claimed concurrently ──
  test("Test A — three queued city tasks are claimed by three concurrent workers simultaneously, not one after another", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const { userId, scrapeJobId } = await makeScrapeJobAndUser(admin);
    const planId = await makePlan(admin, userId, scrapeJobId, 10);
    const [taskToronto, taskNewYork, taskChicago] = await Promise.all([
      makeQueuedTask(admin, planId, userId, "Toronto"),
      makeQueuedTask(admin, planId, userId, "New York"),
      makeQueuedTask(admin, planId, userId, "Chicago"),
    ]);

    // Three separate connections claim three separate rows AT THE SAME
    // TIME — genuine overlap, not `dispatchQueuedDiscoveryTasks` sending
    // them one at a time and waiting for each to finish.
    const results = await Promise.all([
      claimTask(connA, taskToronto),
      claimTask(connB, taskNewYork),
      claimTask(connC, taskChicago),
    ]);

    assert.deepEqual(results, [true, true, true], "all three independent city tasks must claim successfully in parallel");

    const { rows } = await admin.query(`SELECT status FROM discovery_tasks WHERE plan_id = $1`, [planId]);
    assert.ok(rows.every((r) => r.status === "running"), "all three tasks are genuinely running concurrently");
  });

  // ── Test F: no duplicate delivery — two workers cannot both claim the SAME task row ──
  test("Test F — two concurrent workers racing the SAME queued task: exactly one wins the claim", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const { userId, scrapeJobId } = await makeScrapeJobAndUser(admin);
    const planId = await makePlan(admin, userId, scrapeJobId, 10);
    const taskId = await makeQueuedTask(admin, planId, userId, "Toronto");

    const results = await Promise.all([
      claimTask(connA, taskId),
      claimTask(connB, taskId),
      claimTask(connC, taskId),
    ]);

    const winners = results.filter(Boolean).length;
    assert.equal(winners, 1, "exactly one of three concurrent claimants may win a single queued task row");
  });

  // ── Test C: global atomic target — accepted<=requested across concurrent workers ──
  test("Test C — requested=10: several concurrent discovery-task workers deliver leads and the plan stops at exactly 10, never 11+", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const { userId, scrapeJobId } = await makeScrapeJobAndUser(admin);
    const planId = await makePlan(admin, userId, scrapeJobId, 10);

    // Simulate 4 concurrent discovery.task workers (one per city), each
    // independently discovering and delivering multiple candidates without
    // any in-process coordination — exactly what genuine multi-city
    // parallelism produces. Collectively they attempt far more than 10
    // deliveries; claim_discovery_delivery() (Phase 3A, untouched) is the
    // sole authority that must prevent overshoot.
    async function worker(client: pg.Client, attempts: number): Promise<boolean[]> {
      const outcomes: boolean[] = [];
      for (let i = 0; i < attempts; i++) outcomes.push(await claimDelivery(client, planId));
      return outcomes;
    }

    const allOutcomes = await Promise.all([
      worker(connA, 6),
      worker(connB, 6),
      worker(connC, 6),
      worker(admin, 6),
    ]);

    const totalSuccessful = allOutcomes.flat().filter(Boolean).length;
    assert.equal(totalSuccessful, 10, "exactly 10 of the 24 concurrent delivery attempts across 4 workers may succeed");

    const plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 10);
    assert.ok(plan.delivered_count <= plan.requested_count, "accepted <= requested must hold — no 11th accepted lead for requested=10");
    assert.equal(plan.status, "completed");
  });

  // ── Test E analog: cancellation stops further acceptance even mid-flight ──
  test("cancelling the plan mid-flight blocks every subsequent concurrent delivery attempt, preserving what was already accepted", async (t) => {
    if (!poolAvailable) return t.skip("no database available");

    const { userId, scrapeJobId } = await makeScrapeJobAndUser(admin);
    const planId = await makePlan(admin, userId, scrapeJobId, 10);

    assert.equal(await claimDelivery(admin, planId), true);
    assert.equal(await claimDelivery(admin, planId), true);

    await admin.query(`UPDATE discovery_plans SET status = 'cancelled' WHERE id = $1`, [planId]);

    // Three "still-running" workers (their in-process AbortController just
    // hasn't fired yet) all attempt to deliver concurrently after cancellation.
    const results = await Promise.all([claimDelivery(connA, planId), claimDelivery(connB, planId), claimDelivery(connC, planId)]);
    assert.deepEqual(results, [false, false, false], "a cancelled plan must refuse every further concurrent claim");

    const plan = await readPlan(admin, planId);
    assert.equal(plan.delivered_count, 2, "leads accepted before cancellation are preserved, not rolled back");
  });
});
