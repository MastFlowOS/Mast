/**
 * Discovery niche attribution at the engine boundary.
 *
 * ROOT CAUSE these pin: the Python engine's lead dicts have NO `niche` key
 * (`_candidate_dict` on the live/discovery-only path, `_opportunity_to_lead_dict`
 * on the full pipeline). Node passed `niche` INTO the engine per call but got
 * nothing back, so every discovered lead reached `toLeadRow` with
 * `niche === undefined` and was written as NULL. runEngineQuery() now stamps
 * the requested niche on every lead it yields.
 *
 * Uses the `real-shape-engine` fixture (no `niche`, Google `category` present)
 * — the older fixtures hard-code `"niche": "test"`, which hid the bug.
 */
import { test, describe } from "node:test";
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

const { runEngineQuery } = await import("../pythonBridge.js");
const { env } = await import("../../config/env.js");
const { GoogleMapsSearchGenerator } = await import("../../discovery/providers/googleMaps/googleMapsSearchGenerator.js");
const { GoogleMapsProvider } = await import("../../discovery/providers/googleMaps/googleMapsProvider.js");
type EngineLead = import("../pythonBridge.js").EngineLead;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_SHAPE_ENGINE = path.join(__dirname, "fixtures", "real-shape-engine");

async function withEngine<T>(fn: () => Promise<T>): Promise<T> {
  const original = env.SCRAPER_ENGINE_PATH;
  env.SCRAPER_ENGINE_PATH = REAL_SHAPE_ENGINE;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("engine test timed out")), 15000)),
    ]);
  } finally {
    env.SCRAPER_ENGINE_PATH = original;
  }
}

async function collect(params: Parameters<typeof runEngineQuery>[0]): Promise<any[]> {
  const leads: any[] = [];
  for await (const lead of runEngineQuery(params)) leads.push(lead);
  return leads;
}

describe("runEngineQuery niche attribution", () => {
  test("fixture sanity: the raw engine lead really has no niche (the production shape)", async () => {
    // Nothing is stamped when no niche is requested, so this is the raw shape.
    const leads = await withEngine(() => collect({ query: "x", city: "Testville" }));
    assert.equal(leads.length, 2);
    assert.equal("niche" in leads[0], false);
    assert.equal(leads[0].category, "Coffee shop");
  });

  test("A. single niche -> every lead carries that exact niche; Google's category is untouched", async () => {
    const leads = await withEngine(() =>
      collect({ query: "Coffee Shops", city: "Brooklyn", niche: "Coffee Shops" }),
    );
    assert.equal(leads.length, 2);
    for (const lead of leads) {
      assert.equal(lead.niche, "Coffee Shops");
      assert.equal(lead.category, "Coffee shop");
    }
  });

  test("B + C. one engine call per niche -> each lead keeps the niche that produced it, none leaks the first", async () => {
    const niches = ["Coffee Shops", "Barbers", "Gyms"];
    const seen: Array<{ produced: string; leads: any[] }> = [];
    for (const niche of niches) {
      const leads = await withEngine(() => collect({ query: niche, city: "Testville", niche }));
      seen.push({ produced: niche, leads });
    }
    for (const { produced, leads } of seen) {
      assert.equal(leads.length, 2);
      for (const lead of leads) {
        assert.equal(lead.niche, produced);
        assert.equal(lead.name.startsWith(produced), true, "lead really came from this niche's engine call");
      }
    }
    const distinct = new Set(seen.flatMap((s) => s.leads.map((l) => l.niche)));
    assert.deepEqual([...distinct].sort(), [...niches].sort());
  });

  test("D. no niche requested -> niche stays undefined (nothing fabricated)", async () => {
    const leads = await withEngine(() => collect({ query: "x", city: "Testville" }));
    for (const lead of leads) assert.equal(lead.niche, undefined);
  });

  test("D. an unsplit multi-niche string is never guessed at (no first-niche leakage)", async () => {
    const leads = await withEngine(() =>
      collect({ query: "x", city: "Testville", niche: "Coffee Shops, Barbers, Gyms" }),
    );
    for (const lead of leads) assert.equal(lead.niche, undefined);
  });

  test("the exact string is preserved: no lower-casing, slugging or category mapping", async () => {
    const leads = await withEngine(() => collect({ query: "x", city: "Testville", niche: "Bar & Lounge" }));
    assert.equal(leads[0].niche, "Bar & Lounge");
  });

  test("I. pool-expansion-shaped call (area/street query, deliver_target, followUp channels) preserves niche", async () => {
    const leads = await withEngine(() =>
      collect({
        query: "Barbers on Atlantic Ave, New York",
        city: "New York",
        country: "US",
        niche: "Barbers",
        region: "United States",
        area: "Atlantic Ave",
        max_results: 40,
        deliver_target: 10,
        required_channels: ["email"],
        db_path: "data/leads-pool-expand.db",
      } as any),
    );
    assert.equal(leads.length, 2);
    for (const lead of leads) assert.equal(lead.niche, "Barbers");
  });
});

describe("F. live discovery path: SearchGenerator -> GoogleMapsProvider -> engine", () => {
  const generator = new GoogleMapsSearchGenerator();

  test("each generated query carries its own single niche", () => {
    const queries = generator.generate({
      niche: "Coffee Shops, Barbers, Gyms",
      city: "Brooklyn",
      countryCode: "US",
      region: "United States",
    });
    assert.deepEqual(
      queries.map((q) => q.niche),
      ["Coffee Shops", "Barbers", "Gyms"],
    );
    assert.equal(queries[1].queryString, "Barbers Brooklyn");
  });

  test("multi-niche target: every lead is attributed to the niche of the query that produced it; the engine never sees the joined string", async () => {
    const provider = new GoogleMapsProvider();
    const target = {
      niche: "Coffee Shops, Barbers, Gyms",
      city: "Brooklyn",
      countryCode: "US",
      region: "United States",
    };
    const produced: Array<{ queryNiche: string; lead: any }> = [];
    await withEngine(async () => {
      for (const query of generator.generate(target)) {
        for await (const lead of provider.search(query, target, { maxResults: 10, candidateBudget: 10, discoveryOnly: true })) {
          produced.push({ queryNiche: query.niche!, lead: lead as EngineLead });
        }
      }
    });

    assert.equal(produced.length, 6);
    for (const { queryNiche, lead } of produced) {
      assert.equal(lead.niche, queryNiche);
      assert.equal(lead._received_params.niche, queryNiche, "engine received ONE niche, not the joined string");
      assert.equal(lead.category, "Coffee shop");
    }
    assert.deepEqual([...new Set(produced.map((p) => p.lead.niche))], ["Coffee Shops", "Barbers", "Gyms"]);
  });

  test("street/area-qualified targets keep the niche too", async () => {
    const provider = new GoogleMapsProvider();
    const target = { niche: "Barbers", city: "New York", countryCode: "US", region: "United States", street: "Atlantic Ave" };
    const [query] = generator.generate(target);
    assert.equal(query.queryString, "Barbers on Atlantic Ave, New York");
    const leads: any[] = [];
    await withEngine(async () => {
      for await (const lead of provider.search(query, target, { maxResults: 5, candidateBudget: 5, discoveryOnly: true })) leads.push(lead);
    });
    for (const lead of leads) assert.equal(lead.niche, "Barbers");
  });

  test("provider falls back to target.niche only when the query carries none, and never guesses from a joined string", async () => {
    const provider = new GoogleMapsProvider();
    const leads: any[] = [];
    await withEngine(async () => {
      for await (const lead of provider.search(
        { queryString: "anything" },
        { niche: "Coffee Shops, Barbers", city: "X", countryCode: "US", region: "United States" },
        { maxResults: 5, candidateBudget: 5, discoveryOnly: true },
      ))
        leads.push(lead);
    });
    for (const lead of leads) assert.equal(lead.niche, undefined);
  });
});
