import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveInstagramToPersist } from "../instagram.js";
import { channelsSatisfied, mergeEnrichedChannels } from "../channelFilter.js";
import type { EngineEnrichResult } from "../../scraperBridge/pythonBridge.js";

/**
 * Regression — website-discovered Instagram URL was dropped in live enrichment.
 *
 * Python's ContactWorker found the link, but the enrich result never carried
 * it to Node and enrichBusiness() never wrote `businesses.instagram`, so the
 * live post-enrichment channel gate (discoveryPlanJob.ts) rejected every
 * Instagram-requiring candidate that had no pre-existing Instagram value.
 *
 * enrichBusiness() itself needs a database and a Python subprocess, so (as
 * with liveDiscoveryEarlyPruneWiring.test.ts) its wiring is pinned from
 * source, while the persistence decision and the channel gate are exercised
 * as real code.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jobSrc = readFileSync(path.join(__dirname, "../../jobs/businessProcessingJob.ts"), "utf8");
const planSrc = readFileSync(path.join(__dirname, "../../jobs/discoveryPlanJob.ts"), "utf8");

describe("Python -> Node boundary", () => {
  it("a website-discovered Instagram URL in the enrich JSON reaches the Node-typed result", () => {
    // Shape produced by engine_enrichment_bridge._enriched_to_dict and read
    // back through json.dumps -> JSON.parse (see test_enrichment_bridge_instagram.py).
    const wire = JSON.stringify({ email: "hi@bakery.example", instagram: "https://www.instagram.com/the_bakery/" });
    const parsed = JSON.parse(wire) as Pick<EngineEnrichResult, "email" | "instagram">;
    assert.equal(parsed.instagram, "https://www.instagram.com/the_bakery/");
    assert.equal(resolveInstagramToPersist(null, parsed.instagram), "https://www.instagram.com/the_bakery/");
  });
});

describe("resolveInstagramToPersist", () => {
  it("persists a valid extracted URL, canonicalized, when nothing is stored", () => {
    assert.equal(resolveInstagramToPersist(null, "https://www.instagram.com/the_bakery/"), "https://www.instagram.com/the_bakery/");
    assert.equal(resolveInstagramToPersist(undefined, "https://instagram.com/The_Bakery?hl=en"), "https://www.instagram.com/the_bakery/");
    assert.equal(resolveInstagramToPersist("", "@the_bakery"), "https://www.instagram.com/the_bakery/");
  });

  it("fills an invalid stored value (reserved path) with a valid extraction", () => {
    assert.equal(resolveInstagramToPersist("https://www.instagram.com/p/abc/", "https://www.instagram.com/shop/"), "https://www.instagram.com/shop/");
  });

  it("never erases or replaces an existing valid URL when extraction is missing or invalid", () => {
    const existing = "https://www.instagram.com/already_here/";
    for (const extracted of [null, undefined, "", "   ", "https://www.instagram.com/p/xyz/", "https://www.instagram.com/explore/", "https://www.instagram.com/12345/", "not a url"]) {
      assert.equal(resolveInstagramToPersist(existing, extracted), null, `extracted=${JSON.stringify(extracted)} must be a no-op`);
    }
  });

  it("does not overwrite an existing valid URL even with a different valid extraction", () => {
    assert.equal(resolveInstagramToPersist("https://www.instagram.com/already_here/", "https://www.instagram.com/someone_else/"), null);
  });

  it("returns null (no write) for missing or invalid extraction when nothing is stored", () => {
    for (const extracted of [null, undefined, "", "https://www.instagram.com/reel/abc/", "https://www.instagram.com/"]) {
      assert.equal(resolveInstagramToPersist(null, extracted), null);
    }
  });
});

describe("live channel gate with the persisted Instagram URL", () => {
  const requested = ["email", "phone", "instagram"];
  const lead = { email: null, phone: "+1 555 0100", instagram: null, website: "https://bakery.example" };

  it("passes when the URL was extracted+persisted and every other requested channel is satisfied", () => {
    const persisted = resolveInstagramToPersist(null, "https://www.instagram.com/the_bakery/");
    const enrichedRow = { email: "hi@bakery.example", phone: "+1 555 0100", instagram: persisted, website: "https://bakery.example" };
    assert.equal(channelsSatisfied(enrichedRow, requested), true);
    assert.equal(mergeEnrichedChannels(lead, enrichedRow).instagram, "https://www.instagram.com/the_bakery/");
  });

  it("still rejects when extraction found nothing (Instagram stays missing)", () => {
    const persisted = resolveInstagramToPersist(null, null);
    const enrichedRow = { email: "hi@bakery.example", phone: "+1 555 0100", instagram: persisted, website: "https://bakery.example" };
    assert.equal(channelsSatisfied(enrichedRow, requested), false);
  });

  it("keeps AND semantics: Instagram present but another requested channel missing still rejects", () => {
    const persisted = resolveInstagramToPersist(null, "https://www.instagram.com/the_bakery/");
    const enrichedRow = { email: null, phone: "+1 555 0100", instagram: persisted, website: "https://bakery.example" };
    assert.equal(channelsSatisfied(enrichedRow, requested), false);
  });

  it("does not affect leads that do not request Instagram", () => {
    assert.equal(channelsSatisfied({ email: "hi@bakery.example", phone: null, instagram: null }, ["email"]), true);
  });
});

describe("enrichBusiness / live gate wiring", () => {
  const fnStart = jobSrc.indexOf("async function enrichBusiness(");
  const fnEnd = jobSrc.indexOf("async function scoreBusiness(");
  const body = jobSrc.slice(fnStart, fnEnd);

  it("persists the extracted Instagram through resolveInstagramToPersist and never writes a raw/null value", () => {
    assert.notEqual(fnStart, -1);
    assert.match(body, /const siteInstagram = resolveInstagramToPersist\(business\.instagram, site\.instagram\);/);
    assert.match(body, /instagram: siteInstagram \|\| undefined,/);
    assert.doesNotMatch(body, /instagram: site\.instagram/, "raw extracted value must never be written");
    assert.match(body, /instagram: siteInstagram \|\| business\.instagram,/, "validation must use the same normalized value");
  });

  it("writes instagram in the same update as the other enriched columns, before validation/scoring", () => {
    const writeIdx = body.indexOf("instagram: siteInstagram || undefined,");
    const updateIdx = body.indexOf('from("businesses").update({');
    const validateIdx = body.indexOf("validateLead({");
    assert.ok(updateIdx !== -1 && updateIdx < writeIdx && writeIdx < validateIdx);
  });

  it("the live gate re-reads businesses.instagram only after ensureEnriched has completed", () => {
    const ensureIdx = planSrc.indexOf("await ensureEnriched(businessId);");
    const rereadIdx = planSrc.indexOf('.select("email, phone, instagram, website")');
    const gateIdx = planSrc.indexOf("channelsSatisfied(enriched, requestedChannels)");
    assert.ok(ensureIdx !== -1 && rereadIdx !== -1 && gateIdx !== -1);
    assert.ok(ensureIdx < rereadIdx && rereadIdx < gateIdx);
  });
});
