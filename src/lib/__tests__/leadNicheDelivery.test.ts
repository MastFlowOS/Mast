/**
 * Niche persistence through the REAL delivery code (deliverLead.ts,
 * poolLookup.ts) against an in-memory Supabase stand-in. Covers what ends up
 * in `leads.niche` and `businesses.niche` for every discovery path.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";
process.env.SCRAPER_SUBPROCESS_INACTIVITY_MS ??= "10000";
process.env.SCRAPER_SUBPROCESS_MAX_MS ??= "30000";
process.env.SCRAPER_GRACEFUL_SHUTDOWN_MS ??= "1000";

const { supabaseAdmin } = await import("../supabaseAdmin.js");
const { env } = await import("../../config/env.js");
const { runEngineQuery } = await import("../../scraperBridge/pythonBridge.js");
const { deliverLead, insertLeadForUser, upsertBusinessFromEngineLead } = await import(
  "../../scraperBridge/deliverLead.js"
);
const { lookupAndDeliverFromPool } = await import("../poolLookup.js");
const { FakeDb, installFakeSupabase } = await import("./helpers/fakeSupabaseAdmin.js");
type EngineLead = import("../../scraperBridge/pythonBridge.js").EngineLead;
type Row = Record<string, any>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_SHAPE_ENGINE = path.join(__dirname, "../../scraperBridge/__tests__/fixtures/real-shape-engine");

const USER = "user-1";
const ctxBase = { userId: USER, professionSlug: "web-design", scrapeJobId: "job-1", dailyLimit: 100, monthlyLimit: 1000 };

let db: InstanceType<typeof FakeDb>;
let restore: () => void;
beforeEach(() => {
  db = new FakeDb();
  restore = installFakeSupabase(supabaseAdmin, db);
});
afterEach(() => restore());

/** Real-shape engine output for one discovery niche (no `niche` from the engine). */
async function engineLeads(niche: string | undefined, query = niche ?? "x"): Promise<EngineLead[]> {
  const original = env.SCRAPER_ENGINE_PATH;
  env.SCRAPER_ENGINE_PATH = REAL_SHAPE_ENGINE;
  try {
    const out: EngineLead[] = [];
    for await (const lead of runEngineQuery({ query, city: "Testville", niche })) out.push(lead);
    return out;
  } finally {
    env.SCRAPER_ENGINE_PATH = original;
  }
}

const leadFor = (businessName: string) => db.leads.find((l) => l.business_name === businessName);

function seedBusiness(over: Row): Row {
  const b: Row = {
    id: db.nextId("biz"),
    name: "Biz",
    niche: null,
    region: "Brooklyn",
    address: "1 Main St",
    website: null,
    email: null,
    phone: null,
    instagram: null,
    is_disqualified: false,
    first_discovered_at: "2026-01-01T00:00:00Z",
    fingerprints: [],
    ...over,
  };
  db.businesses.push(b);
  return b;
}

const poolParams = (over: Partial<Parameters<typeof lookupAndDeliverFromPool>[0]> = {}) => ({
  userId: USER,
  region: "Brooklyn",
  niche: "Coffee Shops",
  professionSlug: "web-design",
  rank: false,
  quantity: 10,
  scrapeJobId: "job-1",
  dailyLimit: 100,
  monthlyLimit: 1000,
  channels: [] as string[],
  ...over,
});

describe("F + A + B + C. Free live discovery (engine -> deliverLead)", () => {
  test("A. single niche: the CRM lead AND the pool business carry the niche", async () => {
    for (const lead of await engineLeads("Coffee Shops")) {
      const res = await deliverLead(lead, { ...ctxBase, discoveryMode: "live" }, "Brooklyn");
      assert.equal(res.wasNewForUser, true);
    }
    assert.equal(db.leads.length, 2);
    for (const l of db.leads) assert.equal(l.niche, "Coffee Shops");
    // M — businesses.niche is populated (pool_lookup filters on it).
    for (const b of db.businesses) assert.equal(b.niche, "Coffee Shops");
    for (const l of db.leads) assert.equal(l.source, "discover_live");
  });

  test("B + C. multiple niches: each lead keeps the niche that produced it", async () => {
    for (const niche of ["Coffee Shops", "Barbers", "Gyms"]) {
      for (const lead of await engineLeads(niche)) {
        await deliverLead(lead, { ...ctxBase, discoveryMode: "live" }, "Brooklyn");
      }
    }
    assert.equal(db.leads.length, 6);
    for (const niche of ["Coffee Shops", "Barbers", "Gyms"]) {
      const mine = db.leads.filter((l) => l.business_name.startsWith(niche));
      assert.equal(mine.length, 2);
      for (const l of mine) assert.equal(l.niche, niche);
    }
    assert.equal(db.leads.filter((l) => l.niche === "Coffee Shops").length, 2, "first niche did not leak onto everything");
    assert.equal(db.businesses.filter((b) => b.niche === "Coffee Shops").length, 2);
  });

  test("D. no discovery niche: lead and business niche stay null — nothing fabricated", async () => {
    for (const lead of await engineLeads(undefined, "no niche")) {
      await deliverLead(lead, { ...ctxBase, discoveryMode: "live" }, "Brooklyn");
    }
    assert.equal(db.leads.length, 2);
    for (const l of db.leads) assert.equal(l.niche, null);
    for (const b of db.businesses) assert.equal(b.niche, null);
  });
});

describe("I. pool expansion / background + follow-up delivery", () => {
  test("a background expand (no user) still writes businesses.niche, and creates no lead", async () => {
    for (const lead of await engineLeads("Barbers", "Barbers in Williamsburg, Brooklyn")) {
      const res = await deliverLead(lead, { ...ctxBase, userId: null, discoveryMode: "live" }, "Brooklyn");
      assert.equal(res.wasNewForUser, false);
    }
    assert.equal(db.leads.length, 0);
    assert.equal(db.businesses.length, 2);
    for (const b of db.businesses) assert.equal(b.niche, "Barbers");
  });

  test("a follow-up delivery for the requesting user carries the niche onto the CRM row (per-niche runs, area/street queries)", async () => {
    for (const [niche, query] of [
      ["Coffee Shops", "Coffee Shops in Park Slope, Brooklyn"],
      ["Barbers", "Barbers on Atlantic Ave, Brooklyn"],
    ] as const) {
      for (const lead of await engineLeads(niche, query)) {
        await deliverLead(lead, { ...ctxBase, discoveryMode: "live", scrapeJobId: "expand-1" }, "Brooklyn");
      }
    }
    assert.deepEqual(
      [...new Set(db.leads.map((l) => l.niche))].sort(),
      ["Barbers", "Coffee Shops"],
    );
    for (const l of db.leads) assert.equal(l.scrape_job_id, "expand-1");
  });
});

describe("M. businesses.niche persistence", () => {
  const engineLead = (over: Partial<EngineLead> = {}): EngineLead =>
    ({
      name: "Blue Door",
      address: "1 Main St",
      query: "q",
      region: "Brooklyn",
      category: "Coffee shop",
      fingerprints: ["fp:blue-door"],
      is_disqualified: false,
      rating: null,
      reviews: 0,
      ...over,
    }) as unknown as EngineLead;

  test("a newly discovered business is inserted with the requested niche", async () => {
    await upsertBusinessFromEngineLead(engineLead({ niche: "Coffee Shops" }), "Brooklyn");
    assert.equal(db.businesses[0].niche, "Coffee Shops");
    assert.equal(db.businesses[0].category, "Coffee shop", "Google category is stored separately");
  });

  test("rediscovery fills a missing business niche (so pool_lookup can find it)…", async () => {
    const existing = seedBusiness({ name: "Blue Door", niche: null, fingerprints: ["fp:blue-door"], confidence: 0.5 });
    await upsertBusinessFromEngineLead(engineLead({ niche: "Coffee Shops" }), "Brooklyn");
    assert.equal(db.businesses.length, 1);
    assert.equal(existing.niche, "Coffee Shops");
  });

  test("…but never overwrites an existing niche, and a nicheless rediscovery never erases one", async () => {
    const existing = seedBusiness({ name: "Blue Door", niche: "Bakery", fingerprints: ["fp:blue-door"], confidence: 0.5 });
    await upsertBusinessFromEngineLead(engineLead({ niche: "Coffee Shops" }), "Brooklyn");
    assert.equal(existing.niche, "Bakery");
    await upsertBusinessFromEngineLead(engineLead({ niche: undefined }), "Brooklyn");
    assert.equal(existing.niche, "Bakery");
  });
});

describe("G + H. Starter / Pro instant pool discovery", () => {
  function seedPool() {
    return {
      coffee: seedBusiness({ name: "Blue Door", niche: "Coffee Shops" }),
      barber: seedBusiness({ name: "Fade Lab", niche: "Barbers" }),
      gym: seedBusiness({ name: "Iron Works", niche: "Gyms" }),
    };
  }
  const nicheOf = (b: Row) => db.leads.find((l) => l.business_id === b.id)?.niche;

  test("G. Starter (unranked): each pool match keeps the niche that matched it; no first-niche leakage", async () => {
    const pool = seedPool();
    const res = await lookupAndDeliverFromPool(poolParams({ niche: "Coffee Shops, Barbers, Gyms" }));
    assert.equal(res.delivered.length, 3);
    assert.equal(nicheOf(pool.coffee), "Coffee Shops");
    assert.equal(nicheOf(pool.barber), "Barbers");
    assert.equal(nicheOf(pool.gym), "Gyms");
    for (const l of db.leads) assert.equal(l.discovery_mode, "instant_pool");
    assert.equal(db.leads.filter((l) => l.niche === "Coffee Shops").length, 1);
  });

  test("G. single niche request", async () => {
    const pool = seedPool();
    await lookupAndDeliverFromPool(poolParams({ niche: "Barbers" }));
    assert.equal(db.leads.length, 1);
    assert.equal(nicheOf(pool.barber), "Barbers");
  });

  test("H. Pro (ranked): niche attribution and opportunity score both survive ranking", async () => {
    const pool = seedPool();
    db.opportunityScores.set(pool.gym.id, 90);
    db.opportunityScores.set(pool.barber.id, 70);
    db.opportunityScores.set(pool.coffee.id, 50);
    const res = await lookupAndDeliverFromPool(poolParams({ niche: "Coffee Shops, Barbers, Gyms", rank: true }));
    assert.equal(res.delivered.length, 3);
    for (const l of db.leads) assert.equal(l.discovery_mode, "instant_pool_ranked");
    assert.equal(nicheOf(pool.coffee), "Coffee Shops");
    assert.equal(nicheOf(pool.barber), "Barbers");
    assert.equal(nicheOf(pool.gym), "Gyms");
    assert.equal(db.leads.find((l) => l.business_id === pool.gym.id)?.opportunity_score, 90);
  });

  test("the request's niche beats businesses.niche when they differ (pool_lookup is an ilike substring match)", async () => {
    const b = seedBusiness({ name: "Blue Door", niche: "Coffee Shops" });
    await lookupAndDeliverFromPool(poolParams({ niche: "Coffee" }));
    assert.equal(nicheOf(b), "Coffee", "exact selected string, not the business's own tag");
    assert.equal(b.niche, "Coffee Shops", "the business row itself is untouched");
  });
});

describe("E. deterministic dedupe across selected niches", () => {
  test("a business matched by several niches is attributed to the FIRST in request order, delivered once", async () => {
    const both = seedBusiness({ name: "Crumb & Bean", niche: "Coffee Shops & Bakery" });
    const res = await lookupAndDeliverFromPool(poolParams({ niche: "Bakery, Coffee Shops" }));
    assert.equal(res.delivered.length, 1);
    assert.equal(db.leads.length, 1);
    assert.equal(db.leads.find((l) => l.business_id === both.id)?.niche, "Bakery");
  });

  test("reversing the request order flips the attribution accordingly", async () => {
    const both = seedBusiness({ name: "Crumb & Bean", niche: "Coffee Shops & Bakery" });
    await lookupAndDeliverFromPool(poolParams({ niche: "Coffee Shops, Bakery" }));
    assert.equal(db.leads.find((l) => l.business_id === both.id)?.niche, "Coffee Shops");
  });

  test("repeated identical requests always give the same attribution", async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      restore();
      db = new FakeDb();
      restore = installFakeSupabase(supabaseAdmin, db);
      const both = seedBusiness({ name: "Crumb & Bean", niche: "Coffee Shops & Bakery" });
      const onlyBakery = seedBusiness({ name: "Loaf", niche: "Bakery" });
      await lookupAndDeliverFromPool(poolParams({ niche: "Bakery, Coffee Shops, Gyms" }));
      outcomes.add(
        JSON.stringify([
          db.leads.find((l) => l.business_id === both.id)?.niche,
          db.leads.find((l) => l.business_id === onlyBakery.id)?.niche,
        ]),
      );
    }
    assert.equal(outcomes.size, 1);
    assert.deepEqual(JSON.parse([...outcomes][0]), ["Bakery", "Bakery"]);
  });

  test("case-insensitive duplicate selections collapse to the first spelling", async () => {
    const b = seedBusiness({ name: "Blue Door", niche: "Coffee Shops" });
    await lookupAndDeliverFromPool(poolParams({ niche: "Coffee Shops, coffee shops" }));
    assert.equal(db.leads.find((l) => l.business_id === b.id)?.niche, "Coffee Shops");
    assert.equal(db.rpcCalls.filter((c) => c.fn === "pool_lookup").length, 1);
  });
});

describe("J. existing lead protection", () => {
  const business = (over: Row = {}) => ({
    id: "biz-existing",
    name: "Blue Door",
    niche: "Coffee Shops",
    address: null,
    website: null,
    email: null,
    phone: null,
    instagram: null,
    ...over,
  });
  const seedLead = (over: Row): Row => {
    const row = { id: db.nextId("lead"), user_id: USER, business_id: "biz-existing", business_name: "Blue Door", ...over };
    db.leads.push(row);
    return row;
  };
  const noLeadWrites = () => {
    assert.equal(db.mutations("leads").length, 0, "no insert/update/delete on leads");
    assert.equal(db.mutations("lead_activities").length, 0);
    assert.equal(db.rpcCalls.some((c) => c.fn === "try_increment_lead_usage"), false, "no credit reserved");
  };

  test("an existing lead with a niche is untouched by a different discovery niche", async () => {
    const lead = seedLead({ niche: "Barbers", source: "discover_live" });
    const res = await insertLeadForUser(business(), { ...ctxBase, discoveryMode: "live" }, { discoveryNiche: "Gyms" });
    assert.equal(res.wasNewForUser, false);
    assert.equal(lead.niche, "Barbers");
    noLeadWrites();
  });

  test("null / undefined / blank discovery niche cannot erase it", async () => {
    const lead = seedLead({ niche: "Barbers", source: "discover_live" });
    for (const extra of [{ discoveryNiche: null }, { discoveryNiche: undefined }, { discoveryNiche: "  " }, undefined]) {
      await insertLeadForUser(business({ niche: null }), { ...ctxBase, discoveryMode: "live" }, extra);
      assert.equal(lead.niche, "Barbers");
    }
    noLeadWrites();
  });

  test("manual and imported leads (slug niche, blank niche) are never modified", async () => {
    const manual = seedLead({ niche: "coffee_shop", source: "manual" });
    const imported = seedLead({ business_id: "biz-imported", niche: null, source: "import" });
    const before = JSON.stringify([manual, imported]);
    await insertLeadForUser(business(), { ...ctxBase, discoveryMode: "live" }, { discoveryNiche: "Coffee Shops" });
    await insertLeadForUser(
      business({ id: "biz-imported" }),
      { ...ctxBase, discoveryMode: "live" },
      { discoveryNiche: "Coffee Shops" },
    );
    assert.equal(JSON.stringify([manual, imported]), before);
    noLeadWrites();
  });

  test("no backfill: rediscovering a business whose existing lead has a blank niche leaves it blank", async () => {
    const legacy = seedLead({ niche: null, source: "discover_live" });
    const engineLead = (await engineLeads("Coffee Shops"))[0];
    await deliverLead(engineLead, { ...ctxBase, discoveryMode: "live" }, "Brooklyn", "biz-existing");
    assert.equal(legacy.niche, null);
    noLeadWrites();
  });

  test("the whole delivery via the pool path skips owned businesses too", async () => {
    const owned = seedBusiness({ name: "Blue Door", niche: "Coffee Shops" });
    const lead = seedLead({ business_id: owned.id, niche: "Barbers" });
    const res = await lookupAndDeliverFromPool(poolParams({ niche: "Coffee Shops" }));
    assert.equal(res.delivered.length, 0);
    assert.equal(lead.niche, "Barbers");
    noLeadWrites();
  });

  test("sanity: a genuinely new lead IS written, with the discovery niche over the business tag", async () => {
    const res = await insertLeadForUser(
      business({ id: "biz-new", niche: "Coffee Shops" }),
      { ...ctxBase, discoveryMode: "live" },
      { discoveryNiche: "Gyms" },
    );
    assert.equal(res.wasNewForUser, true);
    assert.equal(db.leads.find((l) => l.business_id === "biz-new")?.niche, "Gyms");
  });
});
