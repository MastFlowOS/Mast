import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV ??= "test";
process.env.SUPABASE_URL ??= "https://example-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.SUPABASE_JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/testdb";
process.env.ALLOWED_ORIGIN ??= "http://localhost:5173";

const { getKnownPlaceIdsForTask } = await import("../../jobs/discoveryPlanJob.js");
const { normalizeBrandDomain, normalizeBrandInstagram } = await import("../../lib/brandDedup.js");

describe("Brand-Level Deduplication for Lead Portfolios", () => {
  it("getKnownPlaceIdsForTask populates knownDomains and knownInstagrams from user portfolio", async () => {
    const mockDb = {
      from: (table: string) => {
        assert.equal(table, "businesses");
        return {
          select: (fields: string) => {
            assert.ok(fields.includes("leads!inner(user_id)"));
            return {
              eq: (col: string, val: any) => {
                assert.equal(col, "leads.user_id");
                assert.equal(val, "user-brand-test");
                return {
                  range: async () => ({
                    data: [
                      {
                        place_id: "0x880e2ca59d87f58f:0x16c6cb5e284d552d",
                        website: "https://www.intelligentsia.com/pages/millennium-park",
                        instagram: "https://www.instagram.com/intelligentsiacoffee/",
                        fingerprints: [
                          "place:0x880e2ca59d87f58f:0x16c6cb5e284d552d",
                          "web:intelligentsia.com",
                          "ig:intelligentsiacoffee",
                          "tel:3129209332",
                        ],
                      },
                      {
                        place_id: "0x880fd0123:0x456",
                        website: "https://lacolombe.com",
                        instagram: "@lacolombecoffee",
                        fingerprints: [
                          "place:0x880fd0123:0x456",
                          "web:lacolombe.com",
                          "ig:lacolombecoffee",
                        ],
                      },
                    ],
                    error: null,
                  }),
                };
              },
            };
          },
        };
      },
    };

    const placeIds = await getKnownPlaceIdsForTask(mockDb, "user-brand-test", "US", "Chicago");
    assert.ok(placeIds.length >= 2, "Must contain at least 2 place IDs (expanded forms)");

    const knownDomains = (placeIds as any).knownDomains as Set<string>;
    const knownInstagrams = (placeIds as any).knownInstagrams as Set<string>;

    assert.ok(knownDomains instanceof Set, "knownDomains must be attached as a Set");
    assert.ok(knownInstagrams instanceof Set, "knownInstagrams must be attached as a Set");

    assert.equal(knownDomains.has("intelligentsia.com"), true);
    assert.equal(knownDomains.has("lacolombe.com"), true);
    assert.equal(knownDomains.has("starbucks.com"), false);

    assert.equal(knownInstagrams.has("intelligentsiacoffee"), true);
    assert.equal(knownInstagrams.has("lacolombecoffee"), true);
    assert.equal(knownInstagrams.has("bluebottle"), false);
  });

  it("detects multi-branch collision between distinct Place IDs sharing website or Instagram", () => {
    const knownDomains = new Set<string>(["intelligentsia.com"]);
    const knownInstagrams = new Set<string>(["intelligentsiacoffee"]);

    // Candidate branch 2: Monadnock Building Coffeebar
    const candidateLead = {
      name: "Intelligentsia Coffee Monadnock Coffeebar",
      place_id: "0x880e2ca59d87f58f:0x7567bea982bd233e",
      website: "https://www.intelligentsia.com/pages/monadnock-coffeebar",
      instagram: "@intelligentsiacoffee",
    };

    const candidateDomain = normalizeBrandDomain(candidateLead.website);
    const candidateIg = normalizeBrandInstagram(candidateLead.instagram);

    const isDuplicate =
      (candidateDomain != null && knownDomains.has(candidateDomain)) ||
      (candidateIg != null && knownInstagrams.has(candidateIg));

    assert.equal(isDuplicate, true, "Branch 2 must be recognized as a brand duplicate of Branch 1");
  });

  it("does not false-positive on different businesses sharing generic platforms (e.g. Facebook or Yelp)", () => {
    const knownDomains = new Set<string>();
    const knownInstagrams = new Set<string>();

    const businessA = {
      website: "https://www.facebook.com/joesbarber",
      instagram: "@joesbarber",
    };
    const domainA = normalizeBrandDomain(businessA.website);
    const igA = normalizeBrandInstagram(businessA.instagram);

    if (domainA) knownDomains.add(domainA);
    if (igA) knownInstagrams.add(igA);

    const businessB = {
      website: "https://www.facebook.com/mikesbarber",
      instagram: "@mikesbarber",
    };
    const domainB = normalizeBrandDomain(businessB.website);
    const igB = normalizeBrandInstagram(businessB.instagram);

    const isDuplicate =
      (domainB != null && knownDomains.has(domainB)) ||
      (igB != null && knownInstagrams.has(igB));

    assert.equal(domainA, null, "Facebook must not be treated as a brand domain");
    assert.equal(domainB, null, "Facebook must not be treated as a brand domain");
    assert.equal(isDuplicate, false, "Independent businesses on Facebook must NOT collide");
  });
});
