import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalPlaceId, chijToHex, expandPlaceIdForms, hexToChij } from "../placeId.js";

const VERIFIED_PAIRS = [
  { name: "Café Calidá", hexPair: "0x880fcd7f8fee01b5:0x89b38e817d796008", chij: "ChIJtQHuj3_ND4gRCGB5fYGOs4k" },
  { name: "Two Mile", hexPair: "0x880e25d2309d7c1d:0xb7d6f52d9e2cd16", chij: "ChIJHXydMNIlDogRFs3i2VJvfQs" },
  { name: "Mate & Company", hexPair: "0x880fcd00123c18d3:0xb0dee2bb5ebf8429", chij: "ChIJ0xg8EgDND4gRKYS_Xrvi3rA" },
  { name: "LVL UP", hexPair: "0x880e2d8be7e51999:0x67a9389ccd491477", chij: "ChIJmRnl54stDogRdxRJzZw4qWc" },
  { name: "Pedestrian Coffee", hexPair: "0x880fd37e809c62a5:0xa3c8126d20326228", chij: "ChIJpWKcgH7TD4gRKGIyIG0SyKM" },
];

describe("Canonical Place ID normalizer (TS)", () => {
  for (const pair of VERIFIED_PAIRS) {
    test(`verified pair hex_to_chij: ${pair.name}`, () => {
      const computedChij = hexToChij(pair.hexPair);
      assert.equal(computedChij, pair.chij);
    });

    test(`verified pair chij_to_hex: ${pair.name}`, () => {
      const computedHex = chijToHex(pair.chij);
      assert.equal(computedHex, pair.hexPair);
    });

    test(`canonicalPlaceId normalizes both forms: ${pair.name}`, () => {
      assert.equal(canonicalPlaceId(pair.chij), pair.hexPair);
      assert.equal(canonicalPlaceId(pair.hexPair), pair.hexPair);
      assert.equal(canonicalPlaceId(pair.hexPair.toUpperCase()), pair.hexPair);
    });

    test(`expandPlaceIdForms contains both forms: ${pair.name}`, () => {
      const fromChij = expandPlaceIdForms(pair.chij);
      assert.ok(fromChij.has(pair.hexPair));
      assert.ok(fromChij.has(pair.chij));

      const fromHex = expandPlaceIdForms(pair.hexPair);
      assert.ok(fromHex.has(pair.hexPair));
      assert.ok(fromHex.has(pair.chij));
    });
  }

  test("handles invalid inputs gracefully", () => {
    assert.equal(chijToHex(""), null);
    assert.equal(chijToHex("invalid"), null);
    assert.equal(hexToChij("not-hex"), null);
    assert.equal(canonicalPlaceId("fallback_token"), "fallback_token");
  });
});
