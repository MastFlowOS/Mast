/**
 * COUNTRY-LEVEL DISCOVERY SCOPE — regression tests.
 *
 * A selected country must actually change discovery, and must never be
 * silently widened to its continent. These pin the whole path:
 *
 *   request `region` token(s)
 *     → validateDiscoveryRegion   (validation + plan gating + canonical form)
 *     → resolveCountriesForSelection / resolveDiscoveryTargets
 *                                 (live discovery + pool expansion targets)
 *     → runEngineQuery / GoogleMapsProvider   (the provider receives the country
 *                                 and leads are stamped with it)
 *     → upsertBusinessFromEngineLead          (businesses.country_code)
 *     → lookupAndDeliverFromPool → pool_lookup RPC   (Starter/Pro pool)
 *
 * The core invariant everywhere: US ≠ Canada ≠ UK.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
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
const { COUNTRIES } = await import("../geo/countries.js");
const { CountryRotation, resolveCountriesForSelection } = await import("../geo/regions.js");
const scope = await import("../geo/scope.js");
const { resolveDiscoveryTargets } = await import("../../discovery/planner.js");
const { poolScopesFor, lookupAndDeliverFromPool } = await import("../poolLookup.js");
const { upsertBusinessFromEngineLead, resolveBusinessCountryCode } = await import("../../scraperBridge/deliverLead.js");
const { runEngineQuery } = await import("../../scraperBridge/pythonBridge.js");
const { GoogleMapsProvider } = await import("../../discovery/providers/googleMaps/googleMapsProvider.js");
const { FakeDb, installFakeSupabase } = await import("./helpers/fakeSupabaseAdmin.js");
type EngineLead = import("../../scraperBridge/pythonBridge.js").EngineLead;
type Row = Record<string, any>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_SHAPE_ENGINE = path.join(__dirname, "../../scraperBridge/__tests__/fixtures/real-shape-engine");

const codes = (region: string, opts?: { currencies?: string[] }) =>
  resolveCountriesForSelection(region, opts).map((c) => c.code);

// ─────────────────────────────────────────────────────────────────────────
describe("1. scope parsing and validation", () => {
  test("tokens are recognised as Global / continent / country, case- and space-insensitively", () => {
    const s = scope.parseGeoScope("  united   states , EUROPE, global, Canada, canada ");
    assert.deepEqual(s.tokens, ["United States", "Europe", "Global", "Canada"]);
    assert.equal(s.global, true);
    assert.deepEqual(s.continents, ["Europe"]);
    assert.deepEqual(s.countries.map((c) => c.code), ["US", "CA"]);
    assert.deepEqual(s.invalid, []);
  });

  test("unknown locations are reported, never silently dropped or guessed", () => {
    const s = scope.parseGeoScope("Narnia, Canada");
    assert.deepEqual(s.invalid, ["Narnia"]);
    const v = scope.validateDiscoveryRegion("Narnia, Canada", { regionalSearch: true });
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.code, "invalid_region");
  });

  test("validateDiscoveryRegion returns the canonical wire form", () => {
    const v = scope.validateDiscoveryRegion("canada,  UNITED KINGDOM", { regionalSearch: true });
    assert.ok(v.ok);
    if (v.ok) assert.equal(v.region, "Canada, United Kingdom");
  });

  test("every country in the data set round-trips through the parser", () => {
    for (const c of COUNTRIES) {
      assert.equal(scope.parseGeoScope(c.name).countries[0]?.code, c.code, c.name);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("2. plan gating stays correct", () => {
  const free = { regionalSearch: false };
  const paid = { regionalSearch: true };

  test("Free: continent behavior unchanged — North America yes; other continents and Global no", () => {
    assert.equal(scope.validateDiscoveryRegion("North America", free).ok, true);
    for (const r of ["Europe", "Asia", "South America", "Africa", "Oceania", "Global"]) {
      const v = scope.validateDiscoveryRegion(r, free);
      assert.equal(v.ok, false, r);
      if (!v.ok) assert.equal(v.code, "region_restricted");
    }
  });

  test("Free: countries inside North America are allowed; countries outside are restricted", () => {
    for (const c of ["United States", "Canada", "Mexico"]) {
      assert.equal(scope.validateDiscoveryRegion(c, free).ok, true, c);
    }
    for (const c of ["United Kingdom", "Germany", "Japan", "Brazil"]) {
      const v = scope.validateDiscoveryRegion(c, free);
      assert.equal(v.ok, false, c);
      if (!v.ok) assert.equal(v.code, "region_restricted");
    }
  });

  test("Free: one out-of-region token poisons an otherwise-local selection", () => {
    assert.equal(scope.validateDiscoveryRegion("United States, United Kingdom", free).ok, false);
  });

  test("Starter/Pro/Premium (regionalSearch) may search any supported country", () => {
    for (const c of ["United Kingdom", "Germany", "Japan", "Brazil", "Global", "Europe"]) {
      assert.equal(scope.validateDiscoveryRegion(c, paid).ok, true, c);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("3. live discovery + pool expansion target resolution (US ≠ Canada ≠ UK)", () => {
  test("a country resolves to exactly that country", () => {
    assert.deepEqual(codes("United States"), ["US"]);
    assert.deepEqual(codes("Canada"), ["CA"]);
    assert.deepEqual(codes("United Kingdom"), ["GB"]);
  });

  test("US, Canada and UK are pairwise disjoint", () => {
    const us = new Set(codes("United States"));
    const ca = new Set(codes("Canada"));
    const gb = new Set(codes("United Kingdom"));
    for (const [a, b] of [[us, ca], [us, gb], [ca, gb]] as const) {
      for (const c of a) assert.ok(!b.has(c));
    }
  });

  test("a country is NOT widened to its continent (Canada never yields the US or Mexico)", () => {
    const ca = codes("Canada");
    assert.ok(!ca.includes("US"));
    assert.ok(!ca.includes("MX"));
    assert.ok(ca.length < codes("North America").length);
  });

  test("multiple countries resolve to exactly their union", () => {
    assert.deepEqual(codes("Canada, United Kingdom").sort(), ["CA", "GB"]);
  });

  test("continent behavior is unchanged: North America = every NA country; Global = everything", () => {
    const na = codes("North America");
    assert.deepEqual(na, COUNTRIES.filter((c) => c.region === "North America").map((c) => c.code));
    assert.ok(na.includes("US") && na.includes("CA") && na.includes("MX"));
    assert.ok(!na.includes("GB"));
    assert.equal(codes("Global").length, COUNTRIES.length);
    assert.equal(codes("Global, Canada").length, COUNTRIES.length, "Global already contains Canada; no duplicates");
  });

  test("a continent + a country from another continent = both, de-duplicated", () => {
    const c = codes("North America, United Kingdom");
    assert.ok(c.includes("US") && c.includes("GB"));
    assert.equal(new Set(c).size, c.length);
    assert.equal(codes("North America, Canada").length, codes("North America").length);
  });

  test("currency preference still narrows continents, but never drops an explicitly chosen country", () => {
    const low = COUNTRIES.find((c) => c.incomeTier === "low")!;
    assert.deepEqual(codes(low.name, { currencies: ["USD"] }), [low.code]);
    const narrowed = codes(low.region, { currencies: ["USD"] });
    assert.ok(narrowed.length > 0);
  });

  test("planner: a country scope expands ONLY to that country's internal city tasks", () => {
    const t = resolveDiscoveryTargets({ region: "Canada" });
    assert.ok(t.length > 0);
    assert.ok(t.every((x) => x.country.code === "CA"));
    assert.deepEqual(t.map((x) => x.city).sort(), [...COUNTRIES.find((c) => c.code === "CA")!.majorCities].sort());

    const us = resolveDiscoveryTargets({ region: "United States" });
    assert.ok(us.every((x) => x.country.code === "US"));
    const uk = resolveDiscoveryTargets({ region: "United Kingdom" });
    assert.ok(uk.every((x) => x.country.code === "GB"));
    const cities = (arr: typeof t) => new Set(arr.map((x) => x.city));
    for (const c of cities(t)) assert.ok(!cities(us).has(c) && !cities(uk).has(c));
  });

  test("discoverJob/poolExpandJob rotation only ever visits the selected country", () => {
    const rotation = new CountryRotation(resolveCountriesForSelection("United Kingdom"));
    const visited = [...rotation.round()];
    assert.ok(visited.length > 0);
    assert.ok(visited.every((v) => v.country.code === "GB"));
    // A real city, never the country name (the older root-cause bug).
    assert.ok(visited.every((v) => v.city !== "United Kingdom"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("4. providers receive the selected country and leads carry it", () => {
  const savedEngine = env.SCRAPER_ENGINE_PATH;
  beforeEach(() => {
    env.SCRAPER_ENGINE_PATH = REAL_SHAPE_ENGINE;
  });
  afterEach(() => {
    env.SCRAPER_ENGINE_PATH = savedEngine;
  });

  test("runEngineQuery stamps the REQUESTED country on every lead", async () => {
    for (const requested of ["US", "CA", "GB"]) {
      const out: EngineLead[] = [];
      for await (const lead of runEngineQuery({ query: "Coffee Shops", city: "Testville", country: requested, niche: "Coffee Shops" })) {
        out.push(lead);
      }
      assert.ok(out.length > 0);
      for (const l of out) assert.equal(l.country_code, requested);
    }
  });

  test("GoogleMapsProvider forwards target.countryCode to the engine", async () => {
    const provider = new GoogleMapsProvider();
    const out: EngineLead[] = [];
    for await (const lead of provider.search(
      { queryString: "Coffee Shops", niche: "Coffee Shops" } as any,
      { city: "London", countryCode: "GB", region: "United Kingdom", niche: "Coffee Shops" } as any,
      { maxResults: 5 } as any,
    )) {
      out.push(lead);
    }
    assert.ok(out.length > 0);
    for (const l of out) assert.equal(l.country_code, "GB");
  });

  test("attributeDiscoveryCountry: requested wins, engine echo is the fallback, unknown stays unset", () => {
    assert.equal(scope.attributeDiscoveryCountry({ country: "Canada" }, "US").country_code, "US");
    assert.equal(scope.attributeDiscoveryCountry({ country: "Canada" }, undefined).country_code, "CA");
    assert.equal(scope.attributeDiscoveryCountry({ country: "" }, "gb").country_code, "GB");
    assert.equal("country_code" in scope.attributeDiscoveryCountry({ country: "Atlantis" }, ""), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("5. pool (Starter/Pro) — scope arguments and end-to-end lookup", () => {
  let db: InstanceType<typeof FakeDb>;
  let restore: () => void;
  beforeEach(() => {
    db = new FakeDb();
    restore = installFakeSupabase(supabaseAdmin, db);
  });
  afterEach(() => restore());

  const biz = (name: string, over: Row): Row => {
    const b: Row = {
      id: db.nextId("biz"), name, niche: "Coffee Shops", region: "North America", country_code: null,
      address: "1 Main St", website: null, email: `${name}@x.test`, phone: null, instagram: null,
      is_disqualified: false, first_discovered_at: "2026-01-01T00:00:00Z", fingerprints: [], ...over,
    };
    db.businesses.push(b);
    return b;
  };
  const seed = () => {
    biz("us-1", { country_code: "US", region: "United States" });
    biz("us-2", { country_code: "US", region: "North America" });
    biz("ca-1", { country_code: "CA", region: "Canada" });
    biz("gb-1", { country_code: "GB", region: "United Kingdom" });
    biz("legacy-na", { country_code: null, region: "North America" }); // pre-034 row
  };
  const params = (region: string) => ({
    userId: "user-1", region, niche: "Coffee Shops", professionSlug: "web-design", rank: false,
    quantity: 20, scrapeJobId: "job-1", dailyLimit: 100, monthlyLimit: 1000, channels: [] as string[],
  });
  const deliveredNames = async (region: string) => {
    db.leads.length = 0;
    await lookupAndDeliverFromPool(params(region));
    return db.leads.map((l) => l.business_name).sort();
  };

  test("poolScopesFor: a country is a STRICT country_code lookup; continents keep the label match", () => {
    assert.deepEqual(poolScopesFor("United States"), [{ region: "", countryCodes: ["US"], countryStrict: true }]);
    assert.deepEqual(poolScopesFor("Canada"), [{ region: "", countryCodes: ["CA"], countryStrict: true }]);
    assert.deepEqual(poolScopesFor("United Kingdom"), [{ region: "", countryCodes: ["GB"], countryStrict: true }]);
    const na = poolScopesFor("North America");
    assert.equal(na.length, 1);
    assert.equal(na[0].region, "North America");
    assert.equal(na[0].countryStrict, false);
    assert.ok(na[0].countryCodes!.includes("CA") && !na[0].countryCodes!.includes("GB"));
    assert.deepEqual(poolScopesFor("Brooklyn"), [{ region: "Brooklyn", countryCodes: null, countryStrict: false }], "unknown label = legacy passthrough");
  });

  test("US ≠ Canada ≠ UK: each country search returns only its own businesses", async () => {
    seed();
    const us = await deliveredNames("United States");
    const ca = await deliveredNames("Canada");
    const gb = await deliveredNames("United Kingdom");
    assert.deepEqual(us, ["us-1", "us-2"]);
    assert.deepEqual(ca, ["ca-1"]);
    assert.deepEqual(gb, ["gb-1"]);
  });

  test("a country search never returns a business whose country is unknown", async () => {
    seed();
    assert.ok(!(await deliveredNames("United States")).includes("legacy-na"));
    assert.ok(!(await deliveredNames("Canada")).includes("legacy-na"));
  });

  test("the strict country arguments actually reach pool_lookup", async () => {
    seed();
    await lookupAndDeliverFromPool(params("Canada"));
    const call = db.rpcCalls.find((c) => c.fn === "pool_lookup")!;
    assert.equal(call.args.p_country_strict, true);
    assert.deepEqual(call.args.p_country_codes, ["CA"]);
    assert.equal(call.args.p_region, "");
  });

  test("multiple countries return exactly their union", async () => {
    seed();
    assert.deepEqual(await deliveredNames("United States, Canada"), ["ca-1", "us-1", "us-2"]);
  });

  test("continent behavior does not break: legacy-labelled rows still match, and country-tagged rows are included", async () => {
    seed();
    assert.deepEqual(await deliveredNames("North America"), ["ca-1", "legacy-na", "us-1", "us-2"]);
    assert.ok(!(await deliveredNames("North America")).includes("gb-1"));
    assert.deepEqual(await deliveredNames("Europe"), ["gb-1"]);
  });

  test("Global returns everything with a label or country, and still works", async () => {
    seed();
    biz("labelled-global", { region: "Global" });
    assert.deepEqual(await deliveredNames("Global"), ["ca-1", "gb-1", "labelled-global", "us-1", "us-2"]);
  });

  test("a mixed continent + country request unions both scopes without duplicates", async () => {
    seed();
    assert.deepEqual(await deliveredNames("Europe, Canada"), ["ca-1", "gb-1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("6. businesses carry their country (pool expansion preserves it)", () => {
  let db: InstanceType<typeof FakeDb>;
  let restore: () => void;
  beforeEach(() => {
    db = new FakeDb();
    restore = installFakeSupabase(supabaseAdmin, db);
  });
  afterEach(() => restore());

  const lead = (over: Partial<EngineLead>): EngineLead =>
    ({
      name: "Acme Cafe", address: "1 Main St", city: "Toronto", country: "", query: "Coffee", region: "",
      phone: "", email: "hi@acme.test", website: "https://acme.test", instagram: "", facebook: "", linkedin: "",
      niche: "Coffee Shops", fingerprints: ["fp-acme"], ...over,
    }) as EngineLead;

  test("a country-scoped expansion writes the lead's country to businesses.country_code", async () => {
    await upsertBusinessFromEngineLead(lead({ country_code: "CA" }), "Canada");
    assert.equal(db.businesses[0].country_code, "CA");
    assert.equal(db.businesses[0].region, "Canada");
  });

  test("a continent request never fabricates a country", async () => {
    await upsertBusinessFromEngineLead(lead({}), "North America");
    assert.equal(db.businesses[0].country_code, null);
  });

  test("a single-country request is a safe fallback when the engine gave no country", () => {
    assert.equal(resolveBusinessCountryCode(lead({}), "Canada"), "CA");
    assert.equal(resolveBusinessCountryCode(lead({}), "Canada, United States"), null);
    assert.equal(resolveBusinessCountryCode(lead({}), "Global"), null);
    assert.equal(resolveBusinessCountryCode(lead({ country: "Germany" }), "Europe"), "DE");
  });

  test("rediscovery fills a missing country once and never overwrites a known one", async () => {
    db.businesses.push({ id: "b-old", name: "Old", niche: "Coffee Shops", region: "North America", country_code: null, fingerprints: ["fp-acme"], confidence: 65 });
    await upsertBusinessFromEngineLead(lead({ country_code: "CA" }), "Canada");
    assert.equal(db.businesses.length, 1);
    assert.equal(db.businesses[0].country_code, "CA");
    await upsertBusinessFromEngineLead(lead({ country_code: "US" }), "United States");
    assert.equal(db.businesses[0].country_code, "CA", "a known country is never overwritten");
  });
});
