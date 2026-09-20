/**
 * HTTP-level test of POST /v1/discover for country scope — the real Express
 * router, real auth middleware, real validation/plan gating, real
 * lookupAndDeliverFromPool + insertLeadForUser; only Supabase is an
 * in-memory stand-in (see helpers/fakeSupabaseAdmin.ts, which mirrors the
 * country-aware pool_lookup in migrations/034 — verified separately against
 * a real Postgres).
 *
 * Proves, per plan, that the selected country reaches the job/plan/pool
 * unchanged (canonicalised, never widened) and that the discovery MODE is
 * derived from the plan, not from anything the client sends.
 */
import assert from "node:assert/strict";
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
const { discoverRouter } = await import("../../server/routes/discover.js");
const { FakeDb, installFakeSupabase } = await import("./helpers/fakeSupabaseAdmin.js");
type Row = Record<string, any>;

let db: InstanceType<typeof FakeDb>;
let restoreFake: () => void;
let server: import("node:http").Server;
let base: string;
let plan = "free";
const recorded = { scrapeJobs: [] as Row[], discoveryPlans: [] as Row[] };
let userSeq = 0;

beforeEach(async () => {
  db = new FakeDb();
  restoreFake = installFakeSupabase(supabaseAdmin, db);
  recorded.scrapeJobs = [];
  recorded.discoveryPlans = [];

  const fakeFrom = supabaseAdmin.from.bind(supabaseAdmin) as (t: string) => any;
  const fakeRpc = supabaseAdmin.rpc.bind(supabaseAdmin) as (fn: string, a: Row) => any;
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "profiles") {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: {} }, error: null }) }) }) };
    }
    if (table === "scrape_jobs") {
      return {
        insert: (row: Row) => {
          recorded.scrapeJobs.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "job-1" }, error: null }) }) };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "discovery_plans") {
      return {
        upsert: (row: Row) => {
          recorded.discoveryPlans.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "plan-1" }, error: null }) }) };
        },
      };
    }
    return fakeFrom(table);
  };
  (supabaseAdmin as any).rpc = (fn: string, args: Row) => {
    if (fn === "try_increment_lead_usage" && args.p_count === 0) {
      const data = { subscription_plan: plan, daily_leads_used: 0, monthly_leads_used: 0 };
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
  await new Promise((r) => server.close(r));
  restoreFake();
});

function post(body: Row) {
  // Fresh user per call: the route has a per-user 5/min rate limiter.
  const userId = `00000000-0000-0000-0000-${String(++userSeq).padStart(12, "0")}`;
  const token = jwt.sign({ sub: userId }, process.env.SUPABASE_JWT_SECRET!, { algorithm: "HS256" });
  return fetch(`${base}/v1/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ quantity: 5, niche: "Coffee Shops", channels: [], ...body }),
  });
}

function seedPool() {
  const add = (name: string, region: string, country_code: string | null) =>
    db.businesses.push({
      id: db.nextId("biz"), name, niche: "Coffee Shops", region, country_code, address: "1 Main St",
      website: null, email: `${name}@x.test`, phone: null, instagram: null, is_disqualified: false,
      first_discovered_at: "2026-01-01T00:00:00Z", fingerprints: [],
    });
  add("us-1", "United States", "US");
  add("us-2", "North America", "US");
  add("ca-1", "Canada", "CA");
  add("gb-1", "United Kingdom", "GB");
}
const namesFrom = (results: Array<{ businessId: string }>) =>
  results.map((r) => db.businesses.find((b) => b.id === r.businessId)!.name).sort();

describe("Free plan (Live discovery) — country gating and propagation", () => {
  test("a North-American country passes and is carried, canonicalised, into the job and the discovery plan", async () => {
    plan = "free";
    // The route continues to the queue after this point (not available in a
    // unit test) so the response is a 5xx — what matters is that the gate
    // passed and the country was persisted unchanged before that.
    const res = await post({ region: "  canada " });
    assert.ok(res.status !== 400 && res.status !== 403, `unexpected gate rejection: ${res.status}`);
    assert.equal(recorded.scrapeJobs[0].query.region, "Canada");
    assert.equal(recorded.scrapeJobs[0].mode, "live");
    assert.equal(recorded.discoveryPlans[0].region, "Canada");
  });

  test("United States and Canada are distinct scopes all the way to the plan", async () => {
    plan = "free";
    await post({ region: "United States" });
    await post({ region: "Canada" });
    assert.deepEqual(recorded.discoveryPlans.map((p) => p.region), ["United States", "Canada"]);
  });

  test("continent behavior unchanged: North America still passes", async () => {
    plan = "free";
    const res = await post({ region: "North America" });
    assert.ok(res.status !== 400 && res.status !== 403);
    assert.equal(recorded.discoveryPlans[0].region, "North America");
  });

  test("countries and regions outside the local region are restricted (403)", async () => {
    plan = "free";
    for (const region of ["United Kingdom", "Europe", "Global", "United States, United Kingdom"]) {
      const res = await post({ region });
      assert.equal(res.status, 403, region);
      assert.equal((await res.json()).code, "region_restricted");
    }
    assert.equal(recorded.scrapeJobs.length, 0, "nothing was created for a rejected request");
  });

  test("an unsupported location is a 400, never silently searched or widened", async () => {
    plan = "free";
    const res = await post({ region: "Narnia" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_region");
    assert.equal(recorded.scrapeJobs.length, 0);
  });
});

describe("Starter / Pro (Instant pool) — country-scoped pool delivery", () => {
  test("Starter: each country returns only its own pooled businesses, mode = instant_pool", async () => {
    plan = "starter";
    seedPool();
    const expected: Record<string, string[]> = {
      "United States": ["us-1", "us-2"],
      Canada: ["ca-1"],
      "United Kingdom": ["gb-1"],
    };
    for (const [region, names] of Object.entries(expected)) {
      db.leads.length = 0;
      const res = await post({ region, quantity: 1 + names.length - 1 });
      const body = await res.json().catch(() => ({}));
      // Shortfall triggers the (un-stubbed) live backfill queue → 5xx; the
      // pool delivery that precedes it is what this asserts.
      const delivered = db.leads.map((l) => l.business_name).sort();
      assert.deepEqual(delivered, names, `${region} (status ${res.status} ${JSON.stringify(body).slice(0, 80)})`);
    }
    assert.equal(recorded.scrapeJobs.every((j) => j.mode === "instant_pool" && j.query.region), true);
  });

  test("Starter: a full pool hit returns 200 with unranked instant_pool", async () => {
    plan = "starter";
    seedPool();
    const res = await post({ region: "Canada", quantity: 1 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "instant_pool");
    assert.equal(body.shortfall, 0);
    assert.deepEqual(namesFrom(body.results), ["ca-1"]);
    const call = db.rpcCalls.find((c) => c.fn === "pool_lookup")!;
    assert.equal(call.args.p_rank, false);
    assert.equal(call.args.p_country_strict, true);
    assert.deepEqual(call.args.p_country_codes, ["CA"]);
  });

  test("Pro: same country scoping, mode = instant_pool_ranked (rank flag set by PLAN)", async () => {
    plan = "pro";
    seedPool();
    const res = await post({ region: "United Kingdom", quantity: 1, mode: "scrape" /* ignored by the server */ });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "instant_pool_ranked");
    assert.deepEqual(namesFrom(body.results), ["gb-1"]);
    const call = db.rpcCalls.find((c) => c.fn === "pool_lookup")!;
    assert.equal(call.args.p_rank, true);
    assert.deepEqual(call.args.p_country_codes, ["GB"]);
  });

  test("Starter can search countries outside North America; a continent still works too", async () => {
    plan = "starter";
    seedPool();
    const gb = await post({ region: "United Kingdom", quantity: 1 });
    assert.equal(gb.status, 200);
    db.leads.length = 0;
    const na = await post({ region: "North America", quantity: 3 });
    assert.equal(na.status, 200);
    assert.ok(!db.leads.map((l) => l.business_name).includes("gb-1"));
  });
});

describe("legacy `mode` field (GenerationMode shape) is inert — superseded by `method`", () => {
  test("a `mode` value is always ignored; the resolved plan's default method wins when no `method` is sent", async () => {
    seedPool();
    for (const [p, expected] of [["starter", "instant_pool"], ["pro", "instant_pool_ranked"], ["premium", "instant_pool_ranked"]] as const) {
      plan = p;
      for (const clientMode of ["scrape", "pool", "premium"]) {
        db.leads.length = 0;
        const res = await post({ region: "Canada", quantity: 1, mode: clientMode });
        assert.equal((await res.json()).mode, expected, `${p} with client mode ${clientMode}`);
      }
    }
    plan = "free";
    await post({ region: "Canada", mode: "premium" });
    assert.equal(recorded.scrapeJobs.at(-1)!.mode, "live");
  });
});

describe("Discovery Method is a real, plan-gated selection (`method`)", () => {
  test("an eligible `method` is honored even when it's below the plan's ceiling", async () => {
    plan = "premium";
    seedPool();
    const res = await post({ region: "Canada", quantity: 1, method: "instant_pool" /* below premium's ranked ceiling */ });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "instant_pool", "the selected method won, not the plan's ceiling");
    const call = db.rpcCalls.find((c) => c.fn === "pool_lookup")!;
    assert.equal(call.args.p_rank, false, "instant_pool must not be ranked, even though the plan could rank it");
  });

  test("a `method` above the plan's ceiling is rejected with 403, never silently downgraded or upgraded", async () => {
    plan = "starter"; // ceiling: instant_pool
    seedPool();
    const res = await post({ region: "Canada", quantity: 1, method: "instant_pool_ranked" });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "method_restricted");
    assert.equal(recorded.scrapeJobs.length, 0, "nothing was created for a rejected request");
  });

  test("free plan may only select `live`; `instant_pool` is rejected", async () => {
    plan = "free";
    const res = await post({ region: "Canada", method: "instant_pool" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "method_restricted");
  });

  test("omitting `method` falls back to the plan's default (ceiling) method, unchanged from before", async () => {
    seedPool();
    for (const [p, expected] of [["starter", "instant_pool"], ["pro", "instant_pool_ranked"], ["premium", "instant_pool_ranked"]] as const) {
      plan = p;
      db.leads.length = 0;
      const res = await post({ region: "Canada", quantity: 1 });
      assert.equal((await res.json()).mode, expected, p);
    }
  });
});
