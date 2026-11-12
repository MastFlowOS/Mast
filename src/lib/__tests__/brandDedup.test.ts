import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBrandDomain,
  normalizeBrandInstagram,
  extractBrandFingerprints,
} from "../brandDedup.js";

describe("Brand-Level Deduplication Utilities", () => {
  it("normalizes brand domains and strips protocol, www, paths, queries", () => {
    assert.equal(
      normalizeBrandDomain("https://www.intelligentsia.com/pages/millennium-park-coffeebar"),
      "intelligentsia.com",
    );
    assert.equal(
      normalizeBrandDomain("http://Intelligentsia.COM/pages/monadnock-coffeebar?src=google"),
      "intelligentsia.com",
    );
    assert.equal(normalizeBrandDomain("www.lacolombe.com"), "lacolombe.com");
    assert.equal(normalizeBrandDomain("coffee.co.uk/locations/london"), "coffee.co.uk");
  });

  it("filters out generic and shared platforms so they do not collide", () => {
    assert.equal(normalizeBrandDomain("https://www.facebook.com/joescoffee"), null);
    assert.equal(normalizeBrandDomain("https://instagram.com/joescoffee"), null);
    assert.equal(normalizeBrandDomain("https://www.yelp.com/biz/joes-coffee"), null);
    assert.equal(normalizeBrandDomain("https://linktr.ee/joescoffee"), null);
    assert.equal(normalizeBrandDomain("https://toasttab.com/order/joes"), null);
    assert.equal(normalizeBrandDomain("https://order.toasttab.com/order/joes"), null);
    assert.equal(normalizeBrandDomain(""), null);
    assert.equal(normalizeBrandDomain(null), null);
    assert.equal(normalizeBrandDomain(undefined), null);
  });

  it("normalizes Instagram handles from URLs, handles, and @ handles", () => {
    assert.equal(
      normalizeBrandInstagram("https://www.instagram.com/intelligentsiacoffee/"),
      "intelligentsiacoffee",
    );
    assert.equal(
      normalizeBrandInstagram("@intelligentsiacoffee"),
      "intelligentsiacoffee",
    );
    assert.equal(
      normalizeBrandInstagram("intelligentsiacoffee"),
      "intelligentsiacoffee",
    );
    assert.equal(
      normalizeBrandInstagram("https://instagram.com/reels/12345/"),
      null,
    );
    assert.equal(normalizeBrandInstagram(""), null);
    assert.equal(normalizeBrandInstagram(null), null);
  });

  it("extracts brand fingerprints from fingerprints array or fallback fields", () => {
    const bizWithFp = {
      website: "https://www.intelligentsia.com/pages/monadnock",
      instagram: "https://www.instagram.com/intelligentsiacoffee/",
      fingerprints: [
        "place:0x123:0x456",
        "web:intelligentsia.com",
        "ig:intelligentsiacoffee",
        "tel:3125551234",
      ],
    };
    const extracted = extractBrandFingerprints(bizWithFp);
    assert.equal(extracted.domain, "intelligentsia.com");
    assert.equal(extracted.instagram, "intelligentsiacoffee");

    const bizFallback = {
      website: "https://lacolombe.com/locations",
      instagram: "@lacolombecoffee",
    };
    const extractedFallback = extractBrandFingerprints(bizFallback);
    assert.equal(extractedFallback.domain, "lacolombe.com");
    assert.equal(extractedFallback.instagram, "lacolombecoffee");
  });
});
