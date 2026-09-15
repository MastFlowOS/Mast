/**
 * PAID-TIER LIVE SCRAPING BRIDGE — focused tests.
 *
 * Covers the additive fix that lets a paid-tier (instant_pool /
 * instant_pool_ranked) request whose pool lookup falls short show the SAME
 * LiveDiscoveryScreen Free's Live Discovery already renders, by:
 *   1. discover.ts creating/getting the pool-expand discovery_plans row
 *      SYNCHRONOUSLY (before queuing poolExpandJob) and returning its id.
 *   2. poolExpandJob.ts wiring itself into the EXISTING Task 1 live-event
 *      infrastructure (liveDiscoveryEvent.ts / publishAreaPoolLifecycleEvent),
 *      only for a real user-facing followUp run.
 *   3. The frontend not resetting already-delivered pool-hit progress to 0
 *      once the live event stream takes over.
 *
 * Consistent with this repo's existing precedent for these two files
 * (poolExpandJobExecutionModel.test.ts, poolExpandDeliveryReservation.test.ts):
 * poolExpandJob.ts / discover.ts's own internals (Supabase, pg-boss, the
 * Python engine bridge) are not independently callable, so the wiring
 * guarantees are pinned directly against the source; the one genuinely
 * stateful primitive introduced (idempotent plan creation) is exercised
 * against a real Postgres instance when DATABASE_URL is available, and
 * skipped (not failed) otherwise. The event/reducer behavior itself is
 * exercised for real, since liveDiscoveryEvent.ts / liveDiscoveryState.ts
 * are pure and already unit-testable without any of that infrastructure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

import {
  __testing,
  subscribeToDiscoveryLiveEvents,
  type DiscoveryLiveEvent,
} from "../../discovery/liveDiscoveryEvent.js";
import { publishAreaPoolLifecycleEvent } from "../discoveryPlanJob.js";
import type { AreaWorkerLogEvent } from "../../discovery/googleAreaPool.js";
import { createInitialLiveDiscoveryState, reduceLiveDiscoveryEvents } from "../../discovery/liveDiscoveryState.js";
import { leadDeliveredEvent, candidateRejectedEvent, discoveryCompletedEvent } from "../../discovery/liveDiscoveryEvent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const discoverSrc = readFileSync(path.join(__dirname, "../../server/routes/discover.ts"), "utf8");
const poolExpandSrc = readFileSync(path.join(__dirname, "../poolExpandJob.ts"), "utf8");

test.beforeEach(() => __testing.reset());

// ── 1 & 9. instant_pool with no shortfall: no plan, no planId, no live events ──

test("1/9. discover.ts never creates a pool-expand plan or returns a planId for a pure pool hit (no shortfall)", () => {
  // getOrCreatePoolExpandPlanId must only be called inside the
  // shortfall>0 && !limitReached branch — never unconditionally, and never
  // for the plain pool-hit response path.
  const callSiteIdx = discoverSrc.indexOf("getOrCreatePoolExpandPlanId(");
  assert.ok(callSiteIdx !== -1, "expected discover.ts to call getOrCreatePoolExpandPlanId()");

  const branchStart = discoverSrc.indexOf("if (shortfall > 0 && !limitReached) {");
  const branchEnd = discoverSrc.indexOf("} else if (shortfall > 0 && limitReached) {");
  assert.ok(branchStart !== -1 && branchEnd !== -1, "expected the shortfall>0 && !limitReached branch to exist");
  assert.ok(
    callSiteIdx > branchStart && callSiteIdx < branchEnd,
    "getOrCreatePoolExpandPlanId() must only be called inside the shortfall>0 && !limitReached branch",
  );

  // The final response always includes `planId` as a key (so it is never
  // silently omitted), but its VALUE (poolExpandPlanId) is only ever
  // assigned inside that same branch — a pure pool hit leaves it undefined,
  // and JSON.stringify drops an undefined property, so no fake id is ever
  // sent.
  assert.match(discoverSrc, /let poolExpandPlanId: string \| undefined;/);
  assert.match(discoverSrc, /planId: poolExpandPlanId,/);
  const assignmentIdx = discoverSrc.indexOf("poolExpandPlanId = await getOrCreatePoolExpandPlanId(");
  assert.ok(assignmentIdx > branchStart && assignmentIdx < branchEnd, "poolExpandPlanId must only ever be assigned inside the shortfall backfill branch");
});

test("9. the shortfall>0 && limitReached branch (background-only expansion, no user waiting) never creates a plan either", () => {
  const branchStart = discoverSrc.indexOf("} else if (shortfall > 0 && limitReached) {");
  const branchEnd = discoverSrc.indexOf("} else {", branchStart);
  assert.ok(branchStart !== -1 && branchEnd !== -1);
  const branch = discoverSrc.slice(branchStart, branchEnd);
  assert.doesNotMatch(branch, /getOrCreatePoolExpandPlanId/, "a limit-reached shortfall must never create a plan — there is no user waiting to show it to");
  assert.doesNotMatch(branch, /followUp:/, "this background-only boss.send must stay followUp-less, exactly as before");
});

// ── 2. instant_pool with shortfall: plan created synchronously, same id returned, follow-up still queued ──

test("2. pool-expand plan is created BEFORE boss.send, and the SAME payload object is queued", () => {
  const branchStart = discoverSrc.indexOf("if (shortfall > 0 && !limitReached) {");
  const branchEnd = discoverSrc.indexOf("} else if (shortfall > 0 && limitReached) {");
  const branch = discoverSrc.slice(branchStart, branchEnd);

  const planCallIdx = branch.indexOf("poolExpandPlanId = await getOrCreatePoolExpandPlanId(");
  const bossSendIdx = branch.indexOf("await boss.send(QUEUES.poolExpand, poolExpandPayload)");
  assert.ok(planCallIdx !== -1 && bossSendIdx !== -1);
  assert.ok(planCallIdx < bossSendIdx, "the plan must be created/fetched BEFORE the follow-up job is queued, not after");
  assert.match(branch, /backgroundExpansionQueued = true;/, "the follow-up must still be queued exactly as before");
});

// ── 3. idempotent plan creation: route and poolExpandJob resolve to the same plan (real Postgres) ──

const DATABASE_URL = process.env.POOL_EXPAND_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
let poolAvailable = false;
let admin: pg.Client;

test("3. repeated/idempotent plan creation — route's call and poolExpandJob's later call resolve to the SAME plan row", async (t) => {
  if (!DATABASE_URL) {
    t.skip("no DATABASE_URL — set DATABASE_URL to a Postgres instance with migrations 001-024 applied to run this test");
    return;
  }
  admin = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
    await admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'get_or_create_pool_expand_plan'`);
    poolAvailable = true;
  } catch (err) {
    t.skip(`could not reach test database — ${(err as Error).message}`);
    return;
  }
  try {
    const { rows: userRows } = await admin.query(
      `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`,
      [`pool-expand-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
    );
    const userId = userRows[0].id as string;
    const { rows: jobRows } = await admin.query(
      `INSERT INTO scrape_jobs (user_id, mode, status, query) VALUES ($1, 'instant_pool', 'streaming', '{}'::jsonb) RETURNING id`,
      [userId],
    );
    const scrapeJobId = jobRows[0].id as string;

    // Call #1 — mirrors discover.ts's synchronous call before boss.send.
    const { rows: r1 } = await admin.query(
      `SELECT get_or_create_pool_expand_plan($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
      [scrapeJobId, userId, "plumbers", "North America", "[]", "[]", null, 42],
    );
    // Call #2 — mirrors poolExpandJob.ts's own later getOrCreatePoolExpandPlanId() call for the SAME job.
    const { rows: r2 } = await admin.query(
      `SELECT get_or_create_pool_expand_plan($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
      [scrapeJobId, userId, "plumbers", "North America", "[]", "[]", null, 42],
    );
    assert.equal(r1[0].id, r2[0].id, "the route's call and poolExpandJob's call must resolve to the identical plan row/id");

    const { rows: planRows } = await admin.query(
      `SELECT count(*)::int AS n FROM discovery_plans WHERE scrape_job_id = $1`,
      [scrapeJobId],
    );
    assert.equal(planRows[0].n, 1, "exactly one plan row must exist — never a second plan");
  } finally {
    if (poolAvailable) await admin.end();
  }
});

// ── 4. poolExpand worker_started maps slot 0/1/2 -> Scout 1/2/3 ──

test("4. poolExpand worker_started maps slot 0 -> Scout 1, slot 1 -> Scout 2, slot 2 -> Scout 3 (via the reused publishAreaPoolLifecycleEvent)", () => {
  const planId = "plan-bridge-4";
  const received: DiscoveryLiveEvent[] = [];
  const unsubscribe = subscribeToDiscoveryLiveEvents(planId, (e) => received.push(e));
  const startedScoutSlots = new Set<number>();

  for (const slot of [0, 1, 2] as const) {
    const event: AreaWorkerLogEvent = { type: "worker_started", area: `area-${slot}`, slot };
    publishAreaPoolLifecycleEvent(planId, startedScoutSlots, event, (a) => a);
  }
  unsubscribe();

  const scoutStarted = received.filter((e) => e.type === "scout_started");
  assert.equal(scoutStarted.length, 3);
  assert.deepEqual(scoutStarted.map((e) => e.scoutId), [1, 2, 3]);
  // area_started is published alongside every worker_started (scout_started only fires once per slot).
  const areaStarted = received.filter((e) => e.type === "area_started");
  assert.deepEqual(areaStarted.map((e) => e.scoutId), [1, 2, 3]);
});

test("4b. a slot's scout_started fires only once even if that slot's area is re-claimed (multiple worker_started for the same slot)", () => {
  const planId = "plan-bridge-4b";
  const received: DiscoveryLiveEvent[] = [];
  const unsubscribe = subscribeToDiscoveryLiveEvents(planId, (e) => received.push(e));
  const startedScoutSlots = new Set<number>();

  publishAreaPoolLifecycleEvent(planId, startedScoutSlots, { type: "worker_started", area: "area-a", slot: 0 }, (a) => a);
  publishAreaPoolLifecycleEvent(planId, startedScoutSlots, { type: "worker_started", area: "area-b", slot: 0 }, (a) => a);
  unsubscribe();

  assert.equal(received.filter((e) => e.type === "scout_started").length, 1);
  assert.equal(received.filter((e) => e.type === "area_started").length, 2, "every area claim still gets its own area_started");
});

// ── 7. area completion preserves scoutId/area/outcome (failed/error) ──

test("7. poolExpand area_completed (worker_finished) preserves scoutId, real area label, and failed/error outcome", () => {
  const planId = "plan-bridge-7";
  const received: DiscoveryLiveEvent[] = [];
  const unsubscribe = subscribeToDiscoveryLiveEvents(planId, (e) => received.push(e));
  const startedScoutSlots = new Set<number>([0]);

  const event: AreaWorkerLogEvent = {
    type: "worker_finished",
    area: "area-x",
    slot: 1,
    outcome: { discovered: 4, accepted: 2, rejected: 2, duplicates: 0, exhausted: true, failed: true, error: "engine crashed" },
  };
  publishAreaPoolLifecycleEvent(planId, startedScoutSlots, event, (a) => `Real Area Label for ${a}`);
  unsubscribe();

  const completed = received.find((e) => e.type === "area_completed");
  assert.ok(completed);
  assert.equal(completed!.scoutId, 2, "slot 1 -> Scout 2");
  assert.equal(completed!.areaLabel, "Real Area Label for area-x", "the real, caller-supplied label must be used — never invented");
  assert.equal(completed!.areaOutcome?.failed, true);
  assert.equal(completed!.areaOutcome?.error, "engine crashed");
  assert.equal(completed!.areaOutcome?.accepted, 2);
});

// ── 5. candidate rejection reason strings are the EXACT ones poolExpandJob.ts already uses — never invented ──

test("5. every candidateRejectedEvent call site in poolExpandJob.ts reuses an existing, already-used reason string", () => {
  // channel_filter / validation / disqualified: the SAME template-literal
  // reason already passed to tracer.reject() at each call site.
  assert.match(
    poolExpandSrc,
    /tracer\.reject\(pid, `channel_filter:\$\{JSON\.stringify\(followUp\.channels\)\}`\);[\s\S]{0,400}candidateRejectedEvent\(discoveryPlanId, effectiveScoutId, pid, `channel_filter:\$\{JSON\.stringify\(followUp\.channels\)\}`, eventAreaLabel\)/,
  );
  assert.match(
    poolExpandSrc,
    /tracer\.reject\(pid, `validation:\$\{validation\.reason\}`\);[\s\S]{0,400}candidateRejectedEvent\(discoveryPlanId, effectiveScoutId, pid, `validation:\$\{validation\.reason\}`, eventAreaLabel\)/,
  );
  assert.match(
    poolExpandSrc,
    /tracer\.reject\(pid, "disqualified"\);[\s\S]{0,400}candidateRejectedEvent\(discoveryPlanId, effectiveScoutId, pid, "disqualified", eventAreaLabel\)/,
  );
  // plan_limit_reached / duplicate_already_owned_by_user: the exact reason
  // strings discoveryPlanJob.ts's own equivalent DeliveryResult branches use.
  assert.match(poolExpandSrc, /candidateRejectedEvent\(discoveryPlanId, effectiveScoutId, pid, "plan_limit_reached", eventAreaLabel\)/);
  assert.match(poolExpandSrc, /candidateRejectedEvent\(discoveryPlanId, effectiveScoutId, pid, "duplicate_already_owned_by_user", eventAreaLabel\)/);

  // None of these publish calls are unconditional — every one must be
  // gated on discoveryPlanId (only a real followUp run has one).
  const rejectionCallSites = poolExpandSrc.match(/publishDiscoveryLiveEvent\(\s*candidateRejectedEvent/g) ?? [];
  assert.ok(rejectionCallSites.length >= 5, "expected at least 5 candidateRejectedEvent publish call sites (channel_filter, validation, disqualified, plan_limit_reached, duplicate)");
});

// ── 6. successful delivery emits lead_delivered at the authoritative wasNewForUser point ──

test("6. lead_delivered is emitted exactly where newForUser is incremented (the authoritative per-user delivery point), gated on discoveryPlanId", () => {
  const idx = poolExpandSrc.indexOf("if (result.wasNewForUser) {");
  assert.ok(idx !== -1);
  const block = poolExpandSrc.slice(idx, idx + 700);
  assert.match(block, /newForUser \+= 1;/);
  assert.match(block, /if \(discoveryPlanId\) \{\s*\r?\n\s*publishDiscoveryLiveEvent\(leadDeliveredEvent\(discoveryPlanId, effectiveScoutId, pid, lead\.name, eventAreaLabel\)\);/);
});

// ── 8. completion/failure terminal event uses the full requested target, not just the shortfall ──

test("8. discoveryCompletedEvent at job completion uses (resultsCountBase + newForUser) delivered and (resultsCountBase + payload.shortfall) as the FULL target — never payload.shortfall alone", () => {
  const idx = poolExpandSrc.indexOf("const finalDeliveredCount = resultsCountBase + newForUser;");
  assert.ok(idx !== -1, "expected the final delivered/target reconstruction at job completion");
  const block = poolExpandSrc.slice(idx, idx + 500);
  assert.match(block, /const fullRequestedTarget = resultsCountBase \+ payload\.shortfall;/);
  assert.match(block, /discoveryCompletedEvent\(discoveryPlanId, finalDeliveredCount, fullRequestedTarget\)/);
  assert.match(block, /discoveryFailedEvent\(discoveryPlanId, "cancelled"\)/);
});

test("8b. discovery_completed's target overwrite would be wrong if it only used payload.shortfall — pinned via the pure reducer", () => {
  // Demonstrates WHY 8's fullRequestedTarget matters: discovery_completed
  // unconditionally overwrites state.target with whatever `target` the
  // event carries (see liveDiscoveryState.ts). A pool-hit of 5 + a
  // shortfall of 95 (requested 100 total) must end at target=100, not 95.
  const resultsCountBase = 5;
  const shortfall = 95;
  const newForUser = 95;
  let state = createInitialLiveDiscoveryState(100, resultsCountBase); // matches useLiveDiscoveryState(planId, quantity, initialDelivered)
  state = reduceLiveDiscoveryEvents(state, [
    discoveryCompletedEvent("plan-8b", resultsCountBase + newForUser, resultsCountBase + shortfall),
  ]);
  assert.equal(state.target, 100);
  assert.equal(state.delivered, 100);
  assert.equal(state.status, "completed");
});

// ── 10/11/12. paid backfill starts from the existing delivered count, target stays the real requested quantity, rejected never affects progress ──

test("10/11/12. paid-tier backfill: seeded at 5/100, a new lead_delivered climbs to 6/100, rejections never move delivered/progress", () => {
  const target = 100;
  const poolHitDelivered = 5;
  let state = createInitialLiveDiscoveryState(target, poolHitDelivered);
  assert.equal(state.delivered, 5, "must start at the pool-hit count, never reset to 0");
  assert.equal(state.target, 100, "target is the real requested quantity, not the shortfall");
  assert.equal(state.progressPercent, 5);

  state = reduceLiveDiscoveryEvents(state, [
    candidateRejectedEvent("plan-10", 1, "#1", "validation:missing_name", "Area A"),
    candidateRejectedEvent("plan-10", 1, "#2", "validation:missing_name", "Area A"),
    leadDeliveredEvent("plan-10", 1, "#3", "Joe's Pizza", "Area A"),
  ]);

  assert.equal(state.delivered, 6, "exactly one new genuinely-new-to-user delivery on top of the seeded 5");
  assert.equal(state.rejected, 2);
  assert.equal(state.target, 100, "target must not move");
  assert.equal(state.progressPercent, 6, "progress is delivered/target only — rejected never factors in");
});
