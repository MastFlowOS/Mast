/**
 * Execution-path regression tests for POST /v1/discover.
 *
 * The real Express router, auth middleware, plan gating, validation,
 * lookupAndDeliverFromPool() and insertLeadForUser() all run; only Supabase is
 * an in-memory stand-in (helpers/fakeSupabaseAdmin.ts). `discoverDeps` spies
 * record the only two calls that could start work:
 *
 *   enqueueDiscoveryPlan        — starts Live Discovery (async job)
 *   lookupAndDeliverFromPool    — the Instant retrieval path
 *
 * Contract proven here:
 *   • Instant Pool / Ranked Instant NEVER enqueue Live Discovery, create a
 *     discovery plan, call get_or_create_pool_expand_plan, or return a planId.
 *   • A shortfall is a truthful `completed_partial` (never `completed`), with
 *     requested / delivered / shortfall reported separately.
 *   • Ranked orders GLOBALLY by Opportunity Score across niches, never changes
 *     eligibility, and never claims full ranking when it is not.
 *   • Live Discovery is a separate, explicit run (`followsJobId`) under the
 *     normal plan/credit rules.
 *   • Credits == saved leads: refunds on failure, no double-charge on repeat.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:1/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { default: express } = await import("express");
const { default: jwt } = await import("jsonwebtoken");
const { supabaseAdmin } = await import("../supabaseAdmin.js");
const { discoverRouter, discoverDeps } = await import("../../server/routes/discover.js");
const { refundLeadUsage } = await import("../../scraperBridge/deliverLead.js");
const { FakeDb, installFakeSupabase } = await import("./helpers/fakeSupabaseAdmin.js");
type Row = Record<string, any>;

const realDeps = { ...discoverDeps };

let db: InstanceType<typeof FakeDb>;
let restoreFake: () => void;
let server: import("node:http").Server;
let base: string;

let planId = "pro";
let focusArea: string | undefined = "Graphic Design"; // -> graphic_design
let usage = { daily: 0, monthly: 0 };

let jobs: Row[] = [];
let jobUpdates: Array<{ id: string; patch: Row }> = [];
let touchedTables: string[] = [];
let spies = { enqueue: [] as Row[], lookup: [] as Row[] };
let failLeadInsertOn: number | null = null;
let leadInsertAttempts = 0;
let userSeq = 0;
const newUser = () => `00000000-0000-0000-0000-${String(++userSeq).padStart(12, "0")}`;

beforeEach(async () => {
  db = new FakeDb();
  restoreFake = installFakeSupabase(supabaseAdmin, db);
  planId = "pro";
  focusArea = "Graphic Design";
  usage = { daily: 0, monthly: 0 };
  jobs = [];
  jobUpdates = [];
  touchedTables = [];
  spies = { enqueue: [], lookup: [] };
  failLeadInsertOn = null;
  leadInsertAttempts = 0;

  discoverDeps.enqueueDiscoveryPlan = (async (args: Row) => {
    spies.enqueue.push(args);
    return "plan-live-1";
  }) as typeof discoverDeps.enqueueDiscoveryPlan;
  discoverDeps.lookupAndDeliverFromPool = ((args: Row) => {
    spies.lookup.push(args);
    return realDeps.lookupAndDeliverFromPool(args as any);
  }) as typeof discoverDeps.lookupAndDeliverFromPool;

  const fakeFrom = supabaseAdmin.from.bind(supabaseAdmin) as (t: string) => any;
  const fakeRpc = supabaseAdmin.rpc.bind(supabaseAdmin) as (fn: string, a: Row) => any;

  const selectJobs = () => {
    const filters: Array<[string, "eq" | "in", any]> = [];
    const read = (r: Row, c: string) => (c === "query->>follows_job_id" ? r.query?.follows_job_id : r[c]);
    const run = () => jobs.filter((r) => filters.every(([c, op, v]) => (op === "eq" ? read(r, c) === v : (v as any[]).includes(read(r, c)))));
    const q: any = {
      eq: (c: string, v: any) => (filters.push([c, "eq", v]), q),
      in: (c: string, v: any) => (filters.push([c, "in", v]), q),
      limit: () => q,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return q;
  };

  (supabaseAdmin as any).from = (table: string) => {
    touchedTables.push(table);
    if (table === "profiles") {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: focusArea ? { focusArea } : {} }, error: null }) }) }) };
    }
    if (table === "scrape_jobs") {
      return {
        insert: (row: Row) => {
          const rec = { id: randomUUID(), ...row };
          jobs.push(rec);
          return { select: () => ({ single: async () => ({ data: rec, error: null }) }) };
        },
        update: (patch: Row) => ({
          eq: async (_c: string, id: string) => {
            const rec = jobs.find((j) => j.id === id);
            if (rec) Object.assign(rec, patch);
            jobUpdates.push({ id, patch });
            return { error: null };
          },
        }),
        select: () => selectJobs(),
      };
    }
    if (table === "leads") {
      const q = fakeFrom("leads");
      const originalInsert = q.insert.bind(q);
      q.insert = (row: Row) => {
        leadInsertAttempts += 1;
        if (failLeadInsertOn !== null && leadInsertAttempts >= failLeadInsertOn) {
          return { select: () => ({ maybeSingle: async () => ({ data: null, error: { message: "simulated insert failure" } }) }) };
        }
        return originalInsert(row);
      };
      return q;
    }
    return fakeFrom(table);
  };
  (supabaseAdmin as any).rpc = (fn: string, args: Row) => {
    touchedTables.push(`rpc:${fn}`);
    if (fn === "try_increment_lead_usage" && args.p_count === 0) {
      const data = { subscription_plan: planId, daily_leads_used: usage.daily, monthly_leads_used: usage.monthly };
      return Object.assign(Promise.resolve({ data, error: null }), {
        single: () => Promise.resolve({ data, error: null }),
      });
    }
    return fakeRpc(fn, args);
  };

  const app = express();
  app.use(express.json());
  app.use("/v1/discover", discoverRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  Object.assign(discoverDeps, realDeps);
  await new Promise((r) => server.close(r));
  restoreFake();
});

function post(body: Row, userId = newUser()) {
  const token = jwt.sign({ sub: userId }, process.env.SUPABASE_JWT_SECRET!, { algorithm: "HS256" });
  return fetch(`${base}/v1/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ quantity: 5, region: "United States", niche: "Coffee Shops", channels: [], ...body }),
  });
}

type BizOpts = { niche?: string; email?: boolean; phone?: boolean; instagram?: boolean; website?: boolean; day?: number; disqualified?: boolean; country?: string };
function addBiz(name: string, o: BizOpts = {}) {
  const id = db.nextId("biz");
  db.businesses.push({
    id,
    name,
    niche: o.niche ?? "Coffee Shops",
    region: "United States",
    country_code: o.country ?? "US",
    address: "1 Main St",
    website: o.website === false ? null : `https://${name}.test`,
    email: o.email === false ? null : `${name}@x.test`,
    phone: o.phone === false ? null : "+15550001111",
    instagram: o.instagram === false ? null : `@${name}`,
    is_disqualified: o.disqualified ?? false,
    first_discovered_at: `2026-01-${String(o.day ?? 1).padStart(2, "0")}T00:00:00Z`,
    fingerprints: [],
  });
  return id;
}
const nameOf = (id: string) => db.businesses.find((b) => b.id === id)!.name;
const FORBIDDEN_LIVE_TOUCHES = ["discovery_plans", "discovery_tasks", "rpc:get_or_create_pool_expand_plan", "rpc:claim_discovery_delivery"];
function assertNoLiveWork() {
  assert.equal(spies.enqueue.length, 0, "Instant must never call enqueueDiscoveryPlan");
  for (const t of FORBIDDEN_LIVE_TOUCHES) assert.ok(!touchedTables.includes(t), `Instant must never touch ${t}`);
}

describe("Instant Pool never starts live work", () => {
  test("a full pool hit is synchronous, completed, with no planId and no live dispatch", async () => {
    planId = "starter";
    for (let i = 1; i <= 6; i++) addBiz(`c${i}`, { day: i });
    const res = await post({ method: "instant_pool" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "completed");
    assert.equal(body.requested, 5);
    assert.equal(body.delivered, 5);
    assert.equal(body.shortfall, 0);
    assert.equal(body.shortfallReason, null);
    assert.equal(body.planId, undefined);
    assert.equal(body.backgroundExpansionQueued, false);
    assert.equal(body.liveFollowUp.available, false);
    assert.equal(spies.lookup.length, 1, "uses the pool retrieval path exactly once");
    assert.equal(spies.lookup[0].rank, false);
    assertNoLiveWork();
    assert.equal(jobs[0].mode, "instant_pool");
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].results_count, 5);
  });

  test("a SHORT pool returns the legitimate matches as completed_partial and still dispatches nothing", async () => {
    planId = "starter";
    addBiz("c1", { day: 1 });
    addBiz("c2", { day: 2 });
    addBiz("c3", { day: 3 });
    const res = await post({ method: "instant_pool" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "completed_partial");
    assert.equal(body.requested, 5);
    assert.equal(body.delivered, 3);
    assert.equal(body.shortfall, 2);
    assert.equal(body.shortfallReason, "pool_exhausted");
    assert.equal(body.planId, undefined);
    assert.equal(body.backgroundExpansionQueued, false);
    assert.deepEqual(body.liveFollowUp, { available: true, remaining: 2 });
    assertNoLiveWork();
    assert.equal(jobs[0].status, "completed_partial");
    assert.equal(jobs[0].results_count, 3);
    assert.equal(jobs[0].job_summary.shortfall, 2);
    assert.equal(jobs[0].job_summary.completion_reason, "exhausted");
    assert.equal(db.leads.length, 3);
  });

  test("an empty pool is a truthful zero-delivery partial, not a success and not live scraping", async () => {
    planId = "starter";
    const res = await post({ method: "instant_pool" });
    const body = await res.json();
    assert.equal(body.status, "completed_partial");
    assert.equal(body.delivered, 0);
    assert.equal(body.shortfall, 5);
    assertNoLiveWork();
    assert.equal(db.usageUsed, 0);
  });

  test("filters are never weakened to fill the request (niche, geography, disqualified, channels)", async () => {
    planId = "pro";
    addBiz("ok-1", { day: 1 });
    addBiz("wrong-niche", { niche: "Gyms", day: 2 });
    addBiz("wrong-country", { country: "GB", day: 3 });
    addBiz("dq", { disqualified: true, day: 4 });
    addBiz("no-phone", { phone: false, day: 5 });
    const res = await post({ method: "instant_pool", channels: ["email", "phone"] });
    const body = await res.json();
    assert.equal(body.delivered, 1);
    assert.deepEqual(body.results.map((r: Row) => nameOf(r.businessId)), ["ok-1"]);
    assert.equal(body.status, "completed_partial");
    assertNoLiveWork();
  });

  test("channel filtering happens BEFORE the result limit (newer incomplete rows cannot hide older eligible ones)", async () => {
    planId = "pro";
    addBiz("old-a", { day: 1 });
    addBiz("old-b", { day: 2 });
    addBiz("new-x", { phone: false, day: 20 });
    addBiz("new-y", { phone: false, day: 21 });
    addBiz("new-z", { email: false, day: 22 });
    const res = await post({ method: "instant_pool", quantity: 2, channels: ["email", "phone"] });
    const body = await res.json();
    assert.equal(body.delivered, 2);
    assert.equal(body.status, "completed");
    assert.deepEqual(body.results.map((r: Row) => nameOf(r.businessId)).sort(), ["old-a", "old-b"]);
    assert.equal(spies.lookup[0].channels.join(","), "email,phone", "the channel list reaches the pool query");
  });

  test("channel contract is AND: all four selected channels are present on every delivered lead", async () => {
    planId = "pro";
    addBiz("full", { day: 1 });
    addBiz("no-ig", { instagram: false, day: 2 });
    addBiz("no-site", { website: false, day: 3 });
    const res = await post({ method: "instant_pool", channels: ["email", "phone", "instagram", "website"] });
    const body = await res.json();
    assert.deepEqual(body.results.map((r: Row) => nameOf(r.businessId)), ["full"]);
    const lead = db.leads[0];
    assert.ok(lead.email && lead.phone && lead.instagram_handle && lead.website, "saved lead record carries all four channels");
  });
});

describe("Ranked Instant never starts live work and ranks globally", () => {
  test("pool-only: a shortfall is completed_partial, no live dispatch, ranked ordering by score desc", async () => {
    planId = "pro";
    const a = addBiz("low", { day: 3 });
    const b = addBiz("high", { day: 1 });
    const c = addBiz("mid", { day: 2 });
    db.opportunityScores.set(a, 40).set(b, 95).set(c, 70);
    const res = await post({ method: "instant_pool_ranked" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "completed_partial");
    assert.equal(body.delivered, 3);
    assert.equal(body.shortfall, 2);
    assert.equal(spies.lookup[0].rank, true);
    assert.deepEqual(body.results.map((r: Row) => nameOf(r.businessId)), ["high", "mid", "low"]);
    assert.deepEqual(body.results.map((r: Row) => r.opportunityScore), [95, 70, 40]);
    assert.equal(body.ranking.status, "full");
    assert.equal(body.planId, undefined);
    assertNoLiveWork();
    assert.equal(jobs[0].mode, "instant_pool_ranked");
  });

  test("ranking is GLOBAL across multiple niches (not niche-by-niche)", async () => {
    planId = "pro";
    const c1 = addBiz("coffee-50", { niche: "Coffee Shops", day: 5 });
    const c2 = addBiz("coffee-40", { niche: "Coffee Shops", day: 4 });
    const b1 = addBiz("bakery-90", { niche: "Bakeries", day: 2 });
    const b2 = addBiz("bakery-10", { niche: "Bakeries", day: 1 });
    db.opportunityScores.set(c1, 50).set(c2, 40).set(b1, 90).set(b2, 10);
    const res = await post({ method: "instant_pool_ranked", niche: "Coffee Shops, Bakeries", quantity: 4 });
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r: Row) => nameOf(r.businessId)),
      ["bakery-90", "coffee-50", "coffee-40", "bakery-10"],
      "a later niche's top score must outrank an earlier niche's lower score",
    );
    assert.equal(body.ranking.status, "full");
  });

  test("ranking changes ORDER only — an unscored candidate is still eligible, placed last, and the result is NOT claimed fully ranked", async () => {
    planId = "pro";
    const scored = addBiz("scored", { day: 1 });
    addBiz("unscored-newest", { day: 9 });
    db.opportunityScores.set(scored, 55);
    const res = await post({ method: "instant_pool_ranked" });
    const body = await res.json();
    assert.deepEqual(body.results.map((r: Row) => nameOf(r.businessId)), ["scored", "unscored-newest"]);
    assert.equal(body.ranking.status, "partial");
    assert.equal(body.ranking.scored, 1);
    assert.equal(body.ranking.unscored, 1);
    assert.equal(body.ranking.policy, "unscored_last");
  });

  test("no profession focus -> ranking is reported UNAVAILABLE (never silently claimed), eligibility unchanged", async () => {
    planId = "pro";
    focusArea = undefined;
    const id = addBiz("x", { day: 1 });
    db.opportunityScores.set(id, 99); // cannot join: no profession slug
    const res = await post({ method: "instant_pool_ranked" });
    const body = await res.json();
    assert.equal(body.delivered, 1);
    assert.equal(body.ranking.status, "unavailable");
    assert.equal(body.ranking.reason, "no_profession_focus");
    assertNoLiveWork();
  });
});

describe("Live Discovery is its own asynchronous path", () => {
  test("method live enqueues exactly one plan, returns 202 + planId, and never touches the pool", async () => {
    planId = "pro";
    addBiz("pool-biz");
    const res = await post({ method: "live", channels: ["email"] });
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.equal(body.status, "queued");
    assert.equal(body.planId, "plan-live-1");
    assert.equal(body.mode, "live");
    assert.equal(body.jobId, jobs[0].id);
    assert.equal(spies.enqueue.length, 1);
    assert.equal(spies.enqueue[0].scrapeJobId, jobs[0].id);
    assert.deepEqual(spies.enqueue[0].channels, ["email"]);
    assert.equal(spies.enqueue[0].quantity, 5);
    assert.equal(spies.lookup.length, 0, "Live Discovery must not run the pool retrieval path");
    assert.equal(db.leads.length, 0);
    assert.equal(jobs[0].status, "queued");
  });

  test("if the live plan cannot be queued the job terminates as failed instead of staying queued forever", async () => {
    planId = "pro";
    discoverDeps.enqueueDiscoveryPlan = (async () => {
      throw new Error("queue unavailable");
    }) as typeof discoverDeps.enqueueDiscoveryPlan;
    const res = await post({ method: "live" });
    assert.ok(res.status >= 500);
    assert.equal(jobs[0].status, "failed");
    assert.match(jobs[0].error, /queue unavailable/);
    assert.ok(jobs[0].completed_at);
  });

  test("omitting method uses the plan ceiling: free -> live, starter -> instant_pool, pro -> ranked", async () => {
    planId = "free";
    await post({});
    assert.equal(jobs[0].mode, "live");
    planId = "starter";
    await post({});
    assert.equal(jobs[1].mode, "instant_pool");
    planId = "pro";
    await post({});
    assert.equal(jobs[2].mode, "instant_pool_ranked");
  });
});

describe("plan permissions for all three modes", () => {
  const cases: Array<[string, string, number]> = [
    ["free", "live", 202],
    ["free", "instant_pool", 403],
    ["free", "instant_pool_ranked", 403],
    ["starter", "live", 202],
    ["starter", "instant_pool", 200],
    ["starter", "instant_pool_ranked", 403],
    ["pro", "live", 202],
    ["pro", "instant_pool", 200],
    ["pro", "instant_pool_ranked", 200],
    ["premium", "instant_pool_ranked", 200],
  ];
  for (const [p, method, expected] of cases) {
    test(`${p} + ${method} -> ${expected}`, async () => {
      planId = p;
      const res = await post({ method });
      assert.equal(res.status, expected);
      if (expected === 403) {
        assert.equal((await res.json()).code, "method_restricted");
        assert.equal(jobs.length, 0, "a refused method creates no job");
        assert.equal(spies.lookup.length + spies.enqueue.length, 0);
      }
    });
  }

  test("an unsupported method value fails explicitly and starts nothing", async () => {
    planId = "premium";
    const res = await post({ method: "turbo_instant" });
    assert.ok(res.status >= 400, `expected an error, got ${res.status}`);
    assert.equal(jobs.length, 0);
    assert.equal(spies.lookup.length + spies.enqueue.length, 0);
  });
});

describe("credits reconcile with what was actually saved", () => {
  test("one credit per saved lead; usage equals leads inserted", async () => {
    planId = "starter";
    for (let i = 1; i <= 3; i++) addBiz(`c${i}`, { day: i });
    const body = await (await post({ method: "instant_pool", quantity: 3 })).json();
    assert.equal(body.delivered, 3);
    assert.equal(db.leads.length, 3);
    assert.equal(db.usageUsed, 3);
  });

  test("a plan limit that stops the run is completed_partial in the BOTH response and the job row (never 'completed')", async () => {
    planId = "starter";
    db.usageCap = 2;
    for (let i = 1; i <= 5; i++) addBiz(`c${i}`, { day: i });
    const body = await (await post({ method: "instant_pool" })).json();
    assert.equal(body.delivered, 2);
    assert.equal(body.status, "completed_partial");
    assert.equal(body.limitReached, true);
    assert.equal(body.shortfallReason, "plan_limit_reached");
    assert.equal(body.liveFollowUp.available, false, "no live follow-up is offered when the plan limit is the reason");
    assert.equal(jobs[0].status, "completed_partial");
    assert.equal(jobs[0].job_summary.completion_reason, "limit_reached");
    assert.equal(db.usageUsed, 2);
    assertNoLiveWork();
  });

  test("a mid-run insert failure refunds that lead's credit, keeps what was delivered, and reports it as interrupted", async () => {
    planId = "starter";
    for (let i = 1; i <= 4; i++) addBiz(`c${i}`, { day: i });
    failLeadInsertOn = 2;
    const res = await post({ method: "instant_pool" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.interrupted, true);
    assert.equal(body.status, "completed_partial");
    assert.equal(body.delivered, 1);
    assert.equal(body.shortfallReason, "pool_delivery_interrupted");
    assert.equal(db.leads.length, 1);
    assert.equal(db.usageUsed, 1, "the failed lead's reservation was refunded; only the saved lead is charged");
    assert.equal(jobs[0].status, "completed_partial");
    assert.equal(jobs[0].results_count, 1);
    assertNoLiveWork();
  });

  test("if nothing could be delivered the run FAILS visibly (500 + job failed) and no credits remain charged", async () => {
    planId = "starter";
    addBiz("c1");
    failLeadInsertOn = 1;
    const res = await post({ method: "instant_pool" });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, "pool_delivery_failed");
    assert.equal(jobs[0].status, "failed");
    assert.equal(db.leads.length, 0);
    assert.equal(db.usageUsed, 0);
  });

  test("a pool query error marks the job failed instead of leaving it queued", async () => {
    planId = "starter";
    discoverDeps.lookupAndDeliverFromPool = (async () => {
      throw new Error("pool_lookup exploded");
    }) as typeof discoverDeps.lookupAndDeliverFromPool;
    const res = await post({ method: "instant_pool" });
    assert.ok(res.status >= 500);
    assert.equal(jobs[0].status, "failed");
    assert.match(jobs[0].error, /pool_lookup exploded/);
  });

  test("a repeated identical request (retry / repeated event) never double-delivers or double-charges", async () => {
    planId = "starter";
    for (let i = 1; i <= 3; i++) addBiz(`c${i}`, { day: i });
    const user = newUser();
    const first = await (await post({ method: "instant_pool", quantity: 3 }, user)).json();
    const second = await (await post({ method: "instant_pool", quantity: 3 }, user)).json();
    assert.equal(first.delivered, 3);
    assert.equal(second.delivered, 0, "already-owned businesses are excluded, not re-delivered");
    assert.equal(second.status, "completed_partial");
    assert.equal(db.leads.length, 3);
    assert.equal(db.usageUsed, 3, "credits charged once per lead, never again on retry");
    const ids = db.leads.map((l) => l.business_id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate lead rows");
  });

  test("a duplicate-key race at insert refunds the reservation (no charge for a lead that was not delivered)", async () => {
    planId = "starter";
    const id = addBiz("raced");
    const user = newUser();
    // The pre-insert existence check sees nothing, then another request wins the insert.
    const realFrom = (supabaseAdmin as any).from;
    let sneaked = false;
    (supabaseAdmin as any).from = (table: string) => {
      const q = realFrom(table);
      if (table !== "leads") return q;
      const originalInsert = q.insert.bind(q);
      q.insert = (row: Row) => {
        if (!sneaked) {
          sneaked = true;
          db.leads.push({ id: "other-request", user_id: row.user_id, business_id: row.business_id });
        }
        return originalInsert(row);
      };
      return q;
    };
    const body = await (await post({ method: "instant_pool", quantity: 1 }, user)).json();
    assert.equal(body.delivered, 0);
    assert.equal(db.leads.filter((l) => l.business_id === id).length, 1);
    assert.equal(db.usageUsed, 0, "the reserved credit was refunded");
  });

  test("refundLeadUsage reports failure loudly (and returns false) instead of silently keeping the credit", async () => {
    db.refundFails = true;
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const ok = await refundLeadUsage({ userId: "u1", dailyLimit: 10, monthlyLimit: 100 }, "insert_failed");
      assert.equal(ok, false);
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((e) => String(e[0]).includes("REFUND FAILED") && String(e[0]).includes("reason=insert_failed")));
  });
});

describe("explicit Live Discovery follow-up is a SEPARATE, authorized run", () => {
  async function partialInstantRun(user: string) {
    planId = "starter";
    addBiz("c1", { day: 1 });
    addBiz("c2", { day: 2 });
    const res = await post({ method: "instant_pool", channels: ["email"] }, user);
    const body = await res.json();
    assert.equal(body.status, "completed_partial");
    assert.equal(body.shortfall, 3);
    return body;
  }
  const followUp = (user: string, over: Row = {}) =>
    post({ method: "live", channels: ["email"], quantity: 3, ...over }, user);

  test("starts its OWN job + plan; the Instant job and its counters are untouched", async () => {
    const user = newUser();
    const instant = await partialInstantRun(user);
    const instantJobBefore = JSON.stringify(jobs[0]);
    const res = await followUp(user, { followsJobId: instant.jobId });
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.notEqual(body.jobId, instant.jobId);
    assert.equal(body.followsJobId, instant.jobId);
    assert.equal(body.planId, "plan-live-1");
    assert.equal(spies.enqueue.length, 1);
    assert.equal(spies.enqueue[0].quantity, 3, "only the remaining shortfall is requested");
    assert.equal(jobs[1].mode, "live");
    assert.equal(jobs[1].query.follows_job_id, instant.jobId);
    assert.equal(JSON.stringify(jobs[0]), instantJobBefore, "the pool run's job row is never merged/modified");
    assert.equal(db.usageUsed, 2, "starting the live run charges nothing by itself; only delivered live leads will");
  });

  test("the same partial run can only be continued once (no double authorization / double charge)", async () => {
    const user = newUser();
    const instant = await partialInstantRun(user);
    await followUp(user, { followsJobId: instant.jobId });
    const again = await followUp(user, { followsJobId: instant.jobId });
    assert.equal(again.status, 409);
    const body = await again.json();
    assert.equal(body.code, "follow_up_already_started");
    assert.equal(body.jobId, jobs[1].id);
    assert.equal(spies.enqueue.length, 1);
  });

  test("cannot request more than the recorded shortfall", async () => {
    const user = newUser();
    const instant = await partialInstantRun(user);
    const res = await followUp(user, { followsJobId: instant.jobId, quantity: 4 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "follow_up_quantity_exceeds_shortfall");
    assert.equal(spies.enqueue.length, 0);
  });

  test("must keep the same niche, region and channels", async () => {
    const user = newUser();
    const instant = await partialInstantRun(user);
    const res = await followUp(user, { followsJobId: instant.jobId, niche: "Gyms" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "follow_up_mismatch");
    assert.equal(spies.enqueue.length, 0);
  });

  test("must itself be a live request", async () => {
    const user = newUser();
    const instant = await partialInstantRun(user);
    const res = await post({ method: "instant_pool", channels: ["email"], quantity: 3, followsJobId: instant.jobId }, user);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "follow_up_requires_live");
  });

  test("another user's job, an unknown job, or a non-partial job cannot be continued", async () => {
    const owner = newUser();
    const instant = await partialInstantRun(owner);
    const stranger = await followUp(newUser(), { followsJobId: instant.jobId });
    assert.equal(stranger.status, 404);
    const unknown = await followUp(owner, { followsJobId: randomUUID() });
    assert.equal(unknown.status, 404);
    jobs[0].status = "completed";
    const notPartial = await followUp(owner, { followsJobId: instant.jobId });
    assert.equal(notPartial.status, 409);
    assert.equal((await notPartial.json()).code, "follows_job_not_partial");
    assert.equal(spies.enqueue.length, 0);
  });

  test("normal plan rules still apply to the follow-up (plan limit)", async () => {
    const user = newUser();
    const instant = await partialInstantRun(user);
    usage = { daily: 10_000, monthly: 10_000 };
    const res = await followUp(user, { followsJobId: instant.jobId });
    assert.equal(res.status, 429);
    assert.equal(spies.enqueue.length, 0);
  });
});
